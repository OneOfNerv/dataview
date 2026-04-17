/**
 * WKT 相交分析与渲染 Hook
 * - 输入两个 WKT（支持 POLYGON / MULTIPOLYGON，支持可选 SRID 前缀）
 * - 计算相交几何、相交面积（平方米 / 平方公里）
 * - 输出相交结果 WKT，并可直接在 Cesium 中渲染
 * - 渲染时支持颜色、描边、飞行定位、贴地与水印文案配置
 * - 提供单次清理与全部清理能力，便于组件销毁时释放实体
 *
 * 设计说明：
 * - 几何计算由 Turf 完成（intersect + area）
 * - 渲染基于传入的 getViewer()，需先完成 Cesium Viewer 初始化
 * - 若输入几何不相交，返回 isIntersect=false 且不会创建实体
 */
import * as Cesium from 'cesium'
import {
  area as turfArea,
  featureCollection,
  intersect as turfIntersect,
  multiPolygon,
  polygon,
  rewind
} from '@turf/turf'
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson'

type LngLat = [number, number]
type PolygonLike = Polygon | MultiPolygon

const EPS = 1e-10

export interface WktIntersectionResult {
  isIntersect: boolean
  intersectionWkt: string | null
  intersectionGeometry: PolygonLike | null
  intersectionRings: LngLat[][][] | null
  intersectionRing: LngLat[] | null
  areaSquareMeters: number
  areaSquareKilometers: number
  reason?: string
}

export interface IntersectOptions {
  precision?: number
}

export interface RenderIntersectionOptions {
  id?: string
  fillColor?: Cesium.Color
  outlineColor?: Cesium.Color
  outlineWidth?: number
  zoomTo?: boolean
  clampToGround?: boolean
  watermarkShow?: boolean
  watermarkText?: string
  watermarkColor?: Cesium.Color
}

function isSamePoint(a: LngLat, b: LngLat, eps = EPS) {
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps
}

function stripClosedPoint(points: LngLat[]) {
  if (points.length <= 1) return points
  const first = points[0]!
  const last = points[points.length - 1]!
  if (isSamePoint(first, last)) return points.slice(0, -1)
  return points
}

function dedupeConsecutive(points: LngLat[]) {
  const out: LngLat[] = []
  for (const p of points) {
    const last = out.length > 0 ? out[out.length - 1]! : null
    if (!last || !isSamePoint(last, p)) out.push(p)
  }
  return out
}

function closeRing(points: LngLat[]) {
  if (points.length === 0) return points
  const first = points[0]!
  const last = points[points.length - 1]!
  if (isSamePoint(first, last)) return points
  return [...points, first]
}

function normalizeWkt(wkt: string) {
  return wkt.trim().replace(/^SRID=\d+;/i, '').trim()
}

function splitTopLevelByComma(text: string) {
  const parts: string[] = []
  let depth = 0
  let start = 0

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim())
      start = i + 1
    }
    if (depth < 0) return null
  }

  if (depth !== 0) return null
  parts.push(text.slice(start).trim())
  return parts.filter(Boolean)
}

function stripOuterParens(text: string) {
  const trimmed = text.trim()
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return null
  return trimmed.slice(1, -1).trim()
}

function parseCoordinatePair(pointText: string) {
  const nums = pointText
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((v) => Number.isFinite(v))

  if (nums.length < 2) return null
  return [nums[0]!, nums[1]!] as LngLat
}

function parseRing(ringText: string) {
  const content = stripOuterParens(ringText)
  if (!content) return null

  const points: LngLat[] = content
    .split(',')
    .map((item) => parseCoordinatePair(item))
    .filter((p): p is LngLat => p !== null)

  const open = stripClosedPoint(dedupeConsecutive(points))
  if (open.length < 3) return null
  return closeRing(open)
}

function parsePolygonBody(body: string) {
  const polygonContent = stripOuterParens(body)
  if (!polygonContent) return null

  const ringTexts = splitTopLevelByComma(polygonContent)
  if (!ringTexts || ringTexts.length === 0) return null

  const rings = ringTexts
    .map((ringText) => parseRing(ringText))
    .filter((ring): ring is LngLat[] => ring !== null)

  if (rings.length === 0) return null
  return rings
}

function parseWktPolygonLike(wkt: string): PolygonLike | null {
  const text = normalizeWkt(wkt)
  const start = text.indexOf('(')
  const end = text.lastIndexOf(')')
  if (start < 0 || end <= start) return null
  const bodyWithParens = text.slice(start, end + 1)

  if (/^POLYGON\b/i.test(text)) {
    const rings = parsePolygonBody(bodyWithParens)
    if (!rings) return null
    return { type: 'Polygon', coordinates: rings as Position[][] }
  }

  if (/^MULTIPOLYGON\b/i.test(text)) {
    const multiBody = stripOuterParens(bodyWithParens)
    if (!multiBody) return null
    const polygonTexts = splitTopLevelByComma(multiBody)
    if (!polygonTexts || polygonTexts.length === 0) return null

    const polygons = polygonTexts
      .map((polyText) => parsePolygonBody(polyText))
      .filter((poly): poly is LngLat[][] => poly !== null)

    if (polygons.length === 0) return null
    return { type: 'MultiPolygon', coordinates: polygons as Position[][][] }
  }

  return null
}

function featureFromGeometry(geometry: PolygonLike): Feature<PolygonLike> {
  return geometry.type === 'Polygon'
    ? polygon(geometry.coordinates) as Feature<PolygonLike>
    : multiPolygon(geometry.coordinates) as Feature<PolygonLike>
}

function formatNumber(value: number, precision: number) {
  const p = Math.max(0, precision)
  const fixed = value.toFixed(p)
  const normalized = fixed.replace(/(?:\.0+|(\.\d+?)0+)$/, '$1')
  return normalized === '-0' ? '0' : normalized
}

function ringToWktText(ring: Position[], precision: number) {
  return ring
    .map((coord) => `${formatNumber(coord[0]!, precision)} ${formatNumber(coord[1]!, precision)}`)
    .join(', ')
}

function geometryToWkt(geometry: PolygonLike, precision: number) {
  if (geometry.type === 'Polygon') {
    const ringsText = geometry.coordinates
      .map((ring) => `(${ringToWktText(ring, precision)})`)
      .join(', ')
    return `POLYGON (${ringsText})`
  }

  const polygonsText = geometry.coordinates
    .map((poly) => `(${poly.map((ring) => `(${ringToWktText(ring, precision)})`).join(', ')})`)
    .join(', ')
  return `MULTIPOLYGON (${polygonsText})`
}

function geometryToRings(geometry: PolygonLike): LngLat[][][] {
  if (geometry.type === 'Polygon') {
    return [geometry.coordinates.map((ring) => ring.map((coord) => [coord[0], coord[1]] as LngLat))]
  }
  return geometry.coordinates.map((polygonRings) =>
    polygonRings.map((ring) => ring.map((coord) => [coord[0], coord[1]] as LngLat))
  )
}

function toDegreesArray(ring: LngLat[]) {
  const out: number[] = []
  for (const [lon, lat] of ring) out.push(lon, lat)
  return out
}

function buildPolygonHierarchy(rings: LngLat[][]) {
  const outerRing = rings[0]
  if (!outerRing) return null

  const outer = Cesium.Cartesian3.fromDegreesArray(toDegreesArray(outerRing))
  const holes = rings
    .slice(1)
    .map((holeRing) => {
      if (holeRing.length < 4) return null
      return new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(toDegreesArray(holeRing)))
    })
    .filter((h): h is Cesium.PolygonHierarchy => h !== null)

  return new Cesium.PolygonHierarchy(outer, holes)
}

function computeRingCentroid(ring: LngLat[]) {
  const points = stripClosedPoint(ring)
  if (points.length === 0) return null
  if (points.length === 1) return points[0]

  let area2 = 0
  let cx = 0
  let cy = 0

  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]!
    const [x2, y2] = points[(i + 1) % points.length]!
    const cross = x1 * y2 - x2 * y1
    area2 += cross
    cx += (x1 + x2) * cross
    cy += (y1 + y2) * cross
  }

  if (Math.abs(area2) <= EPS) {
    let sumX = 0
    let sumY = 0
    points.forEach(([x, y]) => {
      sumX += x
      sumY += y
    })
    return [sumX / points.length, sumY / points.length] as LngLat
  }

  return [cx / (3 * area2), cy / (3 * area2)] as LngLat
}

export function useWktIntersection(getViewer: () => Cesium.Viewer | null | undefined) {
  const renderedIds = new Set<string>()
  const renderGroupMap = new Map<string, string[]>()

  const intersectWkt = (
    wktA: string,
    wktB: string,
    options: IntersectOptions = {}
  ): WktIntersectionResult => {
    const precision = options.precision ?? 15
    const geomA = parseWktPolygonLike(wktA)
    const geomB = parseWktPolygonLike(wktB)

    if (!geomA || !geomB) {
      return {
        isIntersect: false,
        intersectionWkt: null,
        intersectionGeometry: null,
        intersectionRings: null,
        intersectionRing: null,
        areaSquareMeters: 0,
        areaSquareKilometers: 0,
        reason: 'WKT 解析失败，仅支持 POLYGON / MULTIPOLYGON'
      }
    }
    
    const featureA = featureFromGeometry(geomA)
    const featureB = featureFromGeometry(geomB)

    const intersection = turfIntersect(featureCollection([featureA, featureB]))

    if (!intersection || !intersection.geometry) {
      return {
        isIntersect: false,
        intersectionWkt: null,
        intersectionGeometry: null,
        intersectionRings: null,
        intersectionRing: null,
        areaSquareMeters: 0,
        areaSquareKilometers: 0
      }
    }

    const geometry = intersection.geometry as PolygonLike
    const intersectionWkt = geometryToWkt(geometry, precision)
    const intersectionRings = geometryToRings(geometry)
    const firstOuter = intersectionRings[0]?.[0] ?? null
    const areaSquareMeters = turfArea(intersection)
    const areaSquareKilometers = areaSquareMeters / 1_000_000

    return {
      isIntersect: true,
      intersectionWkt,
      intersectionGeometry: geometry,
      intersectionRings,
      intersectionRing: firstOuter ? stripClosedPoint(firstOuter) : null,
      areaSquareMeters,
      areaSquareKilometers
    }
  }

  const renderIntersection = (
    result: WktIntersectionResult,
    options: RenderIntersectionOptions = {}
  ) => {
    if (!result.isIntersect || !result.intersectionRings) return null
    const viewer = getViewer()
    if (!viewer) return null

    const {
      id = 'wkt-intersection',
      fillColor = Cesium.Color.fromCssColorString('rgba(249, 249, 121, 0.5)'),
      outlineColor = Cesium.Color.ORANGE,
      outlineWidth = 2,
      zoomTo = false,
      clampToGround = true,
      watermarkShow = true,
      watermarkText = '交付区域',
      watermarkColor = Cesium.Color.WHITE.withAlpha(0.55)
    } = options

    const existingIds = renderGroupMap.get(id)
    if (existingIds) {
      existingIds.forEach((rid) => {
        viewer.entities.removeById(rid)
        renderedIds.delete(rid)
      })
      renderGroupMap.delete(id)
    } else {
      viewer.entities.removeById(id)
      renderedIds.delete(id)
    }

    const entityIds: string[] = []
    const flyTargets: Cesium.Entity[] = []

    result.intersectionRings.forEach((polygonRings, index) => {
      const hierarchy = buildPolygonHierarchy(polygonRings)
      if (!hierarchy) return

      const entityId = result.intersectionRings!.length === 1 ? id : `${id}-${index + 1}`
      const entity = viewer.entities.add({
        id: entityId,
        name: 'wkt-intersection',
        polygon: {
          hierarchy,
          material: fillColor,
          zIndex: 99,
          outline: true,
          outlineColor,
          outlineWidth,
          ...(clampToGround
            ? { height: 0, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND }
            : {})
        }
      })

      entityIds.push(entityId)
      flyTargets.push(entity)
      renderedIds.add(entityId)

      if (watermarkShow) {
        const centroid = computeRingCentroid(polygonRings[0] ?? [])
        if (centroid) {
          const watermarkId = `${entityId}-wm`
          const watermarkEntity = viewer.entities.add({
            id: watermarkId,
            name: 'wkt-intersection-watermark',
            position: Cesium.Cartesian3.fromDegrees(centroid[0], centroid[1]),
            label: {
              text: watermarkText,
              font: '18px sans-serif',
              fillColor: watermarkColor,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              outlineColor: Cesium.Color.BLACK.withAlpha(0.35),
              outlineWidth: 2,
              horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
              verticalOrigin: Cesium.VerticalOrigin.CENTER,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              ...(clampToGround
                ? { heightReference: Cesium.HeightReference.CLAMP_TO_GROUND }
                : {})
            }
          })
          entityIds.push(watermarkId)
          renderedIds.add(watermarkId)
          if (!watermarkEntity) {
            viewer.entities.removeById(watermarkId)
          }
        }
      }
    })

    if (entityIds.length > 0) renderGroupMap.set(id, entityIds)
    if (zoomTo && flyTargets.length > 0) viewer.flyTo(flyTargets, { duration: 1.2 })
    viewer.scene.requestRender()

    if (flyTargets.length === 0) return null
    return flyTargets.length === 1 ? flyTargets[0] : flyTargets
  }

  const intersectAndRender = (
    wktA: string,
    wktB: string,
    options: IntersectOptions & RenderIntersectionOptions = {}
  ) => {
    const result = intersectWkt(wktA, wktB, options)
    const entity = renderIntersection(result, options)
    return { ...result, entity }
  }

  const clearIntersection = (id = 'wkt-intersection') => {
    const viewer = getViewer()
    if (!viewer) return false

    const ids = renderGroupMap.get(id) ?? [id]
    let removed = false
    ids.forEach((rid) => {
      if (viewer.entities.removeById(rid)) {
        removed = true
        renderedIds.delete(rid)
      }
    })

    renderGroupMap.delete(id)
    if (removed) viewer.scene.requestRender()
    return removed
  }

  const clearAllIntersections = () => {
    const viewer = getViewer()
    if (!viewer) return
    renderedIds.forEach((id) => viewer.entities.removeById(id))
    renderedIds.clear()
    renderGroupMap.clear()
    viewer.scene.requestRender()
  }

  return {
    intersectWkt,
    renderIntersection,
    intersectAndRender,
    clearIntersection,
    clearAllIntersections
  }
}

export const useInWkt = useWktIntersection

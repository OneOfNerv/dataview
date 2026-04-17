import * as Cesium from 'cesium'

type LngLat = [number, number]

const EPS = 1e-10

function isSamePoint(a: LngLat, b: LngLat, eps = EPS) {
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps
}

function stripClosedPoint(points: LngLat[]) {
  if (points.length <= 1) return points
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return points
  return isSamePoint(first, last) ? points.slice(0, -1) : points
}

function closeRing(points: LngLat[]) {
  if (points.length === 0) return points
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return points
  return isSamePoint(first, last) ? points : [...points, first]
}

function toDegreesArray(points: LngLat[]) {
  const out: number[] = []
  points.forEach(([lon, lat]) => out.push(lon, lat))
  return out
}

function createTransparentFillMaterial(alpha = 0.01) {
  return new Cesium.ColorMaterialProperty(Cesium.Color.WHITE.withAlpha(alpha))
}

function createLineMaterial(color: Cesium.Color) {
  return new Cesium.ColorMaterialProperty(color)
}

function createFillEnabledProperty(enabled = true) {
  return new Cesium.ConstantProperty(enabled)
}

function createClassificationTypeProperty(type = Cesium.ClassificationType.TERRAIN) {
  return new Cesium.ConstantProperty(type)
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
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
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

  const points = content
    .split(',')
    .map((item) => parseCoordinatePair(item))
    .filter((p): p is LngLat => p !== null)

  const openRing = stripClosedPoint(points)
  if (openRing.length < 3) return null
  return closeRing(openRing)
}

function parsePolygonBody(body: string) {
  const polygonContent = stripOuterParens(body)
  if (!polygonContent) return null

  const ringTexts = splitTopLevelByComma(polygonContent)
  if (!ringTexts || ringTexts.length === 0) return null

  const rings = ringTexts
    .map((ringText) => parseRing(ringText))
    .filter((ring): ring is LngLat[] => ring !== null)

  return rings.length > 0 ? rings : null
}

function parseWktPolygonLike(wkt: string) {
  const text = normalizeWkt(wkt)
  const start = text.indexOf('(')
  const end = text.lastIndexOf(')')
  if (start < 0 || end <= start) return null

  const bodyWithParens = text.slice(start, end + 1)

  if (/^POLYGON\b/i.test(text)) {
    const rings = parsePolygonBody(bodyWithParens)
    return rings ? [rings] : null
  }

  if (/^MULTIPOLYGON\b/i.test(text)) {
    const multiBody = stripOuterParens(bodyWithParens)
    if (!multiBody) return null

    const polygonTexts = splitTopLevelByComma(multiBody)
    if (!polygonTexts || polygonTexts.length === 0) return null

    const polygons = polygonTexts
      .map((polyText) => parsePolygonBody(polyText))
      .filter((poly): poly is LngLat[][] => poly !== null)

    return polygons.length > 0 ? polygons : null
  }

  return null
}

function buildPolygonHierarchy(rings: LngLat[][]) {
  const outerRing = rings[0]
  if (!outerRing) return null

  const outerOpen = stripClosedPoint(outerRing)
  if (outerOpen.length < 3) return null

  const outer = Cesium.Cartesian3.fromDegreesArray(toDegreesArray(outerOpen))
  const holes = rings
    .slice(1)
    .map((holeRing) => {
      const holeOpen = stripClosedPoint(holeRing)
      if (holeOpen.length < 3) return null
      return new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(toDegreesArray(holeOpen)))
    })
    .filter((h): h is Cesium.PolygonHierarchy => h !== null)

  return new Cesium.PolygonHierarchy(outer, holes)
}

function getBoundsFromWKT(wkt: string) {
  if (!wkt) return null
  const coordsString = wkt.slice(wkt.indexOf('(')).replace(/[()]/g, '')
  const points = coordsString.split(',')

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  points.forEach((point) => {
    const coords = point.trim().split(/\s+/)
    if (coords.length < 2) return
    const x = parseFloat(coords[0]!)
    const y = parseFloat(coords[1]!)
    if (Number.isNaN(x) || Number.isNaN(y)) return
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  })

  if (minX === Infinity) return null
  return { west: minX, south: minY, east: maxX, north: maxY }
}

let interactionHandler: Cesium.ScreenSpaceEventHandler | null = null
let hoveredEntity: Cesium.Entity | null = null
const originalLineMaterial = createLineMaterial(Cesium.Color.RED)
const highlightLineMaterial = createLineMaterial(Cesium.Color.YELLOW)
const selectedOwnerIds = new Set<string>()

const rectangleIds = new Set<string>()
const rectangleGroupMap = new Map<string, string[]>()
const rectangleOwnerMap = new Map<string, string>()

export function useCesiumBoundingBox(getViewer: () => Cesium.Viewer | null | undefined) {

  const markGroup = (ownerId: string, entityIds: string[]) => {
    if (entityIds.length === 0) return
    rectangleGroupMap.set(ownerId, entityIds)
    entityIds.forEach((entityId) => {
      rectangleIds.add(entityId)
      rectangleOwnerMap.set(entityId, ownerId)
    })
  }

  const getGroupIds = (id: string) => rectangleGroupMap.get(id) ?? [id]

  const clearGroupMarks = (ownerId: string) => {
    const ids = getGroupIds(ownerId)
    ids.forEach((entityId) => {
      rectangleIds.delete(entityId)
      rectangleOwnerMap.delete(entityId)
    })
    rectangleGroupMap.delete(ownerId)
  }

  const resolveOwnerId = (id: string) => {
    if (rectangleGroupMap.has(id)) return id
    return rectangleOwnerMap.get(id) ?? null
  }

  const setOwnerHighlight = (ownerId: string, highlighted: boolean) => {
    const viewer = getViewer()
    if (!viewer) return
    const ids = getGroupIds(ownerId)
    ids.forEach((entityId) => {
      const entity = viewer.entities.getById(entityId)
      if (entity?.polyline) {
        entity.polyline.material = highlighted ? highlightLineMaterial : originalLineMaterial
      }
    })
  }

  const removeRectangleInternal = (id: string) => {
    const viewer = getViewer()
    if (!viewer) return false

    const ids = getGroupIds(String(id))
    let removed = false
    ids.forEach((entityId) => {
      if (viewer.entities.removeById(entityId)) removed = true
      if (hoveredEntity && hoveredEntity.id === entityId) hoveredEntity = null
    })
    clearGroupMarks(id)
    selectedOwnerIds.delete(id)
    return removed
  }

  const updateHighlights = (ids: Array<string | number> = []) => {
    const viewer = getViewer()
    if (!viewer) return false

    const nextOwners = new Set<string>()
    ids.forEach((id) => {
      const ownerId = resolveOwnerId(String(id))
      if (ownerId) nextOwners.add(ownerId)
    })

    selectedOwnerIds.forEach((ownerId) => {
      if (!nextOwners.has(ownerId)) setOwnerHighlight(ownerId, false)
    })
    nextOwners.forEach((ownerId) => setOwnerHighlight(ownerId, true))

    selectedOwnerIds.clear()
    nextOwners.forEach((ownerId) => selectedOwnerIds.add(ownerId))
    viewer.scene.requestRender()
    return true
  }

  const initBoundingBoxEvents = (onClickCallback?: (id: string, isSelected: boolean) => void) => {
    const viewer = getViewer()
    if (!viewer) return
    if (interactionHandler) return

    interactionHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)

    interactionHandler.setInputAction((movement: { endPosition: Cesium.Cartesian2 }) => {
      const pickedObject = viewer.scene.pick(movement.endPosition) as { id?: Cesium.Entity } | undefined

      if (hoveredEntity && (!pickedObject || pickedObject.id !== hoveredEntity)) {
        const hoveredId = typeof hoveredEntity.id === 'string' ? hoveredEntity.id : null
        const ownerId = hoveredId ? resolveOwnerId(hoveredId) : null
        if (hoveredEntity.polyline) {
          hoveredEntity.polyline.material = ownerId && selectedOwnerIds.has(ownerId)
            ? highlightLineMaterial
            : originalLineMaterial
        }
        hoveredEntity = null
        viewer.scene.canvas.style.cursor = 'default'
        viewer.scene.requestRender()
      }

      const pickedEntity = pickedObject?.id
      const pickedId = typeof pickedEntity?.id === 'string' ? pickedEntity.id : null
      if (!pickedEntity || !pickedId || !rectangleIds.has(pickedId)) return

      if (hoveredEntity !== pickedEntity) {
        hoveredEntity = pickedEntity
        if (pickedEntity.polyline) pickedEntity.polyline.material = highlightLineMaterial
        viewer.scene.canvas.style.cursor = 'pointer'
        viewer.scene.requestRender()
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    interactionHandler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      const pickedObject = viewer.scene.pick(movement.position) as { id?: Cesium.Entity } | undefined
      const pickedEntity = pickedObject?.id
      const pickedId = typeof pickedEntity?.id === 'string' ? pickedEntity.id : null
      if (!pickedEntity || !pickedId || !rectangleIds.has(pickedId)) return

      const ownerId = rectangleOwnerMap.get(pickedId) ?? pickedId
      let isSelected = false

      if (selectedOwnerIds.has(ownerId)) {
        selectedOwnerIds.delete(ownerId)
        const hoveredId = hoveredEntity && typeof hoveredEntity.id === 'string' ? hoveredEntity.id : null
        const hoveredOwnerId = hoveredId ? resolveOwnerId(hoveredId) : null
        if (hoveredOwnerId !== ownerId) setOwnerHighlight(ownerId, false)
      } else {
        selectedOwnerIds.add(ownerId)
        setOwnerHighlight(ownerId, true)
        isSelected = true
      }

      viewer.scene.requestRender()
      if (onClickCallback) onClickCallback(ownerId, isSelected)

      viewer.flyTo(pickedEntity, {
        duration: 1.5,
        offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-90), 0)
      })
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
  }

  const addRectangle = (options: { id: string | number; wkt?: string; geom?: string; geometry?: string; name?: string }) => {
    const viewer = getViewer()
    if (!viewer) return null

    const ownerId = String(options.id)
    const wkt = [options.wkt, options.geom, options.geometry].find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0
    )
    const name = options.name ?? 'bounding-box'
    if (!wkt) return null

    removeRectangleInternal(ownerId)

    const polygons = parseWktPolygonLike(wkt)
    if (polygons && polygons.length > 0) {
      const entities: Cesium.Entity[] = []
      polygons.forEach((rings, index) => {
        const hierarchy = buildPolygonHierarchy(rings)
        const outerRing = rings[0]
        if (!hierarchy || !outerRing) return

        const borderRing = closeRing(stripClosedPoint(outerRing))
        const entityId = polygons.length === 1 ? ownerId : `${ownerId}-${index + 1}`
        const entity = viewer.entities.add({
          id: entityId,
          name,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(toDegreesArray(borderRing)),
            width: 2,
            material: originalLineMaterial,
            clampToGround: true,
            arcType: Cesium.ArcType.RHUMB
          },
          polygon: {
            hierarchy,
            fill: createFillEnabledProperty(),
            material: createTransparentFillMaterial(),
            classificationType: createClassificationTypeProperty()
          }
        })
        entities.push(entity)
      })

      const entityIds = entities
        .map((entity) => (typeof entity.id === 'string' ? entity.id : null))
        .filter((entityId): entityId is string => Boolean(entityId))
      if (entityIds.length > 0) {
        markGroup(ownerId, entityIds)
        if (selectedOwnerIds.has(ownerId)) setOwnerHighlight(ownerId, true)
        viewer.scene.requestRender()
        return entities[0] ?? null
      }
    }

    const bounds = getBoundsFromWKT(wkt)
    if (!bounds) return null

    const { west, south, east, north } = bounds
    const entity = viewer.entities.add({
      id: ownerId,
      name,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray([
          west, north, east, north, east, south, west, south, west, north
        ]),
        width: 2,
        material: originalLineMaterial,
        clampToGround: true,
        arcType: Cesium.ArcType.RHUMB,
      },
      rectangle: {
        coordinates: Cesium.Rectangle.fromDegrees(west, south, east, north),
        fill: createFillEnabledProperty(),
        material: createTransparentFillMaterial(),
      },
    })

    if (typeof entity.id === 'string') markGroup(ownerId, [entity.id])
    if (selectedOwnerIds.has(ownerId)) setOwnerHighlight(ownerId, true)
    viewer.scene.requestRender()
    return entity
  }

  const batchAddRectangles = (
    rectanglesData: Array<{ id: string | number; wkt?: string; geom?: string; geometry?: string; name?: string }>,
    zoom = false
  ) => {
    const viewer = getViewer()
    if (!viewer) return []

    const addedEntities = rectanglesData.map((data) => addRectangle(data)).filter((e): e is Cesium.Entity => e !== null)
    if (zoom && addedEntities.length > 0) viewer.zoomTo(addedEntities)
    return addedEntities
  }

  const removeRectangle = (id: string | number) => {
    const viewer = getViewer()
    if (!viewer) return false

    const removed = removeRectangleInternal(String(id))
    if (removed) {
      viewer.scene.canvas.style.cursor = 'default'
      viewer.scene.requestRender()
    }
    return removed
  }

  const removeAllRectangles = () => {
    const viewer = getViewer()
    if (!viewer) return

    const ownerIds = Array.from(rectangleGroupMap.keys())
    ownerIds.forEach((ownerId) => removeRectangleInternal(ownerId))

    rectangleIds.clear()
    rectangleOwnerMap.clear()
    rectangleGroupMap.clear()
    selectedOwnerIds.clear()
    hoveredEntity = null
    viewer.scene.canvas.style.cursor = 'default'
    viewer.scene.requestRender()
  }

  const applyImageToRectangle = (id: string | number, imageUrl: string) => {
    const viewer = getViewer()
    if (!viewer) return

    const ids = getGroupIds(String(id))
    ids.forEach((entityId) => {
      const entity = viewer.entities.getById(entityId)
      if (!entity) return
      if (entity.rectangle) {
        entity.rectangle.material = new Cesium.ImageMaterialProperty({ image: imageUrl, transparent: true })
        entity.rectangle.fill = createFillEnabledProperty()
        return
      }
      if (entity.polygon) {
        entity.polygon.classificationType = createClassificationTypeProperty()
        entity.polygon.material = new Cesium.ImageMaterialProperty({ image: imageUrl, transparent: true })
        entity.polygon.fill = createFillEnabledProperty()
      }
    })
    viewer.scene.requestRender()
  }

  const clearAllHighlights = () => {
    const viewer = getViewer()
    if (!viewer) return false

    selectedOwnerIds.forEach((ownerId) => setOwnerHighlight(ownerId, false))
    selectedOwnerIds.clear()
    viewer.scene.requestRender()
    return true
  }

  const removeImageFromRectangle = (id: string | number) => {
    const viewer = getViewer()
    if (!viewer) return

    const ids = getGroupIds(String(id))
    ids.forEach((entityId) => {
      const entity = viewer.entities.getById(entityId)
      if (!entity) return
      if (entity.rectangle) {
        entity.rectangle.material = createTransparentFillMaterial()
        entity.rectangle.fill = createFillEnabledProperty()
        return
      }
      if (entity.polygon) {
        entity.polygon.material = createTransparentFillMaterial()
        entity.polygon.fill = createFillEnabledProperty()
      }
    })
    viewer.scene.requestRender()
  }

  const destroyBoundingBoxEvents = () => {
    if (interactionHandler) {
      interactionHandler.destroy()
      interactionHandler = null
    }
  }

  return {
    initBoundingBoxEvents,
    addRectangle,
    batchAddRectangles,
    removeRectangle,
    removeAllRectangles,
    applyImageToRectangle,
    removeImageFromRectangle,
    clearAllHighlights,
    updateHighlights,
    destroyBoundingBoxEvents
  }
}

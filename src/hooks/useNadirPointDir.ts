import * as Cesium from 'cesium'
import { buffer as turfBuffer, lineString } from '@turf/turf'
import type { Feature, LineString, MultiPolygon, Polygon, Position } from 'geojson'

type LngLat = [number, number]
type PolygonLike = Polygon | MultiPolygon

const TWO_PI = Math.PI * 2
const SECONDS_PER_DAY = 86400
const MILLISECONDS_PER_DAY = 86400000
const JULIAN_DATE_UNIX_EPOCH = 2440587.5
const JULIAN_DATE_J2000 = 2451545.0
const EARTH_MU = 3.986004418e14
const KEPLER_EPSILON = 1e-12
const KEPLER_MAX_ITER = 15
const DEFAULT_DURATION_MINUTES = 90
const DEFAULT_STEP_SECONDS = 60
const DEFAULT_MAX_POINTS = 20000
const EPS = 1e-10

export interface TleInput {
  name?: string
  line1: string
  line2: string
}

interface ParsedTle extends TleInput {
  epoch: Date
  inclinationRad: number
  raanRad: number
  eccentricity: number
  argPerigeeRad: number
  meanAnomalyRad: number
  meanMotionRadPerSecond: number
  semiMajorAxisMeters: number
}

export interface NadirTrackPoint {
  time: Date
  longitude: number
  latitude: number
  satelliteHeightMeters: number
}

export interface ComputeNadirTrackOptions {
  startTime?: Date | string | number
  endTime?: Date | string | number
  durationSeconds?: number
  durationMinutes?: number
  stepSeconds?: number
  maxPoints?: number
}

export interface NadirTrackResult {
  tle: ParsedTle
  startTime: Date
  endTime: Date
  stepSeconds: number
  points: NadirTrackPoint[]
  lineCoordinates: LngLat[]
  lineSegments: LngLat[][]
  lineFeatures: Feature<LineString>[]
  lineFeature: Feature<LineString>
}

export interface TrackBufferOptions {
  distance: number
  units?: 'meters' | 'kilometers'
  steps?: number
  precision?: number
}

export interface TrackBufferResult {
  distance: number
  units: 'meters' | 'kilometers'
  feature: Feature<PolygonLike>
  geometry: PolygonLike
  rings: LngLat[][][]
  wkt: string
}

export interface RenderNadirTrackOptions {
  id?: string
  color?: Cesium.Color
  width?: number
  clampToGround?: boolean
  zoomTo?: boolean
  arcType?: Cesium.ArcType
}

export interface RenderTrackBufferOptions {
  id?: string
  fillColor?: Cesium.Color
  outlineColor?: Cesium.Color
  outlineWidth?: number
  clampToGround?: boolean
  zoomTo?: boolean
}

function normalizeLongitude(lon: number) {
  return ((((lon + 180) % 360) + 360) % 360) - 180
}

function normalizeRadians(value: number) {
  const m = value % TWO_PI
  return m < 0 ? m + TWO_PI : m
}

function parseDateInput(input: Date | string | number | undefined, fallback: Date) {
  if (input === undefined) return new Date(fallback.getTime())
  if (input instanceof Date) return new Date(input.getTime())
  const date = new Date(input)
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid date input: ${String(input)}`)
  }
  return date
}

function parseTleInput(input: string | string[] | TleInput): TleInput {
  if (typeof input === 'object' && !Array.isArray(input)) {
    const line1 = input.line1?.trim()
    const line2 = input.line2?.trim()
    if (!line1 || !line2) throw new Error('TLE line1/line2 is required')
    return { name: input.name?.trim(), line1, line2 }
  }

  const lines = (Array.isArray(input) ? input : input.split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length < 2) throw new Error('TLE requires at least 2 lines')
  if (lines.length === 2) return { line1: lines[0]!, line2: lines[1]! }

  return { name: lines[0], line1: lines[1]!, line2: lines[2]! }
}

function parseTleEpoch(line1: string) {
  const year2 = Number(line1.slice(18, 20).trim())
  const dayOfYear = Number(line1.slice(20, 32).trim())
  if (!Number.isFinite(year2) || !Number.isFinite(dayOfYear)) {
    throw new Error('Failed to parse TLE epoch')
  }

  const year = year2 >= 57 ? 1900 + year2 : 2000 + year2
  const startOfYear = Date.UTC(year, 0, 1, 0, 0, 0, 0)
  return new Date(startOfYear + (dayOfYear - 1) * MILLISECONDS_PER_DAY)
}

function parseTle(input: string | string[] | TleInput): ParsedTle {
  const { name, line1, line2 } = parseTleInput(input)

  if (!line1.startsWith('1 ') || !line2.startsWith('2 ')) {
    throw new Error('TLE format invalid: line1 must start with "1 ", line2 must start with "2 "')
  }

  const inclinationDeg = Number(line2.slice(8, 16).trim())
  const raanDeg = Number(line2.slice(17, 25).trim())
  const eccentricity = Number(`0.${line2.slice(26, 33).trim()}`)
  const argPerigeeDeg = Number(line2.slice(34, 42).trim())
  const meanAnomalyDeg = Number(line2.slice(43, 51).trim())
  const meanMotionRevPerDay = Number(line2.slice(52, 63).trim())

  if (
    !Number.isFinite(inclinationDeg) ||
    !Number.isFinite(raanDeg) ||
    !Number.isFinite(eccentricity) ||
    !Number.isFinite(argPerigeeDeg) ||
    !Number.isFinite(meanAnomalyDeg) ||
    !Number.isFinite(meanMotionRevPerDay)
  ) {
    throw new Error('Failed to parse orbital elements from TLE line2')
  }

  if (eccentricity < 0 || eccentricity >= 1) {
    throw new Error(`Unsupported eccentricity from TLE: ${eccentricity}`)
  }

  const epoch = parseTleEpoch(line1)
  const meanMotionRadPerSecond = (meanMotionRevPerDay * TWO_PI) / SECONDS_PER_DAY
  const semiMajorAxisMeters = Math.cbrt(EARTH_MU / (meanMotionRadPerSecond ** 2))

  return {
    name,
    line1,
    line2,
    epoch,
    inclinationRad: Cesium.Math.toRadians(inclinationDeg),
    raanRad: Cesium.Math.toRadians(raanDeg),
    eccentricity,
    argPerigeeRad: Cesium.Math.toRadians(argPerigeeDeg),
    meanAnomalyRad: Cesium.Math.toRadians(meanAnomalyDeg),
    meanMotionRadPerSecond,
    semiMajorAxisMeters
  }
}

function solveKeplerEquation(meanAnomalyRad: number, eccentricity: number) {
  let eccentricAnomaly = eccentricity < 0.8 ? meanAnomalyRad : Math.PI
  for (let i = 0; i < KEPLER_MAX_ITER; i++) {
    const sinE = Math.sin(eccentricAnomaly)
    const cosE = Math.cos(eccentricAnomaly)
    const delta = (eccentricAnomaly - eccentricity * sinE - meanAnomalyRad) / (1 - eccentricity * cosE)
    eccentricAnomaly -= delta
    if (Math.abs(delta) < KEPLER_EPSILON) break
  }
  return eccentricAnomaly
}

function gmstRadians(date: Date) {
  const julianDate = date.getTime() / MILLISECONDS_PER_DAY + JULIAN_DATE_UNIX_EPOCH
  const t = (julianDate - JULIAN_DATE_J2000) / 36525
  const gmstDeg =
    280.46061837 +
    360.98564736629 * (julianDate - JULIAN_DATE_J2000) +
    0.000387933 * t * t -
    (t * t * t) / 38710000
  return Cesium.Math.toRadians((((gmstDeg % 360) + 360) % 360))
}

function eciToEcef(eci: Cesium.Cartesian3, gmstRad: number) {
  const cosTheta = Math.cos(gmstRad)
  const sinTheta = Math.sin(gmstRad)
  const x = cosTheta * eci.x + sinTheta * eci.y
  const y = -sinTheta * eci.x + cosTheta * eci.y
  const z = eci.z
  return new Cesium.Cartesian3(x, y, z)
}

function computeSatellitePositionEcef(tle: ParsedTle, time: Date) {
  const deltaSeconds = (time.getTime() - tle.epoch.getTime()) / 1000
  const meanAnomaly = normalizeRadians(tle.meanAnomalyRad + tle.meanMotionRadPerSecond * deltaSeconds)
  const eccentricAnomaly = solveKeplerEquation(meanAnomaly, tle.eccentricity)

  const cosE = Math.cos(eccentricAnomaly)
  const sinE = Math.sin(eccentricAnomaly)
  const sqrtOneMinusESq = Math.sqrt(1 - tle.eccentricity * tle.eccentricity)

  const xOrbital = tle.semiMajorAxisMeters * (cosE - tle.eccentricity)
  const yOrbital = tle.semiMajorAxisMeters * sqrtOneMinusESq * sinE

  const cosOmega = Math.cos(tle.raanRad)
  const sinOmega = Math.sin(tle.raanRad)
  const cosI = Math.cos(tle.inclinationRad)
  const sinI = Math.sin(tle.inclinationRad)
  const cosW = Math.cos(tle.argPerigeeRad)
  const sinW = Math.sin(tle.argPerigeeRad)

  const xEci =
    xOrbital * (cosOmega * cosW - sinOmega * sinW * cosI) -
    yOrbital * (cosOmega * sinW + sinOmega * cosW * cosI)
  const yEci =
    xOrbital * (sinOmega * cosW + cosOmega * sinW * cosI) +
    yOrbital * (cosOmega * cosW * cosI - sinOmega * sinW)
  const zEci = xOrbital * (sinW * sinI) + yOrbital * (cosW * sinI)

  const eci = new Cesium.Cartesian3(xEci, yEci, zEci)
  return eciToEcef(eci, gmstRadians(time))
}

function toNadirPoint(tle: ParsedTle, time: Date): NadirTrackPoint {
  const satelliteEcef = computeSatellitePositionEcef(tle, time)
  const cartographic = Cesium.Cartographic.fromCartesian(satelliteEcef)
  if (!cartographic) throw new Error('Failed to convert ECEF to cartographic position')

  return {
    time,
    longitude: normalizeLongitude(Cesium.Math.toDegrees(cartographic.longitude)),
    latitude: Cesium.Math.toDegrees(cartographic.latitude),
    satelliteHeightMeters: cartographic.height
  }
}

function closeRing(points: LngLat[]) {
  if (points.length === 0) return points
  const first = points[0]!
  const last = points[points.length - 1]!
  if (Math.abs(first[0] - last[0]) <= EPS && Math.abs(first[1] - last[1]) <= EPS) return points
  return [...points, first]
}

function stripClosedPoint(points: LngLat[]) {
  if (points.length <= 1) return points
  const first = points[0]!
  const last = points[points.length - 1]!
  if (Math.abs(first[0] - last[0]) <= EPS && Math.abs(first[1] - last[1]) <= EPS) return points.slice(0, -1)
  return points
}

function toDegreesArray(points: LngLat[]) {
  const out: number[] = []
  for (const [lon, lat] of points) out.push(lon, lat)
  return out
}

function splitLineByDateLine(coordinates: LngLat[]) {
  if (coordinates.length < 2) return coordinates.length === 0 ? [] : [coordinates.slice()]

  const segments: LngLat[][] = []
  let currentSegment: LngLat[] = [coordinates[0]!]

  for (let i = 1; i < coordinates.length; i++) {
    const [lon1, lat1] = coordinates[i - 1]!
    const [lon2, lat2] = coordinates[i]!
    const delta = lon2 - lon1

    if (Math.abs(delta) <= 180) {
      currentSegment.push([lon2, lat2])
      continue
    }

    const adjustedLon2 = delta > 180 ? lon2 - 360 : lon2 + 360
    const boundary = delta > 180 ? -180 : 180
    const t = (boundary - lon1) / (adjustedLon2 - lon1)
    const ratio = Math.min(1, Math.max(0, t))
    const crossingLat = lat1 + (lat2 - lat1) * ratio
    const crossingPoint: LngLat = [boundary, crossingLat]
    const oppositePoint: LngLat = [boundary === 180 ? -180 : 180, crossingLat]

    currentSegment.push(crossingPoint)
    if (currentSegment.length >= 2) segments.push(currentSegment)
    currentSegment = [oppositePoint, [lon2, lat2]]
  }

  if (currentSegment.length >= 2) segments.push(currentSegment)
  return segments
}

function toLineSegments(input: NadirTrackResult | LngLat[]) {
  if (Array.isArray(input)) return splitLineByDateLine(input)
  if (input.lineSegments && input.lineSegments.length > 0) return input.lineSegments
  return splitLineByDateLine(input.lineCoordinates)
}

function mergePolygonGeometries(features: Feature<PolygonLike>[]): Feature<PolygonLike> {
  if (features.length === 0) throw new Error('No polygon geometries to merge')
  if (features.length === 1) return features[0]!

  const multiCoordinates: Position[][][] = []
  features.forEach((feature) => {
    const geom = feature.geometry
    if (geom.type === 'Polygon') {
      multiCoordinates.push(geom.coordinates)
      return
    }
    multiCoordinates.push(...geom.coordinates)
  })

  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'MultiPolygon',
      coordinates: multiCoordinates
    }
  }
}

function buildPolygonHierarchy(rings: LngLat[][]) {
  const outerRing = rings[0]
  if (!outerRing || outerRing.length < 4) return null

  const outer = Cesium.Cartesian3.fromDegreesArray(toDegreesArray(stripClosedPoint(outerRing)))
  const holes = rings
    .slice(1)
    .map((holeRing) => {
      if (holeRing.length < 4) return null
      const hole = Cesium.Cartesian3.fromDegreesArray(toDegreesArray(stripClosedPoint(holeRing)))
      return new Cesium.PolygonHierarchy(hole)
    })
    .filter((hole): hole is Cesium.PolygonHierarchy => hole !== null)

  return new Cesium.PolygonHierarchy(outer, holes)
}

function geometryToRings(geometry: PolygonLike): LngLat[][][] {
  if (geometry.type === 'Polygon') {
    return [geometry.coordinates.map((ring) => ring.map((coord) => [coord[0]!, coord[1]!] as LngLat))]
  }
  return geometry.coordinates.map((polygonRings) =>
    polygonRings.map((ring) => ring.map((coord) => [coord[0]!, coord[1]!] as LngLat))
  )
}

function formatNumber(value: number, precision: number) {
  const fixed = value.toFixed(Math.max(0, precision))
  const normalized = fixed.replace(/(?:\.0+|(\.\d+?)0+)$/, '$1')
  return normalized === '-0' ? '0' : normalized
}

function ringToWktText(ring: Position[], precision: number) {
  return ring
    .map((coord) => `${formatNumber(coord[0]!, precision)} ${formatNumber(coord[1]!, precision)}`)
    .join(', ')
}

function geometryToWkt(geometry: PolygonLike, precision = 8) {
  if (geometry.type === 'Polygon') {
    const rings = geometry.coordinates.map((ring) => `(${ringToWktText(ring, precision)})`).join(', ')
    return `POLYGON (${rings})`
  }
  const polygons = geometry.coordinates
    .map((poly) => `(${poly.map((ring) => `(${ringToWktText(ring, precision)})`).join(', ')})`)
    .join(', ')
  return `MULTIPOLYGON (${polygons})`
}

export function useNadirPointDir(getViewer: () => Cesium.Viewer | null | undefined) {
  const renderedIds = new Set<string>()
  const renderGroupMap = new Map<string, string[]>()

  const trackGroupId = 'nadir-track'
  const bufferGroupId = 'nadir-track-buffer'

  const clearGroup = (id: string) => {
    const viewer = getViewer()
    if (!viewer) return false

    const ids = renderGroupMap.get(id) ?? [id]
    let removed = false
    ids.forEach((entityId) => {
      if (viewer.entities.removeById(entityId)) {
        removed = true
        renderedIds.delete(entityId)
      }
    })
    renderGroupMap.delete(id)
    if (removed) viewer.scene.requestRender()
    return removed
  }

  const computeNadirTrack = (
    tleInput: string | string[] | TleInput,
    options: ComputeNadirTrackOptions = {}
  ): NadirTrackResult => {
    const tle = parseTle(tleInput)
    const now = new Date()
    const startTime = parseDateInput(options.startTime, now)

    const stepSeconds = options.stepSeconds ?? DEFAULT_STEP_SECONDS
    if (!Number.isFinite(stepSeconds) || stepSeconds <= 0) {
      throw new Error('stepSeconds must be a positive number')
    }

    const endTime = options.endTime
      ? parseDateInput(options.endTime, now)
      : new Date(
          startTime.getTime() +
            ((options.durationSeconds ??
              (options.durationMinutes ?? DEFAULT_DURATION_MINUTES) * 60) *
              1000)
        )

    if (endTime.getTime() <= startTime.getTime()) {
      throw new Error('endTime must be later than startTime')
    }

    const maxPoints = options.maxPoints ?? DEFAULT_MAX_POINTS
    const expectedPoints = Math.floor((endTime.getTime() - startTime.getTime()) / (stepSeconds * 1000)) + 1
    if (expectedPoints > maxPoints) {
      throw new Error(`point count ${expectedPoints} exceeds maxPoints ${maxPoints}`)
    }

    const points: NadirTrackPoint[] = []
    for (let ms = startTime.getTime(); ms <= endTime.getTime(); ms += stepSeconds * 1000) {
      points.push(toNadirPoint(tle, new Date(ms)))
    }

    if (points.length < 2) {
      throw new Error('Not enough points generated. Increase duration or decrease stepSeconds.')
    }

    const lineCoordinates: LngLat[] = points.map((point) => [
      normalizeLongitude(point.longitude),
      point.latitude
    ])
    const lineSegments = splitLineByDateLine(lineCoordinates)
    if (lineSegments.length === 0) {
      throw new Error('Failed to build line segments for nadir track')
    }
    const lineFeatures = lineSegments.map((segment) => lineString(segment) as Feature<LineString>)
    const lineFeature = lineFeatures[0]!

    return {
      tle,
      startTime,
      endTime,
      stepSeconds,
      points,
      lineCoordinates,
      lineSegments,
      lineFeatures,
      lineFeature
    }
  }

  const computeTrackBuffer = (
    trackOrCoordinates: NadirTrackResult | LngLat[],
    options: TrackBufferOptions
  ): TrackBufferResult => {
    const units = options.units ?? 'meters'
    const distance = options.distance
    if (!Number.isFinite(distance) || distance <= 0) {
      throw new Error('buffer distance must be a positive number')
    }

    const segments = toLineSegments(trackOrCoordinates).filter((segment) => segment.length >= 2)
    if (segments.length === 0) {
      throw new Error('At least 2 points are required to compute buffer')
    }

    const distanceKm = units === 'meters' ? distance / 1000 : distance
    const polygonFeatures: Feature<PolygonLike>[] = []
    const collectBufferedFeature = (feature: Feature) => {
      const geometry = feature.geometry as PolygonLike | null
      if (!geometry) return
      if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return
      polygonFeatures.push(feature as Feature<PolygonLike>)
    }

    segments.forEach((segment) => {
      const line = lineString(segment) as Feature<LineString>
      const buffered = turfBuffer(line, distanceKm, {
        units: 'kilometers',
        steps: options.steps ?? 32
      })
      if (!buffered) return
      if (buffered.type === 'FeatureCollection') {
        buffered.features.forEach((feature) => collectBufferedFeature(feature as Feature))
        return
      }
      collectBufferedFeature(buffered as Feature)
    })

    if (polygonFeatures.length === 0) {
      throw new Error('Failed to compute buffer geometry')
    }

    const mergedFeature = mergePolygonGeometries(polygonFeatures)
    const geometry = mergedFeature.geometry
    return {
      distance,
      units,
      feature: mergedFeature,
      geometry,
      rings: geometryToRings(geometry),
      wkt: geometryToWkt(geometry, options.precision ?? 8)
    }
  }

  const renderNadirTrack = (
    trackOrCoordinates: NadirTrackResult | LngLat[],
    options: RenderNadirTrackOptions = {}
  ) => {
    const viewer = getViewer()
    if (!viewer) return null

    const id = options.id ?? trackGroupId
    const segments = toLineSegments(trackOrCoordinates).filter((segment) => segment.length >= 2)
    if (segments.length === 0) return null

    clearGroup(id)

    const entities = segments.map((segment, index) => {
      const entityId = segments.length === 1 ? id : `${id}-${index + 1}`
      return viewer.entities.add({
        id: entityId,
        name: 'nadir-track',
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(toDegreesArray(segment)),
          width: options.width ?? 2,
          material: options.color ?? Cesium.Color.CYAN,
          clampToGround: options.clampToGround ?? true,
          arcType: options.arcType ?? Cesium.ArcType.GEODESIC
        }
      })
    })

    const entityIds = entities
      .map((entity) => (typeof entity.id === 'string' ? entity.id : null))
      .filter((entityId): entityId is string => entityId !== null)
    if (entityIds.length > 0) {
      entityIds.forEach((entityId) => renderedIds.add(entityId))
      renderGroupMap.set(id, entityIds)
    }

    if ((options.zoomTo ?? false) && entities.length > 0) viewer.flyTo(entities, { duration: 1.2 })
    viewer.scene.requestRender()
    return entities.length === 1 ? entities[0] : entities
  }

  const renderTrackBuffer = (
    bufferResult: TrackBufferResult,
    options: RenderTrackBufferOptions = {}
  ) => {
    const viewer = getViewer()
    if (!viewer) return null

    const id = options.id ?? bufferGroupId
    clearGroup(id)

    const entityIds: string[] = []
    const entities: Cesium.Entity[] = []
    bufferResult.rings.forEach((rings, index) => {
      const validRings = rings
        .map((ring) => closeRing(ring))
        .filter((ring) => ring.length >= 4)
      if (validRings.length === 0) return

      const hierarchy = buildPolygonHierarchy(validRings)
      if (!hierarchy) return

      const entityId = bufferResult.rings.length === 1 ? id : `${id}-${index + 1}`
      const entity = viewer.entities.add({
        id: entityId,
        name: 'nadir-track-buffer',
        polygon: {
          hierarchy,
          material: options.fillColor ?? Cesium.Color.CYAN.withAlpha(0.25),
          outline: true,
          outlineColor: options.outlineColor ?? Cesium.Color.CYAN,
          outlineWidth: options.outlineWidth ?? 2,
          ...(options.clampToGround ?? true
            ? { height: 0, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND }
            : {})
        }
      })

      entities.push(entity)
      entityIds.push(entityId)
      renderedIds.add(entityId)
    })

    if (entityIds.length > 0) renderGroupMap.set(id, entityIds)
    if ((options.zoomTo ?? false) && entities.length > 0) viewer.flyTo(entities, { duration: 1.2 })
    viewer.scene.requestRender()

    if (entities.length === 0) return null
    return entities.length === 1 ? entities[0] : entities
  }

  const computeRenderTrack = (
    tleInput: string | string[] | TleInput,
    options: ComputeNadirTrackOptions & RenderNadirTrackOptions = {}
  ) => {
    const track = computeNadirTrack(tleInput, options)
    const entity = renderNadirTrack(track, options)
    return { track, entity }
  }

  const computeRenderTrackBuffer = (
    trackOrCoordinates: NadirTrackResult | LngLat[],
    options: TrackBufferOptions & RenderTrackBufferOptions
  ) => {
    const bufferResult = computeTrackBuffer(trackOrCoordinates, options)
    const entity = renderTrackBuffer(bufferResult, options)
    return { bufferResult, entity }
  }

  const clearNadirTrack = (id = trackGroupId) => clearGroup(id)
  const clearNadirBuffer = (id = bufferGroupId) => clearGroup(id)

  const clearAllNadirGraphics = () => {
    const viewer = getViewer()
    if (!viewer) return
    renderedIds.forEach((id) => viewer.entities.removeById(id))
    renderedIds.clear()
    renderGroupMap.clear()
    viewer.scene.requestRender()
  }

  return {
    parseTle,
    computeNadirTrack,
    computeTrackBuffer,
    renderNadirTrack,
    renderTrackBuffer,
    computeRenderTrack,
    computeRenderTrackBuffer,
    clearNadirTrack,
    clearNadirBuffer,
    clearAllNadirGraphics
  }
}

export const useNadirPointDirection = useNadirPointDir

export type GeoJsonPosition = [number, number] | [number, number, number]
export type GeoJsonRing = GeoJsonPosition[]
export type GeoJsonPolygon = GeoJsonRing[]

export type UnknownRecord = Record<string, unknown>

export interface GeoJsonFeature {
  type: 'Feature'
  id?: string | number
  properties?: UnknownRecord | null
  geometry?: {
    type: string
    coordinates: unknown
  } | null
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection'
  features: GeoJsonFeature[]
}

export interface AdministrativeRegion {
  id: string
  name: string
  properties: UnknownRecord
  value: number | null
  polygons: GeoJsonPolygon[]
  feature: GeoJsonFeature
}

export interface RegionLabelPosition {
  lon: number
  lat: number
}

export interface HeightNormalizeOptions {
  minValue: number
  maxValue: number
  minHeight: number
  maxHeight: number
  fallbackHeight?: number
}

export interface NormalizeAdministrativeOptions {
  heightProperty?: string
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function isPosition(value: unknown): value is GeoJsonPosition {
  return Array.isArray(value)
    && value.length >= 2
    && typeof value[0] === 'number'
    && typeof value[1] === 'number'
    && Number.isFinite(value[0])
    && Number.isFinite(value[1])
}

function normalizeRing(value: unknown): GeoJsonRing | null {
  if (!Array.isArray(value)) return null
  const ring = value.filter(isPosition)
  return ring.length >= 4 ? ring : null
}

function normalizePolygon(value: unknown): GeoJsonPolygon | null {
  if (!Array.isArray(value)) return null
  const rings = value
    .map((ring) => normalizeRing(ring))
    .filter((ring): ring is GeoJsonRing => ring !== null)
  return rings.length > 0 ? rings : null
}

function normalizeFeature(input: unknown): GeoJsonFeature[] {
  if (!isRecord(input)) return []
  if (input.type === 'FeatureCollection' && Array.isArray(input.features)) {
    return input.features.filter((feature): feature is GeoJsonFeature => isRecord(feature) && feature.type === 'Feature')
  }
  if (input.type === 'Feature') return [input as unknown as GeoJsonFeature]
  if (typeof input.type === 'string' && 'coordinates' in input) {
    return [{ type: 'Feature', properties: {}, geometry: input as GeoJsonFeature['geometry'] }]
  }
  return []
}

function resolveFeatureId(feature: GeoJsonFeature, properties: UnknownRecord, index: number) {
  const candidates = [feature.id, properties.id, properties.code, properties.adcode, properties.adCode]
  const found = candidates.find((value) => value !== undefined && value !== null && String(value).trim() !== '')
  return found === undefined ? `region-${index + 1}` : String(found)
}

function resolveFeatureName(properties: UnknownRecord, id: string) {
  const candidates = [properties.name, properties.NAME, properties.fullName, properties.fullname]
  const found = candidates.find((value) => typeof value === 'string' && value.trim() !== '')
  return typeof found === 'string' ? found : id
}

export function normalizeHeightValue(value: number, options: HeightNormalizeOptions) {
  const fallbackHeight = options.fallbackHeight ?? options.minHeight
  if (!Number.isFinite(value) || !Number.isFinite(options.minValue) || !Number.isFinite(options.maxValue)) {
    return fallbackHeight
  }
  if (options.maxValue <= options.minValue) return fallbackHeight

  const ratio = Math.max(0, Math.min(1, (value - options.minValue) / (options.maxValue - options.minValue)))
  return options.minHeight + (options.maxHeight - options.minHeight) * ratio
}

export function normalizeAdministrativeFeatures(
  geojson: unknown,
  options: NormalizeAdministrativeOptions = {}
): AdministrativeRegion[] {
  const heightProperty = options.heightProperty ?? 'value'

  return normalizeFeature(geojson)
    .map((feature, index) => {
      const geometry = feature.geometry
      if (!geometry) return null

      const properties = isRecord(feature.properties) ? { ...feature.properties } : {}
      const id = resolveFeatureId(feature, properties, index)
      const name = resolveFeatureName(properties, id)
      const value = toFiniteNumber(properties[heightProperty])

      let polygons: GeoJsonPolygon[] = []
      if (geometry.type === 'Polygon') {
        const polygon = normalizePolygon(geometry.coordinates)
        if (polygon) polygons = [polygon]
      } else if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
        polygons = geometry.coordinates
          .map((polygon) => normalizePolygon(polygon))
          .filter((polygon): polygon is GeoJsonPolygon => polygon !== null)
      }

      if (polygons.length === 0) return null
      return { id, name, properties, value, polygons, feature }
    })
    .filter((region): region is AdministrativeRegion => region !== null)
}

export function mergeRegionValues(
  regions: AdministrativeRegion[],
  valuesByRegionId: Record<string, number>,
  heightProperty = 'value'
): AdministrativeRegion[] {
  return regions.map((region) => {
    if (!Object.prototype.hasOwnProperty.call(valuesByRegionId, region.id)) return region
    const nextValue = valuesByRegionId[region.id]
    return {
      ...region,
      value: nextValue,
      properties: {
        ...region.properties,
        [heightProperty]: nextValue
      }
    }
  })
}

function getLngLatFromProperty(value: unknown): RegionLabelPosition | null {
  if (!Array.isArray(value) || value.length < 2) return null
  const lon = value[0]
  const lat = value[1]
  if (typeof lon !== 'number' || typeof lat !== 'number') return null
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  return { lon, lat }
}

export function getRegionLabelPosition(region: AdministrativeRegion): RegionLabelPosition | null {
  const preferred = getLngLatFromProperty(region.properties.centroid)
    ?? getLngLatFromProperty(region.properties.center)
  if (preferred) return preferred

  const positions = region.polygons.flatMap((polygon) => polygon[0] ?? [])
  if (positions.length === 0) return null

  let west = Infinity
  let east = -Infinity
  let south = Infinity
  let north = -Infinity

  positions.forEach(([lon, lat]) => {
    west = Math.min(west, lon)
    east = Math.max(east, lon)
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  })

  if (!Number.isFinite(west) || !Number.isFinite(east) || !Number.isFinite(south) || !Number.isFinite(north)) {
    return null
  }

  return {
    lon: (west + east) / 2,
    lat: (south + north) / 2
  }
}

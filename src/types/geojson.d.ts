declare module 'geojson' {
  export type Position = number[]

  export interface Geometry {
    type: string
    coordinates?: unknown
  }

  export interface LineString {
    type: 'LineString'
    coordinates: Position[]
  }

  export interface Polygon {
    type: 'Polygon'
    coordinates: Position[][]
  }

  export interface MultiPolygon {
    type: 'MultiPolygon'
    coordinates: Position[][][]
  }

  export type GeoJsonProperties = Record<string, unknown> | null

  export interface Feature<G = Geometry, P = GeoJsonProperties> {
    type: 'Feature'
    geometry: G
    properties: P
  }

  export interface FeatureCollection<G = Geometry, P = GeoJsonProperties> {
    type: 'FeatureCollection'
    features: Array<Feature<G, P>>
  }
}

import * as Cesium from 'cesium'
import {
  getRegionLabelPosition,
  mergeRegionValues,
  normalizeAdministrativeFeatures,
  normalizeHeightValue,
  type AdministrativeRegion,
  type GeoJsonFeature,
  type GeoJsonFeatureCollection,
  type GeoJsonPolygon,
  type GeoJsonRing,
  type UnknownRecord
} from './useCesiumAdministrativePieMap.logic'

export {
  mergeRegionValues,
  normalizeAdministrativeFeatures,
  normalizeHeightValue,
  getRegionLabelPosition
} from './useCesiumAdministrativePieMap.logic'

export type {
  AdministrativeRegion,
  GeoJsonFeature,
  GeoJsonFeatureCollection,
  GeoJsonPolygon,
  GeoJsonPosition,
  GeoJsonRing,
  HeightNormalizeOptions,
  NormalizeAdministrativeOptions
} from './useCesiumAdministrativePieMap.logic'

export interface AdministrativePieRegionPayload {
  layerId: string
  id: string
  name: string
  properties: UnknownRecord
  value: number | null
  entity: Cesium.Entity
  feature: GeoJsonFeature
}

export interface AdministrativePieMapOptions {
  heightProperty?: string
  minHeight?: number
  maxHeight?: number
  baseHeight?: number
  fallbackHeight?: number
  hoverLiftHeight?: number
  fillColor?: Cesium.Color
  hoverFillColor?: Cesium.Color
  selectedFillColor?: Cesium.Color
  outlineColor?: Cesium.Color
  hoverOutlineColor?: Cesium.Color
  selectedOutlineColor?: Cesium.Color
  outlineWidth?: number
  hoverOutlineWidth?: number
  showLabels?: boolean
  labelProperty?: string
  labelFont?: string
  labelColor?: Cesium.Color
  labelHoverColor?: Cesium.Color
  labelSelectedColor?: Cesium.Color
  labelOutlineColor?: Cesium.Color
  labelBackgroundColor?: Cesium.Color
  labelHeightOffset?: number
  labelScale?: number
  labelHoverScale?: number
  labelFormatter?: (region: AdministrativeRegion) => string
  enableTiandituImagery?: boolean
  tiandituToken?: string
  enableTerrain?: boolean
  terrainProviderType?: 'ion' | 'url'
  terrainUrl?: string
  ionAccessToken?: string
  flyTo?: boolean
  onRegionClick?: (region: AdministrativePieRegionPayload) => void
}

interface RegionEntityState {
  region: AdministrativeRegion
  polygonEntities: Cesium.Entity[]
  outlineEntities: Cesium.Entity[]
  labelEntities: Cesium.Entity[]
  height: number
}

interface LayerState {
  id: string
  regions: AdministrativeRegion[]
  regionMap: Map<string, RegionEntityState>
  entityRegionMap: Map<string, string>
  entities: Cesium.Entity[]
  imageryLayers: Cesium.ImageryLayer[]
  options: Required<Omit<AdministrativePieMapOptions, 'onRegionClick' | 'terrainUrl' | 'tiandituToken' | 'ionAccessToken' | 'labelFormatter'>> & {
    onRegionClick?: (region: AdministrativePieRegionPayload) => void
    terrainUrl?: string
    tiandituToken?: string
    ionAccessToken?: string
    labelFormatter?: (region: AdministrativeRegion) => string
  }
  selectedRegionId: string | null
}

const DEFAULT_TERRAIN_URL = 'https://assets.agi.com/stk-terrain/world'

function getHeightStats(regions: AdministrativeRegion[], fallbackValue = 0) {
  const values = regions
    .map((region) => region.value)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (values.length === 0) return { minValue: fallbackValue, maxValue: fallbackValue }
  return {
    minValue: Math.min(...values),
    maxValue: Math.max(...values)
  }
}

function toDegreesArray(ring: GeoJsonRing) {
  const points: number[] = []
  ring.forEach(([lon, lat]) => {
    points.push(lon, lat)
  })
  return points
}

function buildPolygonHierarchy(polygon: GeoJsonPolygon) {
  const outerRing = polygon[0]
  if (!outerRing) return null

  const outer = Cesium.Cartesian3.fromDegreesArray(toDegreesArray(outerRing))
  const holes = polygon
    .slice(1)
    .map((ring) => new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(toDegreesArray(ring))))

  return new Cesium.PolygonHierarchy(outer, holes)
}

function createColorProperty(color: Cesium.Color) {
  return new Cesium.ColorMaterialProperty(color)
}

function createConstant(value: unknown) {
  return new Cesium.ConstantProperty(value)
}

function getDefaultOptions(options: AdministrativePieMapOptions = {}): LayerState['options'] {
  return {
    heightProperty: options.heightProperty ?? 'value',
    minHeight: options.minHeight ?? 1200,
    maxHeight: options.maxHeight ?? 12000,
    baseHeight: options.baseHeight ?? 0,
    fallbackHeight: options.fallbackHeight ?? 2600,
    hoverLiftHeight: options.hoverLiftHeight ?? 900,
    fillColor: options.fillColor ?? Cesium.Color.fromCssColorString('#16b8d4').withAlpha(0.58),
    hoverFillColor: options.hoverFillColor ?? Cesium.Color.fromCssColorString('#54f0ff').withAlpha(0.78),
    selectedFillColor: options.selectedFillColor ?? Cesium.Color.fromCssColorString('#f7c65f').withAlpha(0.82),
    outlineColor: options.outlineColor ?? Cesium.Color.fromCssColorString('#b9f6ff').withAlpha(0.92),
    hoverOutlineColor: options.hoverOutlineColor ?? Cesium.Color.WHITE,
    selectedOutlineColor: options.selectedOutlineColor ?? Cesium.Color.fromCssColorString('#ffe08a'),
    outlineWidth: options.outlineWidth ?? 2,
    hoverOutlineWidth: options.hoverOutlineWidth ?? 4,
    showLabels: options.showLabels ?? true,
    labelProperty: options.labelProperty ?? 'name',
    labelFont: options.labelFont ?? '700 18px Microsoft YaHei, sans-serif',
    labelColor: options.labelColor ?? Cesium.Color.fromCssColorString('#e9fbff'),
    labelHoverColor: options.labelHoverColor ?? Cesium.Color.fromCssColorString('#59f7ff'),
    labelSelectedColor: options.labelSelectedColor ?? Cesium.Color.fromCssColorString('#ffe58a'),
    labelOutlineColor: options.labelOutlineColor ?? Cesium.Color.fromCssColorString('#02131f'),
    labelBackgroundColor: options.labelBackgroundColor ?? Cesium.Color.fromCssColorString('#062a3a').withAlpha(0.72),
    labelHeightOffset: options.labelHeightOffset ?? 1800,
    labelScale: options.labelScale ?? 1,
    labelHoverScale: options.labelHoverScale ?? 1.18,
    labelFormatter: options.labelFormatter,
    enableTiandituImagery: options.enableTiandituImagery ?? true,
    enableTerrain: options.enableTerrain ?? true,
    terrainProviderType: options.terrainProviderType ?? 'url',
    flyTo: options.flyTo ?? true,
    onRegionClick: options.onRegionClick,
    terrainUrl: options.terrainUrl,
    ionAccessToken: options.ionAccessToken,
    tiandituToken: options.tiandituToken
  }
}

function getRegionLabelText(region: AdministrativeRegion, options: LayerState['options']) {
  if (options.labelFormatter) return options.labelFormatter(region)
  const propertyValue = region.properties[options.labelProperty]
  if (typeof propertyValue === 'string' && propertyValue.trim() !== '') return propertyValue
  if (typeof propertyValue === 'number' && Number.isFinite(propertyValue)) return String(propertyValue)
  return region.name
}

function addLabelEntity(
  viewer: Cesium.Viewer,
  layerId: string,
  region: AdministrativeRegion,
  height: number,
  options: LayerState['options'],
  index: number
) {
  if (!options.showLabels) return null
  const labelPosition = getRegionLabelPosition(region)
  if (!labelPosition) return null

  return viewer.entities.add({
    id: `${layerId}-${region.id}-${index}-label`,
    name: `${region.name}-label`,
    position: Cesium.Cartesian3.fromDegrees(
      labelPosition.lon,
      labelPosition.lat,
      height + options.labelHeightOffset
    ),
    label: {
      text: getRegionLabelText(region, options),
      font: options.labelFont,
      fillColor: options.labelColor,
      outlineColor: options.labelOutlineColor,
      outlineWidth: 5,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      showBackground: true,
      backgroundColor: options.labelBackgroundColor,
      backgroundPadding: new Cesium.Cartesian2(12, 8),
      scale: options.labelScale,
      pixelOffset: new Cesium.Cartesian2(0, -12),
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 500000)
    },
    properties: {
      administrativePieLayerId: layerId,
      administrativePieRegionId: region.id
    }
  })
}

function createTiandituImageryProviders(token = '') {
  const img = new Cesium.UrlTemplateImageryProvider({
    url: `https://t{s}.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}&tk=${token}`,
    subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'],
    maximumLevel: 18
  })
  const label = new Cesium.UrlTemplateImageryProvider({
    url: `https://t{s}.tianditu.gov.cn/cia_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cia&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}&tk=${token}`,
    subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'],
    maximumLevel: 18
  })
  return [img, label]
}

function addPolygonEntities(
  viewer: Cesium.Viewer,
  layerId: string,
  region: AdministrativeRegion,
  height: number,
  options: LayerState['options'],
  index: number
) {
  const polygonEntities: Cesium.Entity[] = []
  const outlineEntities: Cesium.Entity[] = []

  region.polygons.forEach((polygon, polygonIndex) => {
    const hierarchy = buildPolygonHierarchy(polygon)
    const outerRing = polygon[0]
    if (!hierarchy || !outerRing) return

    const entitySuffix = `${layerId}-${region.id}-${index}-${polygonIndex}`
    const polygonEntity = viewer.entities.add({
      id: `${entitySuffix}-surface`,
      name: region.name,
      polygon: {
        hierarchy,
        height: options.baseHeight,
        extrudedHeight: height,
        material: createColorProperty(options.fillColor),
        outline: true,
        outlineColor: options.outlineColor,
        outlineWidth: options.outlineWidth,
        perPositionHeight: false
      },
      properties: {
        administrativePieLayerId: layerId,
        administrativePieRegionId: region.id
      }
    })

    const outlineEntity = viewer.entities.add({
      id: `${entitySuffix}-outline`,
      name: `${region.name}-outline`,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(toDegreesArray(outerRing)),
        width: options.outlineWidth,
        material: createColorProperty(options.outlineColor),
        clampToGround: false,
        arcType: Cesium.ArcType.RHUMB
      },
      properties: {
        administrativePieLayerId: layerId,
        administrativePieRegionId: region.id
      }
    })

    polygonEntities.push(polygonEntity)
    outlineEntities.push(outlineEntity)
  })

  return { polygonEntities, outlineEntities }
}

function setRegionVisual(state: RegionEntityState, options: LayerState['options'], mode: 'normal' | 'hover' | 'selected') {
  const fill = mode === 'selected' ? options.selectedFillColor : mode === 'hover' ? options.hoverFillColor : options.fillColor
  const outline = mode === 'selected' ? options.selectedOutlineColor : mode === 'hover' ? options.hoverOutlineColor : options.outlineColor
  const outlineWidth = mode === 'normal' ? options.outlineWidth : options.hoverOutlineWidth
  const lift = mode === 'hover' ? options.hoverLiftHeight : 0
  const labelColor = mode === 'selected'
    ? options.labelSelectedColor
    : mode === 'hover'
      ? options.labelHoverColor
      : options.labelColor
  const labelScale = mode === 'normal' ? options.labelScale : options.labelHoverScale

  state.polygonEntities.forEach((entity) => {
    if (!entity.polygon) return
    entity.polygon.material = createColorProperty(fill)
    entity.polygon.outlineColor = createConstant(outline)
    entity.polygon.outlineWidth = createConstant(outlineWidth)
    entity.polygon.extrudedHeight = createConstant(state.height + lift)
  })

  state.outlineEntities.forEach((entity) => {
    if (!entity.polyline) return
    entity.polyline.material = createColorProperty(outline)
    entity.polyline.width = createConstant(outlineWidth)
  })

  state.labelEntities.forEach((entity) => {
    if (!entity.label) return
    const labelPosition = getRegionLabelPosition(state.region)
    if (labelPosition) {
      entity.position = new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(
        labelPosition.lon,
        labelPosition.lat,
        state.height + options.labelHeightOffset + lift
      ))
    }
    entity.label.fillColor = createConstant(labelColor)
    entity.label.scale = createConstant(labelScale)
  })
}

export function useCesiumAdministrativePieMap(getViewer: () => Cesium.Viewer | null | undefined) {
  const layerMap = new Map<string, LayerState>()
  let interactionHandler: Cesium.ScreenSpaceEventHandler | null = null
  let hoveredLayerId: string | null = null
  let hoveredRegionId: string | null = null

  const findPickedRegion = (pickedEntity: Cesium.Entity | undefined) => {
    if (!pickedEntity || typeof pickedEntity.id !== 'string') return null

    for (const layer of layerMap.values()) {
      const regionId = layer.entityRegionMap.get(pickedEntity.id)
      if (!regionId) continue
      const state = layer.regionMap.get(regionId)
      if (!state) continue
      return { layer, state, entity: pickedEntity }
    }

    return null
  }

  const clearHover = () => {
    if (!hoveredLayerId || !hoveredRegionId) return
    const layer = layerMap.get(hoveredLayerId)
    const state = layer?.regionMap.get(hoveredRegionId)
    if (layer && state) {
      setRegionVisual(state, layer.options, layer.selectedRegionId === hoveredRegionId ? 'selected' : 'normal')
    }
    hoveredLayerId = null
    hoveredRegionId = null
  }

  const initInteractions = (viewer: Cesium.Viewer) => {
    if (interactionHandler) return
    interactionHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)

    interactionHandler.setInputAction((movement: { endPosition: Cesium.Cartesian2 }) => {
      const pickedObject = viewer.scene.pick(movement.endPosition) as { id?: Cesium.Entity } | undefined
      const picked = findPickedRegion(pickedObject?.id)

      if (!picked) {
        clearHover()
        viewer.scene.canvas.style.cursor = 'default'
        viewer.scene.requestRender()
        return
      }

      if (hoveredLayerId === picked.layer.id && hoveredRegionId === picked.state.region.id) return
      clearHover()
      hoveredLayerId = picked.layer.id
      hoveredRegionId = picked.state.region.id
      setRegionVisual(picked.state, picked.layer.options, 'hover')
      viewer.scene.canvas.style.cursor = 'pointer'
      viewer.scene.requestRender()
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    interactionHandler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      const pickedObject = viewer.scene.pick(movement.position) as { id?: Cesium.Entity } | undefined
      const picked = findPickedRegion(pickedObject?.id)
      if (!picked) return

      if (picked.layer.selectedRegionId && picked.layer.selectedRegionId !== picked.state.region.id) {
        const previous = picked.layer.regionMap.get(picked.layer.selectedRegionId)
        if (previous) setRegionVisual(previous, picked.layer.options, 'normal')
      }

      picked.layer.selectedRegionId = picked.state.region.id
      setRegionVisual(picked.state, picked.layer.options, 'selected')
      viewer.scene.requestRender()

      picked.layer.options.onRegionClick?.({
        layerId: picked.layer.id,
        id: picked.state.region.id,
        name: picked.state.region.name,
        properties: picked.state.region.properties,
        value: picked.state.region.value,
        entity: picked.entity,
        feature: picked.state.region.feature
      })
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
  }

  const applyTerrain = async (viewer: Cesium.Viewer, options: LayerState['options']) => {
    if (!options.enableTerrain) return
    try {
      if (options.ionAccessToken) Cesium.Ion.defaultAccessToken = options.ionAccessToken
      viewer.terrainProvider = options.terrainProviderType === 'ion'
        ? await Cesium.createWorldTerrainAsync()
        : await Cesium.CesiumTerrainProvider.fromUrl(options.terrainUrl ?? DEFAULT_TERRAIN_URL)
    } catch (error) {
      console.warn('行政区厚饼地图地形加载失败，已降级为椭球地形:', error)
      viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider()
    }
  }

  const clearAdministrativePieMap = (layerId: string) => {
    const viewer = getViewer()
    const layer = layerMap.get(layerId)
    if (!viewer || !layer) return false

    layer.entities.forEach((entity) => viewer.entities.remove(entity))
    layer.imageryLayers.forEach((imageryLayer) => viewer.imageryLayers.remove(imageryLayer, false))
    layerMap.delete(layerId)

    if (hoveredLayerId === layerId) {
      hoveredLayerId = null
      hoveredRegionId = null
      viewer.scene.canvas.style.cursor = 'default'
    }

    viewer.scene.requestRender()
    return true
  }

  const addAdministrativePieMap = async (
    layerId: string,
    geojson: GeoJsonFeatureCollection | GeoJsonFeature | unknown,
    options: AdministrativePieMapOptions = {}
  ) => {
    const viewer = getViewer()
    if (!viewer) return []

    clearAdministrativePieMap(layerId)

    const normalizedOptions = getDefaultOptions(options)
    const regions = normalizeAdministrativeFeatures(geojson, { heightProperty: normalizedOptions.heightProperty })
    if (regions.length === 0) return []

    const layer: LayerState = {
      id: layerId,
      regions,
      regionMap: new Map(),
      entityRegionMap: new Map(),
      entities: [],
      imageryLayers: [],
      options: normalizedOptions,
      selectedRegionId: null
    }

    if (normalizedOptions.enableTiandituImagery) {
      createTiandituImageryProviders(normalizedOptions.tiandituToken).forEach((provider) => {
        layer.imageryLayers.push(viewer.imageryLayers.addImageryProvider(provider))
      })
    }

    const stats = getHeightStats(regions)
    regions.forEach((region, index) => {
      const height = normalizeHeightValue(region.value ?? Number.NaN, {
        minValue: stats.minValue,
        maxValue: stats.maxValue,
        minHeight: normalizedOptions.minHeight,
        maxHeight: normalizedOptions.maxHeight,
        fallbackHeight: normalizedOptions.fallbackHeight
      })
      const entities = addPolygonEntities(viewer, layerId, region, height, normalizedOptions, index)
      const labelEntity = addLabelEntity(viewer, layerId, region, height, normalizedOptions, index)
      const state: RegionEntityState = {
        region,
        polygonEntities: entities.polygonEntities,
        outlineEntities: entities.outlineEntities,
        labelEntities: labelEntity ? [labelEntity] : [],
        height
      }
      layer.regionMap.set(region.id, state)
      entities.polygonEntities.concat(entities.outlineEntities, state.labelEntities).forEach((entity) => {
        layer.entities.push(entity)
        if (typeof entity.id === 'string') layer.entityRegionMap.set(entity.id, region.id)
      })
    })

    layerMap.set(layerId, layer)
    initInteractions(viewer)
    await applyTerrain(viewer, normalizedOptions)

    if (normalizedOptions.flyTo && layer.entities.length > 0) {
      await viewer.flyTo(layer.entities, {
        duration: 1.2,
        offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-90), 0)
      })
    }

    viewer.scene.requestRender()
    return layer.entities
  }

  const updateRegionValues = (layerId: string, valuesByRegionId: Record<string, number>) => {
    const viewer = getViewer()
    const layer = layerMap.get(layerId)
    if (!viewer || !layer) return false

    layer.regions = mergeRegionValues(layer.regions, valuesByRegionId, layer.options.heightProperty)
    const stats = getHeightStats(layer.regions)
    layer.regions.forEach((region) => {
      const state = layer.regionMap.get(region.id)
      if (!state) return
      state.region = region
      state.height = normalizeHeightValue(region.value ?? Number.NaN, {
        minValue: stats.minValue,
        maxValue: stats.maxValue,
        minHeight: layer.options.minHeight,
        maxHeight: layer.options.maxHeight,
        fallbackHeight: layer.options.fallbackHeight
      })
      const mode = layer.selectedRegionId === region.id ? 'selected' : 'normal'
      setRegionVisual(state, layer.options, mode)
    })

    viewer.scene.requestRender()
    return true
  }

  const clearAllAdministrativePieMaps = () => {
    Array.from(layerMap.keys()).forEach((layerId) => clearAdministrativePieMap(layerId))
  }

  const destroyAdministrativePieMap = () => {
    clearAllAdministrativePieMaps()
    if (interactionHandler) {
      interactionHandler.destroy()
      interactionHandler = null
    }
    const viewer = getViewer()
    if (viewer) viewer.scene.canvas.style.cursor = 'default'
  }

  return {
    addAdministrativePieMap,
    updateRegionValues,
    clearAdministrativePieMap,
    clearAllAdministrativePieMaps,
    destroyAdministrativePieMap
  }
}

/**
 * Cesium KML 文件加载 Hook
 * - 提供加载 KML 文件的接口 loadKmlFile，支持飞行到数据位置  
 * - 规范化 KML 实体的高度设置，确保正确显示在地形上  normalizeEntityHeight
 * - 提取实体信息（类型、坐标、描述等）供外部使用 extractEntityInfo
 * - 支持移除单个 KML 数据源和清除所有 KML 数据源 removeKml / clearAllKml
 * 
 * @author Nerv
 */
import * as Cesium from 'cesium'

export function useCesiumKml(getViewer: () => any) {
  const kmlDataSources = new Map<string, any>()

  const normalizeEntityHeight = (entity: any) => {
    if (entity.polygon) {
      entity.polygon.perPositionHeight = false
      entity.polygon.height = undefined
      entity.polygon.extrudedHeight = undefined
      entity.polygon.classificationType = Cesium.ClassificationType.TERRAIN
      entity.polygon.zIndex = 10
      entity.polygon.material = Cesium.Color.fromCssColorString('#d17016ff').withAlpha(0.5)
      entity.polygon.outline = true
      entity.polygon.outlineColor = Cesium.Color.fromCssColorString('#2FB5F1')
    }

    if (entity.polyline) {
      entity.polyline.clampToGround = true
      entity.polyline.zIndex = 10
      entity.polyline.depthFailMaterial = entity.polyline.material
      // 颜色和透明度
      entity.polyline.material = Cesium.Color.fromCssColorString('#2FB5F1').withAlpha(0.8)
      // 线宽
      entity.polyline.width = 3
    }

    if (entity.billboard) {
      entity.billboard.heightReference = Cesium.HeightReference.CLAMP_TO_GROUND
      entity.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY
      // entity.billboard.image = '/assets/custom-icon.png'
      // 调整图标大小比例
      // entity.billboard.scale = 1.2
    }

    if (entity.point) {
      entity.point.heightReference = Cesium.HeightReference.CLAMP_TO_GROUND
      entity.point.disableDepthTestDistance = Number.POSITIVE_INFINITY
    }

    if (entity.label) {
      entity.label.heightReference = Cesium.HeightReference.CLAMP_TO_GROUND
      entity.label.disableDepthTestDistance = Number.POSITIVE_INFINITY
    }

    if (entity.model) {
      entity.model.heightReference = Cesium.HeightReference.CLAMP_TO_GROUND
    }
  }

  const getCoordinates = (positions: any[]) => {
    if (!positions || positions.length === 0) return []
    const viewer = getViewer()
    return positions.map((p) => {
      const cartographic = viewer.scene.globe.ellipsoid.cartesianToCartographic(p)
      return [
        Cesium.Math.toDegrees(cartographic.longitude),
        Cesium.Math.toDegrees(cartographic.latitude)
      ]
    })
  }

  const extractEntityInfo = (entity: any) => {
    const time = Cesium.JulianDate.now()
    let type = 'Unknown'
    let coordinates: any[] = []

    if (entity.polygon) {
      type = 'Polygon'
      const hierarchy = entity.polygon.hierarchy.getValue(time)
      if (hierarchy) coordinates = getCoordinates(hierarchy.positions)
    } else if (entity.polyline) {
      type = 'Polyline'
      const positions = entity.polyline.positions.getValue(time)
      if (positions) coordinates = getCoordinates(positions)
    } else if (entity.billboard || entity.point || entity.label || entity.model) {
      type = 'Point'
      const position = entity.position?.getValue(time)
      if (position) coordinates = getCoordinates([position])[0] || []
    }

    return {
      id: entity.id,
      name: entity.name || 'Unnamed',
      description: entity.description ? entity.description.getValue(time) : '',
      type,
      coordinates
    }
  }

  const loadKmlFile = async (file: File, flyTo = true) => {
    const viewer = getViewer()
    if (!viewer) return null

    try {
      const dataSource = await Cesium.KmlDataSource.load(file, {
        camera: viewer.scene.camera,
        canvas: viewer.scene.canvas,
        clampToGround: true
      })

      await viewer.dataSources.add(dataSource)

      // Avoid clamped vectors being visually swallowed by terrain depth testing.
      viewer.scene.globe.depthTestAgainstTerrain = false

      const id = `kml-${Date.now()}`
      kmlDataSources.set(id, dataSource)

      const entityInfoList: any[] = []
      const entities = dataSource.entities.values
      for (const entity of entities) {
        normalizeEntityHeight(entity)
        if (entity.polygon || entity.polyline || entity.billboard || entity.point || entity.label || entity.model) {
          entityInfoList.push(extractEntityInfo(entity))
        }
      }

      if (flyTo) viewer.flyTo(dataSource)
      viewer.scene.requestRender()

      return {
        id,
        fileName: file.name,
        entities: entityInfoList
      }
    } catch (error) {
      console.error('Failed to load KML file:', error)
      throw error
    }
  }

  const removeKml = (id: string) => {
    const viewer = getViewer()
    const dataSource = kmlDataSources.get(id)
    if (viewer && dataSource) {
      viewer.dataSources.remove(dataSource)
      kmlDataSources.delete(id)
      viewer.scene.requestRender()
    }
  }

  const clearAllKml = () => {
    const viewer = getViewer()
    if (!viewer) return
    kmlDataSources.forEach((dataSource) => {
      viewer.dataSources.remove(dataSource)
    })
    kmlDataSources.clear()
    viewer.scene.requestRender()
  }

  return {
    loadKmlFile,
    removeKml,
    clearAllKml
  }
}

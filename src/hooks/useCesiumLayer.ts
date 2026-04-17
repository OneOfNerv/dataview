/**
 * Cesium 图层管理 Hook
 * - 提供添加各种类型图层的接口（XYZ、WMTS、ArcGIS 等） addXYZLayer / addWMTSLayer / addArcGISLayer
 * - 支持图层属性控制（显隐、透明度） setLayerVisibility / setLayerOpacity
 * - 支持图层顺序控制（上移、下移、置顶、置底） moveLayerUp / moveLayerDown / moveLayerToTop / moveLayerToBottom
 * - 提供删除单个图层和清空所有图层的接口 removeLayer / removeAllLayers
 * - 内部使用 Map 结构管理图层，确保按 ID 精准操作，避免重复添加和内存泄漏 
 * 配合 useCesium Hook 获取 Viewer 实例，并在组件销毁时调用 removeAllLayers 释放资源
 * 
 * @author Nerv
 */

import * as Cesium from 'cesium'
export function useCesiumLayer(getViewer: () => any) {
  const layerMap = new Map<string, any>()
  const addLayerToViewer = (id: string, provider: any, index?: number) => {
    const viewer = getViewer()
    if (!viewer) return null
    // 如果已存在同名图层，先移除
    if (layerMap.has(id)) {
      removeLayer(id)
    }
    // 如果传入了 index，则插入到指定层级；否则默认叠加在最顶层
    const layer = viewer.imageryLayers.addImageryProvider(provider, index)
    
    // 存入字典
    layerMap.set(id, layer)
    viewer.scene.requestRender() 
    
    return layer
  }

  // =================添加各种地图服务 =================

  /**
   * 添加 XYZ 瓦片服务 
   */
  const addXYZLayer = (id: string, url: string, options: any = {}) => {
    const { index, ...providerOptions } = options
    const provider = new Cesium.UrlTemplateImageryProvider({
      url,
      maximumLevel: 18,
      ...providerOptions
    })
    return addLayerToViewer(id, provider, index)
  }
/**
   * 添加 特殊水经注 XYZ 瓦片服务 得补零
   */
  const addSJZXYZLayer = (id: string, url: string, options: any = {}) => {
    function zeroPad(num: number, len: number, radix: number ) {
      var str = num.toString(radix || 10).toUpperCase();
      while (str.length < len) {
        str = "0" + str;
      }
      return str;
    }
    const { index, ...providerOptions } = options
    providerOptions.tilingScheme = new Cesium.GeographicTilingScheme()
    const provider = new Cesium.UrlTemplateImageryProvider({
          url,
            customTags: {
        z_m: (imageryProvider: any, x: number, y: number, level: number) => {
          return zeroPad(level + 1, 2, 10)
        },
        x_m: (imageryProvider: any, x: number, y: number, level: number) => {
          return zeroPad(x, 8, 16)
        },
        y_m: (imageryProvider: any, x: number, y: number, level: number) => {
          return zeroPad(y, 8, 16)
        },
      },
      maximumLevel: 18,
      ...providerOptions
    })
    return addLayerToViewer(id, provider, index)
  }
  /**
   * 添加 WMTS 服务 
   */
  const addWMTSLayer = (id: string, options: any) => {
    const { index, ...providerOptions } = options
    const provider = new Cesium.WebMapTileServiceImageryProvider({
      style: 'default',
      format: 'image/jpeg',
      tileMatrixSetID: 'default',
      ...providerOptions // 必须包含 url, layer 等关键参数
    })
    return addLayerToViewer(id, provider, index)
  }

  /**
   * 添加 ArcGIS MapServer 服务
   * ArcGIS Provider 较高版本使用异步加载 (fromUrl)
   */
  const addArcGISLayer = async (id: string, url: string, options: any = {}) => {
    const { index, ...providerOptions } = options
    try {
      const provider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(url, providerOptions)
      return addLayerToViewer(id, provider, index)
    } catch (error) {
      console.error(`ArcGIS 图层 ${id} 加载失败:`, error)
      return null
    }
  }

  // ================= 图层属性控制 =================

  /**
   * 显隐
   */
  const setLayerVisibility = (id: string, isVisible: boolean) => {
    const viewer = getViewer()
    const layer = layerMap.get(id)
    if (layer && viewer) {
      layer.show = isVisible
      viewer.scene.requestRender()
    }
  }

  /**
   * 透明度
   */
  const setLayerOpacity = (id: string, opacity: number) => {
    const viewer = getViewer()
    const layer = layerMap.get(id)
    if (layer && viewer) {
      // 限制范围在 0 ~ 1 之间
      layer.alpha = Math.max(0, Math.min(1, opacity))
      viewer.scene.requestRender()
    }
  }

  // ================= 图层顺序 (Z-Index) 控制 =================

  /**
   * 上移一层
   */
  const moveLayerUp = (id: string) => {
    const viewer = getViewer()
    const layer = layerMap.get(id)
    if (layer && viewer) {
      viewer.imageryLayers.raise(layer)
      viewer.scene.requestRender()
    }
  }

  /**
   * 下移一层
   */
  const moveLayerDown = (id: string) => {
    const viewer = getViewer()
    const layer = layerMap.get(id)
    if (layer && viewer) {
      viewer.imageryLayers.lower(layer)
      viewer.scene.requestRender()
    }
  }

  /**
   * 置于最顶层
   */
  const moveLayerToTop = (id: string) => {
    const viewer = getViewer()
    const layer = layerMap.get(id)
    if (layer && viewer) {
      viewer.imageryLayers.raiseToTop(layer)
      viewer.scene.requestRender()
    }
  }

  /**
   * 置于最底层 (索引 0 是地球基础底图，置底可能会被底图遮盖)
   */
  const moveLayerToBottom = (id: string) => {
    const viewer = getViewer()
    const layer = layerMap.get(id)
    if (layer && viewer) {
      viewer.imageryLayers.lowerToBottom(layer)
      viewer.scene.requestRender()
    }
  }

  // =================删除与清理 =================

  /**
   * 删除指定图层
   */
  const removeLayer = (id: string) => {
    const viewer = getViewer()
    const layer = layerMap.get(id)
    if (layer && viewer) {
      viewer.imageryLayers.remove(layer)
      layerMap.delete(id)
      viewer.scene.requestRender()
    }
  }

  /**
   * 清空由此 Hook 添加的所有图层
   */
  const removeAllLayers = () => {
    const viewer = getViewer()
    if (!viewer) return
    layerMap.forEach((layer) => {
      viewer.imageryLayers.remove(layer)
    })
    layerMap.clear()
    viewer.scene.requestRender()
  }

  return {
    addXYZLayer,
    addWMTSLayer,
    addArcGISLayer,
    setLayerVisibility,
    setLayerOpacity,
    moveLayerUp,
    moveLayerDown,
    moveLayerToTop,
    moveLayerToBottom,
    removeLayer,
    removeAllLayers,
    addSJZXYZLayer
  }
}

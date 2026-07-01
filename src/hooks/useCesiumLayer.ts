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
        z_m: (_imageryProvider: any, _x: number, _y: number, level: number) => {
          return zeroPad(level + 1, 2, 10)
        },
        x_m: (_imageryProvider: any, x: number, _y: number, _level: number) => {
          return zeroPad(x, 8, 16)
        },
        y_m: (_imageryProvider: any, _x: number, y: number, _level: number) => {
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
   * 通用 WMS 服务加载，支持自定义参数（url、layers、parameters 等）
   */
  const addWMSLayer = (id: string, options: any) => {
    const { index, ...providerOptions } = options
    const provider = new Cesium.WebMapServiceImageryProvider({
      ...providerOptions // 必须包含 url, layers 等关键参数
    })
    return addLayerToViewer(id, provider, index)
  }

  /**
   * 添加 UOM 适飞区图层 (CAAC 民航局 WMS 服务)
   * 中国民用航空局无人机运行管理系统 - 适飞空域数据
   *
   * @param codes - 行政区划代码数组，如 ['120000','130000','140000','150000']（华北）
   *                不传则默认加载华北地区适飞区
   *
   * 常用区域代码参考：
   *   华北: 120000,130000,140000,150000
   *   华东: 310000,320000,330000,340000,350000,370000
   *   华南: 440000,450000,460000
   *   华中: 410000,420000,430000
   *   西南: 500000,510000,520000,530000,540000
   *   西北: 610000,620000,630000,640000,650000
   *   东北: 210000,220000,230000
   */
  const addUOMLayer = (id: string, options: any = {}) => {
    const { index, alpha = 0.9, codes, ...restOptions } = options

    // 未传入 codes 时默认华北地区
    const areaCodes: string[] = codes && codes.length > 0
      ? codes
      : ['120000', '130000', '140000', '150000']

    // 按行政区划代码动态构建 layers 和 styles
    const layerList = areaCodes.map((code: string) => `QGSFKYFW:sf${code}`).join(',')
    const styleList = areaCodes.map(() => 'QGSFKYFW:shifeikongyu').join(',')

    const layer = addWMSLayer(id, {
      url: 'https://uom.caac.gov.cn/map/airspace/wms',
      layers: layerList,
      // 指定 Web Mercator 切片方案
      tilingScheme: new Cesium.WebMercatorTilingScheme(),
      parameters: {
        token: '1e4b78fc-06bd-45be-8af7-cabd802ea9a8',
        transparent: true,
        format: 'image/png8',
        styles: styleList,
        version: '1.1.0',
        srs: 'EPSG:3857',
        ...restOptions.parameters
      },
      ...restOptions
    })

    if (layer) {
      const viewer = getViewer()
      layer.alpha = alpha
      viewer?.scene.requestRender()
    }

    return layer
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
    addWMSLayer,
    addArcGISLayer,
    addUOMLayer,
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

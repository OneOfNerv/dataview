import * as Cesium from 'cesium'

export type BasemapType = 'arcgis' | 'osm' | 'gaode_vec' | 'gaode_img' | 'tianditu_img' | 'tianditu_vec'

export function useCesiumBasemap(getViewer: () => any) {
  // 记录当前由添加的底图和注记层
  let currentBaseLayer: any = null
  let currentLabelLayer: any = null

  //天地图，
  const TDT_TK = ''

  const switchBasemap = async (type: BasemapType) => {
    const viewer = getViewer()
    if (!viewer) return

    // 卸载旧底图
    // 如果是第一次切换，清空初始化时自带的第 0 层底图
    if (!currentBaseLayer) {
      const defaultLayer = viewer.imageryLayers.get(0)
      if (defaultLayer) viewer.imageryLayers.remove(defaultLayer)
    } else {
      viewer.imageryLayers.remove(currentBaseLayer)
      currentBaseLayer = null
    }

    // 清理可能存在的旧注记层
    if (currentLabelLayer) {
      viewer.imageryLayers.remove(currentLabelLayer)
      currentLabelLayer = null
    }

    let provider: any = null
    let labelProvider: any = null

    // 根据类型生成对应的 Provider
    switch (type) {
      case 'arcgis':
        // ArcGIS 影像
        provider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
          'https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer'
        )
        break

      case 'osm':
        // OpenStreetMap 
        provider = new Cesium.OpenStreetMapImageryProvider({
          url: 'https://a.tile.openstreetmap.org/'
        })
        break

      case 'gaode_vec':
        // 高德矢量路网地图 
        provider = new Cesium.UrlTemplateImageryProvider({
          url: 'http://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
          subdomains: ['1', '2', '3', '4'],
          maximumLevel: 18,
        })
        break
        
      case 'gaode_img':
        // 高德卫星影像图 
        provider = new Cesium.UrlTemplateImageryProvider({
          url: 'http://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
          subdomains: ['1', '2', '3', '4'],
          maximumLevel: 18,
        })
        break

      case 'tianditu_img':
        // 天地图卫星影像 + 注记 
        provider = new Cesium.WebMapTileServiceImageryProvider({
          url: `http://t{s}.tianditu.gov.cn/img_w/wmts?tk=${TDT_TK}`,
          layer: 'img', style: 'default', format: 'tiles', tileMatrixSetID: 'w',
          subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'], maximumLevel: 18,
        })
        labelProvider = new Cesium.WebMapTileServiceImageryProvider({
          url: `http://t{s}.tianditu.gov.cn/cia_w/wmts?tk=${TDT_TK}`,
          layer: 'cia', style: 'default', format: 'tiles', tileMatrixSetID: 'w',
          subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'], maximumLevel: 18,
        })
        break

      case 'tianditu_vec':
        // 天地图矢量路网 + 注记 
        provider = new Cesium.WebMapTileServiceImageryProvider({
          url: `http://t{s}.tianditu.gov.cn/vec_w/wmts?tk=${TDT_TK}`,
          layer: 'vec', style: 'default', format: 'tiles', tileMatrixSetID: 'w',
          subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'], maximumLevel: 18,
        })
        labelProvider = new Cesium.WebMapTileServiceImageryProvider({
          url: `http://t{s}.tianditu.gov.cn/cva_w/wmts?tk=${TDT_TK}`,
          layer: 'cva', style: 'default', format: 'tiles', tileMatrixSetID: 'w',
          subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'], maximumLevel: 18,
        })
        break
    }

    // 将新底图插入到最底层 (索引 0)
    if (provider) {
      currentBaseLayer = viewer.imageryLayers.addImageryProvider(provider, 0)
    }
    // 如果有注记层，插入到底图之上 (索引 1)
    if (labelProvider) {
      currentLabelLayer = viewer.imageryLayers.addImageryProvider(labelProvider, 1)
    }

    // 触发视图重绘 (开启了 requestRenderMode)
    viewer.scene.requestRender()
  }

  return {
    switchBasemap
  }
}
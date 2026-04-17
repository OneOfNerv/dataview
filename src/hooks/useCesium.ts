/**
 * Cesium 地图初始化 Hook
 * - 初始化 Cesium Viewer 实例，加载底图和地形
 * - 提供获取 Viewer 实例的接口 getViewer
 * - 提供销毁 Viewer 的接口，释放内存 destroyCesium
 * - 使用 markRaw 阻断响应式劫持，避免性能问题 
 * - 开启按需渲染模式，提升性能 
 * 
 * @author Nerv
 */
import * as Cesium from 'cesium'
import { markRaw } from 'vue'

export function useCesium(containerId = 'cesiumContainer') {
  let viewer: any = null

  const initmap = () => {
    // 禁用 Cesium Ion，跳过 token 认证
    Cesium.Ion.defaultAccessToken = undefined as any

    // 天地图影像底图 + 注记
    const TDT_KEY = '079632b1ec7b3f0bdc3dc04309c59b1e'
    const tdtImgProvider = new Cesium.UrlTemplateImageryProvider({
      url: `https://t{s}.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}&tk=${TDT_KEY}`,
      subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'],
      maximumLevel: 18,
    })
    const tdtCiaProvider = new Cesium.UrlTemplateImageryProvider({
      url: `https://t{s}.tianditu.gov.cn/cia_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cia&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}&tk=${TDT_KEY}`,
      subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'],
      maximumLevel: 18,
    })

    // 创建 Viewer 实例
    const  tempViewer =  new Cesium.Viewer(containerId, {
      baseLayer: new Cesium.ImageryLayer(tdtImgProvider),
      baseLayerPicker: false,
      geocoder: false,
      homeButton: true,
      infoBox: false,
      selectionIndicator: false,
      navigationHelpButton: false,
      sceneModePicker: false,
      timeline: false,
      animation: false,
      // 按需渲染
      requestRenderMode: true, 
      maximumRenderTimeChange: Infinity,
    })
     tempViewer.scene.globe.depthTestAgainstTerrain = true
    // 叠加天地图注记图层
    tempViewer.imageryLayers.addImageryProvider(tdtCiaProvider)
    // FPS 显示面板
    tempViewer.scene.debugShowFramesPerSecond = true
    //抗锯齿
    tempViewer.scene.msaaSamples = 4;
    // 阻断响应式劫持
    viewer = markRaw(tempViewer)
  }
  // 对外暴露 viewer 实例
  const getViewer = () => viewer

  // 销毁地图，释放内存
  const destroyCesium = () => {
    if (viewer) {
      viewer.destroy()
      viewer = null
    }
  }

  return { getViewer, initmap, destroyCesium }
}
/**
  * Cesium 地图控制 Hook
  * - 提供缩放、重置、切换 2D/3D 等基本控制功能 
  * - 实时更新地图比例尺、相机位置信息
  * - 实时更新鼠标悬浮位置信息 (经纬度 + 海拔)
  * - 监听相机变化事件，自动更新比例尺和位置信息
  * - 监听鼠标移动事件，实时获取地表坐标（包含地形高度）
  * - 监听帧渲染事件，自定义计算并显示 FPS
  * - 提供销毁函数，移除所有事件监听器，释放资源
  * 配合 useCesium Hook 获取 Viewer 实例，并在组件销毁时调用 destroyControls 释放资源
  * 
 * @author Nerv
 */
import * as Cesium from 'cesium'
import { ref, reactive } from 'vue'
export function useCesiumControls(getViewer: () => any) {
  const scaleText = ref('计算中...')
  const fps = ref(0) 
  
  const cameraPosition = reactive({
    longitude: '0.000000',
    latitude: '0.000000',
    height: '0.00'
  })

  // 鼠标当前悬浮位置信息
  const mousePosition = reactive({
    longitude: '0.000000',
    latitude: '0.000000',
    altitude: '0.00' 
  })

  // 事件句柄缓存，用于销毁
  let cameraChangeListener: any = null
  let mouseHandler: any = null
  let postRenderListener: any = null

  const zoomIn = () => {
    const viewer = getViewer()
    if (!viewer) return
    const cameraHeight = viewer.scene.camera.positionCartographic.height
    viewer.camera.zoomIn(cameraHeight * 0.3)
    viewer.scene.requestRender()
  }

  const zoomOut = () => {
    const viewer = getViewer()
    if (!viewer) return
    const cameraHeight = viewer.scene.camera.positionCartographic.height
    viewer.camera.zoomOut(cameraHeight * 0.3)
    viewer.scene.requestRender()
  }

  const resetHome = () => {
    const viewer = getViewer()
    if (!viewer) return
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(105.0, 35.0, 20000000.0),
      duration: 1.5, 
    })
  }

  const toggle2D3D = () => {
    const viewer = getViewer()
    if (!viewer) return
    if (viewer.scene.mode === Cesium.SceneMode.SCENE3D) {
      viewer.scene.morphTo2D(1.0)
    } else {
      viewer.scene.morphTo3D(1.0)
    }
  }

  const updateScaleBar = () => {
    const viewer = getViewer()
    if (!viewer) return
    const width = viewer.canvas.clientWidth
    const height = viewer.canvas.clientHeight
    const left = viewer.camera.getPickRay(new Cesium.Cartesian2((width / 2) - 50, height - 1))
    const right = viewer.camera.getPickRay(new Cesium.Cartesian2((width / 2) + 50, height - 1))
    let leftPosition, rightPosition
    
    if (left && right) {
      leftPosition = viewer.scene.globe.pick(left, viewer.scene)
      rightPosition = viewer.scene.globe.pick(right, viewer.scene)
    }
    if (!leftPosition || !rightPosition) {
      leftPosition = viewer.scene.camera.pickEllipsoid(new Cesium.Cartesian2((width / 2) - 50, height - 1), viewer.scene.globe.ellipsoid)
      rightPosition = viewer.scene.camera.pickEllipsoid(new Cesium.Cartesian2((width / 2) + 50, height - 1), viewer.scene.globe.ellipsoid)
    }
    
    if (leftPosition && rightPosition) {
      const distance = Cesium.Cartesian3.distance(leftPosition, rightPosition)      
      if (distance > 1000) {
        scaleText.value = (distance / 1000).toFixed(1) + ' km'
      } else {
        scaleText.value = Math.round(distance) + ' m'
      }
    } else {
      scaleText.value = '太高了'
    }
  }

  const updateCameraPosition = () => {
    const viewer = getViewer()
    if (!viewer) return
    const cartographic = viewer.camera.positionCartographic
    cameraPosition.longitude = Cesium.Math.toDegrees(cartographic.longitude).toFixed(6)
    cameraPosition.latitude = Cesium.Math.toDegrees(cartographic.latitude).toFixed(6)
    cameraPosition.height = cartographic.height.toFixed(2)
  }

  // 统一监听器初始化 
  const initListeners = () => {
    const viewer = getViewer()
    if (!viewer) return    
    
    // 相机监听 (比例尺 + 视点位置)
    viewer.camera.percentageChanged = 0.01    
    cameraChangeListener = viewer.camera.changed.addEventListener(() => {
      updateScaleBar()
      updateCameraPosition()
    })
    updateScaleBar()
    updateCameraPosition()

    //鼠标移动监听 (拾取经纬度和海拔)
    mouseHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
    mouseHandler.setInputAction((movement: any) => {
      // 通过射线求交，获取带地形的真实地表坐标
      const ray = viewer.camera.getPickRay(movement.endPosition)
      if (!ray) return
      const earthPosition = viewer.scene.globe.pick(ray, viewer.scene)
      
      if (earthPosition) {
        const cartographic = viewer.scene.globe.ellipsoid.cartesianToCartographic(earthPosition)
        mousePosition.longitude = Cesium.Math.toDegrees(cartographic.longitude).toFixed(6)
        mousePosition.latitude = Cesium.Math.toDegrees(cartographic.latitude).toFixed(6)
        mousePosition.altitude = cartographic.height.toFixed(2) 
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    //帧率监听
    let frameCount = 0
    let lastFpsTime = performance.now()
    postRenderListener = viewer.scene.postRender.addEventListener(() => {
      frameCount++
      const currentTime = performance.now()
      if (currentTime - lastFpsTime >= 1000) {
        fps.value = frameCount
        frameCount = 0
        lastFpsTime = currentTime
      }
    })
  }

  // --- 销毁所有事件 ---
  const destroyControls = () => {
    if (cameraChangeListener) {
      cameraChangeListener() 
      cameraChangeListener = null
    }
    if (postRenderListener) {
      postRenderListener()
      postRenderListener = null
    }
    if (mouseHandler) {
      mouseHandler.destroy()
      mouseHandler = null
    }
  }

  return {
    scaleText, 
    cameraPosition, 
    mousePosition, 
    fps,           
    zoomIn,
    zoomOut,
    resetHome,
    toggle2D3D,
    initListeners, 
    destroyControls
  }
}
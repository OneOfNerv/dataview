/**
 * Cesium 测量工具 Hook
 * - 提供测量距离、面积和高差的功能，支持动态显示测量结果 getSpaceDistance、getSphericalArea
 * - 支持多段线和多边形的测量，自动计算总长度和面积 formatDist、formatArea
 * - 支持三角形测量，显示边长和高差信息 formatDist
 * - 提供清除当前测量和清除所有测量的接口 clearCurrentAction、clearAllMeasurements
 * - 使用 Cesium.ScreenSpaceEventHandler 监听鼠标事件，动态更新测量结果
 * - 使用 Cesium.CallbackProperty 实时更新测量线和面的位置
 * * 注意：需要配合 useCesium Hook 获取 Viewer 实例，并在组件销毁时调用 clearAllMeasurements 释放资源
 * 
 * @author Nerv
 */
import * as Cesium from 'cesium'
export function useCesiumMeasure(getViewer: () => any) {
  let handler: any = null
  let activePoints: any[] = []
  let activeEntities: any[] = []
  let dynamicLabel: any = null
  let mode: 'distance' | 'area' | 'triangle' | 'none' = 'none'
  const measuredEntities = new Set()

  const getSpaceDistance = (pts: any[]) => pts.reduce((acc, p, i) => acc + (i < pts.length - 1 ? Cesium.Cartesian3.distance(p, pts[i + 1]) : 0), 0)
  const formatDist = (d: number) => d > 1000 ? (d / 1000).toFixed(2) + ' km' : d.toFixed(2) + ' m'
  const formatArea = (a: number) => a > 1000000 ? (a / 1000000).toFixed(2) + ' km²' : a.toFixed(2) + ' m²'
  const getPickedPosition = (position: any, viewer: any) => viewer.scene.globe.pick(viewer.scene.camera.getPickRay(position), viewer.scene) || viewer.scene.camera.pickEllipsoid(position, viewer.scene.globe.ellipsoid)

  const getSphericalArea = (positions: any[]) => {
    if (positions.length < 3) return 0
    let area = 0
    const cartographics: any[] = positions.map(p => Cesium.Ellipsoid.WGS84.cartesianToCartographic(p))
    cartographics.push(cartographics[0])
    for (let i = 0; i < cartographics.length - 1; i++) {
      area += cartographics[i].longitude * cartographics[i + 1].latitude - cartographics[i + 1].longitude * cartographics[i].latitude
    }
    return Math.abs(area) * 6378137.0 * 6378137.0 / 2.0
  }

  const clearCurrentAction = () => {
    const viewer = getViewer()
    activeEntities.forEach(e => viewer.entities.remove(e))
    if (dynamicLabel) viewer.entities.remove(dynamicLabel)
    activeEntities = []; activePoints = []; dynamicLabel = null; mode = 'none'
    if (handler) { handler.destroy(); handler = null }
    viewer.scene.canvas.style.cursor = 'default'
    viewer.scene.requestRender()
  }

  const clearAllMeasurements = () => {
    clearCurrentAction()
    const viewer = getViewer()
    measuredEntities.forEach((id: any) => viewer.entities.removeById(id))
    measuredEntities.clear()
    viewer.scene.requestRender()
  }

  const startMeasure = (mMode: 'distance' | 'area' | 'triangle') => {
    const viewer = getViewer()
    if (!viewer) return
    clearCurrentAction()
    mode = mMode
    viewer.scene.canvas.style.cursor = 'crosshair'
    handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)

    dynamicLabel = viewer.entities.add({
      label: { show: false, font: '14px sans-serif', fillColor: Cesium.Color.WHITE, style: Cesium.LabelStyle.FILL_AND_OUTLINE, outlineWidth: 2, outlineColor: Cesium.Color.BLACK, pixelOffset: new Cesium.Cartesian2(15, -15), disableDepthTestDistance: Number.POSITIVE_INFINITY }
    })

    handler.setInputAction((event: any) => {
      const pos = getPickedPosition(event.endPosition, viewer)
      if (!pos) return
      dynamicLabel.position = pos; dynamicLabel.label.show = true

      if (activePoints.length === 0) { dynamicLabel.label.text = '左键点击开始'; viewer.scene.requestRender(); return }

      const tempPts = [...activePoints, pos]
      if (mode === 'distance') dynamicLabel.label.text = `总长: ${formatDist(getSpaceDistance(tempPts))}\n(右键结束)`
      else if (mode === 'area') dynamicLabel.label.text = tempPts.length >= 3 ? `面积: ${formatArea(getSphericalArea(tempPts))}\n(右键结束)` : '请继续点击'
      else if (mode === 'triangle' && activePoints.length === 1) {
        const c1 = Cesium.Cartographic.fromCartesian(activePoints[0]); const c2 = Cesium.Cartographic.fromCartesian(pos)
        dynamicLabel.label.text = `距离: ${formatDist(Cesium.Cartesian3.distance(activePoints[0], pos))}\n高差: ${formatDist(Math.abs(c2.height - c1.height))}`
      }
      viewer.scene.requestRender()
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    handler.setInputAction((event: any) => {
      const pos = getPickedPosition(event.position, viewer)
      if (!pos) return
      activePoints.push(pos)
      const pt = viewer.entities.add({ position: pos, point: { color: Cesium.Color.RED, pixelSize: 6, disableDepthTestDistance: Number.POSITIVE_INFINITY } })
      activeEntities.push(pt); measuredEntities.add(pt.id)

      if (activePoints.length === 1) {
        const lineProps = { positions: new Cesium.CallbackProperty(() => [...activePoints, dynamicLabel.position.getValue(viewer.clock.currentTime)], false), width: 3, material: Cesium.Color.ORANGE, clampToGround: true }
        if (mode === 'distance') activeEntities.push(viewer.entities.add({ polyline: lineProps }))
        else if (mode === 'area') activeEntities.push(viewer.entities.add({ polygon: { hierarchy: new Cesium.CallbackProperty(() => new Cesium.PolygonHierarchy([...activePoints, dynamicLabel.position.getValue(viewer.clock.currentTime)]), false), material: Cesium.Color.CYAN.withAlpha(0.4) }, polyline: lineProps }))
      }

      if (mode === 'triangle' && activePoints.length === 2) {
        const p1 = activePoints[0]; const p2 = activePoints[1]
        const c1 = Cesium.Cartographic.fromCartesian(p1); const c2 = Cesium.Cartographic.fromCartesian(p2)
        const p3 = viewer.scene.globe.ellipsoid.cartographicToCartesian(new Cesium.Cartographic(c2.longitude, c2.latitude, c1.height))
        
        const line = viewer.entities.add({ polyline: { positions: [p1, p2, p3, p1], width: 2, material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.GREEN }) } })
        const resLabel = viewer.entities.add({ position: p2, label: { text: dynamicLabel.label.text.getValue(), font: '14px sans-serif', fillColor: Cesium.Color.YELLOW, pixelOffset: new Cesium.Cartesian2(0, -20), disableDepthTestDistance: Number.POSITIVE_INFINITY } })
        measuredEntities.add(line.id); measuredEntities.add(resLabel.id)
        clearCurrentAction()
      }
      viewer.scene.requestRender()
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

    handler.setInputAction(() => {
      if (activePoints.length < 2) return
      if (mode === 'distance') {
        measuredEntities.add(viewer.entities.add({ polyline: { positions: [...activePoints], width: 3, material: Cesium.Color.ORANGE, clampToGround: true } }).id)
        measuredEntities.add(viewer.entities.add({ position: activePoints[activePoints.length - 1], label: { text: `总长: ${formatDist(getSpaceDistance(activePoints))}`, font: '14px', fillColor: Cesium.Color.YELLOW, disableDepthTestDistance: Infinity, pixelOffset: new Cesium.Cartesian2(0, -20) } }).id)
      } else if (mode === 'area') {
        measuredEntities.add(viewer.entities.add({ polygon: { hierarchy: new Cesium.PolygonHierarchy(activePoints), material: Cesium.Color.CYAN.withAlpha(0.4) }, polyline: { positions: [...activePoints, activePoints[0]], width: 2, material: Cesium.Color.CYAN, clampToGround: true } }).id)
        measuredEntities.add(viewer.entities.add({ position: activePoints[activePoints.length - 1], label: { text: `面积: ${formatArea(getSphericalArea(activePoints))}`, font: '14px', fillColor: Cesium.Color.YELLOW, disableDepthTestDistance: Infinity, pixelOffset: new Cesium.Cartesian2(0, -20) } }).id)
      }
      clearCurrentAction()
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK)
  }

  return { measureLength: () => startMeasure('distance'), measureArea: () => startMeasure('area'), measureHeight: () => startMeasure('triangle'), clearAllMeasurements }
}
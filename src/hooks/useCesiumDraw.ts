/**
 * Cesium 地图绘制 Hook
 * - 提供绘制线、多边形、矩形的功能 startDrawing 
 * - 支持绘制结果的 WKT 字符串和四至范围计算
 * - 提供销毁函数，释放资源
 * @author Nerv
 */
import * as Cesium from 'cesium'

type DrawMode = 'line' | 'polygon' | 'rectangle'
type ActiveDrawMode = DrawMode | 'none'

interface DrawResult {
  type: DrawMode
  positions: Cesium.Cartesian3[]
  lnglats: [number, number][]
  wkt: string
  boundingBox: { west: number; south: number; east: number; north: number }
}

export function useCesiumDraw(getViewer: () => Cesium.Viewer | null | undefined) {
  let handler: Cesium.ScreenSpaceEventHandler | null = null
  let activeShapePoints: Cesium.Cartesian3[] = []
  let activeShape: Cesium.Entity | null = null
  let floatingPoint: Cesium.Entity | null = null
  let drawingMode: ActiveDrawMode = 'none'
  
  // 用于存储当前绘制任务的 Promise resolve 回调
  let drawPromiseResolve: ((value: DrawResult | null) => void) | null = null
  const drawnEntities = new Set<string>()
  const tempPointEntities = new Set<string>()
  const getPickedPosition = (position: Cesium.Cartesian2, viewer: Cesium.Viewer) => {
    const ray = viewer.scene.camera.getPickRay(position)
    if (!ray) return null
    let earthPosition = viewer.scene.globe.pick(ray, viewer.scene)
    if (!earthPosition) {
      earthPosition = viewer.scene.camera.pickEllipsoid(position, viewer.scene.globe.ellipsoid)
    }
    return earthPosition
  }
  const processDrawResult = (
    positions: Cesium.Cartesian3[],
    mode: DrawMode
  ): DrawResult | null => {
    const viewer = getViewer()
    if (!viewer) return null

    let minX = 180, maxX = -180, minY = 90, maxY = -90
    const lnglats: [number, number][] = positions.map((p) => {
      const cartographic = viewer.scene.globe.ellipsoid.cartesianToCartographic(p)
      const lon = Number(Cesium.Math.toDegrees(cartographic.longitude).toFixed(8))
      const lat = Number(Cesium.Math.toDegrees(cartographic.latitude).toFixed(8))
      return [lon, lat]
    })

    let wkt = ''
    if (mode === 'rectangle' && lnglats.length >= 2) {
      const first = lnglats[0]
      const second = lnglats[1]
      if (!first || !second) return null
      minX = Math.min(first[0], second[0])
      maxX = Math.max(first[0], second[0])
      minY = Math.min(first[1], second[1])
      maxY = Math.max(first[1], second[1])
      wkt = `POLYGON ((${minX} ${maxY}, ${maxX} ${maxY}, ${maxX} ${minY}, ${minX} ${minY}, ${minX} ${maxY}))`
    } else {
      lnglats.forEach(p => {
        minX = Math.min(minX, p[0])
        maxX = Math.max(maxX, p[0])
        minY = Math.min(minY, p[1])
        maxY = Math.max(maxY, p[1])
      })
      if (mode === 'line') {
        wkt = `LINESTRING (${lnglats.map(p => p.join(' ')).join(', ')})`
      } else if (mode === 'polygon') {
        const first = lnglats[0]
        if (!first) return null
        const closedLnglats = [...lnglats, first]
        wkt = `POLYGON ((${closedLnglats.map(p => p.join(' ')).join(', ')}))`
      }
    }

    return {
      type: mode,
      positions: positions, 
      lnglats: lnglats,     
      wkt: wkt,             
      boundingBox: { west: minX, south: minY, east: maxX, north: maxY }
    }
  }

  const terminateShape = () => {
    if (!activeShape) return
    const viewer = getViewer()
    if (!viewer) return

    const finalPositions = [...activeShapePoints]
    viewer.entities.remove(activeShape)
    tempPointEntities.forEach(id => viewer.entities.removeById(id))
    tempPointEntities.clear()
    if ((drawingMode === 'polygon' && finalPositions.length < 3) || 
        (drawingMode === 'line' && finalPositions.length < 2)) {
      resetState(viewer)
      if (drawPromiseResolve) drawPromiseResolve(null)
      return
    }
    const currentMode = drawingMode
    if (currentMode === 'none') {
      resetState(viewer)
      if (drawPromiseResolve) drawPromiseResolve(null)
      return
    }

    const generatedEntities: Cesium.Entity[] = []

    if (currentMode === 'polygon') {
      const firstPosition = finalPositions[0]
      if (!firstPosition) {
        resetState(viewer)
        if (drawPromiseResolve) drawPromiseResolve(null)
        return
      }
      generatedEntities.push(viewer.entities.add({
        name: 'draw-polygon-surface',
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(finalPositions),
          material: Cesium.Color.fromCssColorString('rgba(245, 63, 63, 0.4)'),
          height: 0,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          zIndex: 10
        }
      }))

      // 创建闭合边线
      generatedEntities.push(viewer.entities.add({
        name: 'draw-polygon-outline',
        polyline: {
          positions: [...finalPositions, firstPosition], 
          width: 3, 
          material: Cesium.Color.fromCssColorString('#F53F3F'),
          clampToGround: true,
          zIndex: 11
        }
      }))

      // 创建顶点
      finalPositions.forEach((pos, index) => {
        generatedEntities.push(viewer.entities.add({
          name: `draw-polygon-node-${index}`,
          position: pos,
          point: {
            pixelSize: 8,
            color: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
          }
        }))
      })

    } else if (currentMode === 'line') {
      generatedEntities.push(viewer.entities.add({
        name: 'draw-line-shape',
        polyline: { 
          positions: finalPositions, 
          clampToGround: true, 
          width: 3, 
          material: Cesium.Color.YELLOW 
        }
      }))
    } else if (currentMode === 'rectangle') {
      const rectangleCoordinates = Cesium.Rectangle.fromCartesianArray(finalPositions)

      generatedEntities.push(viewer.entities.add({
        name: 'draw-rectangle-shape',
        rectangle: {
          coordinates: rectangleCoordinates,
          material: Cesium.Color.CYAN.withAlpha(0.4)
        }
      }))

      const corners = [
        Cesium.Cartesian3.fromRadians(rectangleCoordinates.west, rectangleCoordinates.north),
        Cesium.Cartesian3.fromRadians(rectangleCoordinates.east, rectangleCoordinates.north),
        Cesium.Cartesian3.fromRadians(rectangleCoordinates.east, rectangleCoordinates.south),
        Cesium.Cartesian3.fromRadians(rectangleCoordinates.west, rectangleCoordinates.south)
      ]
      const firstCorner = corners[0]
      if (!firstCorner) {
        resetState(viewer)
        if (drawPromiseResolve) drawPromiseResolve(null)
        return
      }

      generatedEntities.push(viewer.entities.add({
        name: 'draw-rectangle-outline',
        polyline: {
          positions: [...corners, firstCorner],
          width: 3,
          material: Cesium.Color.fromCssColorString('#00B8D9'),
          clampToGround: true,
          zIndex: 11
        }
      }))

      corners.forEach((pos, index) => {
        generatedEntities.push(viewer.entities.add({
          name: `draw-rectangle-node-${index}`,
          position: pos,
          point: {
            pixelSize: 8,
            color: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
          }
        }))
      })
    }
    generatedEntities.forEach(entity => drawnEntities.add(entity.id))

    // 结果回调
    if (drawPromiseResolve) {
      const resultData = processDrawResult(finalPositions, currentMode)
      drawPromiseResolve(resultData)
    }

    resetState(viewer)
  }

  // 重置状态辅助函数
  const resetState = (viewer: Cesium.Viewer) => {
    activeShape = null
    floatingPoint = null
    activeShapePoints = []
    drawingMode = 'none'
    drawPromiseResolve = null
    
    if (handler) { 
      handler.destroy()
      handler = null 
    }
    viewer.scene.canvas.style.cursor = 'default'
    viewer.scene.requestRender()
  }

  // 启动绘制
  const startDrawing = (mode: DrawMode) => {
    return new Promise<DrawResult | null>((resolve) => {
      const viewer = getViewer()
      if (!viewer) {
        console.warn('地图尚未初始化！')
        resolve(null)
        return
      }
      
      if (drawingMode !== 'none') terminateShape()
      
      drawingMode = mode
      drawPromiseResolve = resolve
      viewer.scene.canvas.style.cursor = 'crosshair'
      
      handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)

      handler.setInputAction((event: { position: Cesium.Cartesian2 }) => {
        const earthPosition = getPickedPosition(event.position, viewer)
        if (!earthPosition) return

        if (activeShapePoints.length === 0) {
          floatingPoint = viewer.entities.add({ 
            position: earthPosition, 
            point: { color: Cesium.Color.WHITE, pixelSize: 6 } 
          })
          tempPointEntities.add(floatingPoint.id)
          activeShapePoints.push(earthPosition)
          
          const dynamicPositions = new Cesium.CallbackProperty(() => {
            if (drawingMode === 'polygon') return new Cesium.PolygonHierarchy(activeShapePoints)
            if (drawingMode === 'rectangle') return activeShapePoints.length < 2 ? undefined : Cesium.Rectangle.fromCartesianArray(activeShapePoints)
            return activeShapePoints
          }, false)
          
          const shapeConfig: Cesium.Entity.ConstructorOptions = {}
          if (mode === 'line') shapeConfig.polyline = { positions: dynamicPositions, width: 3, material: Cesium.Color.YELLOW, clampToGround: true }
          if (mode === 'polygon') shapeConfig.polygon = { hierarchy: dynamicPositions, material: Cesium.Color.YELLOW.withAlpha(0.4) }
          if (mode === 'rectangle') shapeConfig.rectangle = { coordinates: dynamicPositions, material: Cesium.Color.CYAN.withAlpha(0.4) }
          
          activeShape = viewer.entities.add(shapeConfig)
        }
        
        activeShapePoints.push(earthPosition)
        const pt = viewer.entities.add({ 
          position: earthPosition, 
          point: { color: Cesium.Color.WHITE, pixelSize: 6 } 
        })
        tempPointEntities.add(pt.id)

        // 矩形点两次直接完成
        if (drawingMode === 'rectangle' && activeShapePoints.length === 3) terminateShape()
        viewer.scene.requestRender()
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

      handler.setInputAction((event: { endPosition: Cesium.Cartesian2 }) => {
        if (!floatingPoint) return

        const newPosition = getPickedPosition(event.endPosition, viewer)
        if (!newPosition) return

        floatingPoint.position = new Cesium.ConstantPositionProperty(newPosition)
        activeShapePoints.pop()
        activeShapePoints.push(newPosition)
        viewer.scene.requestRender()
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

      handler.setInputAction(() => {
        if (drawingMode === 'polygon' || drawingMode === 'line') {
          activeShapePoints.pop() // 移除跟随鼠标的临时点
          terminateShape()
        }
      }, Cesium.ScreenSpaceEventType.RIGHT_CLICK)
    })
  }

  // 清除所有绘制物
  const clearDrawings = () => {
    const viewer = getViewer()
    if (!viewer) return
    
    if (drawingMode !== 'none') terminateShape()
    
    drawnEntities.forEach(id => viewer.entities.removeById(id))
    drawnEntities.clear()
    viewer.scene.requestRender()
  }

  return {
    drawLine: () => startDrawing('line'),
    drawPolygon: () => startDrawing('polygon'),
    drawRectangle: () => startDrawing('rectangle'),
    clearDrawings,
    destroyDraw: clearDrawings
  }
}

import * as Cesium from 'cesium'

export type DrawMode = 'line' | 'polygon' | 'rectangle'
export type DrawEditMode = 'vertex' | 'translate' | 'add' | 'delete' | 'reshape' | 'none'
export interface SerializedDrawing { id: string; type: DrawMode; lnglats: [number, number][] }
export interface DrawResult extends SerializedDrawing {
  positions: Cesium.Cartesian3[]
  wkt: string
  boundingBox: { west: number; south: number; east: number; north: number }
}
interface Drawing { id: string; type: DrawMode; positions: Cesium.Cartesian3[]; entities: Cesium.Entity[] }
interface Target { drawingId: string; kind: 'shape' | 'node'; vertexIndex?: number }
const STORAGE_KEY = 'cesium-drawings'

/** 绘制、编辑、撤销/重做、吸附及持久化。 */
export function useCesiumDraw(getViewer: () => Cesium.Viewer | null | undefined) {
  let drawHandler: Cesium.ScreenSpaceEventHandler | null = null
  let editHandler: Cesium.ScreenSpaceEventHandler | null = null
  let drawMode: DrawMode | 'none' = 'none'
  let activePoints: Cesium.Cartesian3[] = []
  let activeShape: Cesium.Entity | null = null
  let floatingPoint: Cesium.Entity | null = null
  let resolver: ((value: DrawResult | null) => void) | null = null
  let selectedId: string | null = null
  let snapping = true
  let snapPixels = 14
  let snappedVertex: { drawingId: string; vertexIndex: number } | null = null
  let idSeed = 0
  let dragging: null | { drawingId: string; vertexIndex?: number; start: Cesium.Cartesian3; original: Cesium.Cartesian3[] } = null
  const drawings = new Map<string, Drawing>()
  const targets = new Map<string, Target>()
  const temporaryIds = new Set<string>()
  let history: SerializedDrawing[][] = [[]]
  let historyIndex = 0

  const clone = (p: Cesium.Cartesian3) => Cesium.Cartesian3.clone(p)
  const newId = () => `drawing-${Date.now()}-${++idSeed}`
  const pickGround = (screen: Cesium.Cartesian2, viewer: Cesium.Viewer) => {
    const ray = viewer.camera.getPickRay(screen)
    return (ray && viewer.scene.globe.pick(ray, viewer.scene))
      || viewer.camera.pickEllipsoid(screen, viewer.scene.globe.ellipsoid) || null
  }
  const lnglat = (p: Cesium.Cartesian3): [number, number] => {
    const c = Cesium.Ellipsoid.WGS84.cartesianToCartographic(p)
    return [Number(Cesium.Math.toDegrees(c.longitude).toFixed(8)), Number(Cesium.Math.toDegrees(c.latitude).toFixed(8))]
  }
  const rectangleCorners = (positions: Cesium.Cartesian3[]) => {
    const r = Cesium.Rectangle.fromCartesianArray(positions)
    return [
      Cesium.Cartesian3.fromRadians(r.west, r.north), Cesium.Cartesian3.fromRadians(r.east, r.north),
      Cesium.Cartesian3.fromRadians(r.east, r.south), Cesium.Cartesian3.fromRadians(r.west, r.south)
    ]
  }
  const resultOf = (drawing?: Drawing): DrawResult | null => {
    if (!drawing?.positions.length) return null
    const points = drawing.positions.map(lnglat)
    const xs = points.map(p => p[0]); const ys = points.map(p => p[1])
    const west = Math.min(...xs); const east = Math.max(...xs)
    const south = Math.min(...ys); const north = Math.max(...ys)
    let wkt: string
    if (drawing.type === 'line') wkt = `LINESTRING (${points.map(p => p.join(' ')).join(', ')})`
    else if (drawing.type === 'rectangle') wkt = `POLYGON ((${west} ${north}, ${east} ${north}, ${east} ${south}, ${west} ${south}, ${west} ${north}))`
    else wkt = `POLYGON ((${[...points, points[0]!].map(p => p.join(' ')).join(', ')}))`
    return { id: drawing.id, type: drawing.type, positions: drawing.positions.map(clone), lnglats: points, wkt, boundingBox: { west, south, east, north } }
  }
  const removeEntities = (drawing: Drawing, viewer: Cesium.Viewer) => {
    drawing.entities.forEach(entity => { targets.delete(entity.id); viewer.entities.remove(entity) })
    drawing.entities = []
  }
  const render = (drawing: Drawing) => {
    const viewer = getViewer(); if (!viewer) return
    removeEntities(drawing, viewer)
    const selected = drawing.id === selectedId
    const color = selected ? Cesium.Color.CYAN : Cesium.Color.fromCssColorString('#F53F3F')
    const entities: Cesium.Entity[] = []
    if (drawing.type === 'line') {
      entities.push(viewer.entities.add({ name: 'draw-line-shape', polyline: { positions: drawing.positions, width: selected ? 4 : 3, material: color, clampToGround: true } }))
    } else {
      entities.push(viewer.entities.add({ name: `draw-${drawing.type}-surface`, polygon: { hierarchy: new Cesium.PolygonHierarchy(drawing.positions), material: color.withAlpha(.35), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, zIndex: 10 } }))
      entities.push(viewer.entities.add({ name: `draw-${drawing.type}-outline`, polyline: { positions: [...drawing.positions, drawing.positions[0]!], width: selected ? 4 : 3, material: color, clampToGround: true, zIndex: 11 } }))
    }
    entities.forEach(entity => targets.set(entity.id, { drawingId: drawing.id, kind: 'shape' }))
    drawing.positions.forEach((position, vertexIndex) => {
      const isSnapped = snappedVertex?.drawingId === drawing.id && snappedVertex.vertexIndex === vertexIndex
      const entity = viewer.entities.add({ name: `draw-${drawing.type}-node-${vertexIndex}`, position, point: { pixelSize: isSnapped ? 12 : selected ? 11 : 8, color: isSnapped ? Cesium.Color.RED : selected ? Cesium.Color.CYAN : Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND } })
      targets.set(entity.id, { drawingId: drawing.id, kind: 'node', vertexIndex }); entities.push(entity)
    })
    drawing.entities = entities; viewer.scene.requestRender()
  }
  const selectDrawing = (id: string | null) => {
    const previous = selectedId ? drawings.get(selectedId) : undefined
    selectedId = id && drawings.has(id) ? id : null
    if (previous) render(previous)
    const current = selectedId ? drawings.get(selectedId) : undefined
    if (current && current !== previous) render(current)
    return selectedId
  }
  const exportDrawings = (): SerializedDrawing[] => [...drawings.values()].map(d => ({ id: d.id, type: d.type, lnglats: d.positions.map(lnglat) }))
  const commit = () => {
    const next = exportDrawings()
    if (JSON.stringify(next) === JSON.stringify(history[historyIndex])) return
    history = history.slice(0, historyIndex + 1); history.push(next); historyIndex++
  }
  const removeAll = () => {
    const viewer = getViewer(); if (!viewer) return
    drawings.forEach(d => removeEntities(d, viewer)); drawings.clear(); selectedId = null
  }
  const importDrawings = (data: SerializedDrawing[], addHistory = true) => {
    if (!getViewer() || !Array.isArray(data)) return false
    removeAll()
    data.forEach(item => {
      if (!item || !['line', 'polygon', 'rectangle'].includes(item.type) || !Array.isArray(item.lnglats)) return
      const positions = item.lnglats.filter(p => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1])).map(p => Cesium.Cartesian3.fromDegrees(p[0], p[1]))
      if (positions.length < (item.type === 'line' ? 2 : 3)) return
      const drawing: Drawing = { id: item.id || newId(), type: item.type, positions, entities: [] }
      drawings.set(drawing.id, drawing); render(drawing)
    })
    if (addHistory) commit()
    return true
  }
  const applyHistory = (index: number) => {
    if (!history[index]) return false
    historyIndex = index; return importDrawings(history[index]!, false)
  }
  const undo = () => historyIndex > 0 && applyHistory(historyIndex - 1)
  const redo = () => historyIndex < history.length - 1 && applyHistory(historyIndex + 1)
  const pickedTarget = (screen: Cesium.Cartesian2, viewer: Cesium.Viewer) => {
    const entity = viewer.scene.pick(screen)?.id as Cesium.Entity | undefined
    return entity ? targets.get(entity.id) || null : null
  }
  const refreshVertexStyle = (target: { drawingId: string; vertexIndex: number }) => {
    const drawing = drawings.get(target.drawingId)
    if (!drawing) return
    const selected = drawing.id === selectedId
    const node = drawing.entities.find(entity => {
      const info = targets.get(entity.id)
      return info?.kind === 'node' && info.vertexIndex === target.vertexIndex
    })
    if (!node?.point) return
    const highlighted = snappedVertex?.drawingId === target.drawingId && snappedVertex.vertexIndex === target.vertexIndex
    node.point.color = new Cesium.ConstantProperty(highlighted ? Cesium.Color.RED : selected ? Cesium.Color.CYAN : Cesium.Color.WHITE)
    node.point.pixelSize = new Cesium.ConstantProperty(highlighted ? 12 : selected ? 11 : 8)
  }
  const setSnappedVertex = (target: { drawingId: string; vertexIndex: number } | null) => {
    const previous = snappedVertex
    if (previous?.drawingId === target?.drawingId && previous?.vertexIndex === target?.vertexIndex) return
    snappedVertex = target
    if (previous) refreshVertexStyle(previous)
    if (target) refreshVertexStyle(target)
    getViewer()?.scene.requestRender()
  }
  const snap = (position: Cesium.Cartesian3, screen: Cesium.Cartesian2, exclude?: Target) => {
    const viewer = getViewer(); if (!viewer || !snapping) { setSnappedVertex(null); return position }
    let nearest: Cesium.Cartesian3 | null = null
    let nearestTarget: { drawingId: string; vertexIndex: number } | null = null
    let distance = snapPixels
    drawings.forEach(d => d.positions.forEach((candidate, vertexIndex) => {
      if (exclude?.drawingId === d.id && exclude.vertexIndex === vertexIndex) return
      const projected = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, candidate)
      if (!projected) return
      const current = Cesium.Cartesian2.distance(screen, projected)
      if (current <= distance) {
        distance = current
        nearest = candidate
        nearestTarget = { drawingId: d.id, vertexIndex }
      }
    }))
    setSnappedVertex(nearestTarget)
    return nearest ? clone(nearest) : position
  }
  const cameraInput = (viewer: Cesium.Viewer, enabled: boolean) => {
    const c = viewer.scene.screenSpaceCameraController
    c.enableRotate = enabled; c.enableTranslate = enabled; c.enableTilt = enabled; c.enableLook = enabled
  }
  const nearestSegment = (drawing: Drawing, click: Cesium.Cartesian2, viewer: Cesium.Viewer) => {
    const count = drawing.type === 'line' ? drawing.positions.length - 1 : drawing.positions.length
    let result = 0; let best = Infinity
    for (let i = 0; i < count; i++) {
      const a = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, drawing.positions[i]!)
      const b = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, drawing.positions[(i + 1) % drawing.positions.length]!)
      if (!a || !b) continue
      const ab = Cesium.Cartesian2.subtract(b, a, new Cesium.Cartesian2()); const ap = Cesium.Cartesian2.subtract(click, a, new Cesium.Cartesian2())
      const denominator = Cesium.Cartesian2.dot(ab, ab)
      const t = denominator ? Cesium.Math.clamp(Cesium.Cartesian2.dot(ap, ab) / denominator, 0, 1) : 0
      const point = Cesium.Cartesian2.add(a, Cesium.Cartesian2.multiplyByScalar(ab, t, new Cesium.Cartesian2()), new Cesium.Cartesian2())
      const d = Cesium.Cartesian2.distance(click, point); if (d < best) { best = d; result = i }
    }
    return result
  }
  const cancelDrawing = () => {
    const viewer = getViewer(); if (!viewer || drawMode === 'none') return
    const done = resolver
    if (activeShape) viewer.entities.remove(activeShape)
    temporaryIds.forEach(id => viewer.entities.removeById(id)); temporaryIds.clear()
    activePoints = []; activeShape = null; floatingPoint = null; drawMode = 'none'; resolver = null
    drawHandler?.destroy(); drawHandler = null; setSnappedVertex(null); viewer.canvas.style.cursor = 'default'; done?.(null)
  }
  const stopEditing = () => {
    const viewer = getViewer(); if (viewer) { cameraInput(viewer, true); viewer.canvas.style.cursor = 'default' }
    dragging = null; editHandler?.destroy(); editHandler = null
    if (viewer) clearReshapePreview(viewer)
    else { activeShape = null; floatingPoint = null; activePoints = []; temporaryIds.clear(); setSnappedVertex(null) }
    selectDrawing(null)
  }
  const finishDrawing = () => {
    const viewer = getViewer(); if (!viewer || drawMode === 'none') return
    const done = resolver; const type = drawMode; const positions = [...activePoints]
    if (activeShape) viewer.entities.remove(activeShape)
    temporaryIds.forEach(id => viewer.entities.removeById(id)); temporaryIds.clear()
    activePoints = []; activeShape = null; floatingPoint = null; drawMode = 'none'; resolver = null
    drawHandler?.destroy(); drawHandler = null; setSnappedVertex(null); viewer.canvas.style.cursor = 'default'
    if (positions.length < (type === 'line' ? 2 : type === 'polygon' ? 3 : 2)) { done?.(null); return }
    const drawing: Drawing = { id: newId(), type, positions: type === 'rectangle' ? rectangleCorners(positions) : positions.map(clone), entities: [] }
    drawings.set(drawing.id, drawing); selectedId = drawing.id; render(drawing); commit(); done?.(resultOf(drawing))
  }
  const startDrawing = (mode: DrawMode) => new Promise<DrawResult | null>(resolve => {
    const viewer = getViewer(); if (!viewer) { resolve(null); return }
    cancelDrawing(); stopEditing(); drawMode = mode; resolver = resolve; viewer.canvas.style.cursor = 'crosshair'
    drawHandler = new Cesium.ScreenSpaceEventHandler(viewer.canvas)
    drawHandler.setInputAction((event: { position: Cesium.Cartesian2 }) => {
      let position = pickGround(event.position, viewer); if (!position) return
      position = snap(position, event.position)
      if (!activePoints.length) {
        floatingPoint = viewer.entities.add({ position, point: { color: Cesium.Color.WHITE, pixelSize: 7 } }); temporaryIds.add(floatingPoint.id); activePoints.push(position)
        const dynamic = new Cesium.CallbackProperty(() => mode === 'polygon' ? new Cesium.PolygonHierarchy(activePoints) : mode === 'rectangle' ? (activePoints.length < 2 ? undefined : Cesium.Rectangle.fromCartesianArray(activePoints)) : activePoints, false)
        const options: Cesium.Entity.ConstructorOptions = {}
        if (mode === 'line') options.polyline = { positions: dynamic, width: 3, material: Cesium.Color.YELLOW, clampToGround: true }
        if (mode === 'polygon') options.polygon = { hierarchy: dynamic, material: Cesium.Color.YELLOW.withAlpha(.4) }
        if (mode === 'rectangle') options.rectangle = { coordinates: dynamic, material: Cesium.Color.CYAN.withAlpha(.4) }
        activeShape = viewer.entities.add(options)
      }
      activePoints.push(position)
      const node = viewer.entities.add({ position, point: { color: Cesium.Color.WHITE, pixelSize: 7 } }); temporaryIds.add(node.id)
      if (mode === 'rectangle' && activePoints.length === 3) finishDrawing()
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    drawHandler.setInputAction((event: { endPosition: Cesium.Cartesian2 }) => {
      if (!floatingPoint) return
      let position = pickGround(event.endPosition, viewer); if (!position) return
      position = snap(position, event.endPosition); floatingPoint.position = new Cesium.ConstantPositionProperty(position); activePoints[activePoints.length - 1] = position
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
    drawHandler.setInputAction(() => { if (mode !== 'rectangle') { activePoints.pop(); finishDrawing() } }, Cesium.ScreenSpaceEventType.RIGHT_CLICK)
  })
  const clearReshapePreview = (viewer: Cesium.Viewer) => {
    if (activeShape) viewer.entities.remove(activeShape)
    temporaryIds.forEach(id => viewer.entities.removeById(id))
    temporaryIds.clear()
    activeShape = null
    floatingPoint = null
    activePoints = []
    setSnappedVertex(null)
  }
  const routeForward = (positions: Cesium.Cartesian3[], from: number, to: number) => {
    const route: Cesium.Cartesian3[] = []
    for (let index = from; ; index = (index + 1) % positions.length) {
      route.push(clone(positions[index]!))
      if (index === to) break
    }
    return route
  }
  const pathLength = (positions: Cesium.Cartesian3[]) => positions.slice(1).reduce(
    (total, position, index) => total + Cesium.Cartesian3.distance(positions[index]!, position), 0
  )
  const reshapeGeometry = (drawing: Drawing, path: Cesium.Cartesian3[]) => {
    const startIndex = drawing.positions.findIndex(position => Cesium.Cartesian3.distance(position, path[0]!) < 0.1)
    const endIndex = drawing.positions.findIndex(position => Cesium.Cartesian3.distance(position, path[path.length - 1]!) < 0.1)
    if (startIndex < 0 || endIndex < 0 || startIndex === endIndex) return false
    if (drawing.type === 'line') {
      if (startIndex < endIndex) {
        drawing.positions = [...drawing.positions.slice(0, startIndex), ...path.map(clone), ...drawing.positions.slice(endIndex + 1)]
      } else {
        drawing.positions = [...drawing.positions.slice(0, endIndex), ...path.map(clone).reverse(), ...drawing.positions.slice(startIndex + 1)]
      }
      return true
    }
    if (drawing.type !== 'polygon') return false
    const forward = routeForward(drawing.positions, startIndex, endIndex)
    const backward = routeForward(drawing.positions, endIndex, startIndex).reverse()
    if (pathLength(forward) <= pathLength(backward)) {
      const preserved = routeForward(drawing.positions, endIndex, startIndex)
      drawing.positions = [...path.map(clone), ...preserved.slice(1, -1)]
    } else {
      drawing.positions = [...forward, ...path.slice(1, -1).map(clone).reverse()]
    }
    return drawing.positions.length >= 3
  }
  const beginReshape = (drawing: Drawing, viewer: Cesium.Viewer) => {
    if (drawing.type === 'rectangle') {
      console.warn('矩形需保持规则形状，不支持整形')
      stopEditing()
      return false
    }
    viewer.canvas.style.cursor = 'crosshair'
    editHandler!.setInputAction((event: { position: Cesium.Cartesian2 }) => {
      let position = pickGround(event.position, viewer)
      if (!position) return
      position = snap(position, event.position)
      if (!activePoints.length) {
        if (snappedVertex?.drawingId !== drawing.id) {
          console.warn('整形路径起点必须吸附到当前要素顶点')
          return
        }
        floatingPoint = viewer.entities.add({ position, point: { color: Cesium.Color.YELLOW, pixelSize: 7 } })
        temporaryIds.add(floatingPoint.id)
        activePoints.push(position)
        const dynamic = new Cesium.CallbackProperty(() => activePoints, false)
        activeShape = viewer.entities.add({ polyline: { positions: dynamic, width: 3, material: Cesium.Color.YELLOW, clampToGround: true } })
      }
      activePoints.push(position)
      const node = viewer.entities.add({ position, point: { color: Cesium.Color.YELLOW, pixelSize: 7, disableDepthTestDistance: Number.POSITIVE_INFINITY } })
      temporaryIds.add(node.id)
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    editHandler!.setInputAction((event: { endPosition: Cesium.Cartesian2 }) => {
      if (!floatingPoint) return
      let position = pickGround(event.endPosition, viewer)
      if (!position) return
      position = snap(position, event.endPosition)
      floatingPoint.position = new Cesium.ConstantPositionProperty(position)
      activePoints[activePoints.length - 1] = position
      viewer.scene.requestRender()
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
    editHandler!.setInputAction(() => {
      if (!activePoints.length) return
      activePoints.pop()
      const path = activePoints.map(clone)
      if (path.length < 2 || !reshapeGeometry(drawing, path)) {
        console.warn('整形路径的起点和终点必须吸附到当前要素的两个不同顶点')
        clearReshapePreview(viewer)
        return
      }
      clearReshapePreview(viewer)
      render(drawing)
      commit()
      stopEditing()
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK)
    return true
  }
  const startEditing = (mode: Exclude<DrawEditMode, 'none'>, id?: string) => {
    const viewer = getViewer(); if (!viewer || !drawings.size) return false
    cancelDrawing(); stopEditing(); const ids = [...drawings.keys()]; const targetId = id || selectedId || ids[ids.length - 1]; if (!targetId) return false
    selectDrawing(targetId); viewer.canvas.style.cursor = mode === 'reshape' ? 'crosshair' : mode === 'add' ? 'copy' : mode === 'delete' ? 'not-allowed' : 'grab'
    editHandler = new Cesium.ScreenSpaceEventHandler(viewer.canvas)
    const selectedDrawing = drawings.get(targetId)
    if (mode === 'reshape' && selectedDrawing) return beginReshape(selectedDrawing, viewer)
    editHandler.setInputAction((event: { position: Cesium.Cartesian2 }) => {
      const target = pickedTarget(event.position, viewer); if (target && target.drawingId !== selectedId) selectDrawing(target.drawingId)
      const drawing = selectedId ? drawings.get(selectedId) : undefined; if (!drawing) return
      if (mode === 'delete') {
        if (!target || target.kind !== 'node' || target.vertexIndex === undefined || drawing.type === 'rectangle') return
        if (drawing.positions.length <= (drawing.type === 'line' ? 2 : 3)) return
        drawing.positions.splice(target.vertexIndex, 1); render(drawing); commit(); return
      }
      if (mode === 'add') {
        if (drawing.type === 'rectangle') return
        const position = pickGround(event.position, viewer); if (!position) return
        drawing.positions.splice(nearestSegment(drawing, event.position, viewer) + 1, 0, snap(position, event.position)); render(drawing); commit(); return
      }
      if (mode === 'vertex' && target?.kind === 'node' && target.vertexIndex !== undefined) {
        dragging = { drawingId: drawing.id, vertexIndex: target.vertexIndex, start: drawing.positions[target.vertexIndex]!, original: drawing.positions.map(clone) }
      } else if (mode === 'translate' && target?.drawingId === drawing.id) {
        const start = pickGround(event.position, viewer); if (start) dragging = { drawingId: drawing.id, start, original: drawing.positions.map(clone) }
      }
      if (dragging) { cameraInput(viewer, false); viewer.canvas.style.cursor = 'grabbing' }
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN)
    editHandler.setInputAction((event: { endPosition: Cesium.Cartesian2 }) => {
      if (!dragging) return
      const drawing = drawings.get(dragging.drawingId); let position = pickGround(event.endPosition, viewer); if (!drawing || !position) return
      if (mode === 'vertex' && dragging.vertexIndex !== undefined) {
        position = snap(position, event.endPosition, { drawingId: drawing.id, kind: 'node', vertexIndex: dragging.vertexIndex })
        if (drawing.type === 'rectangle') {
          const opposite = drawing.positions[(dragging.vertexIndex + 2) % 4]; if (opposite) drawing.positions = rectangleCorners([opposite, position])
        } else drawing.positions[dragging.vertexIndex] = position
      } else if (mode === 'translate') {
        const a = Cesium.Ellipsoid.WGS84.cartesianToCartographic(dragging.start); const b = Cesium.Ellipsoid.WGS84.cartesianToCartographic(position)
        drawing.positions = dragging.original.map(p => { const c = Cesium.Ellipsoid.WGS84.cartesianToCartographic(p); return Cesium.Cartesian3.fromRadians(c.longitude + b.longitude - a.longitude, c.latitude + b.latitude - a.latitude, c.height) })
      }
      render(drawing)
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
    editHandler.setInputAction(() => { if (dragging) { dragging = null; cameraInput(viewer, true); viewer.canvas.style.cursor = 'grab'; setSnappedVertex(null); commit() } }, Cesium.ScreenSpaceEventType.LEFT_UP)
    return true
  }
  const deleteDrawing = (id = selectedId) => {
    const viewer = getViewer(); const drawing = id ? drawings.get(id) : undefined; if (!viewer || !drawing) return false
    removeEntities(drawing, viewer); drawings.delete(drawing.id); if (selectedId === id) selectedId = null; commit(); return true
  }
  const clearDrawings = () => { cancelDrawing(); stopEditing(); removeAll(); commit(); getViewer()?.scene.requestRender() }
  const saveDrawings = (key = STORAGE_KEY) => { const data = exportDrawings(); localStorage.setItem(key, JSON.stringify(data)); return data }
  const loadDrawings = (key = STORAGE_KEY) => { try { const data = localStorage.getItem(key); return data ? importDrawings(JSON.parse(data)) : false } catch (error) { console.error('绘制数据解析失败', error); return false } }
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo() }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo() }
    else if (event.key === 'Escape') { cancelDrawing(); stopEditing() }
  }
  window.addEventListener('keydown', onKeyDown)
  const destroyDraw = () => {
    cancelDrawing(); stopEditing(); removeAll()
    snappedVertex = null; window.removeEventListener('keydown', onKeyDown)
  }
  return {
    drawLine: () => startDrawing('line'), drawPolygon: () => startDrawing('polygon'), drawRectangle: () => startDrawing('rectangle'),
    editVertices: (id?: string) => startEditing('vertex', id), translateDrawing: (id?: string) => startEditing('translate', id),
    addVertex: (id?: string) => startEditing('add', id), deleteVertex: (id?: string) => startEditing('delete', id),
    reshapeDrawing: (id?: string) => startEditing('reshape', id),
    stopEditing, selectDrawing, deleteDrawing, clearDrawings, undo, redo, exportDrawings, importDrawings, saveDrawings, loadDrawings,
    getDrawingResult: (id = selectedId) => resultOf(id ? drawings.get(id) : undefined),
    setSnappingEnabled: (enabled: boolean) => { snapping = enabled; if (!enabled) setSnappedVertex(null); return snapping },
    setSnapDistance: (pixels: number) => (snapPixels = Number.isFinite(pixels) && pixels > 0 ? pixels : snapPixels), destroyDraw
  }
}
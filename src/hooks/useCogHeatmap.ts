import * as Cesium from 'cesium'

// ══════════ 类型定义 ══════════

export type CogColorMap = 'gray' | 'jet' | 'hot' | 'terrain'
export type CogStretchMode = 'minmax' | 'stddev' | 'percent'

export interface CogHeatmapOptions {
  bandIndex?: number
  colormap?: CogColorMap
  stretch?: CogStretchMode
  percentClip?: number
  heightScale?: number
  baseHeight?: number
  gridSize?: number
  opacity?: number
  flyTo?: boolean
  flyDuration?: number
  noDataValue?: number
}

interface BandStats {
  min: number; max: number; mean: number; stddev: number
}

interface HeatmapMeta {
  width: number
  height: number
  bandCount: number
  bbox: [number, number, number, number]
  noDataValue: number
  overviewCount: number
}

interface HeatmapContext {
  url: string
  options: Required<CogHeatmapOptions>
  meta: HeatmapMeta
  stats: BandStats
  bandData: Float32Array
  gridW: number
  gridH: number
  primitive: Cesium.Primitive | null
}

// ══════════ Colormap LUT（主线程版） ══════════

const COLOR_STOPS: Record<CogColorMap, number[][]> = {
  gray:    [[0, 0, 0, 0], [1, 255, 255, 255]],
  jet:     [[0, 0, 0, 128], [0.25, 0, 0, 255], [0.5, 0, 255, 255], [0.75, 255, 255, 0], [1, 255, 0, 0]],
  hot:     [[0, 0, 0, 0], [0.33, 255, 0, 0], [0.66, 255, 255, 0], [1, 255, 255, 255]],
  terrain: [[0, 43, 131, 186], [0.25, 171, 221, 164], [0.5, 255, 255, 191], [0.75, 253, 174, 97], [1, 215, 25, 28]]
}

function generateColorLUT(colormap: CogColorMap): Uint8Array {
  const stops = COLOR_STOPS[colormap]
  const lut = new Uint8Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    const ratio = i / 255
    let lower = stops[0], upper = stops[stops.length - 1]
    for (let j = 0; j < stops.length - 1; j++) {
      if (ratio >= stops[j][0] && ratio <= stops[j + 1][0]) {
        lower = stops[j]; upper = stops[j + 1]; break
      }
    }
    const range = upper[0] - lower[0]
    const t = range === 0 ? 0 : (ratio - lower[0]) / range
    lut[i * 4]     = Math.round(lower[1] + t * (upper[1] - lower[1]))
    lut[i * 4 + 1] = Math.round(lower[2] + t * (upper[2] - lower[2]))
    lut[i * 4 + 2] = Math.round(lower[3] + t * (upper[3] - lower[3]))
    lut[i * 4 + 3] = 255
  }
  return lut
}

// ══════════ Worker 通信 ══════════

interface PendingRequest {
  resolve: (value: any) => void
  reject: (reason: any) => void
}

class HeatmapWorker {
  private _worker: Worker
  private _nextId = 0
  private _pending = new Map<number, PendingRequest>()

  constructor() {
    this._worker = new Worker(
      new URL('../workers/cogRenderWorker.ts', import.meta.url),
      { type: 'module' }
    )
    this._worker.onmessage = (e: MessageEvent) => {
      const { requestId } = e.data
      if (requestId === undefined) return
      const p = this._pending.get(requestId)
      if (!p) return
      this._pending.delete(requestId)
      if (e.data.type === 'error') {
        p.reject(new Error(e.data.error))
      } else {
        p.resolve(e.data)
      }
    }
    this._worker.onerror = (e) => console.error('[Heatmap Worker] Error:', e)
  }

  private _send<T>(msg: Record<string, unknown>): Promise<T> {
    const requestId = this._nextId++
    return new Promise<T>((resolve, reject) => {
      this._pending.set(requestId, { resolve, reject })
      this._worker.postMessage({ ...msg, requestId })
    })
  }

  async open(id: string, url: string, bandIndex: number) {
    return this._send<{
      meta: { width: number; height: number; bandCount: number; bbox: [number, number, number, number]; noDataValue: number; overviewCount: number }
      stats: Record<number, BandStats>
    }>({
      type: 'open', id, url,
      renderMode: 'singleband',
      bandIndex,
      rgbBands: [0, 1, 2],
      colormap: 'gray',
      maxConcurrent: 6,
      geotiffCacheSize: 500
    })
  }

  async readBand(id: string, bandIndex: number, gridSize: number) {
    return this._send<{
      data: Float32Array
      width: number
      height: number
      stats: BandStats
    }>({ type: 'readBand', id, bandIndex, gridSize })
  }

  close(id: string) {
    this._worker.postMessage({ type: 'close', id })
  }

  terminate() {
    for (const [, p] of this._pending) {
      p.reject(new Error('Worker terminated'))
    }
    this._pending.clear()
    this._worker.terminate()
  }
}

// ══════════ Cesium 自定义着色器 ══════════

const HEATMAP_VS = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec4 color;
in float batchId;
out vec4 v_color;
void main() {
    vec4 p = czm_translateRelativeToEye(position3DHigh, position3DLow);
    gl_Position = czm_modelViewProjectionRelativeToEye * p;
    v_color = color;
}
`

const HEATMAP_FS = `
in vec4 v_color;
void main() {
    out_FragColor = v_color;
}
`

// ══════════ 网格构建 ══════════

function isInvalid(v: number, noData: number, hasNoData: boolean): boolean {
  return (hasNoData && v === noData) || v === -9999 || isNaN(v) || !isFinite(v)
}

function buildHeatmapMesh(params: {
  bandData: Float32Array
  gridW: number
  gridH: number
  bbox: [number, number, number, number]
  baseHeight: number
  heightScale: number
  colormap: CogColorMap
  stretch: CogStretchMode
  percentClip: number
  stats: BandStats
  noDataValue: number
  opacity: number
}): Cesium.Geometry | null {
  const {
    bandData, gridW, gridH, bbox, baseHeight, heightScale,
    colormap, stretch, percentClip, stats, noDataValue, opacity
  } = params
  const [west, south, east, north] = bbox
  const hasNoData = !isNaN(noDataValue)

  // 计算拉伸范围
  let vMin = stats.min, vMax = stats.max
  if (stretch === 'stddev') {
    vMin = stats.mean - 2 * stats.stddev
    vMax = stats.mean + 2 * stats.stddev
  } else if (stretch === 'percent') {
    const c = percentClip / 100
    vMin = stats.min + c * (stats.max - stats.min)
    vMax = stats.max - c * (stats.max - stats.min)
  }
  if (vMax <= vMin) vMax = vMin + 1e-6
  const range = vMax - vMin

  const lut = generateColorLUT(colormap)
  const alphaU8 = Math.round(Math.max(0, Math.min(1, opacity)) * 255)

  // 标记有效顶点
  const valid = new Uint8Array(gridW * gridH)
  for (let i = 0; i < gridW * gridH; i++) {
    valid[i] = isInvalid(bandData[i], noDataValue, hasNoData) ? 0 : 1
  }

  // 构建顶点位置和颜色
  const positions = new Float64Array(gridW * gridH * 3)
  const colors = new Uint8Array(gridW * gridH * 4)

  for (let row = 0; row < gridH; row++) {
    for (let col = 0; col < gridW; col++) {
      const idx = row * gridW + col
      const v = bandData[idx]

      const lon = west + (col / (gridW - 1)) * (east - west)
      const lat = north - (row / (gridH - 1)) * (north - south)

      let height = baseHeight
      if (valid[idx]) {
        const normalized = Math.max(0, Math.min(1, (v - vMin) / range))
        height = baseHeight + normalized * heightScale
      }

      const cart = Cesium.Cartesian3.fromDegrees(lon, lat, height)
      positions[idx * 3]     = cart.x
      positions[idx * 3 + 1] = cart.y
      positions[idx * 3 + 2] = cart.z

      if (valid[idx]) {
        const normalized = Math.max(0, Math.min(1, (v - vMin) / range))
        const lutIdx = Math.min(255, Math.round(normalized * 255))
        colors[idx * 4]     = lut[lutIdx * 4]
        colors[idx * 4 + 1] = lut[lutIdx * 4 + 1]
        colors[idx * 4 + 2] = lut[lutIdx * 4 + 2]
        colors[idx * 4 + 3] = alphaU8
      }
      // NoData 顶点 colors 保持全 0（透明）
    }
  }

  // 构建三角面片索引（跳过包含 NoData 顶点的三角形）
  const maxTriangles = (gridW - 1) * (gridH - 1) * 2
  const indices = new Uint32Array(maxTriangles * 3)
  let triCount = 0

  for (let row = 0; row < gridH - 1; row++) {
    for (let col = 0; col < gridW - 1; col++) {
      const tl = row * gridW + col
      const tr = tl + 1
      const bl = (row + 1) * gridW + col
      const br = bl + 1

      if (valid[tl] && valid[tr] && valid[bl]) {
        indices[triCount * 3]     = tl
        indices[triCount * 3 + 1] = tr
        indices[triCount * 3 + 2] = bl
        triCount++
      }
      if (valid[tr] && valid[br] && valid[bl]) {
        indices[triCount * 3]     = tr
        indices[triCount * 3 + 1] = br
        indices[triCount * 3 + 2] = bl
        triCount++
      }
    }
  }

  if (triCount === 0) return null

  const finalIndices = indices.slice(0, triCount * 3)

  // 计算包围球
  const center = Cesium.Cartesian3.fromDegrees(
    (west + east) / 2, (south + north) / 2, baseHeight + heightScale / 2
  )
  const corner = Cesium.Cartesian3.fromDegrees(east, north, baseHeight + heightScale)
  const radius = Cesium.Cartesian3.distance(center, corner)

  const attributes = new Cesium.GeometryAttributes()
  attributes.position = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.DOUBLE,
    componentsPerAttribute: 3,
    values: positions
  })
  attributes.color = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.UNSIGNED_BYTE,
    componentsPerAttribute: 4,
    normalize: true,
    values: colors
  })

  return new Cesium.Geometry({
    attributes,
    indices: finalIndices,
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: new Cesium.BoundingSphere(center, radius)
  })
}

// ══════════ Hook 主体 ══════════

export function useCogHeatmap(getViewer: () => any) {
  const heatmaps = new Map<string, HeatmapContext>()
  const worker = new HeatmapWorker()

  const defaultOptions: Required<CogHeatmapOptions> = {
    bandIndex: 0,
    colormap: 'jet',
    stretch: 'minmax',
    percentClip: 2,
    heightScale: 1.0,
    baseHeight: 0,
    gridSize: 256,
    opacity: 1,
    flyTo: true,
    flyDuration: 1.5,
    noDataValue: NaN
  }

  function createPrimitive(geometry: Cesium.Geometry): Cesium.Primitive {
    return new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({ geometry }),
      appearance: new Cesium.Appearance({
        vertexShaderSource: HEATMAP_VS,
        fragmentShaderSource: HEATMAP_FS,
        renderState: {
          depthTest: { enabled: true },
          depthMask: true,
          cull: { enabled: false },
          blending: Cesium.BlendingState.ALPHA_BLEND
        }
      }),
      asynchronous: false
    })
  }

  function removePrimitive(ctx: HeatmapContext) {
    const viewer = getViewer()
    if (ctx.primitive && viewer) {
      viewer.scene.primitives.remove(ctx.primitive)
      ctx.primitive = null
    }
  }

  function rebuildPrimitive(ctx: HeatmapContext) {
    const viewer = getViewer()
    if (!viewer) return

    removePrimitive(ctx)

    const geometry = buildHeatmapMesh({
      bandData: ctx.bandData,
      gridW: ctx.gridW,
      gridH: ctx.gridH,
      bbox: ctx.meta.bbox,
      baseHeight: ctx.options.baseHeight,
      heightScale: ctx.options.heightScale,
      colormap: ctx.options.colormap,
      stretch: ctx.options.stretch,
      percentClip: ctx.options.percentClip,
      stats: ctx.stats,
      noDataValue: ctx.meta.noDataValue,
      opacity: ctx.options.opacity
    })

    if (geometry) {
      ctx.primitive = createPrimitive(geometry)
      viewer.scene.primitives.add(ctx.primitive)
    }
    viewer.scene.requestRender()
  }

  const addHeatmap = async (id: string, url: string, options?: CogHeatmapOptions) => {
    const viewer = getViewer()
    if (!viewer) throw new Error('Viewer 未初始化')

    if (heatmaps.has(id)) removeHeatmap(id)

    const opts = { ...defaultOptions, ...options } as Required<CogHeatmapOptions>

    // 1. 打开 COG 文件
    const openResult = await worker.open(id, url, opts.bandIndex)
    const { meta: rawMeta } = openResult
    const effectiveNoData = !isNaN(opts.noDataValue) ? opts.noDataValue : rawMeta.noDataValue
    const meta: HeatmapMeta = { ...rawMeta, noDataValue: effectiveNoData }

    // 2. 读取波段原始数据
    const bandResult = await worker.readBand(id, opts.bandIndex, opts.gridSize)

    // 3. 构建上下文
    const ctx: HeatmapContext = {
      url, options: opts, meta,
      stats: bandResult.stats,
      bandData: bandResult.data,
      gridW: bandResult.width,
      gridH: bandResult.height,
      primitive: null
    }
    heatmaps.set(id, ctx)

    // 4. 构建网格并渲染
    rebuildPrimitive(ctx)

    // 5. 飞到范围
    if (opts.flyTo) {
      const [west, south, east, north] = meta.bbox
      viewer.camera.flyTo({
        destination: Cesium.Rectangle.fromDegrees(west, south, east, north),
        duration: opts.flyDuration
      })
    }

    return {
      id,
      bbox: meta.bbox,
      bandCount: meta.bandCount,
      width: meta.width,
      height: meta.height,
      gridW: bandResult.width,
      gridH: bandResult.height,
      stats: bandResult.stats
    }
  }

  const updateHeatmap = async (id: string, options: Partial<CogHeatmapOptions>) => {
    const ctx = heatmaps.get(id)
    if (!ctx) return

    const bandChanged = options.bandIndex !== undefined && options.bandIndex !== ctx.options.bandIndex
    const gridChanged = options.gridSize !== undefined && options.gridSize !== ctx.options.gridSize

    Object.assign(ctx.options, options)

    // 波段或网格密度变更 → 重新读取数据
    if (bandChanged || gridChanged) {
      const bandResult = await worker.readBand(id, ctx.options.bandIndex, ctx.options.gridSize)
      ctx.bandData = bandResult.data
      ctx.gridW = bandResult.width
      ctx.gridH = bandResult.height
      ctx.stats = bandResult.stats
    }

    rebuildPrimitive(ctx)
  }

  const removeHeatmap = (id: string) => {
    const ctx = heatmaps.get(id)
    if (!ctx) return
    removePrimitive(ctx)
    worker.close(id)
    heatmaps.delete(id)
  }

  const removeAllHeatmaps = () => {
    heatmaps.forEach((ctx, id) => {
      removePrimitive(ctx)
      worker.close(id)
    })
    heatmaps.clear()
  }

  const flyToHeatmap = (id: string, duration?: number) => {
    const viewer = getViewer()
    const ctx = heatmaps.get(id)
    if (!viewer || !ctx) return
    const [west, south, east, north] = ctx.meta.bbox
    viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(west, south, east, north),
      duration: duration ?? ctx.options.flyDuration
    })
  }

  const setVisibility = (id: string, visible: boolean) => {
    const ctx = heatmaps.get(id)
    if (!ctx?.primitive) return
    ctx.primitive.show = visible
    getViewer()?.scene.requestRender()
  }

  const getHeatmapInfo = (id: string) => {
    const ctx = heatmaps.get(id)
    if (!ctx) return null
    return {
      url: ctx.url,
      bbox: ctx.meta.bbox,
      bandCount: ctx.meta.bandCount,
      gridW: ctx.gridW,
      gridH: ctx.gridH,
      stats: ctx.stats,
      options: { ...ctx.options }
    }
  }

  const destroyHeatmapTools = () => {
    removeAllHeatmaps()
    worker.terminate()
  }

  return {
    addHeatmap,
    updateHeatmap,
    removeHeatmap,
    removeAllHeatmaps,
    flyToHeatmap,
    setVisibility,
    getHeatmapInfo,
    destroyHeatmapTools
  }
}

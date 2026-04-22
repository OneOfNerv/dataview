/**
 * Cesium COG (Cloud Optimized GeoTIFF) 图层 Hook — Worker Pool 版
 *
 * 与原版 API 100% 兼容，但所有 GeoTIFF I/O（readRasters）和像素渲染循环
 * 已移到 Web Worker Pool，主线程不再阻塞。
 *
 * 架构：
 *   Main Thread                          Worker Pool (N Workers)
 *   ────────────                          ────────────────────────
 *   CogImageryProvider                   GeoTIFF.fromUrl / readRasters
 *     ├─ LRU 缓存 (ImageBitmap)          GPU 像素渲染 (OffscreenCanvas + WebGL2)
 *     ├─ 请求取消 (epoch 版本号)          CPU Fallback (LUT / RGB)
 *     ├─ Canvas 对象池                    ↓
 *     └─ Cesium 集成               ──→ ImageBitmap (zero-copy transfer)
 *
 * 性能优化：
 *   1. Canvas 对象池复用
 *   2. 瓦片 LRU 缓存 (ImageBitmap → drawImage 近零开销)
 *   3. Worker Pool 多线程并行：N 个 Worker 同时处理瓦片，吞吐量提升 N 倍
 *   4. GPU 渲染：OffscreenCanvas + WebGL2 fragment shader 并行像素处理
 *   5. ImageBitmap zero-copy transfer，无序列化开销
 *   6. 请求取消：快速缩放/平移时自动丢弃过期瓦片响应
 *   7. ImageBitmap.close() 显式释放显存，防止泄漏
 *   8. updateOptions 直接修改参数 + 清空缓存，避免重建 Provider
 */
import * as Cesium from 'cesium'

//  类型定义
export type CogColorMap = 'gray' | 'jet' | 'hot' | 'terrain'
export type CogStretchMode = 'minmax' | 'stddev' | 'percent'
export type CogRenderMode = 'singleband' | 'rgb'
export interface CogLayerOptions {
  renderMode?: CogRenderMode
  bandIndex?: number
  rgbBands?: [number, number, number]
  colormap?: CogColorMap
  stretch?: CogStretchMode
  /** 百分比拉伸的截断百分比，默认 2（即 2%-98%） */
  percentClip?: number
  alpha?: number
  /** NoData 值，默认从文件元数据读取 */
  noDataValue?: number
  /** 自动飞到图层范围，默认 true */
  flyTo?: boolean
  /** 飞行持续时间，默认 1.5 */
  flyDuration?: number
  /** 最大瓦片级别，默认 22 */
  maximumLevel?: number
  /** 自定义最小瓦片级别，默认 0 */
  minimumLevel?: number
  /** 瓦片缓存最大数量，默认 256 */
  tileCacheSize?: number
  /** 最大并发 Range 请求数，默认 6 */
  maxConcurrent?: number
}

// 图层上下文（内部管理）
interface CogContext {
  url: string
  imageryLayer: Cesium.ImageryLayer
  provider: CogImageryProvider
  options: Required<CogLayerOptions>
  meta: CogMeta
}

interface CogMeta {
  width: number
  height: number
  bandCount: number
  bbox: [number, number, number, number]
  noDataValue: number
  overviewCount: number
  stats: Map<number, { min: number; max: number; mean: number; stddev: number }>
}

//Canvas 对象池 

const POOL_SIZE = 8

class CanvasPool {
  private _pool: HTMLCanvasElement[] = []

  acquire(w: number, h: number): HTMLCanvasElement {
    const c = this._pool.pop() ?? document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  }

  release(c: HTMLCanvasElement) {
    if (this._pool.length < POOL_SIZE) this._pool.push(c)
  }
}

const canvasPool = new CanvasPool()

// LRU 瓦片缓存

class LRUCache<V> {
  private _max: number
  private _map = new Map<string, V>()
  private _onEvict?: (value: V) => void

  constructor(max: number, onEvict?: (value: V) => void) {
    this._max = max
    this._onEvict = onEvict
  }

  get(key: string): V | undefined {
    if (!this._map.has(key)) return undefined
    const v = this._map.get(key)!
    this._map.delete(key)
    this._map.set(key, v)
    return v
  }

  set(key: string, value: V) {
    if (this._map.has(key)) {
      const old = this._map.get(key)!
      this._map.delete(key)
      if (old !== value) this._onEvict?.(old)
    }
    this._map.set(key, value)
    if (this._map.size > this._max) {
      const oldest = this._map.keys().next().value
      if (oldest !== undefined) {
        const evicted = this._map.get(oldest)!
        this._map.delete(oldest)
        this._onEvict?.(evicted)
      }
    }
  }

  clear() {
    if (this._onEvict) {
      this._map.forEach((v) => this._onEvict!(v))
    }
    this._map.clear()
  }

  get size() { return this._map.size }
}

//Worker Pool 

/** 默认 Worker 数量：CPU 核心数 / 2（至少 2，至多 6），避免超过浏览器并发连接限制 */
const DEFAULT_POOL_SIZE = Math.max(2, Math.min(6, Math.floor((navigator.hardwareConcurrency || 4) / 2)))

interface PendingRequest {
  resolve: (value: any) => void
  reject: (reason: any) => void
}

/**
 * Worker Pool — 管理多个 cogRenderWorker 实例
 *
 * - open / calcStats / close 广播给所有 Worker（每个 Worker 都需要持有 GeoTIFF 句柄）
 * - renderTile 轮询分发给空闲 Worker，实现多瓦片并行解码
 * - 支持请求取消：主线程标记 requestId 为已取消 → 响应到达时直接丢弃
 */
class CogWorkerPool {
  private _workers: Worker[] = []
  private _nextId = 0
  private _pending = new Map<number, PendingRequest>()
  private _cancelled = new Set<number>()  // 已取消的 requestId
  private _rrIndex = 0  // round-robin 下一个 Worker 索引
  private _poolSize: number

  constructor(poolSize: number = DEFAULT_POOL_SIZE) {
    this._poolSize = poolSize
    for (let i = 0; i < poolSize; i++) {
      const worker = new Worker(
        new URL('../workers/cogRenderWorker.ts', import.meta.url),
        { type: 'module' }
      )
      worker.onmessage = (e: MessageEvent) => this._handleMessage(e.data)
      worker.onerror = (e) => console.error(`[COG Worker #${i}] Error:`, e)
      this._workers.push(worker)
    }
    console.log(`[COG WorkerPool] Initialized with ${poolSize} workers`)
  }

  private _handleMessage(data: any) {
    const requestId: number | undefined = data.requestId
    if (requestId === undefined) return

    // 已取消的请求：丢弃响应，释放传入的 ImageBitmap
    if (this._cancelled.has(requestId)) {
      this._cancelled.delete(requestId)
      if (data.bitmap) (data.bitmap as ImageBitmap).close()
      return
    }

    const p = this._pending.get(requestId)
    if (!p) return
    this._pending.delete(requestId)

    if (data.type === 'error') {
      p.reject(new Error(data.error))
    } else {
      p.resolve(data)
    }
  }

  /** 向指定 Worker 发送消息 */
  private _sendTo<T>(workerIdx: number, msg: Record<string, unknown>): Promise<T> {
    const requestId = this._nextId++
    return new Promise<T>((resolve, reject) => {
      this._pending.set(requestId, { resolve, reject })
      this._workers[workerIdx].postMessage({ ...msg, requestId })
    })
  }

  /** 向所有 Worker 广播消息并等待全部完成（返回第一个的结果） */
  private async _broadcast<T>(msg: Record<string, unknown>): Promise<T> {
    const promises = this._workers.map((_, i) => this._sendTo<T>(i, msg))
    const results = await Promise.all(promises)
    return results[0]  // 所有 Worker 返回相同结果，取第一个
  }

  /** 向所有 Worker 广播 fire-and-forget 消息 */
  private _broadcastFireAndForget(msg: Record<string, unknown>) {
    for (const worker of this._workers) {
      worker.postMessage(msg)
    }
  }

  /** Round-robin 选择下一个 Worker */
  private _nextWorker(): number {
    const idx = this._rrIndex
    this._rrIndex = (this._rrIndex + 1) % this._poolSize
    return idx
  }

  /**
   * 打开 COG 文件 — 广播给所有 Worker
   */
  async open(id: string, url: string, opts: {
    renderMode: CogRenderMode
    bandIndex: number
    rgbBands: [number, number, number]
    colormap: CogColorMap
    maxConcurrent: number
    geotiffCacheSize: number
    noDataValue: number
  }) {
    return this._broadcast<{
      meta: {
        width: number; height: number; bandCount: number
        bbox: [number, number, number, number]
        noDataValue: number; overviewCount: number
      }
      stats: Record<number, { min: number; max: number; mean: number; stddev: number }>
    }>({
      type: 'open', id, url,
      renderMode: opts.renderMode,
      bandIndex: opts.bandIndex,
      rgbBands: opts.rgbBands,
      colormap: opts.colormap,
      maxConcurrent: opts.maxConcurrent,
      geotiffCacheSize: opts.geotiffCacheSize
    })
  }

  /**
   * 渲染一个瓦片 — 轮询分发给单个 Worker
   * @returns [requestId, Promise<ImageBitmap | null>]
   */
  renderTile(id: string, params: {
    tileWest: number; tileSouth: number
    tileEast: number; tileNorth: number
    tileWidth: number; tileHeight: number
    renderMode: CogRenderMode
    bandIndex: number
    rgbBands: [number, number, number]
    colormap: CogColorMap
    stretch: CogStretchMode
    percentClip: number
  }): { requestId: number; promise: Promise<ImageBitmap | null> } {
    const workerIdx = this._nextWorker()
    const requestId = this._nextId++

    const promise = new Promise<ImageBitmap | null>((resolve, reject) => {
      this._pending.set(requestId, {
        resolve: (data: any) => resolve(data.bitmap ?? null),
        reject
      })
      this._workers[workerIdx].postMessage({
        type: 'renderTile', id, ...params, requestId
      })
    })

    return { requestId, promise }
  }

  /**
   * 取消一个瓦片请求 — 响应到达时丢弃
   */
  cancelRequest(requestId: number) {
    if (this._pending.has(requestId)) {
      this._pending.delete(requestId)
      this._cancelled.add(requestId)
    }
  }

  /**
   * 重新计算指定波段的统计值 — 只需要一个 Worker 执行
   */
  async calcStats(id: string, bands: number[], sampleWidth: number, sampleHeight: number) {
    return this._sendTo<{
      stats: Record<number, { min: number; max: number; mean: number; stddev: number }>
    }>(0, {
      type: 'calcStats', id, bands, sampleWidth, sampleHeight
    })
  }

  /**
   * 释放一个图层的 GeoTIFF 资源 — 广播给所有 Worker
   */
  close(id: string) {
    this._broadcastFireAndForget({ type: 'close', id })
  }

  /**
   * 终止所有 Worker
   */
  terminate() {
    for (const [, p] of this._pending) {
      p.reject(new Error('Worker pool terminated'))
    }
    this._pending.clear()
    this._cancelled.clear()
    for (const worker of this._workers) {
      worker.terminate()
    }
    this._workers = []
  }
}

// 自定义 ImageryProvider

class CogImageryProvider {
  private _layerId: string
  private _workerPool: CogWorkerPool
  private _meta: CogMeta
  private _options: Required<CogLayerOptions>
  private _tilingScheme: Cesium.GeographicTilingScheme
  private _rectangle: Cesium.Rectangle
  private _tileWidth = 256
  private _tileHeight = 256
  private _errorEvent = new Cesium.Event()

  // 缓存
  private _tileCache: LRUCache<ImageBitmap>

  // 每次 updateOptions 递增 epoch，旧 epoch 的响应会被丢弃
  private _epoch = 0
  private _inflightRequests = new Map<number, number>() // requestId → epoch

  // 限制同时在途的瓦片请求数，防止网络拥塞
  private _maxConcurrent: number
  private _activeCount = 0
  private _queue: Array<{
    resolve: (v: HTMLCanvasElement | undefined) => void
    args: [number, number, number]
  }> = []

  constructor(
    layerId: string,
    workerPool: CogWorkerPool,
    meta: CogMeta,
    options: Required<CogLayerOptions>
  ) {
    this._layerId = layerId
    this._workerPool = workerPool
    this._meta = meta
    this._options = options
    this._tilingScheme = new Cesium.GeographicTilingScheme()
    this._tileCache = new LRUCache<ImageBitmap>(options.tileCacheSize, (bitmap) => {
      bitmap.close()  // 释放 GPU/显存资源
    })
    this._maxConcurrent = options.maxConcurrent

    const [west, south, east, north] = meta.bbox
    this._rectangle = Cesium.Rectangle.fromDegrees(west, south, east, north)
  }

  //  Cesium ImageryProvider 属性 
  get tileWidth()       { return this._tileWidth }
  get tileHeight()      { return this._tileHeight }
  get maximumLevel()    { return this._options.maximumLevel }
  get minimumLevel()    { return this._options.minimumLevel }
  get tilingScheme()    { return this._tilingScheme }
  get rectangle()       { return this._rectangle }
  get tileDiscardPolicy() { return undefined }
  get errorEvent()      { return this._errorEvent }
  get credit()          { return undefined as any }
  get hasAlphaChannel() { return true }
  get ready()           { return true }
  get proxy()           { return undefined }

  getTileCredits(): Cesium.Credit[] { return [] }

  /** 更新渲染参数，清空瓦片缓存强制重绘，取消所有在途请求 */
  updateOptions(opts: Partial<CogLayerOptions>) {
    if (opts.colormap !== undefined)   this._options.colormap = opts.colormap
    if (opts.stretch !== undefined)     this._options.stretch = opts.stretch
    if (opts.bandIndex !== undefined)   this._options.bandIndex = opts.bandIndex
    if (opts.rgbBands !== undefined)    this._options.rgbBands = opts.rgbBands
    if (opts.renderMode !== undefined)  this._options.renderMode = opts.renderMode
    if (opts.percentClip !== undefined) this._options.percentClip = opts.percentClip
    if (opts.noDataValue !== undefined) {
      this._options.noDataValue = opts.noDataValue
      this._meta.noDataValue = opts.noDataValue
    }
    this._tileCache.clear()

    // 递增 epoch，所有旧 epoch 的在途请求响应将被丢弃
    this._epoch++
    this._cancelInflightRequests()

    // 清空等待队列（快速参数切换时不再执行旧参数的请求）
    for (const q of this._queue) {
      q.resolve(undefined)
    }
    this._queue = []
  }

  /** 销毁，释放缓存 取消在途请求 清空队列 */
  destroy() {
    this._cancelInflightRequests()
    this._tileCache.clear()
    for (const q of this._queue) {
      q.resolve(undefined)
    }
    this._queue = []
  }

  /** 取消所有在途瓦片请求 */
  private _cancelInflightRequests() {
    for (const [reqId] of this._inflightRequests) {
      this._workerPool.cancelRequest(reqId)
    }
    this._inflightRequests.clear()
  }

  // Cesium 调用此方法获取瓦片
  async requestImage(x: number, y: number, level: number): Promise<HTMLCanvasElement | undefined> {
    const tileRect = this._tilingScheme.tileXYToRectangle(x, y, level)
    if (!Cesium.Rectangle.intersection(tileRect, this._rectangle, new Cesium.Rectangle())) {
      return undefined
    }

    // 缓存键包含所有影响渲染的参数
    const opts = this._options
    const cacheKey = `${x}_${y}_${level}_${opts.colormap}_${opts.stretch}_${opts.bandIndex}_${opts.renderMode}_${opts.stretch === 'percent' ? opts.percentClip : ''}`
    const cached = this._tileCache.get(cacheKey)
    if (cached) {
      return this._bitmapToCanvas(cached)
    }

    // 并发限制：超过上限时排队等待
    if (this._activeCount >= this._maxConcurrent) {
      return new Promise<HTMLCanvasElement | undefined>((resolve) => {
        this._queue.push({ resolve, args: [x, y, level] })
      })
    }

    return this._doRequestImage(x, y, level, cacheKey)
  }

  /** 实际执行瓦片请求（受并发控制） */
  private async _doRequestImage(x: number, y: number, level: number, cacheKey: string): Promise<HTMLCanvasElement | undefined> {
    this._activeCount++
    const opts = this._options
    const tileRect = this._tilingScheme.tileXYToRectangle(x, y, level)

    // 记录当前 epoch，用于后续校验响应是否过期
    const requestEpoch = this._epoch

    try {
      // Worker Pool 轮询分发，返回 requestId + promise
      const { requestId, promise } = this._workerPool.renderTile(this._layerId, {
        tileWest:  Cesium.Math.toDegrees(tileRect.west),
        tileSouth: Cesium.Math.toDegrees(tileRect.south),
        tileEast:  Cesium.Math.toDegrees(tileRect.east),
        tileNorth: Cesium.Math.toDegrees(tileRect.north),
        tileWidth:  this._tileWidth,
        tileHeight: this._tileHeight,
        renderMode: opts.renderMode,
        bandIndex:  opts.bandIndex,
        rgbBands:   opts.rgbBands,
        colormap:   opts.colormap,
        stretch:    opts.stretch,
        percentClip: opts.percentClip
      })
      this._inflightRequests.set(requestId, requestEpoch)

      const bitmap = await promise
      this._inflightRequests.delete(requestId)

      // 检查 epoch：如果在 await 期间参数已变更，丢弃响应
      if (this._epoch !== requestEpoch) {
        if (bitmap) bitmap.close()
        return undefined
      }

      if (bitmap) {
        this._tileCache.set(cacheKey, bitmap)
        return this._bitmapToCanvas(bitmap)
      }
      return undefined
    } catch {
      return undefined
    } finally {
      this._activeCount--
      this._drainQueue()
    }
  }

  /** 从等待队列取出下一个请求执行 */
  private _drainQueue() {
    while (this._queue.length > 0 && this._activeCount < this._maxConcurrent) {
      const next = this._queue.shift()!
      const [x, y, level] = next.args

      // 检查 epoch：排队期间参数可能已变更
      const opts = this._options
      const cacheKey = `${x}_${y}_${level}_${opts.colormap}_${opts.stretch}_${opts.bandIndex}_${opts.renderMode}_${opts.stretch === 'percent' ? opts.percentClip : ''}`
      const cached = this._tileCache.get(cacheKey)
      if (cached) {
        next.resolve(this._bitmapToCanvas(cached))
        continue
      }

      this._doRequestImage(x, y, level, cacheKey).then(next.resolve)
    }
  }

  /** 把 Worker 返回的 ImageBitmap 画到池化 Canvas */
  private _bitmapToCanvas(bitmap: ImageBitmap): HTMLCanvasElement {
    const TW = this._tileWidth, TH = this._tileHeight
    const canvas = canvasPool.acquire(TW, TH)
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, TW, TH)
    ctx.drawImage(bitmap, 0, 0)
    return canvas
  }
}

// Hook 主体

export function useCogTif(getViewer: () => any) {
  const cogLayers = new Map<string, CogContext>()

  // Worker Pool，共享给所有图层
  const workerPool = new CogWorkerPool()

  const defaultOptions: Required<CogLayerOptions> = {
    renderMode: 'singleband',
    bandIndex: 0,
    rgbBands: [0, 1, 2],
    colormap: 'gray',
    stretch: 'minmax',
    percentClip: 2,
    alpha: 1,
    noDataValue: NaN,
    flyTo: true,
    flyDuration: 1.5,
    maximumLevel: 22,
    minimumLevel: 0,
    tileCacheSize: 256,
    maxConcurrent: 6
  }

  const addCogLayer = async (id: string, url: string, options?: CogLayerOptions) => {
    const viewer = getViewer()
    if (!viewer) throw new Error('Viewer 未初始化')

    if (cogLayers.has(id)) removeCogLayer(id)

    const opts = { ...defaultOptions, ...options } as Required<CogLayerOptions>
    const requestedRenderMode = options?.renderMode

    // 1. Worker Pool 打开 COG 文件 + 初始统计（广播到所有 Worker）
    const result = await workerPool.open(id, url, {
      renderMode: opts.renderMode,
      bandIndex: opts.bandIndex,
      rgbBands: opts.rgbBands,
      colormap: opts.colormap,
      maxConcurrent: opts.maxConcurrent,
      geotiffCacheSize: 500,
      noDataValue: opts.noDataValue
    })

    const { meta: rawMeta, stats: statsObj } = result
    const { width, height, bandCount, bbox, noDataValue, overviewCount } = rawMeta

    // 覆盖 NoData
    const effectiveNoData = !isNaN(opts.noDataValue) ? opts.noDataValue : noDataValue

    if (!requestedRenderMode) {
      opts.renderMode = bandCount >= 3 ? 'rgb' : 'singleband'
    }
    const stats = new Map<number, { min: number; max: number; mean: number; stddev: number }>()
    for (const key of Object.keys(statsObj)) {
      stats.set(Number(key), statsObj[Number(key)])
    }

    const meta: CogMeta = { width, height, bandCount, bbox, noDataValue: effectiveNoData, overviewCount, stats }
    console.log('[COG] bbox:', bbox, 'width:', width, 'height:', height, 'bandCount:', bandCount)

    //创建 Provider（主线程 Cesium 集成 + Worker Pool）
    const provider = new CogImageryProvider(id, workerPool, meta, opts)
    const imageryLayer = new Cesium.ImageryLayer(provider as any)
    viewer.imageryLayers.add(imageryLayer)
    imageryLayer.alpha = opts.alpha
    cogLayers.set(id, { url, imageryLayer, provider, options: opts, meta })

    //飞到范围
    if (opts.flyTo) {
      const [west, south, east, north] = bbox
      viewer.camera.flyTo({
        destination: Cesium.Rectangle.fromDegrees(west, south, east, north),
        duration: opts.flyDuration
      })
    }

    viewer.scene.requestRender()

    return {
      id, bbox, bandCount, overviewCount, width, height,
      renderMode: opts.renderMode,
      stats: Object.fromEntries(stats)
    }
  }

  /**
   * 更新渲染参数
   */
  const updateCogLayer = async (id: string, options: Partial<CogLayerOptions>) => {
    const viewer = getViewer()
    const ctx = cogLayers.get(id)
    if (!viewer || !ctx) return

    Object.assign(ctx.options, options)

    // 如果切换了波段，在 Worker 中重新采样统计
    if (options.bandIndex !== undefined || options.rgbBands !== undefined || options.renderMode !== undefined) {
      const sampleBands = ctx.options.renderMode === 'rgb' ? ctx.options.rgbBands : [ctx.options.bandIndex]
      const sampleW = Math.min(ctx.meta.width, 512)
      const sampleH = Math.min(ctx.meta.height, 512)

      const result = await workerPool.calcStats(id, sampleBands, sampleW, sampleH)
      for (const key of Object.keys(result.stats)) {
        ctx.meta.stats.set(Number(key), result.stats[Number(key)])
      }
    }

    if (options.alpha !== undefined) {
      ctx.imageryLayer.alpha = Math.max(0, Math.min(1, options.alpha))
    }

    // 更新 Provider 参数
    ctx.provider.updateOptions(options)

    // 强制 Cesium 丢弃已缓存瓦片并重新请求
    const layerIndex = viewer.imageryLayers.indexOf(ctx.imageryLayer)
    viewer.imageryLayers.remove(ctx.imageryLayer, false)
    const newLayer = new Cesium.ImageryLayer(
      ctx.provider as any
    )
    viewer.imageryLayers.add(newLayer, layerIndex >= 0 ? layerIndex : undefined)
    newLayer.alpha = ctx.options.alpha
    ctx.imageryLayer = newLayer

    viewer.scene.requestRender()
  }

  /** 图层显隐 */
  const setCogLayerVisibility = (id: string, visible: boolean) => {
    const viewer = getViewer()
    const ctx = cogLayers.get(id)
    if (!viewer || !ctx) return
    ctx.imageryLayer.show = visible
    viewer.scene.requestRender()
  }

  /** 图层透明度 (0~1) */
  const setCogLayerOpacity = (id: string, alpha: number) => {
    const viewer = getViewer()
    const ctx = cogLayers.get(id)
    if (!viewer || !ctx) return
    ctx.imageryLayer.alpha = Math.max(0, Math.min(1, alpha))
    ctx.options.alpha = ctx.imageryLayer.alpha
    viewer.scene.requestRender()
  }

  /** 飞到图层范围 */
  const flyToCogLayer = (id: string, duration?: number) => {
    const viewer = getViewer()
    const ctx = cogLayers.get(id)
    if (!viewer || !ctx) return
    const [west, south, east, north] = ctx.meta.bbox
    viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(west, south, east, north),
      duration: duration ?? ctx.options.flyDuration
    })
  }

  /** 获取图层元信息 */
  const getCogLayerInfo = (id: string) => {
    const ctx = cogLayers.get(id)
    if (!ctx) return null
    return {
      url: ctx.url,
      bbox: ctx.meta.bbox,
      width: ctx.meta.width,
      height: ctx.meta.height,
      bandCount: ctx.meta.bandCount,
      overviewCount: ctx.meta.overviewCount,
      noDataValue: ctx.meta.noDataValue,
      renderMode: ctx.options.renderMode,
      colormap: ctx.options.colormap,
      stretch: ctx.options.stretch,
      stats: Object.fromEntries(ctx.meta.stats)
    }
  }

  /** 移除指定 COG 图层 */
  const removeCogLayer = (id: string) => {
    const viewer = getViewer()
    const ctx = cogLayers.get(id)
    if (!ctx) return
    ctx.provider.destroy()
    workerPool.close(id)
    if (viewer) {
      viewer.imageryLayers.remove(ctx.imageryLayer, true)
      viewer.scene.requestRender()
    }
    cogLayers.delete(id)
  }

  /** 移除所有 COG 图层 */
  const removeAllCogLayers = () => {
    const viewer = getViewer()
    cogLayers.forEach((ctx, id) => {
      ctx.provider.destroy()
      workerPool.close(id)
      if (viewer) viewer.imageryLayers.remove(ctx.imageryLayer, true)
    })
    cogLayers.clear()
    viewer?.scene.requestRender()
  }

  /** 销毁（组件 onUnmounted 时调用） */
  const destroyCogTools = () => {
    removeAllCogLayers()
    workerPool.terminate()
  }

  return {
    addCogLayer,
    updateCogLayer,
    setCogLayerVisibility,
    setCogLayerOpacity,
    flyToCogLayer,
    getCogLayerInfo,
    removeCogLayer,
    removeAllCogLayers,
    destroyCogTools
  }
}

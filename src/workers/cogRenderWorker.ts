/**
 * COG (Cloud Optimized GeoTIFF) Tile Render Worker
 *
 * 将 GeoTIFF 文件打开、readRasters I/O、像素渲染全部移到 Worker 线程，
 * 主线程不再因栅格解压 / 像素循环而阻塞 UI。
 *
 * 通信协议（Main <-> Worker）：
 *   open         → openResult    打开 COG 文件 + 返回元数据 + 初始波段统计
 *   renderTile   → tileResult    读取栅格 + 像素渲染 → 返回 ImageBitmap (zero-copy transfer)
 *   calcStats    → statsResult   重新采样指定波段统计（切波段时调用）
 *   close        → (无响应)      释放 GeoTIFF 资源
 *
 * 渲染引擎：
 *   优先使用 GPU (OffscreenCanvas + WebGL2) 并行渲染像素；
 *   不可用时自动 fallback 到 CPU JS 循环。
 */

import * as GeoTIFF from 'geotiff'
import { GpuTileRenderer } from './gpuTileRenderer'

//GPU 渲染器（单例）

const gpuRenderer = new GpuTileRenderer()
if (gpuRenderer.isAvailable()) {
  console.log('[COG Worker] GPU rendering enabled (OffscreenCanvas + WebGL2)')
} else {
  console.warn('[COG Worker] GPU not available, using CPU fallback')
}

type CogColorMap = 'gray' | 'jet' | 'hot' | 'terrain'
type CogStretchMode = 'minmax' | 'stddev' | 'percent'
type CogRenderMode = 'singleband' | 'rgb'

interface BandStats {
  min: number; max: number; mean: number; stddev: number
}

interface LayerState {
  tiff: GeoTIFF.GeoTIFF
  image: GeoTIFF.GeoTIFFImage
  images: GeoTIFF.GeoTIFFImage[]
  width: number
  height: number
  bbox: [number, number, number, number]
  noDataValue: number
  overviewCount: number
  bandCount: number
  stats: Map<number, BandStats>
}


const layers = new Map<string, LayerState>()

// LUT 缓存

const colorStops: Record<CogColorMap, number[][]> = {
  gray:    [[0, 0, 0, 0], [1, 255, 255, 255]],
  jet:     [[0, 0, 0, 128], [0.25, 0, 0, 255], [0.5, 0, 255, 255], [0.75, 255, 255, 0], [1, 255, 0, 0]],
  hot:     [[0, 0, 0, 0], [0.33, 255, 0, 0], [0.66, 255, 255, 0], [1, 255, 255, 255]],
  terrain: [[0, 43, 131, 186], [0.25, 171, 221, 164], [0.5, 255, 255, 191], [0.75, 253, 174, 97], [1, 215, 25, 28]]
}

function generateLUT(colormap: CogColorMap): Uint32Array {
  const stops = colorStops[colormap]
  const lut = new Uint32Array(256)
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
    const r = Math.round(lower[1] + t * (upper[1] - lower[1]))
    const g = Math.round(lower[2] + t * (upper[2] - lower[2]))
    const b = Math.round(lower[3] + t * (upper[3] - lower[3]))
    lut[i] = (0xFF << 24) | (b << 16) | (g << 8) | r
  }
  return lut
}

/** 所有色带的 LUT 只生成一次 */
const lutCache = new Map<CogColorMap, Uint32Array>()
function getLUT(colormap: CogColorMap): Uint32Array {
  let lut = lutCache.get(colormap)
  if (!lut) {
    lut = generateLUT(colormap)
    lutCache.set(colormap, lut)
  }
  return lut
}

// 统计值计算

function isInvalid(v: number, noData: number, hasNoData: boolean): boolean {
  return (hasNoData && v === noData) || v === -9999 || isNaN(v) || !isFinite(v)
}

function calculateBandStats(data: ArrayLike<number>, noData: number): BandStats {
  let min = Infinity, max = -Infinity, sum = 0, count = 0
  const hasNoData = !isNaN(noData)
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    if (isInvalid(v, noData, hasNoData)) continue
    if (v < min) min = v
    if (v > max) max = v
    sum += v; count++
  }
  if (count === 0) return { min: 0, max: 1, mean: 0, stddev: 1 }
  const mean = sum / count
  let varianceSum = 0
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    if (isInvalid(v, noData, hasNoData)) continue
    varianceSum += (v - mean) ** 2
  }
  return { min, max, mean, stddev: Math.sqrt(varianceSum / count) }
}

// 像素工具 

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}

// 消息处理 

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data
  try {
    switch (msg.type) {
      case 'open':        await handleOpen(msg); break
      case 'renderTile':  await handleRenderTile(msg); break
      case 'calcStats':   await handleCalcStats(msg); break
      case 'close':       handleClose(msg); break
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err)
    self.postMessage({ type: 'error', requestId: msg.requestId, error })
  }
}


async function handleOpen(msg: {
  requestId: number
  id: string
  url: string
  renderMode: CogRenderMode
  bandIndex: number
  rgbBands: [number, number, number]
  colormap: CogColorMap
  maxConcurrent: number
  geotiffCacheSize: number
}) {
  const tiff = await GeoTIFF.fromUrl(msg.url, {
    cacheSize: msg.geotiffCacheSize
  } as any)
  const image = await tiff.getImage()

  const width = image.getWidth()
  const height = image.getHeight()
  const bandCount = image.getSamplesPerPixel()
  const rawBbox = image.getBoundingBox()
  const bbox: [number, number, number, number] = [rawBbox[0], rawBbox[1], rawBbox[2], rawBbox[3]]
  const imageCount = await tiff.getImageCount()
  const overviewCount = imageCount - 1

  // 预加载所有概览级别的图像对象（用于后续根据请求分辨率自动选择）
  const images: GeoTIFF.GeoTIFFImage[] = [image]
  for (let i = 1; i < imageCount; i++) {
    try {
      images.push(await tiff.getImage(i))
    } catch {
      break  
    }
  }

  const fd = image.getFileDirectory()
  const noDataValue = (fd as any).GDAL_NODATA
    ? parseFloat((fd as any).GDAL_NODATA)
    : NaN

  // 采样统计
  const sampleBands = msg.renderMode === 'rgb' ? msg.rgbBands : [msg.bandIndex]
  const sampleW = Math.min(width, 512)
  const sampleH = Math.min(height, 512)
  const sampleRasters = await image.readRasters({
    width: sampleW, height: sampleH,
    samples: sampleBands,
    interleave: false
  })

  const stats = new Map<number, BandStats>()
  for (let i = 0; i < sampleBands.length; i++) {
    stats.set(sampleBands[i], calculateBandStats(sampleRasters[i] as any, noDataValue))
  }

  layers.set(msg.id, {
    tiff, image, images,
    width, height, bbox, noDataValue, overviewCount, bandCount,
    stats
  })

  // 返回元数据 + 统计（Map 不能直接 postMessage，转 Object）
  const statsObj: Record<number, BandStats> = {}
  stats.forEach((v, k) => { statsObj[k] = v })

  self.postMessage({
    type: 'openResult',
    requestId: msg.requestId,
    id: msg.id,
    meta: { width, height, bandCount, bbox, noDataValue, overviewCount },
    stats: statsObj
  })
}

// renderTile

async function handleRenderTile(msg: {
  requestId: number
  id: string
  tileWest: number
  tileSouth: number
  tileEast: number
  tileNorth: number
  tileWidth: number
  tileHeight: number
  renderMode: CogRenderMode
  bandIndex: number
  rgbBands: [number, number, number]
  colormap: CogColorMap
  stretch: CogStretchMode
  percentClip: number
}) {
  const layer = layers.get(msg.id)
  if (!layer) {
    self.postMessage({ type: 'tileResult', requestId: msg.requestId, bitmap: null })
    return
  }

  const { tiff, image, images, width, height, bbox, noDataValue, stats } = layer
  const TW = msg.tileWidth, TH = msg.tileHeight
  const hasNoData = !isNaN(noDataValue)

  // 瓦片地理范围
  const tW = msg.tileWest, tS = msg.tileSouth
  const tE = msg.tileEast, tN = msg.tileNorth

  const [cogW, cogS, cogE, cogN] = bbox
  const cogDegW = cogE - cogW, cogDegH = cogN - cogS

  // 裁剪到 COG 范围
  const cW = Math.max(tW, cogW), cS = Math.max(tS, cogS)
  const cE = Math.min(tE, cogE), cN = Math.min(tN, cogN)
  if (cW >= cE || cS >= cN) {
    self.postMessage({ type: 'tileResult', requestId: msg.requestId, bitmap: null })
    return
  }

  // 像素窗口
  const pxL = Math.floor(((cW - cogW) / cogDegW) * width)
  const pxT = Math.floor(((cogN - cN) / cogDegH) * height)
  const pxR = Math.ceil(((cE - cogW) / cogDegW) * width)
  const pxB = Math.ceil(((cogN - cS) / cogDegH) * height)

  // 渲染尺寸
  const tileDegW = tE - tW, tileDegH = tN - tS
  const renderW = Math.round(((cE - cW) / tileDegW) * TW)
  const renderH = Math.round(((cN - cS) / tileDegH) * TH)
  const finalRW = Math.max(1, Math.min(renderW, TW))
  const finalRH = Math.max(1, Math.min(renderH, TH))

  // 需要读取的波段
  const samples = msg.renderMode === 'rgb' ? [...msg.rgbBands] : [msg.bandIndex]

  // 根据瓦片请求的实际分辨率（像素窗口大小 vs 渲染尺寸），
  // 选择分辨率最接近但不低于渲染尺寸的概览级别，
  // 减少不必要的高分辨率数据传输。
  let selectedImage = image
  const srcPixelW = pxR - pxL
  const srcPixelH = pxB - pxT

  if (images.length > 1 && (srcPixelW > finalRW * 2 || srcPixelH > finalRH * 2)) {
    const ratio = Math.max(srcPixelW / finalRW, srcPixelH / finalRH)

    for (let i = 1; i < images.length; i++) {
      const ov = images[i]
      const ovW = ov.getWidth()
      const ovH = ov.getHeight()
      const ovRatio = Math.max(width / ovW, height / ovH)
      if (ovRatio <= ratio) {
        selectedImage = ov
      } else {
        break
      }
    }
  }

  // 根据选中的概览图像重新计算像素窗口
  const selW = selectedImage.getWidth()
  const selH = selectedImage.getHeight()
  let winL = pxL, winT = pxT, winR = pxR, winB = pxB
  if (selectedImage !== image) {
    const sx = selW / width, sy = selH / height
    winL = Math.floor(pxL * sx)
    winT = Math.floor(pxT * sy)
    winR = Math.ceil(pxR * sx)
    winB = Math.ceil(pxB * sy)
  }

  // geotiff.js readRasters: HTTP Range + COG 概览
  const rasters = await selectedImage.readRasters({
    window: [winL, winT, winR, winB],
    width: finalRW,
    height: finalRH,
    samples,
    interleave: false
  })

  // 偏移量（部分覆盖时）
  const dx = Math.round(((cW - tW) / tileDegW) * TW)
  const dy = Math.round(((tN - cN) / tileDegH) * TH)

  //  GPU 渲染
  if (gpuRenderer.isAvailable()) {
    let bitmap: ImageBitmap | null = null

    if (msg.renderMode === 'rgb') {
      const bandMin: [number, number, number] = [0, 0, 0]
      const bandMax: [number, number, number] = [255, 255, 255]
      for (let i = 0; i < 3; i++) {
        const bs = stats.get(msg.rgbBands[i])
        if (bs) {
          if (msg.stretch === 'minmax') {
            bandMin[i] = bs.min; bandMax[i] = bs.max
          } else if (msg.stretch === 'stddev') {
            bandMin[i] = bs.mean - 2 * bs.stddev
            bandMax[i] = bs.mean + 2 * bs.stddev
          } else if (msg.stretch === 'percent') {
            const c = msg.percentClip / 100
            bandMin[i] = bs.min + c * (bs.max - bs.min)
            bandMax[i] = bs.max - c * (bs.max - bs.min)
          }
          if (bandMax[i] <= bandMin[i]) bandMax[i] = bandMin[i] + 1e-6
        }
      }

      bitmap = gpuRenderer.renderRgb({
        rBand: rasters[0] as any,
        gBand: rasters[1] as any,
        bBand: rasters[2] as any,
        srcW: finalRW,
        srcH: finalRH,
        tileW: TW,
        tileH: TH,
        dx, dy,
        noData: noDataValue,
        hasNoData,
        bandMin,
        bandMax
      })
    } else {
      //计算拉伸范围
      const bandStats = stats.get(msg.bandIndex)
      if (!bandStats) {
        self.postMessage({ type: 'tileResult', requestId: msg.requestId, bitmap: null })
        return
      }

      let vMin = bandStats.min, vMax = bandStats.max
      if (msg.stretch === 'stddev') {
        vMin = bandStats.mean - 2 * bandStats.stddev
        vMax = bandStats.mean + 2 * bandStats.stddev
      } else if (msg.stretch === 'percent') {
        const c = msg.percentClip / 100
        vMin = bandStats.min + c * (bandStats.max - bandStats.min)
        vMax = bandStats.max - c * (bandStats.max - bandStats.min)
      }
      if (vMax <= vMin) vMax = vMin + 1e-6

      bitmap = gpuRenderer.renderSingleband({
        band: rasters[0] as any,
        srcW: finalRW,
        srcH: finalRH,
        tileW: TW,
        tileH: TH,
        dx, dy,
        colormap: msg.colormap,
        vMin, vMax,
        noData: noDataValue,
        hasNoData
      })
    }

    if (bitmap) {
      self.postMessage(
        { type: 'tileResult', requestId: msg.requestId, bitmap },
        [bitmap] as any
      )
      return
    }
  }

  //  CPU Fallback 渲染

  // 瓦片完全在 COG 范围内的快速路径
  const fullCover = (dx === 0 && dy === 0 && finalRW === TW && finalRH === TH)
  const total = finalRW * finalRH
  const px32 = new Uint32Array(TW * TH) // 全 0 = 透明

  if (msg.renderMode === 'rgb') {
    const rB = rasters[0] as any, gB = rasters[1] as any, bB = rasters[2] as any
    const bandMin: [number, number, number] = [0, 0, 0]
    const bandMax: [number, number, number] = [255, 255, 255]
    const bandRange: [number, number, number] = [255, 255, 255]
    for (let i = 0; i < 3; i++) {
      const bs = stats.get(msg.rgbBands[i])
      if (bs) {
        if (msg.stretch === 'minmax') {
          bandMin[i] = bs.min; bandMax[i] = bs.max
        } else if (msg.stretch === 'stddev') {
          bandMin[i] = bs.mean - 2 * bs.stddev
          bandMax[i] = bs.mean + 2 * bs.stddev
        } else if (msg.stretch === 'percent') {
          const c = msg.percentClip / 100
          bandMin[i] = bs.min + c * (bs.max - bs.min)
          bandMax[i] = bs.max - c * (bs.max - bs.min)
        }
        if (bandMax[i] <= bandMin[i]) bandMax[i] = bandMin[i] + 1e-6
      }
      bandRange[i] = bandMax[i] - bandMin[i]
    }

    if (fullCover) {
      // 瓦片完全在 COG 范围内，无需偏移计算
      for (let i = 0; i < total; i++) {
        const r = rB[i], g = gB[i], b = bB[i]
        if (isInvalid(r, noDataValue, hasNoData) || isInvalid(g, noDataValue, hasNoData) || isInvalid(b, noDataValue, hasNoData)) {
        } else {
          px32[i] = (0xFF << 24)
            | (clampByte((b - bandMin[2]) / bandRange[2] * 255) << 16)
            | (clampByte((g - bandMin[1]) / bandRange[1] * 255) << 8)
            | clampByte((r - bandMin[0]) / bandRange[0] * 255)
        }
      }
    } else {
      // 部分覆盖，需要偏移
      for (let row = 0; row < finalRH; row++) {
        const srcRow = row * finalRW
        const dstRow = (row + dy) * TW + dx
        for (let col = 0; col < finalRW; col++) {
          const si = srcRow + col
          const r = rB[si], g = gB[si], b = bB[si]
          if (isInvalid(r, noDataValue, hasNoData) || isInvalid(g, noDataValue, hasNoData) || isInvalid(b, noDataValue, hasNoData)) {
            // already 0
          } else {
            px32[dstRow + col] = (0xFF << 24)
              | (clampByte((b - bandMin[2]) / bandRange[2] * 255) << 16)
              | (clampByte((g - bandMin[1]) / bandRange[1] * 255) << 8)
              | clampByte((r - bandMin[0]) / bandRange[0] * 255)
          }
        }
      }
    }
  } else {
    const band = rasters[0] as any
    const bandStats = stats.get(msg.bandIndex)
    if (!bandStats) {
      self.postMessage({ type: 'tileResult', requestId: msg.requestId, bitmap: null })
      return
    }

    let vMin = bandStats.min, vMax = bandStats.max
    if (msg.stretch === 'stddev') {
      vMin = bandStats.mean - 2 * bandStats.stddev
      vMax = bandStats.mean + 2 * bandStats.stddev
    } else if (msg.stretch === 'percent') {
      const c = msg.percentClip / 100
      vMin = bandStats.min + c * (bandStats.max - bandStats.min)
      vMax = bandStats.max - c * (bandStats.max - bandStats.min)
    }
    if (vMax <= vMin) vMax = vMin + 1e-6
    const range = vMax - vMin
    const lut = getLUT(msg.colormap)

    if (fullCover) {
      for (let i = 0; i < total; i++) {
        const v = band[i]
        if (isInvalid(v, noDataValue, hasNoData)) {
          // already 0
        } else {
          const idx = Math.min(255, Math.max(0, Math.round((v - vMin) / range * 255)))
          px32[i] = lut[idx]
        }
      }
    } else {
      for (let row = 0; row < finalRH; row++) {
        const srcRow = row * finalRW
        const dstRow = (row + dy) * TW + dx
        for (let col = 0; col < finalRW; col++) {
          const v = band[srcRow + col]
          if (isInvalid(v, noDataValue, hasNoData)) {
            // already 0
          } else {
            const idx = Math.min(255, Math.max(0, Math.round((v - vMin) / range * 255)))
            px32[dstRow + col] = lut[idx]
          }
        }
      }
    }
  }

  // ImageData  createImageBitmap
  const imageData = new ImageData(new Uint8ClampedArray(px32.buffer), TW, TH)
  const bitmap = await createImageBitmap(imageData)

  // zero-copy transfer ImageBitmap 到主线程
  self.postMessage(
    { type: 'tileResult', requestId: msg.requestId, bitmap },
    [bitmap] as any
  )
}

async function handleCalcStats(msg: {
  requestId: number
  id: string
  bands: number[]
  sampleWidth: number
  sampleHeight: number
}) {
  const layer = layers.get(msg.id)
  if (!layer) {
    self.postMessage({
      type: 'statsResult', requestId: msg.requestId, stats: {}
    })
    return
  }

  const sampleRasters = await layer.image.readRasters({
    width: msg.sampleWidth,
    height: msg.sampleHeight,
    samples: msg.bands,
    interleave: false
  })

  const result: Record<number, BandStats> = {}
  for (let i = 0; i < msg.bands.length; i++) {
    const st = calculateBandStats(sampleRasters[i] as any, layer.noDataValue)
    result[msg.bands[i]] = st
    // 更新 Worker 内部缓存
    layer.stats.set(msg.bands[i], st)
  }

  self.postMessage({
    type: 'statsResult', requestId: msg.requestId, stats: result
  })
}

// ---------- close ----------

function handleClose(msg: { id: string }) {
  layers.delete(msg.id)
}

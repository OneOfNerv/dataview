/**
 * Cesium GeoTIFF 图层 Hook
 * - 支持从 URL 加载 GeoTIFF 文件，自动解析地理坐标和 NoData 值 parseTiffFromUrl
 * - 内置 min-max 和标准差拉伸两种增强显示模式 renderTiff
 * - 提供多种预设色带（灰度、Jet、Hot、Terrain）
 * - 使用 WebGL2 着色器实现高性能渲染，支持大尺寸 TIFF 的动态下采样 
 * - 提供清除渲染和销毁资源的函数，支持多图层管理  
 * 配合 useCesium Hook 获取 Viewer 实例，并在组件销毁时调用 destroyTiffTools 释放资源
 * 
 * @author Nerv
*/
import * as Cesium from 'cesium'
import * as GeoTIFF from 'geotiff'
export type StretchMode = 'minmax' | 'stddev'
export type ColorMap = 'gray' | 'jet' | 'hot' | 'terrain'

// 定义图层上下文接口，用于多图层隔离管理
interface TiffContext {
  entity: Cesium.Entity | null;
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  cache: {
    width: number;
    height: number;
    corners: number[];
    noDataValue: number;
    stats: { min: number; max: number; mean: number; stddev: number };
  };
  lutTexture: WebGLTexture | null;
}

export function useCesiumTiffPolygon(getViewer: () => any) {
  const tiffLayers = new Map<string, TiffContext>()

  // Cesium may cache textures by image identity; use a fresh canvas snapshot to force texture refresh.
  const snapshotCanvas = (source: HTMLCanvasElement) => {
    const target = document.createElement('canvas')
    target.width = source.width
    target.height = source.height
    const ctx2d = target.getContext('2d')
    if (ctx2d) ctx2d.drawImage(source, 0, 0)
    return target
  }

  // 着色器源码
  const vsSource = `#version 300 es
    in vec2 a_position;
    out vec2 v_texcoord;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      v_texcoord = a_position * 0.5 + 0.5;
    }
  `
  const fsSource = `#version 300 es
    precision highp float;
    in vec2 v_texcoord;
    uniform sampler2D u_data;
    uniform sampler2D u_lut;
    uniform float u_min;
    uniform float u_max;
    uniform float u_noData;
    out vec4 outColor;
    void main() {
      float val = texture(u_data, vec2(v_texcoord.x, 1.0 - v_texcoord.y)).r;
      if (val == u_noData || isnan(val)) {
        outColor = vec4(0.0); 
        return;
      }
      float ratio = clamp((val - u_min) / (u_max - u_min), 0.0, 1.0);
      outColor = texture(u_lut, vec2(ratio, 0.5));
    }
  `

  // 工具函数：计算统计值 
  const calculateStats = (data: any, noData: number) => {
    let min = Infinity, max = -Infinity, sum = 0, count = 0
    for (let i = 0; i < data.length; i++) {
      const val = data[i]
      if (val !== noData && !isNaN(val)) {
        if (val < min) min = val; if (val > max) max = val
        sum += val; count++
      }
    }
    const mean = sum / count
    let varianceSum = 0
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== noData && !isNaN(data[i])) {
        varianceSum += Math.pow(data[i] - mean, 2)
      }
    }
    const stddev = Math.sqrt(varianceSum / count)
    return { min, max, mean, stddev }
  }

  //提取 TIFF 精确旋转角点
  const extractTrueCorners = (image: any, width: number, height: number) => {
    const fd = image.getFileDirectory()
    let corners: number[] = []

    if (fd.ModelTransformation) {
      const m = fd.ModelTransformation
      const getCoord = (px: number, py: number) => [
        px * m[0] + py * m[1] + m[3], 
        px * m[4] + py * m[5] + m[7]  
      ]
      corners = [...getCoord(0, 0), ...getCoord(width, 0), ...getCoord(width, height), ...getCoord(0, height)]
    } else if (fd.ModelPixelScale && fd.ModelTiepoint) {
      const sX = fd.ModelPixelScale[0], sY = fd.ModelPixelScale[1]
      const tX = fd.ModelTiepoint[3], tY = fd.ModelTiepoint[4]
      const getCoord = (px: number, py: number) => [tX + px * sX, tY - py * sY]
      corners = [...getCoord(0, 0), ...getCoord(width, 0), ...getCoord(width, height), ...getCoord(0, height)]
    } else {
      const bbox = image.getBoundingBox()
      corners = [bbox[0], bbox[3], bbox[2], bbox[3], bbox[2], bbox[1], bbox[0], bbox[1]]
    }
    return corners
  }

  // 解析并初始化 WebGL
  const processTiffObject = async (id: string, tiff: any) => {
    const image = await tiff.getImage()
    const origW = image.getWidth(), origH = image.getHeight()
    const rasters = await image.readRasters()
    let rasterData = rasters[0]
    const fd = image.getFileDirectory()
    const noDataValue = fd.GDAL_NODATA ? parseFloat(fd.GDAL_NODATA) : -9999
    const corners = extractTrueCorners(image, origW, origH)
    const stats = calculateStats(rasterData, noDataValue)

    const MAX_TEX = 4096
    let texW = origW, texH = origH
    if (origW > MAX_TEX || origH > MAX_TEX) {
      const scale = MAX_TEX / Math.max(origW, origH)
      texW = Math.floor(origW * scale); texH = Math.floor(origH * scale)
      const downData = new Float32Array(texW * texH)
      for(let y=0; y<texH; y++) {
        for(let x=0; x<texW; x++) {
          downData[y * texW + x] = rasterData[Math.floor(y/scale) * origW + Math.floor(x/scale)]
        }
      }
      rasterData = downData
    }

    const canvas = document.createElement('canvas')
    canvas.width = texW; canvas.height = texH
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true })!
    
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src); gl.compileShader(s); return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSource))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSource))
    gl.linkProgram(prog); gl.useProgram(prog)

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'a_position')
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

    const tex = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, texW, texH, 0, gl.RED, gl.FLOAT, new Float32Array(rasterData))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.uniform1i(gl.getUniformLocation(prog, 'u_data'), 0); gl.uniform1i(gl.getUniformLocation(prog, 'u_lut'), 1)

    tiffLayers.set(id, { entity: null, canvas, gl, program: prog, cache: { width: texW, height: texH, corners, noDataValue, stats }, lutTexture: null })
  }

  //色带生成器
  const colorStops = {
    gray: [[0, 0,0,0], [1, 255,255,255]],
    jet: [[0, 0,0,128], [0.25, 0,0,255], [0.5, 0,255,255], [0.75, 255,255,0], [1, 255,0,0]],
    hot: [[0, 0,0,0], [0.33, 255,0,0], [0.66, 255,255,0], [1, 255,255,255]],
    terrain: [[0, 43,131,186], [0.25, 171,221,164], [0.5, 255,255,191], [0.75, 253,174,97], [1, 215,25,28]]
  }
  const generateLUT = (colormap: ColorMap) => {
    const stops = colorStops[colormap]
    const lut = new Uint8Array(256 * 4)
    for (let i = 0; i < 256; i++) {
      const ratio = i / 255
      let lower = stops[0], upper = stops[stops.length - 1]
      for (let j = 0; j < stops.length - 1; j++) {
        if (ratio >= stops[j][0] && ratio <= stops[j+1][0]) {
          lower = stops[j]; upper = stops[j+1]; break
        }
      }
      const range = upper[0] - lower[0]
      const t = range === 0 ? 0 : (ratio - lower[0]) / range
      lut[i*4]=Math.round(lower[1]+t*(upper[1]-lower[1])); lut[i*4+1]=Math.round(lower[2]+t*(upper[2]-lower[2])); lut[i*4+2]=Math.round(lower[3]+t*(upper[3]-lower[3])); lut[i*4+3]=255
    }
    return lut
  }

  // 公开方法
  const parseTiffFromUrl = async (id: string, url: string) => {
    const tiff = await GeoTIFF.fromUrl(url); await processTiffObject(id, tiff)
  }

  const renderTiff = (id: string, options: { stretch: StretchMode, colormap: ColorMap }) => {
    const viewer = getViewer(), ctx = tiffLayers.get(id)
    if (!viewer || !ctx) return
    const { gl, program, cache, canvas } = ctx, { width, height, corners, noDataValue, stats } = cache
    let vMin = stats.min, vMax = stats.max
    if (options.stretch === 'stddev') { vMin = stats.mean - 2 * stats.stddev; vMax = stats.mean + 2 * stats.stddev }
    if (!(vMax > vMin)) vMax = vMin + 1e-6

    gl.useProgram(program)
    gl.uniform1f(gl.getUniformLocation(program, 'u_min'), vMin)
    gl.uniform1f(gl.getUniformLocation(program, 'u_max'), vMax)
    gl.uniform1f(gl.getUniformLocation(program, 'u_noData'), noDataValue)

    if (!ctx.lutTexture) ctx.lutTexture = gl.createTexture()
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, ctx.lutTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, generateLUT(options.colormap))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.viewport(0, 0, width, height); gl.drawArrays(gl.TRIANGLES, 0, 6)

    // 更新或创建材质
    const materialCanvas = snapshotCanvas(canvas)
    const material = new Cesium.ImageMaterialProperty({ image: materialCanvas, transparent: true })
    if (!ctx.entity) {
      ctx.entity = viewer.entities.add({
        id: `tiff-polygon-${id}`,
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(corners),
          material: material,
          classificationType: Cesium.ClassificationType.TERRAIN
        }
      })
      viewer.flyTo(ctx.entity, { duration: 1.5 })
    } else if (ctx.entity?.polygon) {
      ctx.entity.polygon.material = material as any // 强制触发刷新
    }
    viewer.scene.requestRender()
  }

  const clearTiffRender = (id: string) => {
    const viewer = getViewer(), ctx = tiffLayers.get(id)
    if (viewer && ctx && ctx.entity) { viewer.entities.remove(ctx.entity); ctx.entity = null }
    viewer?.scene.requestRender()
  }

  const destroyTiffTools = () => {
    tiffLayers.forEach((_, id) => clearTiffRender(id)); tiffLayers.clear()
  }

  return { parseTiffFromUrl, renderTiff, clearTiffRender, destroyTiffTools }
}

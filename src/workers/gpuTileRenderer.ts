/**
 * GPU Tile Renderer — OffscreenCanvas + WebGL2
 *
 * 在 Worker 线程中使用 OffscreenCanvas 创建 WebGL2 上下文，
 * 将像素渲染（NoData 检测、归一化、LUT 查表、RGB pack）全部交给 GPU 并行完成。
 *
 *   1. 单个 OffscreenCanvas 复用所有瓦片，通过 resize + viewport 控制输出
 *   2. 两套 Fragment Shader：singleband (LUT 伪彩色) + rgb (三波段)
 *   3. LUT 纹理按 colormap 名称缓存，切换色带只更新纹理数据
 *   4. 部分覆盖通过 gl.viewport() 偏移，无需 CPU 逐行复制
 *   5. transferToImageBitmap() zero-copy 获取 GPU 渲染结果
 *   6. 若 OffscreenCanvas / WebGL2 不可用，isAvailable() 返回 false → 外部 fallback CPU
 */

type CogColorMap = 'gray' | 'jet' | 'hot' | 'terrain'

// GLSL 着色器

const VS_SOURCE = `#version 300 es
in vec2 a_position;
out vec2 v_texcoord;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  // [-1,1] → [0,1]，Y 翻转使纹理坐标从左上角开始
  v_texcoord = vec2(a_position.x * 0.5 + 0.5, 1.0 - (a_position.y * 0.5 + 0.5));
}
`

/** 单波段伪彩色：R32F 栅格 + 256×1 LUT 纹理 */
const FS_SINGLEBAND = `#version 300 es
precision highp float;
in vec2 v_texcoord;

uniform sampler2D u_data;
uniform sampler2D u_lut;
uniform float u_min;
uniform float u_max;
uniform float u_noData;
uniform float u_hasNoData;  // 1.0 = true, 0.0 = false

out vec4 outColor;

void main() {
  float val = texture(u_data, v_texcoord).r;

  // NoData / 无效值 → 全透明
  bool invalid = (u_hasNoData > 0.5 && val == u_noData)
              || val == -9999.0;
  // isnan 的 portable 检测 (val != val)
  if (invalid || val != val) {
    outColor = vec4(0.0);
    return;
  }

  float ratio = clamp((val - u_min) / (u_max - u_min), 0.0, 1.0);
  outColor = texture(u_lut, vec2(ratio, 0.5));
}
`

/** RGB 三波段：3 个 R32F 纹理 + 每波段独立 min/max 拉伸 */
const FS_RGB = `#version 300 es
precision highp float;
in vec2 v_texcoord;

uniform sampler2D u_rBand;
uniform sampler2D u_gBand;
uniform sampler2D u_bBand;
uniform float u_noData;
uniform float u_hasNoData;
// 每波段独立拉伸范围
uniform vec3 u_bandMin;  // [rMin, gMin, bMin]
uniform vec3 u_bandMax;  // [rMax, gMax, bMax]

out vec4 outColor;

void main() {
  float r = texture(u_rBand, v_texcoord).r;
  float g = texture(u_gBand, v_texcoord).r;
  float b = texture(u_bBand, v_texcoord).r;

  bool invalid = (u_hasNoData > 0.5 && (r == u_noData || g == u_noData || b == u_noData))
              || r == -9999.0;
  if (invalid || r != r || g != g || b != b) {
    outColor = vec4(0.0);
    return;
  }

  // 根据每波段 min/max 归一化拉伸到 [0, 1]
  outColor = vec4(
    clamp((r - u_bandMin.x) / (u_bandMax.x - u_bandMin.x), 0.0, 1.0),
    clamp((g - u_bandMin.y) / (u_bandMax.y - u_bandMin.y), 0.0, 1.0),
    clamp((b - u_bandMin.z) / (u_bandMax.z - u_bandMin.z), 0.0, 1.0),
    1.0
  );
}
`

//  LUT 色带

const COLOR_STOPS: Record<CogColorMap, number[][]> = {
  gray:    [[0, 0, 0, 0], [1, 255, 255, 255]],
  jet:     [[0, 0, 0, 128], [0.25, 0, 0, 255], [0.5, 0, 255, 255], [0.75, 255, 255, 0], [1, 255, 0, 0]],
  hot:     [[0, 0, 0, 0], [0.33, 255, 0, 0], [0.66, 255, 255, 0], [1, 255, 255, 255]],
  terrain: [[0, 43, 131, 186], [0.25, 171, 221, 164], [0.5, 255, 255, 191], [0.75, 253, 174, 97], [1, 215, 25, 28]]
}

function generateLUTData(colormap: CogColorMap): Uint8Array {
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

// GPU Tile Renderer 

export class GpuTileRenderer {
  private _canvas: OffscreenCanvas | null = null
  private _gl: WebGL2RenderingContext | null = null
  private _available = false

  private _singlebandProg: WebGLProgram | null = null
  private _rgbProg: WebGLProgram | null = null

  private _sbLocs: Record<string, WebGLUniformLocation | null> = {}
  private _rgbLocs: Record<string, WebGLUniformLocation | null> = {}

  private _dataTexture: WebGLTexture | null = null
  private _lutTexture: WebGLTexture | null = null
  private _rgbTextures: [WebGLTexture | null, WebGLTexture | null, WebGLTexture | null] = [null, null, null]

  private _currentLutColormap: CogColorMap | null = null
  private _canvasW = 0
  private _canvasH = 0

  private _dataTexW = 0
  private _dataTexH = 0
  private _rgbTexW: [number, number, number] = [0, 0, 0]
  private _rgbTexH: [number, number, number] = [0, 0, 0]

  constructor() {
    try {
      // Worker 中创建 OffscreenCanvas
      if (typeof OffscreenCanvas === 'undefined') {
        console.warn('[GpuTileRenderer] OffscreenCanvas not available')
        return
      }

      this._canvas = new OffscreenCanvas(256, 256)
      this._canvasW = 256
      this._canvasH = 256

      const gl = this._canvas.getContext('webgl2', {
        premultipliedAlpha: false,
        preserveDrawingBuffer: false, // transferToImageBitmap 不需要 preserve
        antialias: false,
        depth: false,
        stencil: false,
      })

      if (!gl) {
        console.warn('[GpuTileRenderer] WebGL2 not available in Worker')
        return
      }

      this._gl = gl
      // WebGL2 保证 R32F 可采样，所以无需额外扩展
      // 编译着色器
      this._singlebandProg = this._createProgram(VS_SOURCE, FS_SINGLEBAND)
      this._rgbProg = this._createProgram(VS_SOURCE, FS_RGB)

      if (!this._singlebandProg || !this._rgbProg) {
        console.warn('[GpuTileRenderer] Shader compilation failed')
        return
      }

      // 缓存 uniform locations
      this._sbLocs = {
        u_data:      gl.getUniformLocation(this._singlebandProg, 'u_data'),
        u_lut:       gl.getUniformLocation(this._singlebandProg, 'u_lut'),
        u_min:       gl.getUniformLocation(this._singlebandProg, 'u_min'),
        u_max:       gl.getUniformLocation(this._singlebandProg, 'u_max'),
        u_noData:    gl.getUniformLocation(this._singlebandProg, 'u_noData'),
        u_hasNoData: gl.getUniformLocation(this._singlebandProg, 'u_hasNoData'),
      }
      this._rgbLocs = {
        u_rBand:     gl.getUniformLocation(this._rgbProg, 'u_rBand'),
        u_gBand:     gl.getUniformLocation(this._rgbProg, 'u_gBand'),
        u_bBand:     gl.getUniformLocation(this._rgbProg, 'u_bBand'),
        u_noData:    gl.getUniformLocation(this._rgbProg, 'u_noData'),
        u_hasNoData: gl.getUniformLocation(this._rgbProg, 'u_hasNoData'),
        u_bandMin:   gl.getUniformLocation(this._rgbProg, 'u_bandMin'),
        u_bandMax:   gl.getUniformLocation(this._rgbProg, 'u_bandMax'),
      }

      this._setupQuadVAO()
      this._dataTexture = gl.createTexture()
      this._lutTexture = gl.createTexture()
      this._rgbTextures = [gl.createTexture(), gl.createTexture(), gl.createTexture()]
      for (const tex of [this._dataTexture, ...this._rgbTextures]) {
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      }
      gl.bindTexture(gl.TEXTURE_2D, this._lutTexture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.bindTexture(gl.TEXTURE_2D, null)

      // 透明
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

      this._available = true
      console.log('[GpuTileRenderer] GPU rendering initialized successfully')
    } catch (e) {
      console.warn('[GpuTileRenderer] Initialization failed:', e)
    }
  }

  /** GPU 是否可用 */
  isAvailable(): boolean {
    return this._available
  }

  /**
   * 单波段伪彩色 GPU 渲染
   * @returns ImageBitmap (zero-copy) 或 null (需要 CPU fallback)
   */
  renderSingleband(opts: {
    band: ArrayLike<number>
    srcW: number
    srcH: number
    tileW: number
    tileH: number
    dx: number
    dy: number
    colormap: CogColorMap
    vMin: number
    vMax: number
    noData: number
    hasNoData: boolean
  }): ImageBitmap | null {
    const gl = this._gl
    const canvas = this._canvas
    if (!gl || !canvas || !this._singlebandProg) return null

    try {
      const { band, srcW, srcH, tileW, tileH, dx, dy, colormap, vMin, vMax, noData, hasNoData } = opts

      this._ensureCanvasSize(tileW, tileH)
      gl.useProgram(this._singlebandProg)
      gl.activeTexture(gl.TEXTURE0)
      const floatData = band instanceof Float32Array ? band : new Float32Array(band as any)
      const newSz = this._uploadR32F(this._dataTexture, floatData, srcW, srcH, this._dataTexW, this._dataTexH)
      this._dataTexW = newSz.w; this._dataTexH = newSz.h
      gl.uniform1i(this._sbLocs.u_data!, 0)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this._lutTexture)
      if (this._currentLutColormap !== colormap) {
        const lutData = generateLUTData(colormap)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lutData)
        this._currentLutColormap = colormap
      }
      gl.uniform1i(this._sbLocs.u_lut!, 1)

      gl.uniform1f(this._sbLocs.u_min!, vMin)
      gl.uniform1f(this._sbLocs.u_max!, vMax)
      gl.uniform1f(this._sbLocs.u_noData!, noData)
      gl.uniform1f(this._sbLocs.u_hasNoData!, hasNoData ? 1.0 : 0.0)

      gl.clearColor(0, 0, 0, 0)
      gl.viewport(0, 0, tileW, tileH)
      gl.clear(gl.COLOR_BUFFER_BIT)

      // 部分覆盖：通过 viewport 偏移
      // WebGL viewport Y 轴从底部开始，所以 dy 需要翻转
      gl.viewport(dx, tileH - dy - srcH, srcW, srcH)

      gl.drawArrays(gl.TRIANGLES, 0, 6)

     // zero-copy 提取 ImageBitmap
      return canvas.transferToImageBitmap()
    } catch (e) {
      console.warn('[GpuTileRenderer] Singleband render failed:', e)
      return null
    }
  }

  /**
   * RGB 三波段 GPU 渲染（支持每波段独立拉伸）
   * @returns ImageBitmap (zero-copy) 或 null (需要 CPU fallback)
   */
  renderRgb(opts: {
    rBand: ArrayLike<number>
    gBand: ArrayLike<number>
    bBand: ArrayLike<number>
    srcW: number
    srcH: number
    tileW: number
    tileH: number
    dx: number
    dy: number
    noData: number
    hasNoData: boolean
    bandMin: [number, number, number]
    bandMax: [number, number, number]
  }): ImageBitmap | null {
    const gl = this._gl
    const canvas = this._canvas
    if (!gl || !canvas || !this._rgbProg) return null

    try {
      const { rBand, gBand, bBand, srcW, srcH, tileW, tileH, dx, dy, noData, hasNoData, bandMin, bandMax } = opts

      this._ensureCanvasSize(tileW, tileH)

      gl.useProgram(this._rgbProg)

      // 上传 3 个波段纹理
      const bands = [rBand, gBand, bBand]
      const texUnits = [gl.TEXTURE0, gl.TEXTURE1, gl.TEXTURE2]
      const locs = [this._rgbLocs.u_rBand!, this._rgbLocs.u_gBand!, this._rgbLocs.u_bBand!]

      for (let i = 0; i < 3; i++) {
        gl.activeTexture(texUnits[i])
        const floatData = bands[i] instanceof Float32Array ? bands[i] as Float32Array : new Float32Array(bands[i] as any)
        const newSz = this._uploadR32F(this._rgbTextures[i], floatData, srcW, srcH, this._rgbTexW[i], this._rgbTexH[i])
        this._rgbTexW[i] = newSz.w; this._rgbTexH[i] = newSz.h
        gl.uniform1i(locs[i], i)
      }

      gl.uniform1f(this._rgbLocs.u_noData!, noData)
      gl.uniform1f(this._rgbLocs.u_hasNoData!, hasNoData ? 1.0 : 0.0)
      gl.uniform3f(this._rgbLocs.u_bandMin!, bandMin[0], bandMin[1], bandMin[2])
      gl.uniform3f(this._rgbLocs.u_bandMax!, bandMax[0], bandMax[1], bandMax[2])

      // 清空 + viewport
      gl.clearColor(0, 0, 0, 0)
      gl.viewport(0, 0, tileW, tileH)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.viewport(dx, tileH - dy - srcH, srcW, srcH)

      // 绘制
      gl.drawArrays(gl.TRIANGLES, 0, 6)

      return canvas.transferToImageBitmap()
    } catch (e) {
      console.warn('[GpuTileRenderer] RGB render failed:', e)
      return null
    }
  }

  /** 销毁 GPU 资源 */
  destroy() {
    const gl = this._gl
    if (!gl) return

    if (this._dataTexture) gl.deleteTexture(this._dataTexture)
    if (this._lutTexture) gl.deleteTexture(this._lutTexture)
    for (const t of this._rgbTextures) {
      if (t) gl.deleteTexture(t)
    }
    if (this._singlebandProg) gl.deleteProgram(this._singlebandProg)
    if (this._rgbProg) gl.deleteProgram(this._rgbProg)

    this._available = false
    this._gl = null
    this._canvas = null
  }

  // ==================== 内部方法 ====================

  /**
   * 尺寸相同时用 texSubImage2D 只更新数据，
   * 避免 texImage2D 重新分配 GPU 内存的开销。
   */
  private _uploadR32F(
    tex: WebGLTexture | null,
    data: Float32Array,
    w: number, h: number,
    trackedW: number, trackedH: number
  ): { w: number; h: number } {
    const gl = this._gl!
    gl.bindTexture(gl.TEXTURE_2D, tex)

    if (trackedW === w && trackedH === h) {
      // 仅更新像素数据（避免 GPU 内存重分配）
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.FLOAT, data)
    } else {
      // 尺寸变化时重新分配纹理
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, data)
    }

    return { w, h }
  }

  /** 确保 OffscreenCanvas 尺寸匹配瓦片大小 */
  private _ensureCanvasSize(w: number, h: number) {
    if (this._canvasW !== w || this._canvasH !== h) {
      this._canvas!.width = w
      this._canvas!.height = h
      this._canvasW = w
      this._canvasH = h
    }
  }

  /** 链接着色器程序 */
  private _createProgram(vsSrc: string, fsSrc: string): WebGLProgram | null {
    const gl = this._gl!
    const vs = this._compileShader(gl.VERTEX_SHADER, vsSrc)
    const fs = this._compileShader(gl.FRAGMENT_SHADER, fsSrc)
    if (!vs || !fs) return null

    const prog = gl.createProgram()!
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('[GpuTileRenderer] Program link error:', gl.getProgramInfoLog(prog))
      gl.deleteProgram(prog)
      return null
    }

    // 着色器已链接，删除着色器对象
    gl.deleteShader(vs)
    gl.deleteShader(fs)

    return prog
  }

  /** 编译单个着色器 */
  private _compileShader(type: number, source: string): WebGLShader | null {
    const gl = this._gl!
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(
        `[GpuTileRenderer] Shader compile error (${type === gl.VERTEX_SHADER ? 'VS' : 'FS'}):`,
        gl.getShaderInfoLog(shader)
      )
      gl.deleteShader(shader)
      return null
    }

    return shader
  }

  /** 设置全屏四边形 VAO (共享两套 shader) */
  private _setupQuadVAO() {
    const gl = this._gl!

    const quadVertices = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1,
    ])

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW)

    // 为两个 program 设置 a_position attribute
    for (const prog of [this._singlebandProg!, this._rgbProg!]) {
      const loc = gl.getAttribLocation(prog, 'a_position')
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc)
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
      }
    }
  }
}

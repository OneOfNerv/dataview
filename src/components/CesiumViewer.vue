<template>
  <div class="toolbar">
    <button @click="drawTools.drawLine()">画线</button>
    <button @click="drawTools.drawPolygon()">画面</button>
    <button @click="drawTools.clearDrawings()">清空绘制</button>
    <button @click="measureTools.measureLength()">测距</button>
    <button @click="measureTools.measureArea()">测面</button>
    <button @click="measureTools.measureHeight()">测高</button>
    <button @click="measureTools.clearAllMeasurements()">清空量测</button>
    <button @click="boxTools.addRectangle({id: 'rect-001',wkt: wktstring,name: '主测四至'})">添加四至</button>
    <button @click="boxTools.applyImageToRectangle('rect-001', 'http://dm.xiopmspace.com:9090/dm/rest/file/browse?id=49120&fileType=1')">贴图</button>
    <button @click="boxTools.removeRectangle('rect-001')">移除四至</button>
    <button @click="controls.toggle2D3D()">切换3D/2D</button>
    <button @click="controls.zoomIn()">放大</button>
    <button @click="controls.zoomOut()">缩小</button>
    <button @click="controls.resetHome()">复位</button>
    <button @click="triggerUpload()">上传 KML</button>
    <button @click="draw_Ins()">绘制并计算与四至相交范围</button>
    <button @click="wktTools.clearIntersection('my-intersection')">清除裁剪范围</button>
    <button @click="runNadirDemo()">星下点轨迹示例</button>
    <button @click="clearNadirDemo()">清理星下点轨迹</button>
    <input 
      type="file" 
      ref="fileInputRef" 
      accept=".kml,.kmz" 
      style="display: none" 
      @change="handleFileUpload" 
    />
    <button @click="kmlTools.clearAllKml()">清空 KML</button>

    <span class="divider">|</span>
    <button @click="onUrlLoad" :disabled="isLoading" class="btn-tiff">
      {{ isLoading ? '解析中...' : '加载单波段 TIFF' }}
    </button>

    <span class="divider">|</span>
    <span class="axis-label">事件轴示例:</span>
    <button
      v-for="item in axisItems"
      :key="item.id"
      class="btn-axis"
      :class="{ active: activeAxisId === item.id }"
      @click="onAxisItemClick(item.id)"
    >
      {{ item.label }}
    </button>
    <button class="btn-axis" @click="switchPrevAxis">上一项</button>
    <button class="btn-axis" @click="switchNextAxis">下一项</button>
    <span class="axis-status">当前：{{ activeAxisId || '-' }}</span>
    
    <template v-if="hasData">
      <select v-model="renderConfig.stretch" @change="applyRender">
        <option value="minmax">极值拉伸 (Min-Max)</option>
        <option value="stddev">标准差拉伸 (2 StdDev)</option>
      </select>

      <div class="colormap-picker">
        <div class="color-item" :class="{ active: renderConfig.colormap === 'gray' }" @click="selectColorMap('gray')" title="灰度">
          <div class="gradient gradient-gray"></div>
        </div>
        <div class="color-item" :class="{ active: renderConfig.colormap === 'jet' }" @click="selectColorMap('jet')" title="彩虹">
          <div class="gradient gradient-jet"></div>
        </div>
        <div class="color-item" :class="{ active: renderConfig.colormap === 'hot' }" @click="selectColorMap('hot')" title="热力">
          <div class="gradient gradient-hot"></div>
        </div>
        <div class="color-item" :class="{ active: renderConfig.colormap === 'terrain' }" @click="selectColorMap('terrain')" title="地形">
          <div class="gradient gradient-terrain"></div>
        </div>
      </div>

      <button @click="clearData" class="btn-danger">清除 TIFF</button>
    </template>

    <span class="divider">|</span>
    <span class="axis-label">COG:</span>
    <button @click="onCogLoad" :disabled="cogLoading" class="btn-tiff">
      {{ cogLoading ? '加载中...' : '加载 COG' }}
    </button>
    <template v-if="cogLoaded && cogInfo">
      <select v-model="cogConfig.renderMode" @change="applyCogUpdate" title="渲染模式">
        <option value="singleband">单波段</option>
        <option v-if="cogInfo.bandCount >= 3" value="rgb">RGB 合成</option>
      </select>

      <template v-if="cogConfig.renderMode === 'rgb'">
        <div class="band-selectors">
          <label class="band-label r">R
            <select :value="cogConfig.rgbBands[0]" @change="setRgbBand(0, +($event.target as HTMLSelectElement).value)">
              <option v-for="b in bandOptions" :key="b" :value="b">B{{ b + 1 }}</option>
            </select>
          </label>
          <label class="band-label g">G
            <select :value="cogConfig.rgbBands[1]" @change="setRgbBand(1, +($event.target as HTMLSelectElement).value)">
              <option v-for="b in bandOptions" :key="b" :value="b">B{{ b + 1 }}</option>
            </select>
          </label>
          <label class="band-label b">B
            <select :value="cogConfig.rgbBands[2]" @change="setRgbBand(2, +($event.target as HTMLSelectElement).value)">
              <option v-for="b in bandOptions" :key="b" :value="b">B{{ b + 1 }}</option>
            </select>
          </label>
        </div>
      </template>

      <template v-else>
        <select v-model.number="cogConfig.bandIndex" @change="applyCogUpdate" title="波段">
          <option v-for="b in bandOptions" :key="b" :value="b">Band {{ b + 1 }}</option>
        </select>
        <div class="colormap-picker">
          <div class="color-item" :class="{ active: cogConfig.colormap === 'gray' }" @click="selectCogColorMap('gray')" title="灰度">
            <div class="gradient gradient-gray"></div>
          </div>
          <div class="color-item" :class="{ active: cogConfig.colormap === 'jet' }" @click="selectCogColorMap('jet')" title="彩虹">
            <div class="gradient gradient-jet"></div>
          </div>
          <div class="color-item" :class="{ active: cogConfig.colormap === 'hot' }" @click="selectCogColorMap('hot')" title="热力">
            <div class="gradient gradient-hot"></div>
          </div>
          <div class="color-item" :class="{ active: cogConfig.colormap === 'terrain' }" @click="selectCogColorMap('terrain')" title="地形">
            <div class="gradient gradient-terrain"></div>
          </div>
        </div>
      </template>

      <select v-model="cogConfig.stretch" @change="applyCogUpdate">
        <option value="minmax">极值拉伸</option>
        <option value="stddev">标准差拉伸</option>
        <option value="percent">百分比拉伸</option>
      </select>

      <button @click="clearCogData" class="btn-danger">清除 COG</button>
    </template>
  </div>

  <div id="cesiumContainer" class="w-full h-full">
    <CogLegend
      v-if="cogLoaded && cogInfo"
      :colormap="cogConfig.colormap"
      :stretch="cogConfig.stretch"
      :stats="currentBandStats"
      :render-mode="cogConfig.renderMode"
      :band-index="cogConfig.bandIndex"
      :rgb-bands="cogConfig.rgbBands"
    />
    <div class="scale-display">
      <span>比例尺：{{ controls.scaleText }}</span>
      <span style="margin-left: 20px;">📷 相机位置：{{ controls.cameraPosition.longitude }}°, {{ controls.cameraPosition.latitude }}°</span>
      <span style="margin-left: 20px;">🖱️ 鼠标拾取：{{ controls.mousePosition.longitude }}°, {{ controls.mousePosition.latitude }}° (海拔 {{ controls.mousePosition.altitude }}m)</span>
      <span style="margin-left: 20px; font-weight: bold; color: #4ade80;">FPS：{{ controls.fps }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import * as Cesium from 'cesium'
import { useCesium } from '../hooks/useCesium' 
import { useCesiumBoundingBox } from '../hooks/useCesiumBoundingBox'
import { useCesiumDraw } from '../hooks/useCesiumDraw'
import { useCesiumMeasure } from '../hooks/useCesiumMeasure'
import { useCesiumControls } from '../hooks/useCesiumControls'
import { useCesiumKml } from '../hooks/useCesiumkml'
import { useCesiumTiffPolygon } from '../hooks/useCesiumGeoTiff'
import type { StretchMode, ColorMap } from '../hooks/useCesiumGeoTiff'
import { useCesiumTimelineLayerSwitch } from '../hooks/useCesiumTimelineLayerSwitch'
import { useWktIntersection } from '../hooks/useWktIntersection'
import { useNadirAreaTrackAnalysis } from '../hooks/useNadirAreaTrackAnalysis'
import { useCogTif } from '../hooks/useCogTif'
import type { CogColorMap as CogCMap, CogStretchMode as CogSMode, CogRenderMode } from '../hooks/useCogTif'
import CogLegend from './CogLegend.vue'

const { getViewer, initmap, destroyCesium } = useCesium()
const wktTools = useWktIntersection(getViewer)
const nadirAreaTools = useNadirAreaTrackAnalysis(getViewer)
const boxTools = useCesiumBoundingBox(getViewer)
const drawTools = useCesiumDraw(getViewer)
const measureTools = useCesiumMeasure(getViewer)
const controls = useCesiumControls(getViewer)
const kmlTools = useCesiumKml(getViewer)
const tiffTools = useCesiumTiffPolygon(getViewer)
const cogTools = useCogTif(getViewer)
const layerAxis = useCesiumTimelineLayerSwitch(getViewer)
const axisItems = layerAxis.axisItemsSorted
const activeAxisId = layerAxis.activeItemId
const axisDemoEntities: Cesium.Entity[] = []

const initTimelineLayerDemo = async () => {
  const viewer = getViewer()
  if (!viewer) return

  axisDemoEntities.forEach((entity) => viewer.entities.remove(entity))
  axisDemoEntities.length = 0
//时间轴显示demo
  const demoDefs = [
    {
      id: 'timeline-layer-1',
      label: '2026-01-31',
      time: '2026-01-31T00:00:00Z',
      lon: 115.00,
      lat: 30.86,
      color: Cesium.Color.CYAN.withAlpha(0.45)
    },
    {
      id: 'timeline-layer-2',
      label: '2026-02-01',
      time: '2026-02-01T00:00:00Z',
      lon: 115.12,
      lat: 30.94,
      color: Cesium.Color.LIME.withAlpha(0.45)
    },
    {
      id: 'timeline-layer-3',
      label: '2026-02-02',
      time: '2026-02-02T00:00:00Z',
      lon: 115.24,
      lat: 30.82,
      color: Cesium.Color.ORANGE.withAlpha(0.45)
    }
  ]

  const axisItemsPayload = demoDefs.map((item, index) => {
    const entity = viewer.entities.add({
      id: item.id,
      name: `timeline-demo-${item.label}`,
      show: false,
      position: Cesium.Cartesian3.fromDegrees(item.lon, item.lat, 80),
      point: {
        pixelSize: 16,
        color: item.color,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      label: {
        text: item.label,
        font: '14px sans-serif',
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        pixelOffset: new Cesium.Cartesian2(0, -20),
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    })
    axisDemoEntities.push(entity)
    return {
      id: item.id,
      label: item.label,
      time: item.time,
      eventKey: `evt-${index + 1}`,
      targets: [entity],
      flyToTarget: entity
    }
  })

  await layerAxis.registerItems(axisItemsPayload, axisItemsPayload[0]?.id)
  viewer.scene.requestRender()
}

const onAxisItemClick = async (id: string) => {
  const switched = await layerAxis.onAxisClick(id, { flyTo: true })
  if (!switched) console.warn('Axis switch failed:', id)
}

const switchPrevAxis = async () => {
  const switched = await layerAxis.activatePrev({ flyTo: true })
  if (!switched && axisItems.value.length > 0) {
    await layerAxis.activateByIndex(axisItems.value.length - 1, { flyTo: true })
  }
}

const switchNextAxis = async () => {
  const switched = await layerAxis.activateNext({ flyTo: true })
  if (!switched && axisItems.value.length > 0) {
    await layerAxis.activateByIndex(0, { flyTo: true })
  }
}

onMounted(async () => {
  await initmap() 
  boxTools.initBoundingBoxEvents((id: string) => {
    console.log(`鼠标点击在四至 ${id} 上`)
  })
  controls.initListeners()
  await initTimelineLayerDemo()
})

onUnmounted(() => {
  boxTools.destroyBoundingBoxEvents()
  drawTools.destroyDraw()
  measureTools.clearAllMeasurements()
  nadirAreaTools.clearLastAnalysis()
  controls.destroyControls()
  tiffTools.destroyTiffTools() // 全局销毁
  cogTools.destroyCogTools()   // COG 销毁
  layerAxis.clearItems(false)
  const viewer = getViewer()
  if (viewer) axisDemoEntities.forEach((entity) => viewer.entities.remove(entity))
  destroyCesium()
})

//  KML 
const fileInputRef = ref<HTMLInputElement | null>(null)
const parsedEntities = ref<any[]>([])
const triggerUpload = () => { if (fileInputRef.value) fileInputRef.value.click() } 
const handleFileUpload = async (event: Event) => {
  const input = event.target as HTMLInputElement | null
  const file = input?.files?.[0]
  if (!file) return

  const fileName = file.name.toLowerCase()
  if (!fileName.endsWith('.kml') && !fileName.endsWith('.kmz')) {
    alert('仅支持上传 .kml 或 .kmz 文件')
    if (input) input.value = ''
    return
  }

  try {
    const result = await kmlTools.loadKmlFile(file, true)
    parsedEntities.value = result?.entities ?? []
    console.log('KML 加载成功:', result)
  } catch (error) {
    console.error('上传 KML 失败:', error)
    alert('上传 KML 失败，请检查文件格式或内容')
  } finally {
    // 允许再次选择同一个文件时依然触发 change 事件
    if (input) input.value = ''
  }
}

// 原始 GeoTIFF WebGL 
const isLoading = ref(false)
const hasData = ref(false)
const tiffUrl = ref('/XG005_20260324_042829_00004_0027_0074_E99.98_N36.79_L2C_HSI.tiff')

// 当前操作的 TIFF 唯一 ID
const currentTiffId = 'layer-test-01'

const renderConfig = reactive({
  stretch: 'minmax' as StretchMode,
  colormap: 'jet' as ColorMap
})

const onUrlLoad = async () => {
  if (!tiffUrl.value) {
    alert('请输入有效的 TIFF 链接！')
    return
  }
  await processData(() => tiffTools.parseTiffFromUrl(currentTiffId, tiffUrl.value))
}

const processData = async (parseMethod: () => Promise<any>) => {
  isLoading.value = true
  try {
    await parseMethod()
    hasData.value = true
    applyRender() // 数据解析完毕后触发渲染
  } catch (error) {
    console.error("加载TIFF失败:", error)
    alert('GeoTIFF 解析失败！')
  } finally {
    isLoading.value = false
  }
}

// 选中色带触发重绘
const selectColorMap = (cmap: ColorMap) => {
  renderConfig.colormap = cmap;
  applyRender();
}

const applyRender = () => {
  tiffTools.renderTiff(currentTiffId, {
    stretch: renderConfig.stretch,
    colormap: renderConfig.colormap
  });
};

const clearData = () => {
  tiffTools.clearTiffRender(currentTiffId)
  hasData.value = false
}

const tleDemoText = `ISS (ZARYA)
1 61906U 24205N   25285.31572638  .00024486  00000+0  92944-3 0  9996
2 61906  97.4403   0.1773 0011256 192.0607 168.0364 15.26772231 50918`

const runNadirDemo = async () => {
  try {
    const result = await nadirAreaTools.drawAreaAndAnalyze(
      () => drawTools.drawPolygon(),
      {
        baseId: 'nadir-track-demo',
        tleInput: tleDemoText,
        startTime: new Date(),
        durationMinutes: 1200,
        stepSeconds: 20,
        bufferDistance: 20_000,
        bufferUnits: 'meters',
        trackWidth: 2,
        intersectTrackWidth: 4,
        trackColor: Cesium.Color.YELLOW,
        intersectTrackColor: Cesium.Color.LIME,
        bboxOutlineColor: Cesium.Color.ORANGE,
        bufferFillColor: Cesium.Color.LIME.withAlpha(0.25),
        bufferOutlineColor: Cesium.Color.LIME,
        clampToGround: true,
        zoomToTrack: true
      }
    )

    if (!result) {
      console.warn('未完成区域绘制，已取消分析')
      return
    }

    console.log('Nadir area analysis done:', {
      pointCount: result.track.points.length,
      startTime: result.track.startTime,
      endTime: result.track.endTime,
      intersectSegmentCount: result.intersectedSegments.length,
      timeWindows: result.timeWindows.map((item) => ({
        enterTime: item.enterTime.toISOString(),
        leaveTime: item.leaveTime.toISOString(),
        durationSeconds: Number(item.durationSeconds.toFixed(2))
      }))
    })
  } catch (error) {
    console.error('Nadir area analysis failed:', error)
  }
}

const clearNadirDemo = () => {
  nadirAreaTools.clearLastAnalysis()
}

const wktstring = ref('POLYGON ((-115.081689 32.359361, -114.332064 32.238461, -114.498986 31.573281, -115.243068 31.693724, -115.081689 32.359361))')

const cogLoading = ref(false)
const cogLoaded = ref(false)
const currentCogId = 'cog-layer-01'
const cogUrl = ref('http://192.168.5.221:9000/image_original_output.tif')
const cogConfig = reactive({
  renderMode: 'rgb' as CogRenderMode,
  bandIndex: 0,
  rgbBands: [0, 1, 2] as [number, number, number],
  stretch: 'minmax' as CogSMode,
  colormap: 'jet' as CogCMap
})

const cogInfo = ref<{
  renderMode: CogRenderMode
  bandCount: number
  bandIndex: number
  rgbBands: [number, number, number]
  stats: Record<string | number, { min: number; max: number; mean: number; stddev: number }>
} | null>(null)

/** 当前活跃波段的统计值 */
const currentBandStats = computed(() => {
  if (!cogInfo.value || cogInfo.value.renderMode === 'rgb') return null
  const idx = cogInfo.value.bandIndex
  return cogInfo.value.stats[idx] ?? null
})

/** 可选波段列表 */
const bandOptions = computed(() => {
  const count = cogInfo.value?.bandCount ?? 1
  return Array.from({ length: count }, (_, i) => i)
})

const setRgbBand = (channel: 0 | 1 | 2, bandIdx: number) => {
  cogConfig.rgbBands[channel] = bandIdx
  applyCogUpdate()
}

const onCogLoad = async () => {
  let url = cogUrl.value
  if (!url) {
    url = prompt('请输入 COG TIF 文件 URL:') || ''
    if (!url) return
    cogUrl.value = url
  }
  cogLoading.value = true
  try {
    const info = await cogTools.addCogLayer(currentCogId, url, {
      colormap: cogConfig.colormap,
      stretch: cogConfig.stretch,
      flyTo: true
    })
    cogLoaded.value = true
    cogConfig.renderMode = info.renderMode as CogRenderMode
    cogInfo.value = {
      renderMode: info.renderMode as CogRenderMode,
      bandCount: info.bandCount,
      bandIndex: 0,
      rgbBands: [0, 1, 2],
      stats: info.stats
    }
    console.log('COG 加载成功:', info)
  } catch (err) {
    console.error('COG 加载失败:', err)
    alert('COG 加载失败，请检查 URL 是否正确、服务器是否支持 Range 请求和 CORS')
  } finally {
    cogLoading.value = false
  }
}

const selectCogColorMap = (cmap: CogCMap) => {
  cogConfig.colormap = cmap
  applyCogUpdate()
}

const applyCogUpdate = () => {
  cogTools.updateCogLayer(currentCogId, {
    renderMode: cogConfig.renderMode,
    bandIndex: cogConfig.bandIndex,
    rgbBands: [...cogConfig.rgbBands] as [number, number, number],
    colormap: cogConfig.colormap,
    stretch: cogConfig.stretch
  })
  if (cogInfo.value) {
    cogInfo.value.renderMode = cogConfig.renderMode
    cogInfo.value.bandIndex = cogConfig.bandIndex
    cogInfo.value.rgbBands = [...cogConfig.rgbBands] as [number, number, number]
  }
}

const clearCogData = () => {
  cogTools.removeCogLayer(currentCogId)
  cogLoaded.value = false
  cogInfo.value = null
}

const draw_Ins = async () => {
  try {
    const drawresult = await drawTools.drawPolygon()
    if (!drawresult?.wkt) {
      console.warn('绘制结果无有效 WKT，无法计算相交')
      return
    }


    const range = wktTools.intersectAndRender(drawresult.wkt, wktstring.value, {
      id: 'my-intersection',
      fillColor: Cesium.Color.fromCssColorString('rgba(249, 249, 121, 0.5)'),
      outlineColor: Cesium.Color.RED,
      zoomTo: true,
      clampToGround: false
    })

    if (!range.isIntersect) {
      console.warn('绘制图形与目标范围无相交区域', range.reason)
      return
    }

    console.log('draw_Ins 相交成功:', {
      drawWkt: drawresult.wkt,
      intersectionWkt: range.intersectionWkt,
      areaSquareKilometers: range.areaSquareKilometers
    })
  } catch (error) {
    console.error('draw_Ins 执行失败:', error)
  }
}
</script>

<style scoped>
#cesiumContainer { display: block; }
.toolbar {
  position: absolute; top: 10px; left: 10px; right: 10px; z-index: 999;
  background: rgba(30, 30, 30, 0.85); padding: 10px; border-radius: 6px;
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px; backdrop-filter: blur(4px);
}
button, select {
  padding: 6px 10px; cursor: pointer; border: 1px solid #555; border-radius: 4px;
  background: #444; color: #fff; font-size: 13px; transition: all 0.2s;
}
button:hover { background: #555; }
.btn-tiff { background: #2b83ba; border-color: #2b83ba; }
.btn-danger { background: #d7191c; border-color: #d7191c; }
.divider { color: #666; font-weight: bold; margin: 0 4px; }
.axis-label { color: #ccc; font-size: 12px; }
.btn-axis { background: #334155; border-color: #475569; }
.btn-axis.active { background: #0d9488; border-color: #0d9488; }
.axis-status { color: #a3a3a3; font-size: 12px; margin-left: 4px; }
.colormap-picker { display: flex; gap: 6px; align-items: center; }
.band-selectors {
  display: flex; gap: 4px; align-items: center;
}
.band-label {
  display: flex; align-items: center; gap: 2px;
  font-size: 12px; font-weight: 600; color: #ccc;
}
.band-label select {
  width: 56px; padding: 4px 2px; font-size: 12px;
  background: #333; border: 1px solid #555; color: #fff; border-radius: 3px;
}
.band-label.r { color: #f77; }
.band-label.g { color: #7f7; }
.band-label.b { color: #7af; }
.color-item {
  width: 45px; height: 22px; border: 2px solid transparent; border-radius: 3px;
  cursor: pointer; box-sizing: border-box; transition: all 0.2s;
}
.color-item:hover { transform: scale(1.05); }
.color-item.active { border-color: #fff; box-shadow: 0 0 6px rgba(255,255,255,0.8); }
.gradient { width: 100%; height: 100%; border-radius: 1px; }
.gradient-gray { background: linear-gradient(to right, #000, #fff); }
.gradient-jet { background: linear-gradient(to right, #000080, #0000ff, #00ffff, #ffff00, #ff0000); }
.gradient-hot { background: linear-gradient(to right, #000, #f00, #ff0, #fff); }
.gradient-terrain { background: linear-gradient(to right, #2b83ba, #abdda4, #ffffbf, #fdae61, #d7191c); }
.scale-display {
  position: absolute; bottom: 0; left: 0; width: 100%; z-index: 999;
  background: rgba(20, 20, 20, 0.75); color: #ddd; padding: 6px 20px;
  font-family: monospace; font-size: 13px; backdrop-filter: blur(4px);
}
</style>

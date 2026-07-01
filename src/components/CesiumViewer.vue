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
    <button @click="runOrbitFovDemo()">卫星轨道视锥</button>
    <button @click="orbitFovTools.clearVisualization(); orbitFovActive = false">清除轨道视锥</button>
    <button @click="loadAdministrativePieMap" :disabled="adminPieLoaded || adminPieLoading" class="btn-uom">
      {{ adminPieLoading ? '立体行政区加载中' : adminPieLoaded ? '立体行政区已加载' : '立体行政区' }}
    </button>
    <button @click="clearAdministrativePieMap" :disabled="!adminPieLoaded">清除立体行政区</button>
    <label class="roll-control" v-if="orbitFovActive">
      LANDSAT侧摆：<input type="range" min="-45" max="45" step="1" v-model.number="landsatRoll" @input="onLandsatRollChange" />
      <span>{{ landsatRoll }}°</span>
    </label>
    <input 
      type="file" 
      ref="fileInputRef" 
      accept=".kml,.kmz" 
      style="display: none" 
      @change="handleFileUpload" 
    />
    <button @click="kmlTools.clearAllKml()">清空 KML</button>

    <span class="divider">|</span>
    <span class="axis-label">UOM:</span>
    <button @click="onLoadUOM" :disabled="uomLoaded" class="btn-uom">
      {{ uomLoaded ? '已加载' : '适飞区' }}
    </button>
    <button @click="onClearUOM" :disabled="!uomLoaded">清除UOM</button>

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
    <button @click="onClassCogLoad" :disabled="cogLoading" class="btn-class">
      分类 COG 示例
    </button>
    <template v-if="cogLoaded && cogInfo">
      <select v-model="cogConfig.renderMode" @change="applyCogUpdate" title="渲染模式">
        <option value="singleband">单波段</option>
        <option v-if="cogInfo.bandCount >= 3" value="rgb">RGB 合成</option>
        <option value="classified">分类图</option>
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
        <div v-if="cogConfig.renderMode === 'classified'" class="class-editor">
          <label v-for="item in classificationClasses" :key="item.id ?? item.value" class="class-chip" :title="`${item.name}: ${item.value}`">
            <input
              type="color"
              :value="item.color"
              @input="setClassColor(item.value, ($event.target as HTMLInputElement).value)"
              @change="setClassColor(item.value, ($event.target as HTMLInputElement).value)"
            />
            <span>{{ item.name }}</span>
          </label>
          <button class="btn-apply-class" :disabled="!classColorDirty" @click="applyClassColors">确认修改</button>
        </div>
        <div v-else class="colormap-picker">
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

      <select v-if="cogConfig.renderMode !== 'classified'" v-model="cogConfig.stretch" @change="applyCogUpdate">
        <option value="minmax">极值拉伸</option>
        <option value="stddev">标准差拉伸</option>
        <option value="percent">百分比拉伸</option>
      </select>

      <button @click="clearCogData" class="btn-danger">清除 COG</button>
    </template>

    <span class="divider">|</span>
    <span class="axis-label">3D热力图:</span>
    <button @click="onHeatmapLoad" :disabled="heatmapLoading" class="btn-tiff">
      {{ heatmapLoading ? '加载中...' : '加载热力图' }}
    </button>
    <template v-if="heatmapLoaded && heatmapInfo">
      <select v-model.number="heatmapConfig.bandIndex" @change="applyHeatmapUpdate" title="波段">
        <option v-for="b in heatmapBandOptions" :key="b" :value="b">Band {{ b + 1 }}</option>
      </select>

      <div class="colormap-picker">
        <div class="color-item" :class="{ active: heatmapConfig.colormap === 'gray' }" @click="selectHeatmapColorMap('gray')" title="灰度">
          <div class="gradient gradient-gray"></div>
        </div>
        <div class="color-item" :class="{ active: heatmapConfig.colormap === 'jet' }" @click="selectHeatmapColorMap('jet')" title="彩虹">
          <div class="gradient gradient-jet"></div>
        </div>
        <div class="color-item" :class="{ active: heatmapConfig.colormap === 'hot' }" @click="selectHeatmapColorMap('hot')" title="热力">
          <div class="gradient gradient-hot"></div>
        </div>
        <div class="color-item" :class="{ active: heatmapConfig.colormap === 'terrain' }" @click="selectHeatmapColorMap('terrain')" title="地形">
          <div class="gradient gradient-terrain"></div>
        </div>
      </div>

      <select v-model="heatmapConfig.stretch" @change="applyHeatmapUpdate">
        <option value="minmax">极值拉伸</option>
        <option value="stddev">标准差拉伸</option>
        <option value="percent">百分比拉伸</option>
      </select>

      <label class="roll-control">
        高度:<input type="range" min="100" max="50000" step="100" v-model.number="heatmapConfig.heightScale" @input="applyHeatmapUpdate" />
        <span>{{ heatmapConfig.heightScale }}m</span>
      </label>

      <label class="roll-control">
        基准:<input type="range" min="0" max="10000" step="100" v-model.number="heatmapConfig.baseHeight" @input="applyHeatmapUpdate" />
        <span>{{ heatmapConfig.baseHeight }}m</span>
      </label>

      <button @click="clearHeatmap" class="btn-danger">清除热力图</button>
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
      :classes="classificationClasses"
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
import { useCesiumLayer } from '../hooks/useCesiumLayer'
import { useWktIntersection } from '../hooks/useWktIntersection'
import { useNadirAreaTrackAnalysis } from '../hooks/useNadirAreaTrackAnalysis'
import { useSatelliteOrbitFov } from '../hooks/useSatelliteOrbitFov'
import { useCogTif } from '../hooks/useCogTif'
import type { CogColorMap as CogCMap, CogStretchMode as CogSMode, CogRenderMode } from '../hooks/useCogTif'
import type { CogClassItem } from '../utils/cogClassification'
import { useCogHeatmap } from '../hooks/useCogHeatmap'
import type { CogColorMap as HeatmapCMap, CogStretchMode as HeatmapSMode } from '../hooks/useCogHeatmap'
import { useCesiumAdministrativePieMap } from '../hooks/useCesiumAdministrativePieMap'
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
const heatmapTools = useCogHeatmap(getViewer)
const orbitFovTools = useSatelliteOrbitFov(getViewer)
const adminPieMapTools = useCesiumAdministrativePieMap(getViewer)
const layerTools = useCesiumLayer(getViewer)
const layerAxis = useCesiumTimelineLayerSwitch(getViewer)
const axisItems = layerAxis.axisItemsSorted
const activeAxisId = layerAxis.activeItemId
const axisDemoEntities: Cesium.Entity[] = []
const adminPieLoaded = ref(false)
const adminPieLoading = ref(false)
const adminPieLayerId = 'administrative-pie-demo'
const adminPieDemoGeoJsonUrl = '/administrative-pie-demo.geojson'

const loadAdministrativePieMap = async () => {
  adminPieLoading.value = true
  try {
    const response = await fetch(adminPieDemoGeoJsonUrl)
    if (!response.ok) throw new Error(`GeoJSON 加载失败: ${response.status}`)
    const geojson = await response.json()

    const entities = await adminPieMapTools.addAdministrativePieMap(adminPieLayerId, geojson, {
      heightProperty: 'value',
      tiandituToken: '079632b1ec7b3f0bdc3dc04309c59b1e',
      terrainProviderType: 'url',
      terrainUrl: 'http://',
      minHeight: 1400,
      maxHeight: 12000,
      baseHeight: 0,
      hoverLiftHeight: 1400,
      flyTo: true,
      onRegionClick: (region) => {
        console.log('行政厚饼点击:', {
          id: region.id,
          name: region.name,
          value: region.value,
          properties: region.properties
        })
      }
    })
    adminPieLoaded.value = entities.length > 0
  } catch (error) {
    console.error('行政厚饼 GeoJSON 加载失败:', error)
    alert('行政厚饼 GeoJSON 加载失败，请检查 public/administrative-pie-demo.geojson')
  } finally {
    adminPieLoading.value = false
  }
}

const clearAdministrativePieMap = () => {
  adminPieMapTools.clearAdministrativePieMap(adminPieLayerId)
  adminPieLoaded.value = false
}

// ================= UOM 适飞区 =================
const uomLayerId = 'uom-flyzone'
const uomLoaded = ref(false)

const onLoadUOM = () => {
  const result = layerTools.addUOMLayer(uomLayerId, { codes: ['440000', '450000', '460000'] })
  if (result) uomLoaded.value = true
}

const onClearUOM = () => {
  layerTools.removeLayer(uomLayerId)
  uomLoaded.value = false
}

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
  orbitFovTools.destroy()
  controls.destroyControls()
  tiffTools.destroyTiffTools() // 全局销毁
  cogTools.destroyCogTools()   // COG 销毁
  heatmapTools.destroyHeatmapTools()
  adminPieMapTools.destroyAdministrativePieMap()
  layerTools.removeAllLayers()
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

const orbitFovDemoTle1 = `ISS (ZARYA)
1 61906U 24205N   25285.31572638  .00024486  00000+0  92944-3 0  9996
2 61906  97.4403   0.1773 0011256 192.0607 168.0364 15.26772231 50918`

const orbitFovDemoTle2 = `LANDSAT 9
1 49260U 21088A   25284.91234567  .00000120  00000+0  30000-4 0  9991
2 49260  98.2200  45.6789 0001234  85.4321 274.7654 14.57112345 12345`

const runOrbitFovDemo = () => {
  orbitFovTools.startVisualization({
    satellites: [
      {
        name: 'ISS',
        tle: orbitFovDemoTle1,
        fovAlongDeg: 2.4,
        fovCrossDeg: 3.6,
        rollDeg: 0
      },
      {
        name: 'LANDSAT-9',
        tle: orbitFovDemoTle2,
        fovAlongDeg: 7.5,
        fovCrossDeg: 7.5,
        rollDeg: landsatRoll.value,
        color: Cesium.Color.YELLOW
      }
    ],
    durationMinutes: 90,
    stepSeconds: 30,
    animationSpeed: 60
  })
  orbitFovActive.value = true
}

const orbitFovActive = ref(false)
const landsatRoll = ref(10)

const onLandsatRollChange = () => {
  orbitFovTools.updateSatelliteParam(1, { rollDeg: landsatRoll.value })
}

const wktstring = ref('POLYGON ((-115.081689 32.359361, -114.332064 32.238461, -114.498986 31.573281, -115.243068 31.693724, -115.081689 32.359361))')

const cogLoading = ref(false)
const cogLoaded = ref(false)
const currentCogId = 'cog-layer-01'
const cogUrl = ref('http://192.168.5.221:9000/CLCD_v01_2024_albert_shaanxi_COG.tif')
const classJsonUrl = '/data/Class.json'
const classificationClasses = ref<CogClassItem[]>([])
const classColorDirty = ref(false)
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
      renderMode: cogConfig.renderMode,
      bandIndex: cogConfig.bandIndex,
      rgbBands: [...cogConfig.rgbBands] as [number, number, number],
      colormap: cogConfig.colormap,
      stretch: cogConfig.stretch,
      classification: { classes: classificationClasses.value, transparentUnknown: true },
      flyTo: true
    })
    cogLoaded.value = true
    classColorDirty.value = false
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

const loadClassificationClasses = async () => {
  const response = await fetch(classJsonUrl)
  if (!response.ok) throw new Error(`分类配置加载失败: ${response.status}`)
  const data = await response.json() as CogClassItem[]
  classificationClasses.value = data.map((item) => ({ ...item }))
  classColorDirty.value = false
  return classificationClasses.value
}

const onClassCogLoad = async () => {
  try {
    if (classificationClasses.value.length === 0) {
      await loadClassificationClasses()
    }
    cogConfig.renderMode = 'classified'
    cogConfig.bandIndex = 0
    await onCogLoad()
  } catch (err) {
    console.error('分类 COG 加载失败:', err)
    alert('分类 COG 加载失败，请检查 COG URL 与 /data/Class.json')
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
    stretch: cogConfig.stretch,
    classification: { classes: classificationClasses.value, transparentUnknown: true }
  })
  if (cogInfo.value) {
    cogInfo.value.renderMode = cogConfig.renderMode
    cogInfo.value.bandIndex = cogConfig.bandIndex
    cogInfo.value.rgbBands = [...cogConfig.rgbBands] as [number, number, number]
  }
}

const setClassColor = (value: number, color: string) => {
  classificationClasses.value = classificationClasses.value.map((item) =>
    item.value === value ? { ...item, color } : item
  )
  classColorDirty.value = true
}

const applyClassColors = async () => {
  if (cogConfig.renderMode === 'classified' && cogLoaded.value) {
    await cogTools.updateCogLayer(currentCogId, {
      classification: { classes: classificationClasses.value, transparentUnknown: true }
    })
    classColorDirty.value = false
  }
}

const clearCogData = () => {
  cogTools.removeCogLayer(currentCogId)
  cogLoaded.value = false
  cogInfo.value = null
  classColorDirty.value = false
}

// ═══════════ 3D 热力图 ═══════════
const heatmapLoading = ref(false)
const heatmapLoaded = ref(false)
const currentHeatmapId = 'heatmap-01'
const heatmapUrl = ref('http://192.168.5.221:9000/chla_cog.tiff')
const heatmapConfig = reactive({
  bandIndex: 0,
  colormap: 'jet' as HeatmapCMap,
  stretch: 'minmax' as HeatmapSMode,
  heightScale: 5000,
  baseHeight: 0,
  gridSize: 256,
  opacity: 1
})
const heatmapInfo = ref<{
  bandCount: number
  gridW: number
  gridH: number
  stats: { min: number; max: number; mean: number; stddev: number }
} | null>(null)

const heatmapBandOptions = computed(() => {
  const count = heatmapInfo.value?.bandCount ?? 1
  return Array.from({ length: count }, (_, i) => i)
})

const onHeatmapLoad = async () => {
  let url = heatmapUrl.value
  if (!url) {
    url = prompt('请输入 COG TIF 文件 URL:') || ''
    if (!url) return
    heatmapUrl.value = url
  }
  heatmapLoading.value = true
  try {
    const info = await heatmapTools.addHeatmap(currentHeatmapId, url, {
      bandIndex: heatmapConfig.bandIndex,
      colormap: heatmapConfig.colormap,
      stretch: heatmapConfig.stretch,
      heightScale: heatmapConfig.heightScale,
      baseHeight: heatmapConfig.baseHeight,
      gridSize: heatmapConfig.gridSize,
      opacity: heatmapConfig.opacity,
      flyTo: true
    })
    heatmapLoaded.value = true
    heatmapInfo.value = {
      bandCount: info.bandCount,
      gridW: info.gridW,
      gridH: info.gridH,
      stats: info.stats
    }
    console.log('3D 热力图加载成功:', info)
  } catch (err) {
    console.error('3D 热力图加载失败:', err)
    alert('3D 热力图加载失败')
  } finally {
    heatmapLoading.value = false
  }
}

const applyHeatmapUpdate = () => {
  heatmapTools.updateHeatmap(currentHeatmapId, {
    bandIndex: heatmapConfig.bandIndex,
    colormap: heatmapConfig.colormap,
    stretch: heatmapConfig.stretch,
    heightScale: heatmapConfig.heightScale,
    baseHeight: heatmapConfig.baseHeight,
    opacity: heatmapConfig.opacity
  })
}

const selectHeatmapColorMap = (cmap: HeatmapCMap) => {
  heatmapConfig.colormap = cmap
  applyHeatmapUpdate()
}

const clearHeatmap = () => {
  heatmapTools.removeHeatmap(currentHeatmapId)
  heatmapLoaded.value = false
  heatmapInfo.value = null
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
.btn-class { background: #7c3aed; border-color: #7c3aed; }
.btn-uom { background: #059669; border-color: #059669; }
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
.class-editor {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 520px;
  overflow-x: auto;
  padding: 2px 0;
}
.class-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  height: 26px;
  padding: 2px 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  color: #ddd;
  font-size: 12px;
}
.class-chip input[type="color"] {
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
}
.class-chip span {
  max-width: 64px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.btn-apply-class {
  flex: 0 0 auto;
  height: 26px;
  padding: 2px 10px;
  background: #16a34a;
  border-color: #16a34a;
  font-size: 12px;
}
.btn-apply-class:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}
.scale-display {
  position: absolute; bottom: 0; left: 0; width: 100%; z-index: 999;
  background: rgba(20, 20, 20, 0.75); color: #ddd; padding: 6px 20px;
  font-family: monospace; font-size: 13px; backdrop-filter: blur(4px);
}
.roll-control {
  display: flex; align-items: center; gap: 6px; color: #ccc; font-size: 12px;
}
.roll-control input[type="range"] {
  width: 100px; cursor: pointer;
}
.roll-control span {
  min-width: 36px; text-align: right; font-weight: 600; color: #4ade80;
}
</style>

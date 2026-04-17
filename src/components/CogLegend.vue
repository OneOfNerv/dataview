<script setup lang="ts">
/**
 * COG / GeoTIFF 图例组件
 * 根据当前色带、拉伸模式和波段统计值，渲染一个垂直渐变图例，
 *
 * demo：
 *   <CogLegend
 *     :colormap="'jet'"
 *     :stretch="'minmax'"
 *     :stats="{ min: 0, max: 100, mean: 50, stddev: 20 }"
 *   />
 */
import { computed } from 'vue'

export interface CogLegendProps {
  colormap: 'gray' | 'jet' | 'hot' | 'terrain'
  stretch: 'minmax' | 'stddev' | 'percent'
  stats: { min: number; max: number; mean: number; stddev: number } | null
  percentClip?: number
  bandIndex?: number
  renderMode?: 'singleband' | 'rgb'
  rgbBands?: [number, number, number]
  title?: string
}

const props = withDefaults(defineProps<CogLegendProps>(), {
  percentClip: 2,
  bandIndex: 0,
  renderMode: 'singleband',
  rgbBands: () => [0, 1, 2] as [number, number, number],
  title: '图例'
})

const colormapLabel: Record<string, string> = {
  gray: '灰度', jet: '彩虹', hot: '热力', terrain: '地形'
}

// 渐变 CSS（top = max，bottom = min）
const gradientMap: Record<string, string> = {
  gray:    'linear-gradient(to bottom, #ffffff, #000000)',
  jet:     'linear-gradient(to bottom, #ff0000, #ffff00, #00ffff, #0000ff, #000080)',
  hot:     'linear-gradient(to bottom, #ffffff, #ffff00, #ff0000, #000000)',
  terrain: 'linear-gradient(to bottom, #d7191c, #fdae61, #ffffbf, #abdda4, #2b83ba)'
}
const gradientCss = computed(() => gradientMap[props.colormap] ?? gradientMap.gray)
const displayRange = computed(() => {
  if (!props.stats) return { min: 0, max: 1 }
  const { min, max, mean, stddev } = props.stats
  if (props.stretch === 'stddev') {
    return { min: mean - 2 * stddev, max: mean + 2 * stddev }
  }
  if (props.stretch === 'percent') {
    const c = props.percentClip / 100
    return { min: min + c * (max - min), max: max - c * (max - min) }
  }
  return { min, max }
})

const TICK_COUNT = 5
const ticks = computed(() => {
  const { min: vMin, max: vMax } = displayRange.value
  const arr: { value: number; label: string }[] = []
  for (let i = 0; i < TICK_COUNT; i++) {
    const t = i / (TICK_COUNT - 1)
    const value = vMax - t * (vMax - vMin)
    arr.push({ value, label: fmtNum(value) })
  }
  return arr
})

const stretchLabel = computed(() => {
  switch (props.stretch) {
    case 'minmax':  return '极值拉伸'
    case 'stddev':  return '标准差 (2σ)'
    case 'percent': return `百分比裁剪 (${props.percentClip}%)`
  }
})

const displayTitle = computed(() => {
  if (props.title) return props.title
  return props.renderMode === 'rgb' ? 'RGB 真彩色' : `Band ${props.bandIndex}`
})

function fmtNum(v: number): string {
  if (v === 0) return '0'
  const a = Math.abs(v)
  if (a >= 1e6 || (a > 0 && a < 0.01)) return v.toExponential(1)
  if (Number.isInteger(v) && a < 1e6) return v.toLocaleString()
  if (a >= 100) return v.toFixed(1)
  if (a >= 1)   return v.toFixed(2)
  return v.toFixed(3)
}
</script>

<template>
  <div class="cog-legend">
    <div class="legend-header">
      <span class="legend-title">{{ displayTitle }}</span>
      <span class="legend-cmap">{{ colormapLabel[colormap] ?? colormap }}</span>
    </div>
    <template v-if="renderMode === 'singleband' && stats">
      <div class="legend-body">
        <div class="bar-wrap">
          <div class="legend-bar" :style="{ background: gradientCss }"></div>
          <div class="tick-marks">
            <span v-for="(_, i) in ticks" :key="i" class="tick-mark"
              :style="{ top: `${(i / (TICK_COUNT - 1)) * 100}%` }" />
          </div>
        </div>
        <div class="legend-ticks">
          <span v-for="tick in ticks" :key="tick.value" class="tick-label">
            {{ tick.label }}
          </span>
        </div>
      </div>
      <div class="legend-footer">{{ stretchLabel }}</div>
    </template>
    <template v-else-if="renderMode === 'rgb'">
      <div class="legend-rgb">
        <div class="rgb-row"><span class="rgb-dot r" />R&nbsp;&rarr;&nbsp;Band {{ rgbBands[0] }}</div>
        <div class="rgb-row"><span class="rgb-dot g" />G&nbsp;&rarr;&nbsp;Band {{ rgbBands[1] }}</div>
        <div class="rgb-row"><span class="rgb-dot b" />B&nbsp;&rarr;&nbsp;Band {{ rgbBands[2] }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.cog-legend {
  position: absolute;
  right: 16px;
  bottom: 44px;
  z-index: 900;
  min-width: 120px;
  background: rgba(18, 18, 22, 0.88);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: #e0e0e0;
  user-select: none;
  pointer-events: auto;
  overflow: hidden;
}

.legend-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.legend-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: #f0f0f0;
}
.legend-cmap {
  font-size: 10px;
  color: #888;
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 6px;
  border-radius: 3px;
}

.legend-body {
  display: flex;
  gap: 6px;
  padding: 10px 12px 6px;
}

.bar-wrap {
  position: relative;
  flex-shrink: 0;
}
.legend-bar {
  width: 16px;
  height: 150px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.15);
}

.tick-marks {
  position: absolute;
  top: 0;
  right: -4px;
  width: 4px;
  height: 100%;
}
.tick-mark {
  position: absolute;
  right: 0;
  width: 4px;
  height: 1px;
  background: rgba(255, 255, 255, 0.35);
  transform: translateY(-0.5px);
}

.legend-ticks {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  height: 150px;
  padding-left: 2px;
}
.tick-label {
  font-family: 'Menlo', 'Consolas', 'Monaco', monospace;
  font-size: 10.5px;
  line-height: 1;
  color: #ccc;
  white-space: nowrap;
}

.legend-footer {
  padding: 4px 12px 8px;
  font-size: 10px;
  color: #777;
  text-align: center;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.legend-rgb {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 14px 12px;
}
.rgb-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-family: 'Menlo', 'Consolas', monospace;
  color: #ccc;
}
.rgb-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.rgb-dot.r { background: #f55; box-shadow: 0 0 4px rgba(255, 85, 85, 0.5); }
.rgb-dot.g { background: #5f5; box-shadow: 0 0 4px rgba(85, 255, 85, 0.5); }
.rgb-dot.b { background: #58f; box-shadow: 0 0 4px rgba(85, 136, 255, 0.5); }
</style>

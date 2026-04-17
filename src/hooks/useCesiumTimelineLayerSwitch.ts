/**
 * 时间轴切换功能，适用于根据时间轴切换不同的图层状态（显隐、样式等）。
 * 先把每个时相/事件对应的图层对象收集好（Entity/DataSource/ImageryLayer）。
  * 调一次 registerItems(items, defaultId) 建立轴。
  * 点击时间轴节点时只调用 activateById 或 activateByTime。
  * 如果图层不是 show 控制型（比如 TIFF 渲染函数），用 VisibilityController：setVisible(true) -> render setVisible(false) -> clear 
*/
import { computed, isRef, ref } from 'vue'
import type { Ref } from 'vue'
import * as Cesium from 'cesium'

export type AxisTimeValue = string | number | Date

export type ShowLike = { show: boolean }
export type VisibilityController = { setVisible: (visible: boolean) => void | Promise<void> }
export type LayerResolver = () => LayerTarget | null | undefined

export type LayerTarget =
  | ShowLike
  | Ref<ShowLike | null | undefined>
  | VisibilityController
  | LayerResolver

export interface AxisLayerItem {
  id: string
  label: string
  time?: AxisTimeValue
  eventKey?: string
  targets: LayerTarget[]
  flyToTarget?: Cesium.Entity | Cesium.DataSource | (() => Cesium.Entity | Cesium.DataSource | null | undefined)
  onShow?: () => void | Promise<void>
  onHide?: () => void | Promise<void>
}

export type ActivateOptions = {
  exclusive?: boolean
  flyTo?: boolean
}

export type TimeMatchMode = 'exact' | 'nearest' | 'latest_before'

type ResolvedTarget = ShowLike | VisibilityController | Ref<ShowLike | null | undefined> | null | undefined

const toMs = (value?: AxisTimeValue) => {
  if (value === undefined || value === null) return Number.NaN
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN
  const dateMs = Date.parse(value)
  if (!Number.isNaN(dateMs)) return dateMs
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : Number.NaN
}

const isPromiseLike = (value: unknown): value is Promise<unknown> => {
  return !!value && typeof (value as Promise<unknown>).then === 'function'
}

const isVisibilityController = (target: unknown): target is VisibilityController => {
  return !!target && typeof target === 'object' && typeof (target as VisibilityController).setVisible === 'function'
}

const isShowLike = (target: unknown): target is ShowLike => {
  return !!target && typeof target === 'object' && typeof (target as ShowLike).show === 'boolean'
}

const resolveTarget = (target: LayerTarget): ResolvedTarget => {
  let current: unknown = target
  let depth = 0

  while (typeof current === 'function' && depth < 5) {
    current = (current as LayerResolver)()
    depth += 1
  }

  if (!current) return null
  if (isRef(current)) return current
  if (isVisibilityController(current)) return current
  if (isShowLike(current)) return current
  return null
}

const setSingleTargetVisible = async (target: LayerTarget, visible: boolean) => {
  const resolved = resolveTarget(target)
  if (!resolved) return

  if (isRef(resolved)) {
    if (resolved.value && isShowLike(resolved.value)) {
      resolved.value.show = visible
    }
    return
  }

  if (isVisibilityController(resolved)) {
    const result = resolved.setVisible(visible)
    if (isPromiseLike(result)) await result
    return
  }

  if (isShowLike(resolved)) {
    resolved.show = visible
  }
}

const setTargetsVisible = async (targets: LayerTarget[], visible: boolean) => {
  for (const target of targets) {
    await setSingleTargetVisible(target, visible)
  }
}

const resolveFlyToTarget = (target?: AxisLayerItem['flyToTarget']) => {
  if (!target) return null
  return typeof target === 'function' ? target() ?? null : target
}

export function useCesiumTimelineLayerSwitch(getViewer: () => any) {
  const axisItems = ref<AxisLayerItem[]>([])
  const activeItemId = ref<string | null>(null)

  const axisItemsSorted = computed(() => {
    return [...axisItems.value].sort((a, b) => {
      const ta = toMs(a.time)
      const tb = toMs(b.time)
      const aValid = Number.isFinite(ta)
      const bValid = Number.isFinite(tb)
      if (!aValid && !bValid) return a.label.localeCompare(b.label)
      if (!aValid) return 1
      if (!bValid) return -1
      return ta - tb
    })
  })

  const activeIndex = computed(() => {
    if (!activeItemId.value) return -1
    return axisItemsSorted.value.findIndex((x) => x.id === activeItemId.value)
  })

  const activeItem = computed(() => {
    if (!activeItemId.value) return null
    return axisItems.value.find((x) => x.id === activeItemId.value) ?? null
  })

  const requestRender = () => {
    const viewer = getViewer()
    viewer?.scene?.requestRender?.()
  }

  const updateItem = (id: string, patch: Partial<AxisLayerItem>) => {
    const item = axisItems.value.find((x) => x.id === id)
    if (!item) return false
    Object.assign(item, patch)
    requestRender()
    return true
  }

  const registerItem = async (item: AxisLayerItem, visible = false) => {
    axisItems.value = [...axisItems.value.filter((x) => x.id !== item.id), item]

    if (visible) {
      await setTargetsVisible(item.targets, true)
      if (item.onShow) await item.onShow()
      activeItemId.value = item.id
    } else {
      await setTargetsVisible(item.targets, false)
      if (item.onHide) await item.onHide()
    }

    requestRender()
  }

  const registerItems = async (items: AxisLayerItem[], activeId?: string) => {
    axisItems.value = []
    activeItemId.value = null

    for (const item of items) {
      await registerItem(item, false)
    }

    if (activeId) {
      await activateById(activeId)
    }
  }

  const removeItem = async (id: string, hide = true) => {
    const item = axisItems.value.find((x) => x.id === id)
    if (item && hide) {
      await setTargetsVisible(item.targets, false)
      if (item.onHide) await item.onHide()
    }
    axisItems.value = axisItems.value.filter((x) => x.id !== id)
    if (activeItemId.value === id) activeItemId.value = null
    requestRender()
  }

  const clearItems = async (hide = true) => {
    if (hide) {
      for (const item of axisItems.value) {
        await setTargetsVisible(item.targets, false)
        if (item.onHide) await item.onHide()
      }
    }

    axisItems.value = []
    activeItemId.value = null
    requestRender()
  }

  const deactivateAll = async () => {
    for (const item of axisItems.value) {
      await setTargetsVisible(item.targets, false)
      if (item.onHide) await item.onHide()
    }
    activeItemId.value = null
    requestRender()
  }

  const activateById = async (id: string, options: ActivateOptions = {}) => {
    const { exclusive = true, flyTo = false } = options
    const current = axisItems.value.find((x) => x.id === id)
    if (!current) return false

    if (exclusive) {
      for (const item of axisItems.value) {
        const show = item.id === id
        await setTargetsVisible(item.targets, show)
        if (show) {
          if (item.onShow) await item.onShow()
        } else {
          if (item.onHide) await item.onHide()
        }
      }
    } else {
      await setTargetsVisible(current.targets, true)
      if (current.onShow) await current.onShow()
    }

    activeItemId.value = id

    if (flyTo) {
      const viewer = getViewer()
      const flyToTarget = resolveFlyToTarget(current.flyToTarget)
      if (viewer && flyToTarget) viewer.flyTo(flyToTarget)
    }

    requestRender()
    return true
  }

  const activateByIndex = async (index: number, options: ActivateOptions = {}) => {
    const item = axisItemsSorted.value[index]
    if (!item) return false
    return activateById(item.id, options)
  }

  const activateNext = async (options: ActivateOptions = {}) => {
    const nextIndex = activeIndex.value + 1
    if (nextIndex >= axisItemsSorted.value.length) return false
    return activateByIndex(nextIndex, options)
  }

  const activatePrev = async (options: ActivateOptions = {}) => {
    const prevIndex = activeIndex.value - 1
    if (prevIndex < 0) return false
    return activateByIndex(prevIndex, options)
  }

  const activateByEvent = async (eventKey: string, options: ActivateOptions = {}) => {
    const item = axisItems.value.find((x) => x.eventKey === eventKey)
    if (!item) return false
    return activateById(item.id, options)
  }

  const activateByTime = async (
    value: AxisTimeValue,
    mode: TimeMatchMode = 'nearest',
    options: ActivateOptions = {}
  ) => {
    const target = toMs(value)
    if (!Number.isFinite(target)) return false

    const timedItems = axisItems.value
      .map((item) => ({ item, time: toMs(item.time) }))
      .filter((x) => Number.isFinite(x.time))

    if (timedItems.length === 0) return false

    let hit: AxisLayerItem | null = null

    if (mode === 'exact') {
      hit = timedItems.find((x) => x.time === target)?.item ?? null
    } else if (mode === 'latest_before') {
      const candidates = timedItems.filter((x) => x.time <= target).sort((a, b) => b.time - a.time)
      hit = candidates[0]?.item ?? null
    } else {
      const nearest = timedItems
        .slice()
        .sort((a, b) => Math.abs(a.time - target) - Math.abs(b.time - target))[0]
      hit = nearest?.item ?? null
    }

    return hit ? activateById(hit.id, options) : false
  }

  const onAxisClick = (id: string, options: ActivateOptions = {}) => activateById(id, options)

  return {
    axisItems,
    axisItemsSorted,
    activeItemId,
    activeItem,
    activeIndex,
    registerItem,
    registerItems,
    updateItem,
    removeItem,
    clearItems,
    deactivateAll,
    activateById,
    activateByIndex,
    activateNext,
    activatePrev,
    activateByTime,
    activateByEvent,
    onAxisClick
  }
}

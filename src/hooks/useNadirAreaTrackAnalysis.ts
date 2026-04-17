import * as Cesium from 'cesium'
import {
  useNadirPointDir,
  type ComputeNadirTrackOptions,
  type NadirTrackResult,
  type TleInput,
  type TrackBufferResult
} from './useNadirPointDir'

type LngLat = [number, number]

export interface DrawPolygonResultLike {
  lnglats: LngLat[]
  wkt: string
  boundingBox: { west: number; south: number; east: number; north: number }
}

export interface BoundingBoxRect {
  west: number
  south: number
  east: number
  north: number
}

export interface TrackIntersectTimeWindow {
  enterTime: Date
  leaveTime: Date
  enterPosition: LngLat
  leavePosition: LngLat
  durationSeconds: number
}

export interface DrawAnalyzeOptions extends ComputeNadirTrackOptions {
  tleInput: string | string[] | TleInput
  baseId?: string
  bufferDistance?: number
  bufferUnits?: 'meters' | 'kilometers'
  bufferSteps?: number
  trackColor?: Cesium.Color
  trackWidth?: number
  intersectTrackColor?: Cesium.Color
  intersectTrackWidth?: number
  bufferFillColor?: Cesium.Color
  bufferOutlineColor?: Cesium.Color
  bboxOutlineColor?: Cesium.Color
  showTimeLabels?: boolean
  timeLabelFont?: string
  enterTimeLabelColor?: Cesium.Color
  leaveTimeLabelColor?: Cesium.Color
  zoomToTrack?: boolean
  clampToGround?: boolean
}

export interface DrawAnalyzeResult {
  drawResult: DrawPolygonResultLike
  minBoundingBox: BoundingBoxRect
  track: NadirTrackResult
  intersectedSegments: LngLat[][]
  timeWindows: TrackIntersectTimeWindow[]
  bufferResults: TrackBufferResult[]
}

interface SegmentClipResult {
  start: LngLat
  end: LngLat
  startRatio: number
  endRatio: number
}

interface AnalysisRenderState {
  trackIds: string[]
  intersectTrackIds: string[]
  bufferIds: string[]
  bboxIds: string[]
  timeLabelIds: string[]
}

const EPS = 1e-10

function isSamePoint(a: LngLat, b: LngLat, eps = EPS) {
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps
}

function normalizeBoundingBox(bbox: BoundingBoxRect): BoundingBoxRect {
  return {
    west: Math.min(bbox.west, bbox.east),
    east: Math.max(bbox.west, bbox.east),
    south: Math.min(bbox.south, bbox.north),
    north: Math.max(bbox.south, bbox.north)
  }
}

function interpolatePoint(a: LngLat, b: LngLat, ratio: number): LngLat {
  return [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio]
}

function clipSegmentToRect(a: LngLat, b: LngLat, rect: BoundingBoxRect): SegmentClipResult | null {
  const [x0, y0] = a
  const [x1, y1] = b
  const dx = x1 - x0
  const dy = y1 - y0

  let tEnter = 0
  let tLeave = 1

  const clipBoundary = (p: number, q: number) => {
    if (Math.abs(p) <= EPS) return q >= 0
    const r = q / p
    if (p < 0) {
      if (r > tLeave) return false
      if (r > tEnter) tEnter = r
      return true
    }
    if (r < tEnter) return false
    if (r < tLeave) tLeave = r
    return true
  }

  if (!clipBoundary(-dx, x0 - rect.west)) return null
  if (!clipBoundary(dx, rect.east - x0)) return null
  if (!clipBoundary(-dy, y0 - rect.south)) return null
  if (!clipBoundary(dy, rect.north - y0)) return null
  if (tEnter > tLeave + EPS) return null

  const startRatio = Math.min(1, Math.max(0, tEnter))
  const endRatio = Math.min(1, Math.max(0, tLeave))
  return {
    start: interpolatePoint(a, b, startRatio),
    end: interpolatePoint(a, b, endRatio),
    startRatio,
    endRatio
  }
}

function interpolateTime(start: Date, end: Date, ratio: number) {
  const ms = start.getTime() + (end.getTime() - start.getTime()) * ratio
  return new Date(ms)
}

function appendPoint(points: LngLat[], point: LngLat) {
  const last = points.length > 0 ? points[points.length - 1]! : null
  if (!last || !isSamePoint(last, point)) points.push(point)
}

function extractTrackInsideRect(
  track: NadirTrackResult,
  rect: BoundingBoxRect
): { segments: LngLat[][]; windows: TrackIntersectTimeWindow[] } {
  const points = track.points
  const segments: LngLat[][] = []
  const windows: TrackIntersectTimeWindow[] = []

  let currentSegment: LngLat[] | null = null
  let currentEnter: Date | null = null
  let currentLeave: Date | null = null
  let currentEnterPoint: LngLat | null = null
  let currentLeavePoint: LngLat | null = null

  const flushCurrent = () => {
    if (
      !currentSegment ||
      !currentEnter ||
      !currentLeave ||
      !currentEnterPoint ||
      !currentLeavePoint ||
      currentSegment.length < 2
    ) {
      currentSegment = null
      currentEnter = null
      currentLeave = null
      currentEnterPoint = null
      currentLeavePoint = null
      return
    }

    segments.push(currentSegment)
    windows.push({
      enterTime: currentEnter,
      leaveTime: currentLeave,
      enterPosition: [currentEnterPoint[0], currentEnterPoint[1]],
      leavePosition: [currentLeavePoint[0], currentLeavePoint[1]],
      durationSeconds: Math.max(0, (currentLeave.getTime() - currentEnter.getTime()) / 1000)
    })

    currentSegment = null
    currentEnter = null
    currentLeave = null
    currentEnterPoint = null
    currentLeavePoint = null
  }

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i]!
    const p1 = points[i + 1]!
    const point0: LngLat = [p0.longitude, p0.latitude]
    const point1: LngLat = [p1.longitude, p1.latitude]

    // 跳过跨日期变更线的大跳变，避免出现错误长线段。
    if (Math.abs(point1[0] - point0[0]) > 180) {
      flushCurrent()
      continue
    }

    const clipped = clipSegmentToRect(point0, point1, rect)
    if (!clipped) {
      flushCurrent()
      continue
    }

    const enterTime = interpolateTime(p0.time, p1.time, clipped.startRatio)
    const leaveTime = interpolateTime(p0.time, p1.time, clipped.endRatio)

    if (!currentSegment || !currentEnter || !currentLeave) {
      currentSegment = []
      appendPoint(currentSegment, clipped.start)
      appendPoint(currentSegment, clipped.end)
      currentEnter = enterTime
      currentLeave = leaveTime
      currentEnterPoint = [clipped.start[0], clipped.start[1]]
      currentLeavePoint = [clipped.end[0], clipped.end[1]]
      continue
    }

    const lastPoint = currentSegment[currentSegment.length - 1]!
    if (isSamePoint(lastPoint, clipped.start)) {
      appendPoint(currentSegment, clipped.end)
      currentLeave = leaveTime
      currentLeavePoint = [clipped.end[0], clipped.end[1]]
      continue
    }

    flushCurrent()
    currentSegment = []
    appendPoint(currentSegment, clipped.start)
    appendPoint(currentSegment, clipped.end)
    currentEnter = enterTime
    currentLeave = leaveTime
    currentEnterPoint = [clipped.start[0], clipped.start[1]]
    currentLeavePoint = [clipped.end[0], clipped.end[1]]
  }

  flushCurrent()
  return { segments, windows }
}

export function useNadirAreaTrackAnalysis(getViewer: () => Cesium.Viewer | null | undefined) {
  const nadirTools = useNadirPointDir(getViewer)

  const state: AnalysisRenderState = {
    trackIds: [],
    intersectTrackIds: [],
    bufferIds: [],
    bboxIds: [],
    timeLabelIds: []
  }

  const formatDateTime = (date: Date) => {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    const hh = String(date.getHours()).padStart(2, '0')
    const mm = String(date.getMinutes()).padStart(2, '0')
    const ss = String(date.getSeconds()).padStart(2, '0')
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`
  }

  const clearLastAnalysis = () => {
    const viewer = getViewer()
    state.trackIds.forEach((id) => nadirTools.clearNadirTrack(id))
    state.intersectTrackIds.forEach((id) => nadirTools.clearNadirTrack(id))
    state.bufferIds.forEach((id) => nadirTools.clearNadirBuffer(id))

    if (viewer) {
      state.bboxIds.forEach((id) => viewer.entities.removeById(id))
      state.timeLabelIds.forEach((id) => viewer.entities.removeById(id))
      viewer.scene.requestRender()
    }

    state.trackIds = []
    state.intersectTrackIds = []
    state.bufferIds = []
    state.bboxIds = []
    state.timeLabelIds = []
  }

  const renderBoundingBox = (
    rect: BoundingBoxRect,
    id: string,
    outlineColor: Cesium.Color,
    clampToGround: boolean
  ) => {
    const viewer = getViewer()
    if (!viewer) return

    const coords = [
      rect.west, rect.north,
      rect.east, rect.north,
      rect.east, rect.south,
      rect.west, rect.south,
      rect.west, rect.north
    ]

    const entity = viewer.entities.add({
      id,
      name: 'nadir-analysis-bbox',
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(coords),
        width: 2,
        material: outlineColor,
        clampToGround,
        arcType: Cesium.ArcType.RHUMB
      }
    })
    if (typeof entity.id === 'string') state.bboxIds.push(entity.id)
    viewer.scene.requestRender()
  }

  const renderTimeLabels = (
    windows: TrackIntersectTimeWindow[],
    baseId: string,
    clampToGround: boolean,
    options: DrawAnalyzeOptions
  ) => {
    const viewer = getViewer()
    if (!viewer) return
    if (!(options.showTimeLabels ?? true)) return

    windows.forEach((window, index) => {
      const enterId = `${baseId}-enter-label-${index + 1}`
      const leaveId = `${baseId}-leave-label-${index + 1}`

      const enterEntity = viewer.entities.add({
        id: enterId,
        name: 'nadir-analysis-enter-time',
        position: Cesium.Cartesian3.fromDegrees(window.enterPosition[0], window.enterPosition[1], 0),
        label: {
          text: `Enter ${formatDateTime(window.enterTime)}`,
          font: options.timeLabelFont ?? '14px sans-serif',
          fillColor: options.enterTimeLabelColor ?? Cesium.Color.LIME,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          showBackground: true,
          backgroundColor: Cesium.Color.BLACK.withAlpha(0.45),
          pixelOffset: new Cesium.Cartesian2(0, -20),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          ...(clampToGround
            ? { heightReference: Cesium.HeightReference.CLAMP_TO_GROUND }
            : {})
        }
      })
      if (typeof enterEntity.id === 'string') state.timeLabelIds.push(enterEntity.id)

      const leaveEntity = viewer.entities.add({
        id: leaveId,
        name: 'nadir-analysis-leave-time',
        position: Cesium.Cartesian3.fromDegrees(window.leavePosition[0], window.leavePosition[1], 0),
        label: {
          text: `Leave ${formatDateTime(window.leaveTime)}`,
          font: options.timeLabelFont ?? '14px sans-serif',
          fillColor: options.leaveTimeLabelColor ?? Cesium.Color.ORANGE,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          showBackground: true,
          backgroundColor: Cesium.Color.BLACK.withAlpha(0.45),
          pixelOffset: new Cesium.Cartesian2(0, 20),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          ...(clampToGround
            ? { heightReference: Cesium.HeightReference.CLAMP_TO_GROUND }
            : {})
        }
      })
      if (typeof leaveEntity.id === 'string') state.timeLabelIds.push(leaveEntity.id)
    })

    viewer.scene.requestRender()
  }

  const drawAreaAndAnalyze = async (
    drawPolygon: () => Promise<DrawPolygonResultLike | null>,
    options: DrawAnalyzeOptions
  ): Promise<DrawAnalyzeResult | null> => {
    clearLastAnalysis()

    const drawResult = await drawPolygon()
    if (!drawResult) return null

    const baseId = options.baseId ?? 'nadir-area-analysis'
    const clampToGround = options.clampToGround ?? true
    const minBoundingBox = normalizeBoundingBox(drawResult.boundingBox)

    renderBoundingBox(
      minBoundingBox,
      `${baseId}-bbox`,
      options.bboxOutlineColor ?? Cesium.Color.ORANGE,
      clampToGround
    )

    const track = nadirTools.computeNadirTrack(options.tleInput, options)
    nadirTools.renderNadirTrack(track, {
      id: `${baseId}-track`,
      color: options.trackColor ?? Cesium.Color.CYAN,
      width: options.trackWidth ?? 2,
      clampToGround,
      zoomTo: options.zoomToTrack ?? true
    })
    state.trackIds.push(`${baseId}-track`)

    const extraction = extractTrackInsideRect(track, minBoundingBox)
    extraction.segments.forEach((segment, index) => {
      const intersectId = `${baseId}-intersect-${index + 1}`
      nadirTools.renderNadirTrack(segment, {
        id: intersectId,
        color: options.intersectTrackColor ?? Cesium.Color.LIME,
        width: options.intersectTrackWidth ?? 4,
        clampToGround,
        zoomTo: false
      })
      state.intersectTrackIds.push(intersectId)
    })

    const bufferDistance = options.bufferDistance ?? 0
    const bufferResults: TrackBufferResult[] = []
    if (bufferDistance > 0) {
      extraction.segments.forEach((segment, index) => {
        const bufferId = `${baseId}-buffer-${index + 1}`
        const { bufferResult } = nadirTools.computeRenderTrackBuffer(segment, {
          id: bufferId,
          distance: bufferDistance,
          units: options.bufferUnits ?? 'meters',
          steps: options.bufferSteps ?? 32,
          fillColor: options.bufferFillColor ?? Cesium.Color.LIME.withAlpha(0.25),
          outlineColor: options.bufferOutlineColor ?? Cesium.Color.LIME,
          clampToGround,
          zoomTo: false
        })
        bufferResults.push(bufferResult)
        state.bufferIds.push(bufferId)
      })
    }

    renderTimeLabels(extraction.windows, baseId, clampToGround, options)

    return {
      drawResult,
      minBoundingBox,
      track,
      intersectedSegments: extraction.segments,
      timeWindows: extraction.windows,
      bufferResults
    }
  }

  return {
    drawAreaAndAnalyze,
    clearLastAnalysis
  }
}

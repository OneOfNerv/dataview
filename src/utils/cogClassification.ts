export interface CogClassItem {
  name: string
  value: number
  color: string
  id?: string
  description?: string
}

export interface NormalizedCogClassItem extends CogClassItem {
  rgba: [number, number, number, number]
}

export interface CogClassificationStyle {
  classes: CogClassItem[]
  transparentUnknown?: boolean
  unknownColor?: string
}

export interface NormalizedCogClassificationStyle {
  classes: NormalizedCogClassItem[]
  transparentUnknown: boolean
  unknownColor: [number, number, number, number]
  styleKey: string
}

const DEFAULT_UNKNOWN_COLOR: [number, number, number, number] = [0, 0, 0, 0]

export function parseCssColorToRgba(color: string): [number, number, number, number] {
  const hex = color.trim()
  const shortHex = /^#([0-9a-f]{3}|[0-9a-f]{4})$/i.exec(hex)
  if (shortHex) {
    const raw = shortHex[1]
    const r = parseInt(raw[0] + raw[0], 16)
    const g = parseInt(raw[1] + raw[1], 16)
    const b = parseInt(raw[2] + raw[2], 16)
    const a = raw.length === 4 ? parseInt(raw[3] + raw[3], 16) / 255 : 1
    return [r, g, b, a]
  }

  const longHex = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex)
  if (longHex) {
    const raw = longHex[1]
    const r = parseInt(raw.slice(0, 2), 16)
    const g = parseInt(raw.slice(2, 4), 16)
    const b = parseInt(raw.slice(4, 6), 16)
    const a = raw.length === 8 ? parseInt(raw.slice(6, 8), 16) / 255 : 1
    return [r, g, b, a]
  }

  throw new Error(`Unsupported class color: ${color}`)
}

export function normalizeCogClassification(
  style?: CogClassificationStyle
): NormalizedCogClassificationStyle {
  const classes = (style?.classes ?? [])
    .filter((item) => Number.isFinite(item.value) && item.color)
    .map((item) => ({
      ...item,
      rgba: parseCssColorToRgba(item.color)
    }))

  const transparentUnknown = style?.transparentUnknown ?? true
  const unknownColor = transparentUnknown
    ? DEFAULT_UNKNOWN_COLOR
    : style?.unknownColor
      ? parseCssColorToRgba(style.unknownColor)
      : [0, 0, 0, 1] as [number, number, number, number]

  const styleKey = classes
    .map((item) => `${item.value}:${item.color.toLowerCase()}`)
    .join('|') + `|unknown:${transparentUnknown}:${unknownColor.join(',')}`

  return { classes, transparentUnknown, unknownColor, styleKey }
}

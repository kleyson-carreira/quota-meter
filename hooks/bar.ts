import type { PaceStatus } from './pace'

export type BarColor = 'green' | 'yellow' | 'red' | 'cyan'

export type Segment = { text: string; color?: BarColor; dimColor?: boolean }

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const
const FULL = '█'
const EMPTY = '░'
const MARKER = '│'
const MARKER_COLOR: BarColor = 'cyan'

const FILL_COLORS: Readonly<Record<PaceStatus, BarColor>> = {
  under: 'green',
  near: 'yellow',
  over: 'red',
}

const clampPercent = (percent: number): number => Math.min(100, Math.max(0, percent))

export const barCells = (width: number, real: number): string[] => {
  const eighths = Math.round((clampPercent(real) / 100) * width * 8)
  const cells: string[] = Array.from({ length: Math.floor(eighths / 8) }, () => FULL)
  const partial = EIGHTHS[eighths % 8]
  if (partial) cells.push(partial)
  while (cells.length < width) cells.push(EMPTY)

  return cells
}

export const markerIndex = (width: number, ideal: number): number =>
  Math.min(width - 1, Math.round((clampPercent(ideal) / 100) * width))

export const renderBar = (
  width: number,
  real: number,
  ideal: number | undefined,
  status: PaceStatus,
): Segment[] => {
  const marker = ideal === undefined ? -1 : markerIndex(width, ideal)
  const segments: Segment[] = []

  barCells(width, real).forEach((cell, index) => {
    const next: Segment =
      index === marker
        ? { text: MARKER, color: MARKER_COLOR }
        : cell === EMPTY
          ? { text: cell, dimColor: true }
          : { text: cell, color: FILL_COLORS[status] }
    const last = segments[segments.length - 1]
    const isSameStyle =
      last !== undefined &&
      last.color === next.color &&
      last.dimColor === next.dimColor &&
      next.text !== MARKER &&
      last.text !== MARKER

    if (isSameStyle) last.text += next.text
    else segments.push(next)
  })

  return segments
}

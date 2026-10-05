export type PaceStatus = 'under' | 'near' | 'over'

const HOUR_MS = 3_600_000

const DURATIONS_MS: Readonly<Record<string, number>> = {
  five_hour: 5 * HOUR_MS,
  seven_day: 168 * HOUR_MS,
}

const LABELS: Readonly<Record<string, string>> = {
  five_hour: '5h',
  seven_day: '7d',
}

export const windowDuration = (kind: string): number | undefined => DURATIONS_MS[kind]

export const windowLabel = (kind: string): string => LABELS[kind] ?? 'lim'

export const isExpired = (resetsAt: string | undefined, now: number): boolean =>
  resetsAt !== undefined && Date.parse(resetsAt) <= now

// Linear 24/7 pace: the share of the window that has elapsed.
export const idealPercent = (
  kind: string,
  resetsAt: string | undefined,
  now: number,
): number | undefined => {
  const duration = windowDuration(kind)
  if (duration === undefined || resetsAt === undefined) return undefined

  const end = Date.parse(resetsAt)
  if (Number.isNaN(end) || end <= now) return undefined

  const elapsed = now - (end - duration)

  return Math.min(100, Math.max(0, (elapsed / duration) * 100))
}

export const formatCountdown = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '<1m'

  const days = Math.floor(minutes / 1_440)
  const hours = Math.floor((minutes % 1_440) / 60)
  const rest = minutes % 60

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h${String(rest).padStart(2, '0')}m`

  return `${rest}m`
}

export const formatTokens = (count: number): string => {
  if (count < 1_000) return String(count)
  if (count < 10_000) return `${(Math.floor(count / 100) / 10).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.floor(count / 1_000)}k`

  return `${(Math.floor(count / 10_000) / 100).toFixed(2)}M`
}

export const formatUsd = (usd: number): string => `$${usd.toFixed(2)}`

// Decides the bar's color: how far ahead of the ideal pace is still fine.
// `real` and `ideal` are 0–100; `ideal` is undefined when the window has no
// known duration or reset time (e.g. `spend_limit`), so only `real` can decide.
// Invariants the tests pin: 0% used is 'under', 100% used is 'over', and the
// status never improves as `real` grows for a fixed `ideal`.
export const paceStatus = (real: number, ideal: number | undefined): PaceStatus => {
  if (real >= 90) return 'over'
  if (ideal === undefined) return real >= 75 ? 'near' : 'under'
  if (real <= ideal) return 'under'

  return real - ideal <= 10 ? 'near' : 'over'
}

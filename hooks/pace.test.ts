import { describe, expect, test } from 'claude-code/testing'

import {
  formatCountdown,
  formatTokens,
  formatUsd,
  idealPercent,
  isExpired,
  paceStatus,
  windowDuration,
  windowLabel,
} from './pace'

const HOUR = 3_600_000
const NOW = Date.parse('2026-10-05T12:00:00Z')
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()

describe('windows', () => {
  test('known kinds have a duration and a label', () => {
    expect(windowDuration('five_hour')).toBe(5 * HOUR)
    expect(windowDuration('seven_day')).toBe(168 * HOUR)
    expect(windowLabel('five_hour')).toBe('5h')
    expect(windowLabel('seven_day')).toBe('7d')
  })

  test('unknown kinds have no duration', () => {
    expect(windowDuration('spend_limit')).toBeUndefined()
    expect(windowLabel('spend_limit')).toBe('lim')
  })

  test('names every object inherits are not window kinds', () => {
    expect(windowDuration('toString')).toBeUndefined()
    expect(windowLabel('toString')).toBe('lim')
    expect(windowLabel('constructor')).toBe('lim')
  })
})

describe('idealPercent', () => {
  test('is 0 when the window has just started', () => {
    expect(idealPercent('five_hour', at(5 * HOUR), NOW)).toBe(0)
  })

  test('is 50 halfway through the window', () => {
    expect(idealPercent('five_hour', at(2.5 * HOUR), NOW)).toBe(50)
  })

  test('follows the weekly window over 168 hours', () => {
    expect(Math.round(idealPercent('seven_day', at(72 * HOUR), NOW) ?? -1)).toBe(57)
  })

  test('is undefined without a reset time, a known duration, or a future reset', () => {
    expect(idealPercent('five_hour', undefined, NOW)).toBeUndefined()
    expect(idealPercent('spend_limit', at(HOUR), NOW)).toBeUndefined()
    expect(idealPercent('five_hour', at(0), NOW)).toBeUndefined()
    expect(idealPercent('five_hour', 'not a date', NOW)).toBeUndefined()
  })
})

describe('isExpired', () => {
  test('is true once the reset time is reached', () => {
    expect(isExpired(at(0), NOW)).toBe(true)
    expect(isExpired(at(-HOUR), NOW)).toBe(true)
  })

  test('is false before the reset or without one', () => {
    expect(isExpired(at(1), NOW)).toBe(false)
    expect(isExpired(undefined, NOW)).toBe(false)
  })
})

describe('formatCountdown', () => {
  test('shows <1m under a minute', () => {
    expect(formatCountdown(0)).toBe('<1m')
    expect(formatCountdown(59_999)).toBe('<1m')
    expect(formatCountdown(-5_000)).toBe('<1m')
  })

  test('shows minutes, then hours and padded minutes, then days and hours', () => {
    expect(formatCountdown(60_000)).toBe('1m')
    expect(formatCountdown(12 * 60_000)).toBe('12m')
    expect(formatCountdown(HOUR + 5 * 60_000)).toBe('1h05m')
    expect(formatCountdown(HOUR + 54 * 60_000)).toBe('1h54m')
    expect(formatCountdown(24 * HOUR)).toBe('1d 0h')
    expect(formatCountdown(76 * HOUR + 30 * 60_000)).toBe('3d 4h')
  })
})

describe('formatTokens', () => {
  test('rounds down at every unit boundary', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(8_250)).toBe('8.2k')
    expect(formatTokens(9_999)).toBe('9.9k')
    expect(formatTokens(82_400)).toBe('82k')
    expect(formatTokens(999_999)).toBe('999k')
    expect(formatTokens(1_249_000)).toBe('1.24M')
  })
})

describe('formatUsd', () => {
  test('shows two decimals', () => {
    expect(formatUsd(3.4712)).toBe('$3.47')
    expect(formatUsd(0)).toBe('$0.00')
  })
})

describe('paceStatus', () => {
  const RANK = { under: 0, near: 1, over: 2 } as const

  test('is under when nothing is used', () => {
    expect(paceStatus(0, 50)).toBe('under')
    expect(paceStatus(0, undefined)).toBe('under')
  })

  test('is under while comfortably behind the ideal pace', () => {
    expect(paceStatus(30, 50)).toBe('under')
  })

  test('is over when the window is used up', () => {
    expect(paceStatus(100, 50)).toBe('over')
    expect(paceStatus(100, 100)).toBe('over')
    expect(paceStatus(100, undefined)).toBe('over')
  })

  test('never improves as real usage grows', () => {
    for (const ideal of [undefined, 0, 25, 50, 75, 100]) {
      let previous = 0
      for (let real = 0; real <= 100; real += 1) {
        const current = RANK[paceStatus(real, ideal)]
        expect(current).toBeGreaterThanOrEqual(previous)
        previous = current
      }
    }
  })
})

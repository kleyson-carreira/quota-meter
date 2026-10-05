import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Limit, Reading } from '../types'
import { renderBar } from './bar'
import {
  formatCountdown,
  formatTokens,
  formatUsd,
  idealPercent,
  isExpired,
  paceStatus,
  windowLabel,
} from './pace'

const COMMAND = 'quota'
const TICK_MS = 60_000
const READING_KEY = 'lastReading'
const HIDDEN_KEY = 'isHidden'
const LABEL_COLUMNS = 4
const MIN_BAR = 10
const MAX_BAR = 40

const limits = atom({ plugin: 'quota-meter', key: 'limits' } as const, [])
const isStale = atom({ plugin: 'quota-meter', key: 'isStale' } as const, false)
const usd = atom({ plugin: 'quota-meter', key: 'usd' } as const, null)
const tokens = atom({ plugin: 'quota-meter', key: 'tokens' } as const, { total: 0, output: 0 })
const now = atom({ plugin: 'quota-meter', key: 'now' } as const, 0)
const isHidden = atom({ plugin: 'quota-meter', key: 'isHidden' } as const, false)

const copyLimits = (rateLimits: readonly SessionRateLimit[]): Limit[] =>
  rateLimits.map(limit => ({ ...limit }))

const isLimit = (value: unknown): value is Limit => {
  if (typeof value !== 'object' || value === null) return false
  const { kind, percentUsed, resetsAt } = value as Record<string, unknown>

  return (
    typeof kind === 'string' &&
    typeof percentUsed === 'number' &&
    Number.isFinite(percentUsed) &&
    (resetsAt === undefined || typeof resetsAt === 'string')
  )
}

// A reading an older version stored may differ: keep the entries that still read as limits.
const storedLimits = (value: unknown): Limit[] => {
  if (typeof value !== 'object' || value === null) return []
  const stored = (value as { limits?: unknown }).limits

  return Array.isArray(stored) ? stored.filter(isLimit) : []
}

const tick = async ($: EngineInterface): Promise<void> => {
  const time = await $.clock.now()
  await update($, now, () => time)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show or hide the quota meter band' })

    const usage = await $.session.usage()
    const stored = storedLimits(await $.store.get(READING_KEY))
    const hidden = (await $.store.get(HIDDEN_KEY)) === true

    if (usage.rateLimits.length > 0) {
      const fresh = copyLimits(usage.rateLimits)
      await update($, limits, () => fresh)
      await update($, isStale, () => false)
    } else if (stored.length > 0) {
      await update($, limits, () => stored)
      await update($, isStale, () => true)
    }

    await update($, usd, () => usage.cost?.usd ?? null)
    await update($, isHidden, () => hidden)
    await tick($)
    $.clock.every(TICK_MS, () => void tick($))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length > 0) {
      const fresh = copyLimits(e.rateLimits)
      const reading: Reading = { limits: fresh, at: await $.clock.now() }
      await update($, limits, () => fresh)
      await update($, isStale, () => false)
      await $.store.set(READING_KEY, reading)
    }

    if (e.cost !== undefined) {
      const total = e.cost.usd
      await update($, usd, () => total)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const usage = e.usage
    if (usage !== undefined) {
      await update($, tokens, current => ({
        total:
          current.total +
          usage.input_tokens +
          usage.output_tokens +
          usage.cache_read_input_tokens +
          usage.cache_creation_input_tokens,
        output: current.output + usage.output_tokens,
      }))
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // Neither /clear nor an in-process /resume is followed by session.start.
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, tokens, () => ({ total: 0, output: 0 }))
      await update($, usd, () => null)
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    // This session's state, not the store: another session may have toggled it.
    const hidden = !(await read($, isHidden))
    await $.store.set(HIDDEN_KEY, hidden)
    await update($, isHidden, () => hidden)

    return { text: hidden ? 'Quota meter hidden. Run /quota to show it again.' : 'Quota meter shown.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const list = await read($, limits)
    const stale = await read($, isStale)
    const cost = await read($, usd)
    const used = await read($, tokens)
    // Reading `now` subscribes the band to the minute tick.
    const tickedAt = await read($, now)
    const time = Math.max(tickedAt, await $.clock.now())

    const session = [
      used.total > 0 ? `${formatTokens(used.total)} tok (out ${formatTokens(used.output)})` : null,
      cost !== null ? formatUsd(cost) : null,
    ].filter(part => part !== null)

    if (list.length === 0 && session.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)

    const rows = list.map(limit => {
      const isOver = isExpired(limit.resetsAt, time)
      const real = isOver ? 0 : limit.percentUsed
      const ideal = isOver ? undefined : idealPercent(limit.kind, limit.resetsAt, time)
      const details = isOver
        ? ['new window on next msg']
        : [
            ideal === undefined ? null : `ideal ${Math.round(ideal)}%`,
            limit.resetsAt === undefined
              ? null
              : `resets ${formatCountdown(Date.parse(limit.resetsAt) - time)}`,
          ].filter(part => part !== null)
      const tail = `  ${[`${Math.round(real)}%`.padStart(4), ...details].join('  ')}${stale ? '  (last seen)' : ''}`

      return { limit, real, ideal, tail }
    })

    // The bar takes what the longest row's text leaves; below MIN_BAR the text truncates instead.
    const tailColumns = Math.max(0, ...rows.map(row => row.tail.length))
    const width = Math.min(MAX_BAR, Math.max(MIN_BAR, e.props.bodyColumns - LABEL_COLUMNS - tailColumns))

    return (
      <Box flexDirection="column">
        {rows.map(({ limit, real, ideal, tail }) => (
          <Box key={limit.kind}>
            <Text dimColor={stale}>{windowLabel(limit.kind).padEnd(LABEL_COLUMNS)}</Text>
            <Box key={`${limit.kind}-bar`} flexShrink={0}>
              {renderBar(width, real, ideal, paceStatus(real, ideal)).map((segment, index) => (
                <Text key={`${limit.kind}-${index}`} color={segment.color} dimColor={segment.dimColor === true || stale}>
                  {segment.text}
                </Text>
              ))}
            </Box>
            <Text dimColor={stale} wrap="truncate-end">
              {tail}
            </Text>
          </Box>
        ))}
        {session.length > 0 && <Text dimColor>{`session  ${session.join(' · ')}`}</Text>}
      </Box>
    )
  })
}

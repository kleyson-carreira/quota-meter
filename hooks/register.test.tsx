import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

const HOUR = 3_600_000
const NOW = Date.parse('2026-10-05T12:00:00Z')
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()

const SURFACES = ['terminal', 'desktop'] as const

const BAND = {
  plugin: 'quota-meter',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// 5h: 3h of 5h elapsed, so the ideal is 60%. 7d: 96h of 168h elapsed, so 57%.
const LIMITS: SessionRateLimit[] = [
  { kind: 'five_hour', percentUsed: 48, resetsAt: at(2 * HOUR) },
  { kind: 'seven_day', percentUsed: 24, resetsAt: at(72 * HOUR) },
]

// Answers, beneath the plugin, every engine call the module makes.
const engine = (
  on: On,
  options: { store?: Record<string, unknown> | Map<string, unknown>; rateLimits?: SessionRateLimit[] } = {},
) => {
  const clock = mock.clock(on, { now: NOW })
  const store = options.store
  if (store instanceof Map) {
    // A store the test can change mid-run, as another session writing to it would.
    on('store.get', ($, e) => ({ value: store.get(e.key) }))
    on('store.set', ($, e) => {
      store.set(e.key, e.value)

      return { value: undefined }
    })
  } else {
    mock.store(on, store ?? {})
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.end', () => ({ sessionId: 'test' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  // The engine's own band, standing in as an empty Box.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: options.rateLimits ?? [] },
  }))

  return clock
}

const start = ($: Engine) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

const measure = ($: Engine, rateLimits: SessionRateLimit[], usd: number) =>
  $.session.measure({
    context: { window: 200_000 },
    rateLimits,
    cost: { usd },
    changed: ['rateLimits', 'cost'],
  })

const complete = ($: Engine, usage: [number, number, number, number], agentId?: string) =>
  $.turn.complete({
    answer: '',
    durationMs: 1_000,
    isAborted: false,
    reason: 'answer',
    turnId: `turn-${agentId ?? 'main'}`,
    ...(agentId === undefined ? {} : { agentId }),
    usage: {
      input_tokens: usage[0],
      output_tokens: usage[1],
      cache_read_input_tokens: usage[2],
      cache_creation_input_tokens: usage[3],
      model: 'claude-opus-5-5',
    },
  })

const runQuota = ($: Engine) =>
  $.command.run({
    command: 'quota',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

test('draws both windows and the session row on every surface', async ($, on) => {
  engine(on)
  await start($)
  await measure($, LIMITS, 3.47)
  await complete($, [1_000, 2_000, 10_000, 500])
  await complete($, [500, 500, 0, 0], 'subagent-1')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /48%  ideal 60%  resets 2h00m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /24%  ideal 57%  resets 3d 0h/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'session  14k tok (out 2.5k) · $3.47' })).toBeDefined()
    await ui.unmount()
  }
})

test('moves the ideal marker and the countdown with the clock', async ($, on) => {
  const clock = engine(on)
  await start($)
  await measure($, LIMITS, 1)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /ideal 60%  resets 2h00m/ })).toBeDefined()

  await clock.advance(HOUR)

  expect(await ui.find({ type: 'Text', text: /ideal 80%  resets 1h00m/ })).toBeDefined()
  await ui.unmount()
})

test('shows the stored reading as last seen until the first measurement', async ($, on) => {
  engine(on, { store: { lastReading: { limits: LIMITS, at: NOW - HOUR } } })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /48%.*\(last seen\)/ })).toBeDefined()

  await measure($, LIMITS, 1)

  expect(await ui.find({ type: 'Text', text: /\(last seen\)/ })).toBeUndefined()
  await ui.unmount()
})

test('an expired window waits for the next message', async ($, on) => {
  engine(on)
  await start($)
  await measure($, [{ kind: 'five_hour', percentUsed: 97, resetsAt: at(-60_000) }], 1)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /0%  new window on next msg/ })).toBeDefined()
  await ui.unmount()
})

test('/quota hides the band and shows it again', async ($, on) => {
  engine(on)
  await start($)
  await measure($, LIMITS, 1)

  expect((await runQuota($)).text).toMatch(/hidden/)
  const hidden = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await hidden.find({ type: 'Text', text: /ideal/ })).toBeUndefined()
  await hidden.unmount()

  expect((await runQuota($)).text).toMatch(/shown/)
  const shown = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await shown.find({ type: 'Text', text: /ideal/ })).toBeDefined()
  await shown.unmount()
})

test('draws nothing without readings, tokens or cost', async ($, on) => {
  engine(on)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  await ui.unmount()
})

test('keeps the minimum bar width on a narrow terminal', async ($, on) => {
  engine(on)
  await start($)
  await measure($, LIMITS, 1)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 30 } })
  const cells = await ui.findAll({ type: 'Text', text: /^[█▏▎▍▌▋▊▉░│]+$/ })
  expect(cells.map(cell => cell.text).join('')).toHaveLength(2 * 10)
  await ui.unmount()
})

test('shows an unknown window without pace, even past 100%', async ($, on) => {
  engine(on)
  await start($)
  await measure($, [{ kind: 'spend_limit', percentUsed: 104.4 }], 1)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^lim/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /104%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ideal|resets/ })).toBeUndefined()
  await ui.unmount()
})

test('ignores a stored reading it cannot read', async ($, on) => {
  engine(on, { store: { lastReading: 'garbage' } })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  await ui.unmount()
})

test('/clear starts the session row over and keeps the windows', async ($, on) => {
  engine(on)
  await start($)
  await measure($, LIMITS, 2)
  await complete($, [1_000, 1_000, 0, 0])
  await $.session.end({ reason: 'clear', sessionId: 'test', resume: { id: 'test' } })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^session/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /ideal 60%/ })).toBeDefined()
  await ui.unmount()
})

test('keeps every row within the band, stale or fresh', async ($, on) => {
  engine(on, { store: { lastReading: { limits: LIMITS, at: NOW - HOUR } } })
  await start($)

  for (const isStale of [true, false]) {
    if (!isStale) await measure($, LIMITS, 1)
    for (const bodyColumns of [75, 115]) {
      const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns } })
      for (const key of ['five_hour', 'seven_day']) {
        expect((await ui.find({ key }))?.text.length ?? Infinity).toBeLessThanOrEqual(bodyColumns)
      }
      await ui.unmount()
    }
  }
})

test('truncates the details, never the bar, on a narrow terminal', async ($, on) => {
  engine(on)
  await start($)
  await measure($, LIMITS, 1)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 30 } })
  expect((await ui.find({ key: 'five_hour-bar' }))?.props.flexShrink).toBe(0)
  expect((await ui.find({ type: 'Text', text: /48%/ }))?.props.wrap).toBe('truncate-end')
  await ui.unmount()
})

test('skips stored entries it cannot read and keeps the rest', async ($, on) => {
  const limits = [null, 'x', { kind: 'five_hour', percent: 48 }, { kind: 'seven_day', percentUsed: 24, resetsAt: at(72 * HOUR) }]
  engine(on, { store: { lastReading: { limits, at: NOW } } })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /24%.*\(last seen\)/ })).toBeDefined()
  expect(await ui.find({ key: 'five_hour' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /NaN/ })).toBeUndefined()
  await ui.unmount()
})

test('/quota hides the band even after another session hid it', async ($, on) => {
  const store = new Map<string, unknown>()
  engine(on, { store })
  await start($)
  await measure($, LIMITS, 1)
  store.set('isHidden', true)

  expect((await runQuota($)).text).toMatch(/hidden/)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /ideal/ })).toBeUndefined()
  await ui.unmount()
})

test('a resumed conversation starts the session row over', async ($, on) => {
  engine(on)
  await start($)
  await measure($, LIMITS, 2)
  await complete($, [1_000, 1_000, 0, 0])
  await $.session.end({ reason: 'resume', sessionId: 'test', resume: { id: 'other' } })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^session/ })).toBeUndefined()
  await ui.unmount()
})

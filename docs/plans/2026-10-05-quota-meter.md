# quota-meter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A global Claude Code mod that draws, above the prompt, the 5-hour and weekly quota usage against a linear ideal-pace marker, the time to each reset, and the session's tokens and cost.

**Architecture:** Two pure modules (`pace.ts` for math and formatting, `bar.ts` for the bar's colored segments) under a thin wiring module (`register.tsx`) that turns engine events into atoms and draws the `AbovePrompt` band from them. Per-session values live in `$.state` atoms; the last reading and the hidden flag live in `$.store` so they cross sessions.

**Tech Stack:** Claude Code 2.1.289 function hooks (TypeScript/TSX, `claude-code` API), `claude-code/testing` kit, TypeScript 5 via `npx` for type-checking.

**Spec:** `docs/specs/2026-10-05-quota-meter-design.md`

## Global Constraints

- Mod root: `~/.claude/mods/quota-meter` (git repository, branch `main`). Plugin name: `quota-meter`.
- English everywhere: code, comments, UI copy, test names, commit messages. No AI attribution trailers in commits.
- Atom refs use string literals, never constants: `atom({ plugin: 'quota-meter', key: 'limits' } as const, ...)`. `claude plugin validate` rejects anything else.
- The types contract `types/index.d.ts` is self-contained: no `import`, `export ... from` or references.
- Hooks modules run with no DOM and no Node: everything outside goes through `$`. Elements come from `$.ui.resolve(e)`.
- In tests, engine *operations* (`session.usage`, `command.register`) are answered as `{ value: ... }`; *events* (`session.start`, `session.measure`, `turn.complete`, `session.end`, `ui.render`) are answered with their result.
- Window durations: `five_hour` = 5 h, `seven_day` = 168 h. Ideal pace is linear, 24/7.
- Placeholders: `$SCRATCH` is any folder outside the repo, `<mod folder>` is the mod's absolute path, and `<session-id>` is the id of the session authoring the mod.
- Verification commands (all three must pass before any commit that touches `hooks/` or `types/`):
  - `claude plugin validate ~/.claude/mods/quota-meter` → `✔ Validation passed`
  - `claude plugin test ~/.claude/mods/quota-meter` → `0 fail`
  - `npx -y -p typescript@5 tsc -p $SCRATCH/tsconfig.check.json` → exit 0, no output

## Review Focus

1. A narrow terminal (`bodyColumns` 30): the bar must clamp to its 10-cell minimum, not collapse or overflow. Test in Task 3.
2. A window of an unknown kind (`spend_limit`) past 100%: label `lim`, the percent rounded as reported, no ideal and no countdown. Test in Task 3.
3. A corrupt `lastReading` in `$.store` (an older format, a string): ignored, never thrown on. Test in Task 3.
4. `/clear`: the session row starts over while the quota windows stay. Test in Task 3.
5. A hot reload re-runs `register` and `session.start`: the band must keep one minute tick and one `/quota` command. Not reachable from the test kit; checked by hand in Task 4.

---

### Task 1: Scaffold and the pace module

**Files:**
- Create: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `types/index.d.ts`, `hooks/register.tsx` (minimal), `hooks/pace.ts`, `hooks/pace.test.ts`
- Create (outside the repo): `$SCRATCH/tsconfig.check.json`

**Interfaces:**
- Produces (`hooks/pace.ts`): `type PaceStatus = 'under' | 'near' | 'over'`; `windowDuration(kind: string): number | undefined`; `windowLabel(kind: string): string`; `isExpired(resetsAt: string | undefined, now: number): boolean`; `idealPercent(kind: string, resetsAt: string | undefined, now: number): number | undefined`; `formatCountdown(ms: number): string`; `formatTokens(count: number): string`; `formatUsd(usd: number): string`; `paceStatus(real: number, ideal: number | undefined): PaceStatus`.
- Produces (`types/index.d.ts`): `Limit`, `Reading`, `Tokens`, and `PluginState['quota-meter']`.

- [ ] **Step 1: Write the scaffold**

`.claude-plugin/plugin.json`:

```json
{
  "name": "quota-meter",
  "version": "0.1.0",
  "description": "Band above the prompt: 5-hour and weekly quota vs. ideal pace, time to reset, session tokens and cost",
  "author": { "name": "Kleyson Carreira" },
  "types": "./types/index.d.ts"
}
```

`hooks/hooks.json`:

```json
{ "modules": ["./register.tsx"] }
```

`types/index.d.ts`:

```ts
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Reading = { limits: Limit[]; at: number }

export type Tokens = { total: number; output: number }

declare module 'claude-code' {
  interface PluginState {
    'quota-meter': {
      limits: Limit[]
      isStale: boolean
      usd: number | null
      tokens: Tokens
      now: number
      isHidden: boolean
    }
  }
}
```

`hooks/register.tsx` (minimal, so the manifest validates until Task 3):

```tsx
import type { Register } from 'claude-code'

// Wired in Task 3.
export const register: Register = () => {}
```

`$SCRATCH/tsconfig.check.json` (outside the repo; it names the engine's type file, which lives under the session's temp folder):

```json
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
  },
  "include": [
    "<claude-code.d.ts named by the plugin-authoring skill>",
    "<mod folder>/hooks",
    "<mod folder>/types"
  ]
}
```

- [ ] **Step 2: Write the failing tests**

`hooks/pace.test.ts`:

```ts
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
```

The `paceStatus` tests pin invariants only (nothing used is `under`, a used-up window is `over`, status never improves as usage grows), so any thresholds the owner picks pass them.

- [ ] **Step 3: Run the tests to see them fail**

Run: `claude plugin test ~/.claude/mods/quota-meter`
Expected: FAIL, `hooks/pace.test.ts` cannot import `./pace`.

- [ ] **Step 4: Implement `hooks/pace.ts`**

Learning mode: the owner writes the body of `paceStatus` (where yellow and red begin). Create the file with every other function as below and `paceStatus` throwing `new Error('paceStatus: not written yet')`, hand it to the owner, and use the reference body below only if they delegate it.

```ts
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

export const paceStatus = (real: number, ideal: number | undefined): PaceStatus => {
  if (real >= 90) return 'over'
  if (ideal === undefined) return real >= 75 ? 'near' : 'under'
  if (real <= ideal) return 'under'

  return real - ideal <= 10 ? 'near' : 'over'
}
```

- [ ] **Step 5: Run the checks**

Run: `claude plugin test ~/.claude/mods/quota-meter` → Expected: `hooks/pace.test.ts` all pass, `0 fail`.
Run: `claude plugin validate ~/.claude/mods/quota-meter` → Expected: `✔ Validation passed`.
Run: `npx -y -p typescript@5 tsc -p $SCRATCH/tsconfig.check.json` → Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd ~/.claude/mods/quota-meter
git add .claude-plugin hooks types
git commit -m "feat: scaffold quota-meter and add pace math and formatters"
```

---

### Task 2: The bar module

**Files:**
- Create: `hooks/bar.ts`, `hooks/bar.test.ts`

**Interfaces:**
- Consumes: `PaceStatus` from `./pace`.
- Produces: `type BarColor = 'green' | 'yellow' | 'red' | 'cyan'`; `type Segment = { text: string; color?: BarColor; dimColor?: boolean }`; `barCells(width: number, real: number): string[]`; `markerIndex(width: number, ideal: number): number`; `renderBar(width: number, real: number, ideal: number | undefined, status: PaceStatus): Segment[]`.

- [ ] **Step 1: Write the failing tests**

`hooks/bar.test.ts`:

```ts
import { describe, expect, test } from 'claude-code/testing'

import { barCells, markerIndex, renderBar } from './bar'
import type { Segment } from './bar'

const joined = (segments: Segment[]): string => segments.map(segment => segment.text).join('')

describe('barCells', () => {
  test('0% is all empty and 100% is all full', () => {
    expect(barCells(10, 0).join('')).toBe('░░░░░░░░░░')
    expect(barCells(10, 100).join('')).toBe('██████████')
  })

  test('fills to the eighth of a cell', () => {
    expect(barCells(10, 45).join('')).toBe('████▌░░░░░')
    expect(barCells(10, 12.5).join('')).toBe('█▎░░░░░░░░')
  })

  test('clamps out-of-range usage', () => {
    expect(barCells(10, 130).join('')).toBe('██████████')
    expect(barCells(10, -5).join('')).toBe('░░░░░░░░░░')
  })
})

describe('markerIndex', () => {
  test('stays inside the bar', () => {
    expect(markerIndex(10, 0)).toBe(0)
    expect(markerIndex(10, 50)).toBe(5)
    expect(markerIndex(10, 100)).toBe(9)
  })
})

describe('renderBar', () => {
  test('draws the marker in the empty part', () => {
    expect(renderBar(10, 20, 60, 'under')).toEqual([
      { text: '██', color: 'green' },
      { text: '░░░░', dimColor: true },
      { text: '│', color: 'cyan' },
      { text: '░░░', dimColor: true },
    ])
  })

  test('draws the marker inside the fill', () => {
    expect(renderBar(10, 80, 30, 'over')).toEqual([
      { text: '███', color: 'red' },
      { text: '│', color: 'cyan' },
      { text: '████', color: 'red' },
      { text: '░░', dimColor: true },
    ])
  })

  test('draws no marker without an ideal', () => {
    expect(renderBar(10, 50, undefined, 'near')).toEqual([
      { text: '█████', color: 'yellow' },
      { text: '░░░░░', dimColor: true },
    ])
  })

  test('always spans exactly the width', () => {
    for (const width of [10, 23, 40]) {
      for (const real of [0, 33.3, 99.9, 100]) {
        expect(joined(renderBar(width, real, 50, 'under'))).toHaveLength(width)
      }
    }
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `claude plugin test ~/.claude/mods/quota-meter`
Expected: FAIL, `hooks/bar.test.ts` cannot import `./bar`.

- [ ] **Step 3: Implement `hooks/bar.ts`**

```ts
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
```

- [ ] **Step 4: Run the checks**

Run the three verification commands from Global Constraints. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/mods/quota-meter
git add hooks/bar.ts hooks/bar.test.ts
git commit -m "feat: render quota bars with sub-cell fill and ideal-pace marker"
```

---

### Task 3: Wire the band

**Files:**
- Modify: `hooks/register.tsx` (replace the minimal module)
- Create: `hooks/register.test.tsx`

**Interfaces:**
- Consumes: everything `pace.ts` and `bar.ts` produce; `Limit`, `Reading` from `../types`.
- Produces: the band on `AbovePrompt`, the `/quota` command, `$.store` keys `lastReading` (`Reading`) and `isHidden` (`boolean`).

- [ ] **Step 1: Write the failing tests**

`hooks/register.test.tsx` (`.tsx` because the stand-in for the engine's own band is JSX; the kit runs `*.test.tsx` too):

```tsx
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
  options: { store?: Record<string, unknown>; rateLimits?: SessionRateLimit[] } = {},
) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, options.store ?? {})
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
```

Notes for the implementer: a `Text`'s JSX `key` does not reach `ui.find`, so the tests find rows by their text. The `ui.render` answer in `engine()` is the engine's own band; without it, a hook that returns `next(e)` makes `$.ui.mount` throw.

- [ ] **Step 2: Run the tests to see them fail**

Run: `claude plugin test ~/.claude/mods/quota-meter`
Expected: FAIL in `hooks/register.test.tsx` (the minimal module draws nothing and registers no command).

- [ ] **Step 3: Implement `hooks/register.tsx`**

```tsx
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
// Label (4) + percent, ideal, countdown and stale suffix around the bar.
const TEXT_COLUMNS = 40
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

const isReading = (value: unknown): value is Reading =>
  typeof value === 'object' && value !== null && Array.isArray((value as Reading).limits)

const tick = async ($: EngineInterface): Promise<void> => {
  const time = await $.clock.now()
  await update($, now, () => time)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show or hide the quota meter band' })

    const usage = await $.session.usage()
    const stored = await $.store.get(READING_KEY)
    const hidden = (await $.store.get(HIDDEN_KEY)) === true

    if (usage.rateLimits.length > 0) {
      const fresh = copyLimits(usage.rateLimits)
      await update($, limits, () => fresh)
      await update($, isStale, () => false)
    } else if (isReading(stored)) {
      await update($, limits, () => stored.limits)
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
    if (e.reason === 'clear') {
      await update($, tokens, () => ({ total: 0, output: 0 }))
      await update($, usd, () => null)
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const hidden = (await $.store.get(HIDDEN_KEY)) !== true
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
    const width = Math.min(MAX_BAR, Math.max(MIN_BAR, e.props.bodyColumns - TEXT_COLUMNS))

    const row = (limit: Limit) => {
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
      const suffix = stale ? '  (last seen)' : ''

      return (
        <Box key={limit.kind}>
          <Text dimColor={stale}>{windowLabel(limit.kind).padEnd(4)}</Text>
          {renderBar(width, real, ideal, paceStatus(real, ideal)).map((segment, index) => (
            <Text key={`${limit.kind}-${index}`} color={segment.color} dimColor={segment.dimColor === true || stale}>
              {segment.text}
            </Text>
          ))}
          <Text dimColor={stale}>
            {`  ${`${Math.round(real)}%`.padStart(4)}  ${details.join('  ')}${suffix}`}
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {list.map(row)}
        {session.length > 0 && <Text dimColor>{`session  ${session.join(' · ')}`}</Text>}
      </Box>
    )
  })
}
```

- [ ] **Step 4: Run the checks**

Run the three verification commands from Global Constraints. Expected: `34 pass`, `0 fail`; validation passed; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/mods/quota-meter
git add hooks/register.tsx hooks/register.test.tsx
git commit -m "feat: draw the quota band above the prompt and add /quota toggle"
```

---

### Task 4: Live preview in the authoring session

**Files:**
- Create (outside the repo): link `~/.claude/dev-mods/<session-id>/quota-meter` → `~/.claude/mods/quota-meter`
- Modify (only if the engine writes files into the mod): `.gitignore`

- [ ] **Step 1: Link the mod into the session's hot-reload folder**

```bash
ln -s ~/.claude/mods/quota-meter ~/.claude/dev-mods/<session-id>/quota-meter
```

The engine asks the owner once: "Enable hot reloading for this session?" The owner answers `Enable for this session`. The mod loads when the turn ends.

- [ ] **Step 2: Confirm it loaded**

At the start of the next turn the engine's notice says what the load came to. Expected: `quota-meter` loaded, no `refused` or `did not load` line in the transcript. If the notice says the folder is empty or the plugin is missing (the watcher did not follow the link), replace the link with a copy: `rm ~/.claude/dev-mods/<session-id>/quota-meter && cp -R ~/.claude/mods/quota-meter ~/.claude/dev-mods/<session-id>/quota-meter`, and repeat the copy after each later edit.

- [ ] **Step 3: Check the band by eye (owner)**

The owner sends one message and confirms: two bars (`5h`, `7d`) with a cyan `│`, percent, `ideal N%`, `resets ...`, and the `session` row; `/quota` hides and shows it. Review Focus 5: after one minute the countdown moves once; after editing any file under `hooks/` (a reload) `/quota` is still listed once.

- [ ] **Step 4: Type-check through the engine's own tsconfig**

Run: `ls ~/.claude/mods/quota-meter/.claude-plugin/types && git -C ~/.claude/mods/quota-meter status --short`
If the engine wrote files outside `.claude-plugin/types/` (for example a `tsconfig.json`), add them to `.gitignore` and commit:

```bash
cd ~/.claude/mods/quota-meter
git add .gitignore
git commit -m "chore: ignore engine-generated type files"
```

---

### Task 5: Install globally

**Files:**
- Modify (outside the repo): `~/.claude/settings.json` (`env` block)
- Create: `README.md`
- Delete (outside the repo): the link or copy from Task 4

- [ ] **Step 1: Show the owner the settings change, then apply it**

The change adds one key to the currently empty `env` block:

```json
"env": {
  "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/quota-meter"
}
```

After the owner approves, apply it without touching any other key:

```bash
python3 - <<'PY'
import json, os
path = os.path.expanduser('~/.claude/settings.json')
with open(path) as handle:
    settings = json.load(handle)
settings.setdefault('env', {})['CLAUDE_CODE_PLUGIN_DIRS'] = '~/.claude/mods/quota-meter'
with open(path, 'w') as handle:
    json.dump(settings, handle, indent=2, ensure_ascii=False)
    handle.write('\n')
PY
python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude/settings.json')))['env'])"
```

Expected: `{'CLAUDE_CODE_PLUGIN_DIRS': '~/.claude/mods/quota-meter'}`

- [ ] **Step 2: Remove the session preview so nothing loads twice**

```bash
rm -rf ~/.claude/dev-mods/<session-id>/quota-meter
```

- [ ] **Step 3: Write `README.md`**

```markdown
# quota-meter

A Claude Code mod that draws a band above the prompt with:

- 5-hour and weekly subscription usage as bars;
- a cyan `│` marking the ideal linear pace for each window;
- time left until each window resets;
- the session's tokens (output in parentheses) and cost.

## Install

Loaded in every session through `~/.claude/settings.json`:

    "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/quota-meter" }

Interactive sessions watch this folder, so edits hot-reload.

## Use

`/quota` hides or shows the band (remembered across sessions).

## Develop

    claude plugin validate ~/.claude/mods/quota-meter
    claude plugin test ~/.claude/mods/quota-meter

Design: `docs/specs/2026-10-05-quota-meter-design.md`.
```

- [ ] **Step 4: Commit**

```bash
cd ~/.claude/mods/quota-meter
git add README.md
git commit -m "docs: add README with install and usage"
```

- [ ] **Step 5: Verify in a fresh session (owner)**

The owner opens a new Claude Code session (terminal or desktop) in any folder and confirms the band appears after the first reply. Expected: the same band as in Task 4, with `(last seen)` on the bars before the first reply when a reading was stored earlier.

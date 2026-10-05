# quota-meter — design

Date: 2026-10-05
Status: approved in conversation, pending written-spec review

## Goal

A Claude Code mod, loaded in **every** session (terminal and desktop), that shows at a
glance whether subscription usage is on pace to last until each window resets:

- real usage of the 5-hour window and of the weekly window, as bars;
- an "ideal pace" marker inside each bar that advances with the clock;
- time left until each window resets;
- what the current session has consumed, in tokens and US dollars.

Success: one look at the band answers "am I ahead of or behind pace, and how long until
it resets?" without running `/usage` or `/cost`.

## Decisions

| Topic | Decision |
| --- | --- |
| Placement | Band above the prompt (`ui.render` on `AbovePrompt`), 2–3 rows |
| Ideal pace | Linear, 24/7: `elapsed / windowDuration` |
| UI copy | English, hardcoded (no i18n layer for a personal tool) |
| Global loading | Folder `~/.claude/mods/quota-meter`, named in `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json` |
| Data source | Engine only (`$.session.usage()`, `session.measure`, `turn.complete`); no network calls |

## Layout

```
5h  ████████████▌░░░░│░░░░░░░░  48%  ideal 62%  resets 1h54m
7d  ██████▊░░░░░░░░│░░░░░░░░░░  24%  ideal 55%  resets 3d 4h
session  1.24M tok (out 82k) · $3.47
```

- Bar width follows `e.props.bodyColumns` minus the fixed text, clamped to 10–40 cells.
- Real fill uses eighth blocks (`▏▎▍▌▋▊▉█`) for sub-cell precision; the remainder is `░`.
- The ideal marker `│` replaces the cell at `round(ideal / 100 × width)`, clamped to the bar.
- Fill color comes from `paceStatus(real, ideal)`: `under` → green, `near` → yellow,
  `over` → red. The marker is drawn in a fixed contrasting color. The thresholds inside
  `paceStatus` are the owner's call and are written by them, against prepared tests.

## Units

| File | Responsibility | Depends on |
| --- | --- | --- |
| `hooks/pace.ts` | Pure: window duration per kind, `idealPercent`, `formatCountdown`, `formatTokens`, `formatUsd`, `paceStatus` | nothing |
| `hooks/bar.ts` | Pure: `(width, real, ideal, status)` → colored segments | `pace.ts` types |
| `hooks/register.tsx` | Wiring: events → atoms → band; `/quota` command | `claude-code`, `pace.ts`, `bar.ts` |
| `types/index.d.ts` | `PluginState['quota-meter']` contract | — |

### Window durations

| `kind` | Duration | Label |
| --- | --- | --- |
| `five_hour` | 5 h | `5h` |
| `seven_day` | 168 h | `7d` |
| anything else (e.g. `spend_limit`) | unknown | `lim` — bar and percent only, no marker or countdown |

### Formulas

- `windowStart = resetsAt − duration`
- `idealPercent = clamp((now − windowStart) / duration × 100, 0, 100)`; `undefined` when
  `resetsAt` is absent or the duration is unknown.
- Expired window (`resetsAt ≤ now`): real shown as 0, no marker, text `new window on next msg`.

### Formatting

- Countdown: `≥ 1 day` → `3d 4h`; `≥ 1 hour` → `1h54m`; `≥ 1 min` → `12m`; else `<1m`.
- Tokens: `< 1,000` → `950`; `< 10k` → `8.2k`; `< 1M` → `82k`; else `1.24M`.
- USD: `$3.47` (two decimals).

## Data flow

| Event | Action |
| --- | --- |
| `session.start` | Read `lastReading` and `isHidden` from `$.store`; seed atoms from `$.session.usage()`; register `/quota`; start `$.clock.every(60_000)` updating the `now` atom |
| `session.measure` | Write `rateLimits` and `cost` to atoms; when `rateLimits` is non-empty, persist `{ rateLimits, at }` to `$.store` as `lastReading` and clear the stale flag |
| `turn.complete` | Add `usage` (all four counts, main loop and subagents) to the `tokens` atom |
| `session.end` (`reason: 'clear'`) | Reset the `tokens` atom (cost restarts with the session) |
| `command.run` (`quota`) | Toggle `isHidden` in the atom and in `$.store` |
| `ui.render` (`AbovePrompt`) | Draw the band, or `next(e)` when hidden, a survey holds the band, or there is nothing to show |

`$.state` (atoms) holds per-session values and survives hot reloads; `$.store` holds what
must cross sessions (`lastReading`, `isHidden`).

### Stale reading

Until this session's first `session.measure` with rate limits, the bars draw the stored
`lastReading` dimmed, with a `(last seen)` suffix. A stored window whose `resetsAt` has
passed renders as expired.

## Edge cases

- `rateLimits` empty (API key, not a subscription) and no stored reading: session row only.
- `cost` absent: session row shows tokens only.
- Nothing at all to show: `next(e)`, the band stays empty.
- `percentUsed > 100` (exceeded spend limit): bar full, percent printed as reported.

## Testing

- `hooks/pace.test.ts`: durations, `idealPercent` at start/middle/end/expired/no `resetsAt`,
  every formatter boundary, `paceStatus` cases.
- `hooks/bar.test.ts`: 0%, 100%, sub-cell fill, marker inside fill, marker in empty part,
  marker absent, width clamping.
- `hooks/register.test.ts`: a simulated `session.measure` draws the band on `terminal` and
  `desktop`; `/quota` hides it; an empty measurement draws nothing.
- Gate: `claude plugin validate`, `tsc -p`, `claude plugin test` all pass.

## Development and installation

1. Source of truth: `~/.claude/mods/quota-meter` (git repository).
2. Live preview in the authoring session through its hot-reload mods folder (a symlink
   to the source; a copy if the watcher does not follow links), removed once installed.
3. Global: add `"CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/quota-meter"` to the `env`
   block of `~/.claude/settings.json` (diff shown before applying). Takes effect in new
   sessions; interactive sessions watch the folder, so later edits hot-reload.

## Out of scope

- Work-hours-weighted pacing, exhaustion projection, history charts.
- Any network call or reading of `/usage` output.

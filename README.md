# quota-meter

A Claude Code mod that shows, right above the prompt, whether your subscription usage is on pace to last until each limit resets.

```
5h  ████████████▌░░░░│░░░░░░░░   48%  ideal 62%  resets 1h54m
7d  ██████▊░░░░░░░░│░░░░░░░░░░   24%  ideal 55%  resets 3d 4h
session  1.24M tok (out 82k) · $3.47
```

- **Bars:** how much of the 5-hour window and of the weekly window you have used.
- **`│` marker:** the ideal pace. It is linear over the whole window, 24/7: halfway through the window, the ideal is 50%. It moves with the clock, so you can see yourself pull ahead of it or fall behind.
- **Colors:**
  - **green:** at or below the ideal;
  - **yellow:** up to 10 points ahead of it;
  - **red:** more than 10 points ahead, or at 90% used or more.
  - A window with no known length (e.g. a gateway's `spend_limit`) has no ideal: it turns yellow at 75% and red at 90%.
- **`resets`:** time left until each window resets.
- **`session`:** tokens this session has processed (cache reads included; output in parentheses) and its cost, as `/cost` reports it.

The figures come from Claude Code itself (`$.session.usage()` and the `session.measure` event). The mod makes no network calls. A new session has no reading until its first reply, so until then it shows the last one it saw, dimmed and marked `(last seen)`.

## Requirements

- Claude Code **2.1.289** or newer, which runs mods written as function hooks. That plugin API is in early access and may change between releases.
- A Claude subscription (e.g. Pro or Max) for the quota bars. With an API key there are no rate-limit windows to show, so only the session row appears.

## Install

1. Clone the repository anywhere:

   ```sh
   git clone https://github.com/kleyson-carreira/quota-meter ~/.claude/mods/quota-meter
   ```

2. Load it in every session, in the terminal and in the desktop app, by naming the folder in the `env` block of `~/.claude/settings.json`:

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/quota-meter"
     }
   }
   ```

   To load several folders, separate them with `:` (`;` on Windows).

3. Start a new session. The variable is read at startup, so sessions that are already running don't pick it up. Interactive sessions watch the folder, so later edits to the mod reload by themselves.

To try it in a single terminal session instead, run `claude --plugin-dir ~/.claude/mods/quota-meter`.

## Use

`/quota` hides or shows the band. The choice is remembered across sessions.

## Develop

```sh
claude plugin validate ~/.claude/mods/quota-meter
claude plugin test ~/.claude/mods/quota-meter
npx -y -p typescript@5 tsc -p ~/.claude/mods/quota-meter   # after Claude Code has loaded the mod once
```

| File | Role |
| --- | --- |
| `hooks/pace.ts` | Window math and formatting, pure |
| `hooks/bar.ts` | Bar segments: sub-cell fill and the ideal marker, pure |
| `hooks/register.tsx` | Engine events → state → the band and `/quota` |
| `types/index.d.ts` | The mod's state contract |

The design is in [`docs/specs`](docs/specs/2026-10-05-quota-meter-design.md), and the implementation plan it was built from is in [`docs/plans`](docs/plans/2026-10-05-quota-meter.md).

## License

[MIT](LICENSE)

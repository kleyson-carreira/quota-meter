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
    npx -y -p typescript@5 tsc -p ~/.claude/mods/quota-meter   # after the engine has loaded the mod once

Design: `docs/specs/2026-10-05-quota-meter-design.md`.

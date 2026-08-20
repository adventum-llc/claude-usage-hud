# Claude Usage HUD

Put your **per-model weekly quota** (Fable, Opus, …) in your Claude Code statusline.

```
claude-fable-5 | main | ▮▮▮▮▮▮▯▯▯▯ 5h 39% | ▮▮▮▮▮▮▮▯▯▯ 7d 64% | Fable █████████░ 97%
                                                                 ^^^^^^^^^^^^^^^^^^^ this part
```

## The problem

Claude Code's statusline payload only carries the **aggregate** 5-hour / 7-day
rate-limit windows. The per-model weekly buckets — the ones that actually stop
you — are tracked server-side and rendered by `/usage`, but never reach the
statusline. The day this tool was written, the aggregate bars read 39% / 64%
while the Fable weekly bucket sat at **97–99%, severity: critical**. No warning.

This tool polls the same endpoint `/usage` uses and feeds the per-model number
to the [claude-hud](https://github.com/jarrodwatts/claude-hud) statusline plugin
through its supported `externalUsagePath` option. Nothing vendored is patched.

## Honest caveats — read first

- **It calls an undocumented, internal Anthropic endpoint**
  (`GET https://api.anthropic.com/api/oauth/usage`). It may change or vanish
  without notice. Failure is soft: the segment disappears, your HUD keeps working.
- **It reads your local Claude Code OAuth token** from
  `~/.claude/.credentials.json` (read-only) and sends it to `api.anthropic.com`
  and nowhere else. No telemetry, no third parties. The script is ~200 lines,
  zero dependencies — read it before you run it.
- **Not affiliated with, endorsed by, or supported by Anthropic.**
- **Some plans show nothing.** If your account has no per-model weekly quotas
  (no `weekly_scoped` entries), you get no label and no error.
- Tested against **claude-hud** specifically. Other statuslines would need
  their own read path for the snapshot JSON.

## Requirements

- Node 20+ (uses built-in `fetch`; zero npm dependencies)
- [claude-hud](https://github.com/jarrodwatts/claude-hud) installed as your Claude Code statusline
- A Claude Code login (`~/.claude/.credentials.json` exists) — macOS and Linux

## Install

```bash
curl -fsSL -o ~/.claude/usage-poll.mjs https://raw.githubusercontent.com/adventum-llc/claude-usage-hud/master/usage-poll.mjs
node ~/.claude/usage-poll.mjs --verbose   # should print your real percentages
```

Then point claude-hud at the snapshot in `~/.claude/plugins/claude-hud/config.json`:

```json
{
  "display": {
    "externalUsagePath": "~/.claude/hud-usage.json",
    "externalUsageFreshnessMs": 900000
  }
}
```

Finally, run the poller on a timer so the snapshot stays fresh. Simplest option —
a `SessionStart` hook in `~/.claude/settings.json` (refreshes on every session
start/clear/resume):

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "(node ~/.claude/usage-poll.mjs --if-stale &) || true"
      }]
    }]
  }
}
```

Or a cron entry every 5 minutes:

```
*/5 * * * * node ~/.claude/usage-poll.mjs --if-stale
```

`--if-stale` makes it safe to wire anywhere chatty — it exits immediately if the
snapshot is younger than 2 minutes (`HUD_USAGE_MIN_AGE_MS`).

There is also an `install.sh` that does the download and prints these snippets.
It deliberately **never edits your config files** — you paste the snippets yourself.

## Configuration

All via environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `HUD_USAGE_SNAPSHOT` | `~/.claude/hud-usage.json` | Where the snapshot is written |
| `HUD_USAGE_CREDENTIALS` | `~/.claude/.credentials.json` | Claude Code credentials file |
| `HUD_USAGE_MODELS` | `Fable,Opus,Sonnet` | Label priority order |
| `HUD_USAGE_BAR` | `1` | Set `0` to drop the bar glyphs |
| `HUD_USAGE_BAR_WIDTH` | `10` | Bar width in characters |
| `HUD_USAGE_MIN_AGE_MS` | `120000` | Freshness threshold for `--if-stale` |

Flags: `--verbose`, `--if-stale`, `--help`.

## Behavior notes

- The label is capped by claude-hud at **50 chars**; the poller degrades
  gracefully (drops bars, then lower-priority models) to fit.
- The bar is **monochrome by design** — claude-hud sanitizes external labels,
  stripping ANSI colors. The `█`/`░` glyphs survive.
- Stale snapshots (older than `externalUsageFreshnessMs`) make the segment
  disappear rather than show a frozen number.
- Quota is **account-level**: every session shows the same percentages.
- If claude-hud isn't installed, the script still writes its snapshot and
  exits 0, harming nothing.

## Uninstall

```bash
rm ~/.claude/usage-poll.mjs ~/.claude/hud-usage.json
```

Remove the hook/cron entry and the `externalUsagePath` line from claude-hud's
config.

## License

MIT © Adventum LLC

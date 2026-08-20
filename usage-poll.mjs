#!/usr/bin/env node
/**
 * claude-usage-hud — surface per-model weekly quota in your Claude Code statusline.
 *
 * Claude Code's statusline payload only carries the aggregate five_hour /
 * seven_day rate-limit windows. The per-model weekly buckets (e.g. "Fable",
 * "Opus") — the ones that actually stop you — live only in the `limits[]`
 * array of Anthropic's OAuth usage endpoint, which is what `/usage` renders.
 *
 * This script polls that endpoint and writes a snapshot JSON that the
 * claude-hud statusline plugin reads via its supported
 * `display.externalUsagePath` option. The per-model text rides in the
 * snapshot's `balance_label`.
 *
 * Honest caveats — read before running:
 *  - `GET https://api.anthropic.com/api/oauth/usage` is an INTERNAL,
 *    UNDOCUMENTED endpoint. It may change or disappear without notice.
 *    Failure mode is soft: the label vanishes, your HUD keeps working.
 *  - Auth: reads your local OAuth access token from
 *    `~/.claude/.credentials.json` (read-only). The token is sent to
 *    api.anthropic.com and NOWHERE else. Nothing is collected or phoned home.
 *  - Not affiliated with, endorsed by, or supported by Anthropic.
 *  - Plans without per-model weekly quotas simply show no label.
 *
 * Usage:  node usage-poll.mjs [--verbose] [--if-stale] [--help]
 * Run it on a timer or a Claude Code hook; claude-hud ignores snapshots older
 * than `display.externalUsageFreshnessMs` (default 5m).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const CREDENTIALS = process.env.HUD_USAGE_CREDENTIALS
  || path.join(os.homedir(), '.claude', '.credentials.json');
const OUT = process.env.HUD_USAGE_SNAPSHOT
  || path.join(os.homedir(), '.claude', 'hud-usage.json');
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const TIMEOUT_MS = 15_000;

/** --if-stale: skip the fetch entirely when the snapshot is younger than this. */
const MIN_AGE_MS = Number.parseInt(process.env.HUD_USAGE_MIN_AGE_MS || '120000', 10) || 120_000;

/** Models to surface in the label, in priority order. */
const TRACKED = (process.env.HUD_USAGE_MODELS || 'Fable,Opus,Sonnet')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Draw a bar matching claude-hud's own quotaBar (same glyphs + fill math).
 * It renders uncolored: claude-hud runs balance_label through
 * sanitizeDisplayText, which strips ANSI escapes, so the native bars stay
 * colored while this one is plain. Set HUD_USAGE_BAR=0 to disable.
 */
const BAR_ENABLED = process.env.HUD_USAGE_BAR !== '0';
const BAR_WIDTH = Number.parseInt(process.env.HUD_USAGE_BAR_WIDTH || '10', 10) || 10;

const HELP = `usage-poll.mjs — write a claude-hud external usage snapshot with per-model quota

Usage: node usage-poll.mjs [options]

Options:
  --verbose     Print the snapshot summary after writing (never prints the token)
  --if-stale    Exit 0 without fetching if the existing snapshot is younger
                than HUD_USAGE_MIN_AGE_MS (default 120000 ms). Safe to wire to
                chatty hooks without hammering the API.
  --help        Show this help

Environment:
  HUD_USAGE_SNAPSHOT     Output path (default: ~/.claude/hud-usage.json)
  HUD_USAGE_CREDENTIALS  Credentials file (default: ~/.claude/.credentials.json)
  HUD_USAGE_MODELS       Comma list, label priority order (default: Fable,Opus,Sonnet)
  HUD_USAGE_BAR          Set to 0 to disable the bar glyphs in the label
  HUD_USAGE_BAR_WIDTH    Bar width in characters (default: 10)
  HUD_USAGE_MIN_AGE_MS   Freshness threshold for --if-stale (default: 120000)

Exit codes: 0 = snapshot written (or fresh under --if-stale); 1 = failed, nothing written.`;

function bar(percent, width = BAR_WIDTH) {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function readToken() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read credentials at ${CREDENTIALS}: ${err.code || err.message}`);
  }
  const oauth = raw.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new Error('no claudeAiOauth.accessToken in credentials (is Claude Code logged in?)');
  }
  // expiresAt is epoch millis. Refreshing is Claude Code's job — if the token
  // is stale we bail rather than write a misleading snapshot.
  if (typeof oauth.expiresAt === 'number' && Date.now() >= oauth.expiresAt) {
    throw new Error('oauth access token expired; run any claude command to refresh');
  }
  return oauth.accessToken;
}

async function fetchUsage(token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`GET /api/oauth/usage -> HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function pct(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(Math.min(100, Math.max(0, value)));
}

function isoOrNull(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Pull per-model weekly windows out of `limits[]`. Entries look like:
 *   { kind: "weekly_scoped", percent: 97, resets_at: "...",
 *     scope: { model: { display_name: "Fable" } }, is_active: true }
 * Plans without per-model quotas have no such entries — that's fine, the
 * snapshot still carries the aggregate windows and no label is added.
 */
function scopedModelWindows(usage) {
  const limits = Array.isArray(usage.limits) ? usage.limits : [];
  const out = [];
  for (const entry of limits) {
    if (!entry || entry.kind !== 'weekly_scoped') continue;
    const name = entry.scope?.model?.display_name;
    const percent = pct(entry.percent);
    if (!name || percent === null) continue;
    out.push({
      name,
      percent,
      resetsAt: isoOrNull(entry.resets_at),
      severity: entry.severity ?? 'normal',
      isActive: entry.is_active === true,
    });
  }
  return out;
}

/** "Fable ████████░░ 82%" — claude-hud caps balance_label at 50 chars. */
function buildBalanceLabel(windows) {
  if (windows.length === 0) return null;
  const rank = (w) => {
    const i = TRACKED.findIndex((t) => w.name.toLowerCase().startsWith(t.toLowerCase()));
    return i === -1 ? TRACKED.length : i;
  };
  const sorted = [...windows].sort((a, b) => {
    // Active/critical windows first, then configured priority, then highest use.
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return b.percent - a.percent;
  });
  // claude-hud truncates balance_label past 50 chars, so add segments only
  // while they fit — with the bar first, then degrading to bare percentages.
  for (const withBar of BAR_ENABLED ? [true, false] : [false]) {
    const parts = [];
    for (const w of sorted) {
      const part = withBar
        ? `${w.name} ${bar(w.percent)} ${w.percent}%`
        : `${w.name} ${w.percent}%`;
      const next = parts.length ? `${parts.join(' | ')} ${part}` : part;
      if (next.length > 50) break;
      parts.push(part);
    }
    if (parts.length) return parts.join(' | ');
  }
  return null;
}

/** Atomic write: tmp + rename. A failed run never leaves a partial snapshot. */
function writeSnapshot(snapshot) {
  const dir = path.dirname(OUT);
  const tmp = path.join(dir, `.${path.basename(OUT)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(tmp, OUT);
  fs.chmodSync(OUT, 0o600);
}

function snapshotAgeMs() {
  try {
    return Date.now() - fs.statSync(OUT).mtimeMs;
  } catch {
    return Infinity;
  }
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP);
    return;
  }
  if (process.argv.includes('--if-stale') && snapshotAgeMs() < MIN_AGE_MS) {
    if (process.argv.includes('--verbose')) {
      console.log(`snapshot ${OUT} is fresh (< ${MIN_AGE_MS}ms), skipping fetch`);
    }
    return;
  }
  const usage = await fetchUsage(readToken());
  const windows = scopedModelWindows(usage);
  const snapshot = {
    updated_at: new Date().toISOString(),
    five_hour: {
      used_percentage: pct(usage.five_hour?.utilization),
      resets_at: isoOrNull(usage.five_hour?.resets_at),
    },
    seven_day: {
      used_percentage: pct(usage.seven_day?.utilization),
      resets_at: isoOrNull(usage.seven_day?.resets_at),
    },
  };
  const label = buildBalanceLabel(windows);
  if (label) snapshot.balance_label = label;
  writeSnapshot(snapshot);

  if (process.argv.includes('--verbose')) {
    console.log(`wrote ${OUT}`);
    console.log(`  5h  ${snapshot.five_hour.used_percentage}%`);
    console.log(`  7d  ${snapshot.seven_day.used_percentage}%`);
    for (const w of windows) {
      console.log(`  ${w.name} ${w.percent}% (${w.severity}${w.isActive ? ', active' : ''})`);
    }
    console.log(`  label: ${label ?? '(none — no per-model weekly quotas on this plan)'}`);
  }
}

main().catch((err) => {
  console.error(`usage-poll: ${err.message}`);
  process.exit(1);
});

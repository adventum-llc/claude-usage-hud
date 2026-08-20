#!/usr/bin/env bash
# claude-usage-hud installer.
# Downloads usage-poll.mjs and PRINTS the config snippets you need.
# It never edits your settings.json or claude-hud config — you paste those yourself.
set -euo pipefail

DEST="${HOME}/.claude/usage-poll.mjs"
RAW_URL="https://raw.githubusercontent.com/adventum-llc/claude-usage-hud/master/usage-poll.mjs"

command -v node >/dev/null 2>&1 || { echo "error: node not found (Node 20+ required)"; exit 1; }
mkdir -p "${HOME}/.claude"

echo "Downloading usage-poll.mjs -> ${DEST}"
curl -fsSL -o "${DEST}" "${RAW_URL}"
chmod 0644 "${DEST}"

echo "Testing against your account..."
if node "${DEST}" --verbose; then
  echo
  echo "OK. Now wire it up (two manual pastes):"
else
  echo
  echo "The test run failed (see message above). Fix that first — usually it means"
  echo "Claude Code isn't logged in on this machine. Config snippets below anyway:"
fi

cat <<'EOF'

1) ~/.claude/plugins/claude-hud/config.json — add under "display":

    "externalUsagePath": "~/.claude/hud-usage.json",
    "externalUsageFreshnessMs": 900000

2) ~/.claude/settings.json — keep the snapshot fresh via a SessionStart hook:

    "hooks": {
      "SessionStart": [{
        "hooks": [{
          "type": "command",
          "command": "(node ~/.claude/usage-poll.mjs --if-stale &) || true"
        }]
      }]
    }

   (or a cron entry: */5 * * * * node ~/.claude/usage-poll.mjs --if-stale)

Uninstall: rm ~/.claude/usage-poll.mjs ~/.claude/hud-usage.json and remove the
two snippets above.
EOF

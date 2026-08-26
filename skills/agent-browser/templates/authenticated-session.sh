#!/usr/bin/env bash
# Inspect or continue an authenticated flow in the real persistent Chrome profile.
# Usage: authenticated-session.sh URL [account]
# Account defaults to Caleb; use "erebora" or another named email when directed.

set -euo pipefail

target_url="${1:?Usage: authenticated-session.sh URL [account]}"
account="${2:-}"
IFS= read -r task_uuid </proc/sys/kernel/random/uuid
task_session="auth-check-${task_uuid//-/}"
browser_bin="${BASH_SOURCE[0]%/*}/../../../scripts/agent-browser-real-chrome"
browser_args=(--session "$task_session")
if [[ -n "$account" ]]; then
  browser_args=(--account "$account" "${browser_args[@]}")
fi

created_session=0
cleanup() {
  if [[ "$created_session" == 1 ]]; then
    "$browser_bin" "${browser_args[@]}" close >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

"$browser_bin" "${browser_args[@]}" open "$target_url"
created_session=1
"$browser_bin" "${browser_args[@]}" snapshot -i --compact

printf '%s\n' \
  "Use the visible saved-account path before requesting input." \
  "If the page proves unavoidable 2FA/password/hardware input, foreground this exact session, then background and continue."

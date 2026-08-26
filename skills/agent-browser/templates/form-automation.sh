#!/usr/bin/env bash
# Safe starting point for a rendered form flow in the real Chrome profile.
# Usage: form-automation.sh URL [account]

set -euo pipefail

form_url="${1:?Usage: form-automation.sh URL [account]}"
account="${2:-}"
IFS= read -r task_uuid </proc/sys/kernel/random/uuid
task_session="form-flow-${task_uuid//-/}"
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

"$browser_bin" "${browser_args[@]}" open "$form_url"
created_session=1
"$browser_bin" "${browser_args[@]}" snapshot -i --compact

# Continue with fresh refs from the snapshot, for example:
# agent-browser "${browser_args[@]}" fill @e1 "value"
# agent-browser "${browser_args[@]}" click @e2
# agent-browser "${browser_args[@]}" snapshot -i --compact

printf '%s\n' "Use fresh refs, verify the visible result, and let the cleanup trap close the task session."

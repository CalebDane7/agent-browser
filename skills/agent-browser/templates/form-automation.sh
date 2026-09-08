#!/usr/bin/env bash
# Safe starting point for a rendered form flow in the real Chrome profile.
# Usage: form-automation.sh URL [account]

set -euo pipefail

form_url="${1:?Usage: form-automation.sh URL [account]}"
account="${2:-}"
IFS= read -r task_uuid </proc/sys/kernel/random/uuid
task_session="form-flow-${task_uuid//-/}"
browser_bin="$(command -v agent-browser)"
browser_args=(--session "$task_session")
if [[ -n "$account" ]]; then
  browser_args=(--account "$account" "${browser_args[@]}")
fi

cleanup_armed=0
cleanup() {
  prior_status=$?
  trap - EXIT
  if [[ "$cleanup_armed" == 1 ]]; then
    if ! "$browser_bin" "${browser_args[@]}" close; then
      printf 'Agent Browser cleanup failed for session %s.\n' "$task_session" >&2
      if [[ "$prior_status" -eq 0 ]]; then
        prior_status=1
      fi
    fi
  fi
  exit "$prior_status"
}
trap cleanup EXIT

cleanup_armed=1
"$browser_bin" "${browser_args[@]}" open "$form_url"
"$browser_bin" "${browser_args[@]}" snapshot -i --compact

# Continue with fresh refs from the snapshot, for example:
# "$browser_bin" "${browser_args[@]}" fill @e1 "value"
# "$browser_bin" "${browser_args[@]}" click @e2
# "$browser_bin" "${browser_args[@]}" snapshot -i --compact

printf '%s\n' "Use fresh refs, verify the visible result, and let the cleanup trap close the task session."

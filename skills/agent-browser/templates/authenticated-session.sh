#!/usr/bin/env bash
# Inspect an authenticated flow in the real persistent Chrome profile.
# Usage: authenticated-session.sh URL [account]
# Omit [account] to use the locally configured default, or pass an enrolled handle.

set -euo pipefail

target_url="${1:?Usage: authenticated-session.sh URL [account]}"
account="${2:-}"
IFS= read -r task_uuid </proc/sys/kernel/random/uuid
task_session="auth-check-${task_uuid//-/}"
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
"$browser_bin" "${browser_args[@]}" open "$target_url"
"$browser_bin" "${browser_args[@]}" snapshot -i --compact

printf '%s\n' "Review the snapshot for a saved-account path before requesting user input."

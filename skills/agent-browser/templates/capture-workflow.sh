#!/usr/bin/env bash
# Token-bounded rendered capture in the real Chrome profile.
# Usage: capture-workflow.sh URL [output-dir] [selector]

set -euo pipefail

target_url="${1:?Usage: capture-workflow.sh URL [output-dir] [selector]}"
output_dir="${2:-.}"
selector="${3:-}"
IFS= read -r task_uuid </proc/sys/kernel/random/uuid
task_session="capture-${task_uuid//-/}"
browser_bin="$(command -v agent-browser)"

mkdir -p "$output_dir"
cleanup_armed=0
cleanup() {
  prior_status=$?
  trap - EXIT
  if [[ "$cleanup_armed" == 1 ]]; then
    if ! "$browser_bin" --session "$task_session" close; then
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
"$browser_bin" --session "$task_session" open "$target_url"
"$browser_bin" --session "$task_session" snapshot -i --compact >"$output_dir/page-structure.txt"
# Full-page repairs have candidate proof but are not in the default installed engine.
"$browser_bin" --session "$task_session" screenshot "$output_dir/page-viewport.png"

if [[ -n "$selector" ]]; then
  "$browser_bin" --session "$task_session" get text "$selector" >"$output_dir/selected-text.txt"
fi

printf 'Saved rendered capture in %s\n' "$output_dir"

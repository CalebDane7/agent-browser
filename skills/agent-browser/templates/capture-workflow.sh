#!/usr/bin/env bash
# Token-bounded rendered capture in the real Chrome profile.
# Usage: capture-workflow.sh URL [output-dir] [selector]

set -euo pipefail

target_url="${1:?Usage: capture-workflow.sh URL [output-dir] [selector]}"
output_dir="${2:-.}"
selector="${3:-}"
IFS= read -r task_uuid </proc/sys/kernel/random/uuid
task_session="capture-${task_uuid//-/}"
browser_bin="${BASH_SOURCE[0]%/*}/../../../scripts/agent-browser-real-chrome"

/usr/bin/mkdir -p "$output_dir"
created_session=0
cleanup() {
  if [[ "$created_session" == 1 ]]; then
    "$browser_bin" --session "$task_session" close >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

"$browser_bin" --session "$task_session" open "$target_url"
created_session=1
"$browser_bin" --session "$task_session" snapshot -i --compact >"$output_dir/page-structure.txt"
"$browser_bin" --session "$task_session" screenshot --full "$output_dir/page-full.png"

if [[ -n "$selector" ]]; then
  "$browser_bin" --session "$task_session" get text "$selector" >"$output_dir/selected-text.txt"
fi

printf 'Saved rendered capture in %s\n' "$output_dir"

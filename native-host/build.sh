#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 ABSOLUTE_OUTPUT_EXE" >&2
  exit 2
fi

output=$1
if [[ $output != /* ]]; then
  echo "output path must be absolute" >&2
  exit 2
fi
if [[ -e $output ]]; then
  echo "refusing to overwrite existing output: $output" >&2
  exit 2
fi

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
compiler=${CXX:-x86_64-w64-mingw32-g++}
if ! command -v "$compiler" >/dev/null 2>&1; then
  echo "missing Windows cross-compiler: $compiler" >&2
  exit 127
fi

mkdir -p -- "$(dirname -- "$output")"
temporary=$(mktemp -- "${output}.tmp.XXXXXX")
cleanup() {
  rm -f -- "$temporary"
}
trap cleanup EXIT

export LC_ALL=C
export TZ=UTC
export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-0}

"$compiler" \
  -std=c++20 \
  -Os \
  -Wall \
  -Wextra \
  -Wconversion \
  -Werror \
  -fno-exceptions \
  -fno-rtti \
  -ffunction-sections \
  -fdata-sections \
  "-ffile-prefix-map=${source_dir}=native-host" \
  "-fdebug-prefix-map=${source_dir}=native-host" \
  -DUNICODE \
  -D_UNICODE \
  "$source_dir/agent_browser_native_host.cpp" \
  -o "$temporary" \
  -municode \
  -static \
  -static-libgcc \
  -static-libstdc++ \
  -luser32 \
  -Wl,--gc-sections \
  -Wl,--strip-all \
  -Wl,--no-insert-timestamp \
  -Wl,--nxcompat \
  -Wl,--dynamicbase \
  -Wl,--high-entropy-va

chmod 0755 "$temporary"
mv -- "$temporary" "$output"
trap - EXIT

#!/usr/bin/env bash
# Build the cabra executable (plan 1.2.2): scripts/bld.sh <backend> <out>
#
# Versioned in scripts/ (not tmp/ — this is project infrastructure, and
# tmp/ is gitignored; recorded as the deviation from plan 1.2.2's
# original wording). Resolves the engine and deps exactly as
# run-tests.sh does, then emits the release executable.
#
# The build gate must be able to MATCH the failures it watches for:
# gate on the exit code AND the binary existing AND the error grep, and
# always print the skipped-kernel count — a kernel that fails to lower
# is SKIPPED, not failed, and reads back zeros at runtime.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
CAJETA="${CAJETA:-cajeta}"
BE="${1:-vulkan}"
OUT="${2:-$here/tmp/cabra}"
export CAJETA_OWNED_BIND="${CAJETA_OWNED_BIND:-warn}"
export CAJETA_CAPTURED_BORROW="${CAJETA_CAPTURED_BORROW:-warn}"

OLLA_HOME="${OLLA_HOME:-$HOME/.olla}"
codec_ver="$(sed -n 's/.*"dev\.cajeta\.codec"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$here/../cajeta-llm/cajeta.json" | head -1)"
jinja_ver="$(sed -n 's/.*"dev\.cajeta\.jinja"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$here/../cajeta-llm/cajeta.json" | head -1)"
CODEC="${CODEC:-$here/../cajeta-codec/build/archive/dev.cajeta.codec-$codec_ver.cja}"
JINJA="${JINJA:-$here/../cajeta-jinja/build/archive/dev.cajeta.jinja-$jinja_ver.cja}"
LLM_SRC="${LLM_SRC:-$here/../cajeta-llm/src/main/cajeta}"

mkdir -p "$here/tmp"
LOG="$here/tmp/bld-$(basename "$OUT").log"
# TWO STEPS, not one: a build over two source roots leaves the second
# root's types unresolved from the first (hit twice on 2026-08-27, in
# the test build and here), so the engine becomes an archive first and
# cabra compiles against it.
"$CAJETA" --emit=cja -o "$here/tmp/llm-$BE.cja" \
    --classpath="$CODEC,$JINJA" \
    dev.cajeta.llm.Llm.run "$LLM_SRC" "$here/tmp" > "$LOG" 2>&1
"$CAJETA" --emit=exe --release --xpu-backend="$BE" \
    --classpath="$here/tmp/llm-$BE.cja,$CODEC,$JINJA" \
    -o "$OUT" dev.cajeta.cabra.Main.main \
    "$here/src/main/cajeta" "$here/tmp" >> "$LOG" 2>&1
rc=$?
bad=$(grep -oE "CAJETA_ERROR_[A-Z_]+|SIGSEGV|error:" "$LOG" | grep -v FRESH_RETURN | sort -u | head -5 || true)
if [ $rc -ne 0 ] || [ ! -x "$OUT" ] || [ -n "$bad" ]; then
    echo "BUILD FAIL ($BE -> $OUT) rc=$rc: $bad"
    grep -nE "CAJETA_ERROR|SIGSEGV|error:" "$LOG" | head -10
    exit 1
fi
echo "BUILD OK ($BE -> $OUT)"
grep -c "xpu-kernel-skipped" "$LOG" | sed 's/^/  kernels skipped: /' || true

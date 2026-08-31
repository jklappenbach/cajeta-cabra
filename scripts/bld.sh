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
logging_ver="$(sed -n 's/.*"dev\.cajeta\.logging"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$here/cajeta.json" | head -1)"
LOGGING="${LOGGING:-$here/../cajeta-logging/build/archive/dev.cajeta.logging-$logging_ver.cja}"
http_ver="$(sed -n 's/.*"dev\.cajeta\.http"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$here/cajeta.json" | head -1)"
HTTP="${HTTP:-$here/../cajeta-http/build/archive/dev.cajeta.http-$http_ver.cja}"
LLM_SRC="${LLM_SRC:-$here/../cajeta-llm/src/main/cajeta}"

mkdir -p "$here/tmp"
LOG="$here/tmp/bld-$(basename "$OUT").log"
# TWO STEPS, not one, and this is the DESIGNED shape rather than a
# workaround: a compile reads exactly ONE source root (`cajeta <entry>
# <source-root> <output-dir>`), so a second tree is a dependency — the
# engine becomes an archive and cabra compiles against it via
# --classpath. The engine repo's own run-tests.sh does the same.
#
# Passing both trees as positionals looked like it worked and did not:
# the extra argument SHIFTED the rest, binding the engine tree to the
# output directory (exit 0, empty output dir, object files written into
# a source tree, none of its types compiled). That silent misread is
# fixed in the compiler as of cajeta c963d19b — it is now a hard error
# naming --classpath.
"$CAJETA" --emit=cja -o "$here/tmp/llm-$BE.cja" \
    --classpath="$CODEC,$JINJA,$LOGGING" \
    dev.cajeta.llm.Llm.run "$LLM_SRC" "$here/tmp" > "$LOG" 2>&1
"$CAJETA" --emit=exe --release --xpu-backend="$BE" \
    --classpath="$here/tmp/llm-$BE.cja,$CODEC,$JINJA,$LOGGING,$HTTP" \
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

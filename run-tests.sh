#!/usr/bin/env bash
# Build + run the cabra test suite (plan 1.2.1).
#
# The suite compiles cabra's main+test sources against the ENGINE
# library (dev.cajeta.llm) and its runtime deps (codec, jinja), with
# cajeta-unit driving reflective @Test discovery. Resolution order for
# every dependency (the cajeta-llm pattern, verbatim):
#   1. sibling checkout — build it, use what it emits (local dev)
#   2. $OLLA_HOME store at the cajeta.json pin
#   3. Olla registry /v2/resolve + /v2/blob, sha256-verified
#
# Env:
#   CAJETA       compiler binary (default: cajeta on PATH)
#   XPU_BACKEND  compile backend for the suite (default cpu — the
#                engine's device paths run portably; override to run
#                the same suite on silicon)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
CAJETA="${CAJETA:-cajeta}"
XPU_BACKEND="${XPU_BACKEND:-${CAJETA_XPU_BACKEND:-cpu}}"
echo ">> compile backend: ${XPU_BACKEND}"

# Engine warn-first ownership switches ride along until cajeta-llm's
# migration closes (see its run-tests.sh for the story).
export CAJETA_OWNED_BIND="${CAJETA_OWNED_BIND:-warn}"
export CAJETA_CAPTURED_BORROW="${CAJETA_CAPTURED_BORROW:-warn}"

OLLA_HOME="${OLLA_HOME:-$HOME/.olla}"
OLLA_URL="${OLLA_URL:-https://olla.cajeta.dev}"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1;
    else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# resolve <name> <repo-dir> — sets RESOLVED to an archive path.
resolve() {
    local name="$1" repo="$2" ver cja
    RESOLVED=""
    if [[ -d "$repo" ]]; then
        echo ">> building $name from checkout ($repo)"
        ( cd "$repo" && "$CAJETA" build >/dev/null )
        cja="$(ls -t "$repo"/build/archive/$name-*.cja 2>/dev/null | head -1)"
        [[ -n "$cja" ]] && { RESOLVED="$cja"; return; }
    fi
    ver="$(sed -n 's/.*"'"${name//./\\.}"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        "$here/cajeta.json" | head -1)"
    [[ -n "$ver" ]] || { echo "no $name pin in cajeta.json" >&2; exit 1; }
    cja="$OLLA_HOME/$name/$ver/$name-$ver.cja"
    [[ -f "$cja" ]] && { RESOLVED="$cja"; return; }
    cja="$here/build/.dep-cache/$name-$ver.cja"
    if [[ ! -f "$cja" ]]; then
        echo ">> fetching $name $ver from $OLLA_URL"
        local meta sha got
        meta="$(curl -fsS "$OLLA_URL/v2/resolve?name=$name&version=$ver")"
        sha="$(printf '%s' "$meta" | sed -n 's/.*"sha256":"sha256:\([0-9a-f]*\)".*/\1/p')"
        [[ -n "$sha" ]] || { echo "/v2/resolve gave no sha256 for $name" >&2; exit 1; }
        mkdir -p "$(dirname "$cja")"
        curl -fsS -o "$cja" "$OLLA_URL/v2/blob/$sha"
        got="$(sha256_of "$cja")"
        [[ "$got" == "$sha" ]] || { rm -f "$cja"; echo "sha256 mismatch for $name" >&2; exit 1; }
    fi
    RESOLVED="$cja"
}

resolve dev.cajeta.unit  "${UNIT_REPO:-$here/../cajeta-unit}";  unit_cja="$RESOLVED"
resolve dev.cajeta.codec "${CODEC_REPO:-$here/../cajeta-codec}"; codec_cja="$RESOLVED"
resolve dev.cajeta.jinja "${JINJA_REPO:-$here/../cajeta-jinja}"; jinja_cja="$RESOLVED"
echo ">> unit: $unit_cja"
echo ">> codec: $codec_cja"
echo ">> jinja: $jinja_cja"

# The engine: no `cajeta build` task emits its .cja with deps wired, so
# build it the way its own run-tests.sh does — one --emit=cja over its
# main sources with codec+jinja on the classpath.
LLM_REPO="${LLM_REPO:-$here/../cajeta-llm}"
if [[ -d "$LLM_REPO" ]]; then
    echo ">> building dev.cajeta.llm from checkout ($LLM_REPO)"
    "$CAJETA" --emit=cja -o "$out/llm.cja" \
        --classpath="$codec_cja,$jinja_cja" \
        dev.cajeta.llm.Llm.run "$LLM_REPO/src/main/cajeta" "$out" >/dev/null
    llm_cja="$out/llm.cja"
else
    resolve dev.cajeta.llm "/nonexistent"; llm_cja="$RESOLVED"
fi
echo ">> engine: $llm_cja"

# cabra's own library .cja first — the engine-repo pattern, and the
# designed one: a compile reads exactly ONE source root, so main sources
# become an archive and the tests compile against it via --classpath.
# (Passing both trees as positionals silently rebound the output dir to
# a source tree; a hard error in the compiler as of c963d19b.)
echo ">> building cabra library .cja"
"$CAJETA" --emit=cja -o "$out/cabra.cja" \
    --classpath="$llm_cja,$codec_cja,$jinja_cja" \
    dev.cajeta.cabra.Main.main "$here/src/main/cajeta" "$out" >/dev/null

echo ">> building + running the cabra test binary"
"$CAJETA" --emit=exe --profile=test --xpu-backend="$XPU_BACKEND" \
    --classpath="$out/cabra.cja,$llm_cja,$unit_cja,$codec_cja,$jinja_cja" \
    -o "$out/cabratests" \
    dev.cajeta.cabra.selftest.TestMain.run \
    "$here/src/test/cajeta" "$out" >/dev/null

( cd "$here" && "$out/cabratests" )

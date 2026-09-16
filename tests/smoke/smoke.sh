#!/usr/bin/env bash
# Headless launch assertions for Qwen Studio on Linux (spec section 11.5).
# Usage: tests/smoke/smoke.sh <executable> <resources-dir>
# NOTE: --no-sandbox below is a TEST-ONLY flag (Docker's default seccomp blocks user namespaces).
# It is never part of any shipped launcher or desktop file.
set -euo pipefail

EXE="${1:?executable path required}"
RES="${2:?resources dir required}"
PORT="${SMOKE_PORT:-9333}"
LOG="${SMOKE_LOG:-$PWD/smoke.log}"
BUN_VERSION="${BUN_VERSION:-1.2.10}"
UV_VERSION="${UV_VERSION:-0.12.15}"
XPID=""
PGID=""
SMOKE_TMP_HOME=""

cleanup() {
  rc=$?
  if [ "${SMOKE_KEEP_RUNNING:-0}" != "1" ] && [ -n "$SMOKE_TMP_HOME" ] && [ -d "$SMOKE_TMP_HOME" ]; then
    rm -rf "$SMOKE_TMP_HOME" || true
  fi
  exit "$rc"
}
trap cleanup EXIT

dump_log() { if [ -f "$LOG" ]; then echo "--- $LOG ---" >&2; cat "$LOG" >&2; echo "--- end log ---" >&2; fi; }

# Signal an entire process group, not just its leader: xvfb-run does not
# forward signals to the app it wraps, so signalling only the launcher PID
# can leave Xvfb and/or the Electron process orphaned holding $PORT.
kill_group() {
  local pgid="$1"
  [ -z "$pgid" ] && return 0
  kill -TERM -- "-$pgid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    kill -0 -- "-$pgid" 2>/dev/null || return 0
    sleep 1
  done
  kill -KILL -- "-$pgid" 2>/dev/null || true
}

fail() {
  echo "SMOKE FAIL: $*" >&2
  dump_log
  [ -n "$PGID" ] && kill_group "$PGID"
  exit 1
}

targets() { curl -s "http://127.0.0.1:$PORT/json" 2>/dev/null | tr -d '\n' | sed 's/},/}\n/g'; }

echo "== 1. sidecar versions"
[ "$("$RES/bun/bun" --version)" = "$BUN_VERSION" ] || fail "bun --version != $BUN_VERSION"
"$RES/python/uvx" --version | grep -q "^uvx $UV_VERSION" || fail "uvx --version != $UV_VERSION"
"$RES/python/uv" --version | grep -q "^uv $UV_VERSION" || fail "uv --version != $UV_VERSION"

echo "== 2. launch"
if ! command -v xvfb-run >/dev/null 2>&1 && [ -z "${DISPLAY:-}" ]; then
  fail "neither xvfb-run nor an existing DISPLAY is available; cannot launch"
fi

if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/json"; then
  fail "port $PORT already answers /json (stale process or port in use)"
fi

ORIG_HOME="$HOME"
export HOME; HOME="$(mktemp -d)"
SMOKE_TMP_HOME="$HOME"
unset XDG_CONFIG_HOME
export ELECTRON_ENABLE_LOGGING=1
rm -f "$LOG"

# Launch under job control so the backgrounded job (xvfb-run + everything it
# forks, or the app directly) gets its own new process group whose PGID
# equals $!, giving fail()/cleanup a single target that reaches every
# descendant.
set -m
if command -v xvfb-run >/dev/null 2>&1; then
  xvfb-run -a "$EXE" --remote-debugging-port="$PORT" --no-sandbox >"$LOG" 2>&1 &
  XPID=$!
else
  echo "NOTICE: xvfb-run not found on PATH; running directly on DISPLAY=$DISPLAY" >&2
  # Preserve X auth: HOME was just swapped to a fresh temp dir, so fall back to
  # the real user's ~/.Xauthority when XAUTHORITY isn't already set explicitly.
  if [ -z "${XAUTHORITY:-}" ] && [ -f "$ORIG_HOME/.Xauthority" ]; then
    export XAUTHORITY="$ORIG_HOME/.Xauthority"
  fi
  "$EXE" --remote-debugging-port="$PORT" --no-sandbox >"$LOG" 2>&1 &
  XPID=$!
fi
set +m
PGID=$XPID

echo "== 3. wait for the shell page target"
PAGE_LINE=""
for _ in $(seq 1 60); do
  PAGE_LINE="$(targets | grep '"type": *"page"' | grep 'out/renderer/index.html"' || true)"
  [ -n "$PAGE_LINE" ] && break
  kill -0 "$XPID" 2>/dev/null || fail "app exited early"
  sleep 1
done
[ -n "$PAGE_LINE" ] || fail "no page target for out/renderer/index.html within 60 s"

echo "== 4. wait for the chat.qwen.ai webview target"
WEBVIEW_LINE=""
for _ in $(seq 1 30); do
  WEBVIEW_LINE="$(targets | grep '"type": *"webview"' | grep '"url": *"https://chat.qwen.ai' || true)"
  [ -n "$WEBVIEW_LINE" ] && break
  sleep 1
done
[ -n "$WEBVIEW_LINE" ] || fail "no webview target for https://chat.qwen.ai within 30 s"

echo "== 5. log scan"
if grep -E "Unsupported platform|Cannot find module|ERR_UPDATER_INVALID_VERSION" "$LOG"; then fail "forbidden string in log"; fi

if [ "${SMOKE_KEEP_RUNNING:-0}" = "1" ]; then
  disown "$XPID"
  echo "SMOKE_PID=$XPID"
  echo "SMOKE_HOME=$HOME"
  echo "SMOKE PASS (app left running)"
  exit 0
fi

echo "== 6. clean exit via DevTools"
for id in $(targets | grep '"type": *"page"' | sed -n 's/.*"id": *"\([^"]*\)".*/\1/p'); do
  curl -s -X PUT "http://127.0.0.1:$PORT/json/close/$id" >/dev/null || true
done
for _ in $(seq 1 30); do
  kill -0 "$XPID" 2>/dev/null || break
  sleep 1
done
if kill -0 "$XPID" 2>/dev/null; then fail "app still running 30 s after closing all pages"; fi
RC=0; wait "$XPID" || RC=$?
[ "$RC" = "0" ] || fail "app exit code $RC (expected 0)"
echo "SMOKE PASS"
exit 0

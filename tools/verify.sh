#!/usr/bin/env bash
# One-shot verification gate: the node suites first, then a real browser against a real
# server, driven over CDP. Everything the script starts exits with the script, including the
# Chrome it launched in a temp profile.
#
#   bash tools/verify.sh                              # node suites + @boot @play @routes @save @reloaded @pointer
#   SCENARIOS="pointer" bash tools/verify.sh          # one browser suite while editing the view
#   SKIP_UNIT=1 bash tools/verify.sh                  # browser only (what the CI browser job does)
#
# PORTS: web 5193, devtools 9353. They must NOT collide with the sibling repos in this series
# (gridlock/nine-rings and friends default to :5180/:9340 and :5181/:9341). Talking to somebody
# else's DevTools endpoint is how a run ends up asserting against a page that is not this game —
# and an orphan Chrome left by a killed agent squats the port and fakes a green "0 rows failed".
# So: check before launching, and name your own port.
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterization saturates the cores and, with no CDP client attached, the process will not exit
# on its own. This game is 2D canvas, so plain headless Chrome is enough.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
CDP_PORT=${CDP_PORT:-9353}
WEB_PORT=${WEB_PORT:-5193}
BASE=${BASE_URL:-http://127.0.0.1:$WEB_PORT/}
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

# --------------------------------------------------------------- scenario bodies parse as JS
cd "$HERE"
# Cheapest gate in this script and the only one that needs no server and no browser: a scenario
# body is a string, so a mismatched quote inside it surfaces as `@boot threw SyntaxError` (or, for
# the pointer suite, as a stack from the driver) instead of as a failing assertion.
echo "=== scenario bodies ==="
node tools/playtest.mjs selftest || { echo "=== a scenario body does not parse; browser not started ===" >&2; exit 1; }

# --------------------------------------------------------------------------- one server, one browser
# Refuse to run on top of somebody else's session instead of silently joining it.
if pgrep -f "remote-debugging-port=$CDP_PORT" >/dev/null 2>&1; then
  echo "a Chrome is already bound to devtools :$CDP_PORT — set CDP_PORT to a free port" >&2
  pgrep -fl "remote-debugging-port=$CDP_PORT" >&2
  exit 5
fi
if lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "something is already listening on :$WEB_PORT — set WEB_PORT to a free port" >&2
  exit 6
fi

UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$CDP_PORT --user-data-dir=$UDD \
  --window-size=1000,820 --no-first-run --no-default-browser-check about:blank >/tmp/fleet-chrome.log 2>&1 &
CPID=$!
node "$HERE/server.cjs" $WEB_PORT >/tmp/fleet-server.log 2>&1 &
SPID=$!
cleanup() {
  kill -9 $CPID $SPID 2>/dev/null
  wait $CPID 2>/dev/null
  wait $SPID 2>/dev/null
  rm -rf $UDD
}
trap cleanup EXIT
# The watchdog redirects its fds: a background subshell inherits the script's stdout, and if
# this runs inside a pipeline it would hold the write end open for the full timeout and stall
# the consumer long after the tests finished.
( sleep ${WD_TIMEOUT:-300}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# A fresh --user-data-dir binds DevTools noticeably later than a warm profile, so wait on the
# endpoints rather than guessing a sleep duration. Both must answer: the DevTools port *and* the
# web root this run is about to load.
for i in $(seq 1 60); do
  curl -fsS -m 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$CDP_PORT" >&2; exit 3; }
for i in $(seq 1 40); do
  curl -fsS -m 1 "$BASE" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS -m 2 "$BASE" >/dev/null 2>&1 || {
  echo "static server never answered on $BASE" >&2; exit 4; }

cd "$HERE"
FAILED=0

echo "=== node suites ==="
# SKIP_UNIT=1 for the browser job in CI: the suites are its own job there.
if [ -z "${SKIP_UNIT:-}" ]; then
  for f in test/*.test.mjs; do
    echo "--- $f"
    node "$f" || FAILED=1
  done
fi

export CDP_PORT
export BASE_URL=$BASE
node tools/playtest.mjs open "$BASE" | head -3
# js/data/lots.js is 96 measured rows and the shell resolves a route before it reports a state,
# so wait on window.fleet rather than on a timer.
BOOT=""
for i in $(seq 1 60); do
  BOOT=$(node tools/playtest.mjs eval "window.fleet?window.fleet.state.id:'nope'" nonav 2>/dev/null | tr -d '\n" ')
  case "$BOOT" in *nope*|"") sleep 0.5 ;; *) break ;; esac
done
echo "boot chart: $BOOT"
[ -z "$BOOT" ] && { echo "window.fleet never appeared at $BASE" >&2; exit 7; }
[ "$BOOT" = "nope" ] && { echo "window.fleet never appeared at $BASE" >&2; exit 5; }

# @reloaded has to run after @save (it reads what @save left on disk) and each scenario runs in
# its own driver process, which is what makes the "eval without nonav" reload real.
TOTAL_ROWS=0
TOTAL_BAD=0
for s in ${SCENARIOS:-boot play routes save reloaded pointer}; do
  echo "=== @$s ==="
  if [ "$s" = "reloaded" ]; then
    OUT=$(node tools/playtest.mjs eval "@$s" 2>&1)
  else
    OUT=$(node tools/playtest.mjs eval "@$s" nonav 2>&1)
  fi
  # The result JSON is cut out of the console with a brace counter, not with JSON.parse of a
  # whole line: headless appends other text to the same line.
  printf '%s\n' "$OUT" | python3 -c '
import sys, json
raw = sys.stdin.read()
start = raw.find("{")
if start < 0:
    print("NO RESULT", raw[-400:]); sys.exit(1)
depth = 0
end = -1
for i in range(start, len(raw)):
    if raw[i] == "{": depth += 1
    elif raw[i] == "}":
        depth -= 1
        if depth == 0:
            end = i
            break
if end < 0:
    print("TRUNCATED RESULT", raw[start:start+200]); sys.exit(1)
try:
    d = json.loads(raw[start:end + 1])
except Exception as e:
    print("BAD JSON", e, raw[start:start+200]); sys.exit(1)
rows = d.get("rows", [])
print("rows:", len(rows), "fail:", d.get("fail"))
for r in rows:
    if not r["pass"]: print("  FAIL", r["test"], json.dumps(r["detail"], ensure_ascii=False)[:240])
sys.exit(1 if d.get("fail") else 0)
' || FAILED=1
  ROWS=$(printf '%s\n' "$OUT" | python3 -c '
import sys, json
raw = sys.stdin.read(); start = raw.find("{")
depth = 0
for i in range(start, len(raw)) if start >= 0 else []:
    if raw[i] == "{": depth += 1
    elif raw[i] == "}":
        depth -= 1
        if depth == 0:
            try: print(len(json.loads(raw[start:i+1]).get("rows", [])))
            except Exception: print(0)
            break
' 2>/dev/null | tail -1)
  TOTAL_ROWS=$((TOTAL_ROWS + ${ROWS:-0}))
  # A clean console is part of the contract: a thrown page error, a refused resource or a
  # rendering warning all count, even when every assertion above happened to pass.
  if printf '%s' "$OUT" | grep -qE '\[EXCEPTION\]|\[log:error\]|\[error\]|\[warning\]'; then
    echo "  CONSOLE NOT CLEAN for @$s"
    printf '%s\n' "$OUT" | grep -E '\[EXCEPTION\]|\[log:error\]|\[error\]|\[warning\]' | head -5
    FAILED=1
  fi
  node tools/playtest.mjs shot "/tmp/fleet-$s.png" >/dev/null 2>&1
done

echo "=== browser rows: $TOTAL_ROWS ==="
echo "=== console ==="
node tools/playtest.mjs logs
kill $WD 2>/dev/null
wait $WD 2>/dev/null
# Nothing of this run may outlive the script: an orphan headless Chrome squats the devtools
# port and the next agent's gate then reports zero failures because it never reached a browser.
# This check has to run *after* the kill — asking whether a Chrome is alive while the EXIT trap
# is still the thing that would kill it can only ever answer "leftover", so a green run was
# impossible and the real failures were buried under a wall of process listings.
kill $SPID 2>/dev/null
kill $CPID 2>/dev/null
for i in $(seq 1 20); do
  pgrep -f "user-data-dir=$UDD" >/dev/null 2>&1 || break
  sleep 0.25
done
[ "$CPID" != 0 ] && kill -9 $CPID 2>/dev/null
if pgrep -f "user-data-dir=$UDD" >/dev/null 2>&1; then
  echo "chrome did not exit: still running on :$CDP_PORT" >&2
  pgrep -fl "user-data-dir=$UDD" >&2 | head -3
  FAILED=1
else
  echo "=== chrome exited, temp profile gone ==="
fi
rm -rf "$UDD"
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED

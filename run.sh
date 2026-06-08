#!/usr/bin/env bash
# GASF Print Calendar — scheduled render + upload wrapper (cron entry point).
#
# Renders the live MEC calendar to a one-page landscape PDF on the Jabra box
# and pushes it to the GASF WordPress server's uploads dir. Fully isolated from
# the jabra-dashboard pm2 processes — it only reads its own files and scps out.
#
# Invoke from cron as:  bash /opt/gasf-print-calendar/run.sh
set -uo pipefail

APP_DIR=/opt/gasf-print-calendar
MAIN_PDF="$APP_DIR/calendar.pdf"
LOG="$APP_DIR/render.log"
LOCK="/tmp/gasf-print-calendar.lock"
DEST_DIR="gasf-bluehost:public_html/wp-content/uploads/"

# Cron's PATH is bare; make sure node + chromium resolve.
export PATH=/usr/local/bin:/usr/bin:/bin:$PATH
export CHROME_PATH="${CHROME_PATH:-/usr/bin/chromium-browser}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

# Protect the production Jabra dashboard: if the box runs out of memory during
# a render, make the kernel's OOM killer pick THIS process tree (node + its
# Chromium children inherit the score) instead of the dashboard. 800 = highly
# killable; the dashboard keeps the default 0.
echo 800 > /proc/self/oom_score_adj 2>/dev/null || true

ts()  { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

# Keep the log from growing without bound.
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 1000 ]; then
  tail -n 400 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# Single-flight: never let two renders overlap on the 2 GB box.
exec 9>"$LOCK"
if ! flock -n 9; then
  log "SKIP: a render is already running"
  exit 0
fi

if [ -z "$NODE_BIN" ]; then
  log "FAIL: node not found on PATH"
  exit 1
fi

log "START render (node=$NODE_BIN chrome=$CHROME_PATH)"
# Clear last run's PDFs so a partial render can't leave a stale month behind.
rm -f "$APP_DIR"/calendar.pdf "$APP_DIR"/calendar-*.pdf
if OUT_DIR="$APP_DIR" "$NODE_BIN" "$APP_DIR/render.js" >> "$LOG" 2>&1; then
  SIZE=$(stat -c%s "$MAIN_PDF" 2>/dev/null || echo 0)
  if [ "$SIZE" -lt 10000 ]; then
    log "FAIL: current-month PDF small/missing ($SIZE bytes) — not uploading"
    exit 1
  fi
  COUNT=$(ls -1 "$APP_DIR"/calendar*.pdf 2>/dev/null | wc -l)
  log "render OK ($COUNT files, current=$SIZE bytes); uploading"
  if scp -o ConnectTimeout=30 -o BatchMode=yes "$APP_DIR"/calendar.pdf "$APP_DIR"/calendar-*.pdf "$DEST_DIR" >> "$LOG" 2>&1; then
    log "UPLOAD OK ($COUNT files) -> $DEST_DIR"
  else
    log "FAIL: scp upload failed"
    exit 1
  fi
else
  log "FAIL: render returned non-zero (see above)"
  exit 1
fi
log "DONE"

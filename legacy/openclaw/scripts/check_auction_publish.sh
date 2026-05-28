#!/usr/bin/env bash
set -euo pipefail

LOG="/root/.openclaw/workspace/logs/auction_publish_cron.log"
WATCHDOG_LOG="/root/.openclaw/workspace/logs/auction_watchdog.log"
STATUS_FILE="/root/.openclaw/workspace/data/auction_refresh_status.json"
PYTHON_BIN=${PYTHON_BIN:-$(command -v python3)}

mkdir -p /root/.openclaw/workspace/logs

publish_ok=0
if grep -q "PUBLISH SUCCESS" "$LOG" 2>/dev/null; then
  publish_ok=1
fi

failed_sources=""
if [[ -f "$STATUS_FILE" ]]; then
  failed_sources=$(
    "$PYTHON_BIN" - "$STATUS_FILE" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as fh:
    payload = json.load(fh)
failed = []
for key, item in (payload.get('sources') or {}).items():
    if item.get('status') == 'failed':
        failed.append(item.get('label') or key)
print(', '.join(failed))
PY
  )
fi

if [[ "$publish_ok" -eq 0 ]]; then
  echo "[WATCHDOG] Missing publish success marker at $(TZ=America/New_York date '+%Y-%m-%d %I:%M:%S %p EST')" >> "$WATCHDOG_LOG"
  timeout 45m /root/.openclaw/workspace/scripts/publish_auction_shortlist.sh >> "$LOG" 2>&1
elif [[ -n "$failed_sources" ]]; then
  echo "[WATCHDOG] Publish completed but source failures remain at $(TZ=America/New_York date '+%Y-%m-%d %I:%M:%S %p EST'): $failed_sources" >> "$WATCHDOG_LOG"
else
  echo "[WATCHDOG] Publish already succeeded cleanly by $(TZ=America/New_York date '+%Y-%m-%d %I:%M:%S %p EST')" >> "$WATCHDOG_LOG"
fi

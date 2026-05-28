#!/usr/bin/env bash
set -euo pipefail
source /root/scripts/lib/time_est.sh

LOG_DIR="/root/.openclaw/workspace/logs"
STATUS_FILE="/root/.openclaw/workspace/data/auction_refresh_status.json"
mkdir -p "$LOG_DIR"
mkdir -p /root/.openclaw/workspace/data

if [ -x /root/.openclaw/workspace/.venv/bin/python ]; then
  PYTHON_BIN=/root/.openclaw/workspace/.venv/bin/python
else
  PYTHON_BIN=${PYTHON_BIN:-$(command -v python3)}
fi

HORIZON_HOURS=${AUCTION_HORIZON_HOURS:-120}

declare -a SOURCE_ORDER=(
  dynadot
  namecheap
  drive_uploads
  dropcatch
  parkio
  godaddy
  namesilo
  sedo
  sedo_expired
  namejet_lastchance
  namejet_email
  namejet_exclusive
)

init_source_status() {
  local key="$1"
  local label="$2"
  export "AUCTION_LABEL_${key}=$label"
  export "AUCTION_STATUS_${key}=pending"
  export "AUCTION_DETAIL_${key}="
}

write_status_file() {
  "$PYTHON_BIN" - "$STATUS_FILE" "${SOURCE_ORDER[@]}" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

status_file = sys.argv[1]
keys = sys.argv[2:]
payload = {
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "sources": {},
}
for key in keys:
    item = {
        "label": os.environ.get(f"AUCTION_LABEL_{key}", key),
        "status": os.environ.get(f"AUCTION_STATUS_{key}", "unknown"),
    }
    detail = os.environ.get(f"AUCTION_DETAIL_{key}", "").strip()
    if detail:
        item["detail"] = detail
    payload["sources"][key] = item

with open(status_file, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, indent=2)
    fh.write("\n")
PY
}

set_source_status() {
  local key="$1"
  local status="$2"
  local detail="${3:-}"
  export "AUCTION_STATUS_${key}=$status"
  export "AUCTION_DETAIL_${key}=$detail"
  write_status_file
}

for key in "${SOURCE_ORDER[@]}"; do
  case "$key" in
    dynadot) init_source_status "$key" "Dynadot" ;;
    namecheap) init_source_status "$key" "Namecheap" ;;
    drive_uploads) init_source_status "$key" "Drive auction uploads" ;;
    dropcatch) init_source_status "$key" "DropCatch" ;;
    parkio) init_source_status "$key" "Park.io" ;;
    godaddy) init_source_status "$key" "GoDaddy" ;;
    namesilo) init_source_status "$key" "NameSilo" ;;
    sedo) init_source_status "$key" "Sedo" ;;
    sedo_expired) init_source_status "$key" "Sedo expired" ;;
    namejet_lastchance) init_source_status "$key" "NameJet last chance" ;;
    namejet_email) init_source_status "$key" "NameJet email digest" ;;
    namejet_exclusive) init_source_status "$key" "NameJet exclusive storefront" ;;
  esac
done
write_status_file

echo "==== $(est_now) starting shortlist publish ====" >> "$LOG_DIR/auction_publish.log"

cd /root/.openclaw/workspace

run_step() {
  local label="$1"
  shift
  echo "[$(est_now)] START $label" >> "$LOG_DIR/auction_publish.log"
  if "$@" >> "$LOG_DIR/auction_publish.log" 2>&1; then
    echo "[$(est_now)] DONE  $label" >> "$LOG_DIR/auction_publish.log"
  else
    echo "[$(est_now)] FAIL  $label" >> "$LOG_DIR/auction_publish.log"
    exit 1
  fi
}

run_step_with_retry() {
  local label="$1"
  shift
  local max_attempts=${RUN_STEP_RETRY_ATTEMPTS:-3}
  local delay_seconds=${RUN_STEP_RETRY_DELAY_SECONDS:-60}
  local attempt=1
  local current_delay=$delay_seconds

  while true; do
    echo "[$(est_now)] START $label (attempt $attempt/$max_attempts)" >> "$LOG_DIR/auction_publish.log"
    if "$@" >> "$LOG_DIR/auction_publish.log" 2>&1; then
      echo "[$(est_now)] DONE  $label (attempt $attempt/$max_attempts)" >> "$LOG_DIR/auction_publish.log"
      return 0
    fi

    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "[$(est_now)] FAIL  $label after $attempt/$max_attempts attempts" >> "$LOG_DIR/auction_publish.log"
      exit 1
    fi

    echo "[$(est_now)] RETRY $label in ${current_delay}s" >> "$LOG_DIR/auction_publish.log"
    sleep "$current_delay"
    attempt=$((attempt + 1))
    current_delay=$((current_delay * 2))
  done
}

run_advisory_step() {
  local label="$1"
  shift
  echo "[$(est_now)] START $label" >> "$LOG_DIR/auction_publish.log"
  if "$@" >> "$LOG_DIR/auction_publish.log" 2>&1; then
    echo "[$(est_now)] DONE  $label" >> "$LOG_DIR/auction_publish.log"
  else
    echo "[$(est_now)] WARN  $label (non-blocking)" >> "$LOG_DIR/auction_publish.log"
  fi
}

run_source_step() {
  local key="$1"
  local label="$2"
  shift 2
  echo "[$(est_now)] START $label" >> "$LOG_DIR/auction_publish.log"
  if "$@" >> "$LOG_DIR/auction_publish.log" 2>&1; then
    echo "[$(est_now)] DONE  $label" >> "$LOG_DIR/auction_publish.log"
    set_source_status "$key" "ok"
  else
    echo "[$(est_now)] FAIL  $label (continuing without this source)" >> "$LOG_DIR/auction_publish.log"
    set_source_status "$key" "failed" "$label failed during refresh; continuing without this source."
    return 1
  fi
}

# Refresh every source before publishing
if run_source_step dynadot "Dynadot fetch" "$PYTHON_BIN" scripts/dynadot_open_fetch.py --hours "$HORIZON_HOURS" --out /tmp/dynadot_open.json; then
  if ! run_source_step dynadot "Dynadot filter" "$PYTHON_BIN" scripts/dynadot_filter.py; then
    :
  fi
else
  echo "[$(est_now)] SKIP  Dynadot filter (fetch failed)" >> "$LOG_DIR/auction_publish.log"
fi

run_source_step namecheap "Namecheap crawl" "$PYTHON_BIN" scripts/namecheap_auctions_crawl.py || true
run_source_step drive_uploads "Drive auction uploads" "$PYTHON_BIN" scripts/scan_drive_auction_uploads.py || true
run_source_step dropcatch "DropCatch scrape" "$PYTHON_BIN" scripts/dropcatch_auctions_fetch.py || true
run_source_step parkio "Park.io fetch" "$PYTHON_BIN" scripts/parkio_auctions_fetch.py || true
run_source_step godaddy "GoDaddy bulk fetch" "$PYTHON_BIN" scripts/godaddy_auctions_fetch.py --hours "$HORIZON_HOURS" --out data/godaddy_auctions_filtered.json || true
run_source_step namesilo "NameSilo fetch" "$PYTHON_BIN" scripts/namesilo_auctions_fetch.py --hours "$HORIZON_HOURS" --out data/namesilo_auctions_filtered.json || true
run_source_step sedo "Sedo fresh search export" "$PYTHON_BIN" scripts/sedo_expiring_export.py --tlds com,net,ai,co --length-min 1 --length-max 12 --max-words 1 --max-age 12 --size 500 || true
run_source_step sedo_expired "Sedo expired auctions fetch" "$PYTHON_BIN" scripts/sedo_expired_fetch.py --tlds com,org,io --length-min 1 --length-max 12 --out data/sedo_expired_auctions.json || true
echo "[$(est_now)] SKIP  NameJet last chance (using Judy Drive dump instead)" >> "$LOG_DIR/auction_publish.log"
printf '[]\n' > /root/.openclaw/workspace/data/namejet_lastchance_full.json
set_source_status "namejet_lastchance" "disabled" "Using Judy Drive dump instead."

echo "[$(est_now)] SKIP  NameJet email digest ingest (using Judy Drive dump instead)" >> "$LOG_DIR/auction_publish.log"
printf '[]\n' > /root/.openclaw/workspace/data/namejet_email_filtered.json
set_source_status "namejet_email" "disabled" "Using Judy Drive dump instead."

echo "[$(est_now)] SKIP  NameJet exclusive storefront (using Judy Drive dump instead)" >> "$LOG_DIR/auction_publish.log"
mkdir -p /root/.openclaw/workspace/data/namejet
printf '{"rows": []}\n' > /root/.openclaw/workspace/data/namejet/namejet_exclusive_latest.json
set_source_status "namejet_exclusive" "disabled" "Using Judy Drive dump instead."
run_advisory_step "Auction freshness check" "$PYTHON_BIN" scripts/validate_auction_dates.py
run_step_with_retry "Sheet push" "$PYTHON_BIN" scripts/push_auctions_to_sheet.py
run_advisory_step "Slack publish" "$PYTHON_BIN" scripts/post_auction_watchlist.py

echo "==== $(est_now) completed shortlist publish ====" >> "$LOG_DIR/auction_publish.log"
echo "PUBLISH SUCCESS $(est_now)" >> /root/.openclaw/workspace/logs/auction_publish_cron.log

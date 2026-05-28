#!/usr/bin/env bash
set -euo pipefail
cd /root/.openclaw/workspace

ZIP_TARGET="data/afternic/inventory_latest.zip"
TARGET="data/afternic/inventory_latest.csv"
DOWNLOAD_URL="https://search.afternic.com/broker/all?id=zt5nchodbseszkp&compress=1"
MAX_ATTEMPTS=4
SLEEP_SECONDS=900

if [[ -x /root/.openclaw/workspace/.venv/bin/python ]]; then
  PYTHON_BIN=/root/.openclaw/workspace/.venv/bin/python
else
  PYTHON_BIN=$(command -v python3)
fi

download_inventory() {
  echo "[INFO] Downloading Afternic inventory..."
  curl -L --fail --retry 3 -o "$ZIP_TARGET" "$DOWNLOAD_URL"
  gunzip -c "$ZIP_TARGET" > "$TARGET"
}

check_rolled() {
  if [[ ! -f "$TARGET" ]]; then
    echo "[ERROR] Missing $TARGET" >&2
    return 2
  fi
  local file_day
  local today
  file_day=$(TZ=America/New_York date -r "$TARGET" +%Y-%m-%d)
  today=$(TZ=America/New_York date +%Y-%m-%d)
  [[ "$file_day" == "$today" ]]
}

get_file_timestamp() {
  if [[ -f "$TARGET" ]]; then
    TZ=America/New_York date -r "$TARGET" '+%Y-%m-%d %H:%M:%S %Z'
  else
    echo "(missing)"
  fi
}

attempt=1
while (( attempt <= MAX_ATTEMPTS )); do
  download_inventory
  status=$(check_rolled; echo $?)
  if [[ "$status" == "0" ]]; then
    echo "[INFO] Afternic inventory rolled (mod time: $(get_file_timestamp)). Running diff."
    "$PYTHON_BIN" scripts/afternic_diff.py
    echo "[INFO] Running NameJet exclusive diff."
    "$PYTHON_BIN" scripts/namejet_exclusive_diff.py
    echo "[INFO] Refreshing upgrade target map and scanning overlap targets."
    if ! "$PYTHON_BIN" scripts/build_upgrade_target_map.py; then
      echo "[WARN] build_upgrade_target_map.py failed; continuing." >&2
    fi
    if ! "$PYTHON_BIN" scripts/run_upgrade_overlap.py; then
      echo "[WARN] run_upgrade_overlap.py failed; continuing." >&2
    fi
    echo "[INFO] Syncing Afternic net-new sheet."
    if ! "$PYTHON_BIN" scripts/update_afternic_net_new_sheet.py; then
      echo "[WARN] update_afternic_net_new_sheet.py failed; continuing." >&2
    fi
    echo "[INFO] Refreshing Afternic sublist sheet and Today's New Listings."
    if ! "$PYTHON_BIN" scripts/refresh_sublist_sheet.py; then
      echo "[WARN] refresh_sublist_sheet.py failed; continuing." >&2
    fi
    exit 0
  elif [[ "$status" == "2" ]]; then
    echo "[ERROR] Inventory file not found. Aborting." >&2
    exit 1
  fi

  if (( attempt == MAX_ATTEMPTS )); then
    echo "[ERROR] Inventory file still stale as of $(get_file_timestamp); giving up after $MAX_ATTEMPTS attempts." >&2
    exit 1
  fi

  echo "[INFO] Inventory still stale (mod time: $(get_file_timestamp)). Waiting $SLEEP_SECONDS seconds before rechecking (attempt $attempt/$MAX_ATTEMPTS)."
  sleep "$SLEEP_SECONDS"
  (( attempt++ ))
done

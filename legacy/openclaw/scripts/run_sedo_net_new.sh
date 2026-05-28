#!/bin/bash
set -euo pipefail

cd /root/.openclaw/workspace
python3 scripts/sedo_expiring_export.py --tlds com,net,ai,co --length-min 1 --length-max 12 --max-words 1 --max-age 12 --size 500
python3 scripts/sedo_net_new_slack.py

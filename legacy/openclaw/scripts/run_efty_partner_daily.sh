#!/bin/bash
set -euo pipefail

cd /root/.openclaw/workspace
mkdir -p data/revisions/efty_partner /root/logs

python3 scripts/efty_partner_ingest.py
cp -f data/efty_partner_latest.csv "data/revisions/efty_partner/efty_partner_$(date -u +%Y%m%d).csv"
python3 scripts/efty_partner_diff.py
python3 scripts/rotate_marketplace_dumps.py

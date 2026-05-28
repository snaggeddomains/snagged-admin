#!/usr/bin/env bash
# Runs at the start of every Claude Code on the web session.
# Installs deps so the pipeline CLI and dashboard are ready immediately.

set -euo pipefail
cd "$(dirname "$0")/../.."

if [ -f pyproject.toml ]; then
  python3 -m pip install --quiet -e ".[dev]" >/dev/null 2>&1 || true
fi

if [ -f dashboard/package.json ]; then
  (cd dashboard && npm install --silent --no-audit --no-fund) >/dev/null 2>&1 || true
fi

echo "session-start: ready (python deps + dashboard deps installed if present)"

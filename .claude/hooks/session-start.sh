#!/usr/bin/env bash
# Runs at the start of every Claude Code on the web session.
# 1) flags git divergence, 2) surfaces CLAUDE.md, 3) installs deps, and
# 4) sets up a headless browser so Claude can screenshot-verify the dashboard.
set -euo pipefail
cd "$(dirname "$0")/../.." 2>/dev/null || true
ROOT="$(pwd)"

# ── 1. Git divergence check ────────────────────────────────────────────────
if [ -d .git ] && command -v git >/dev/null 2>&1; then
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  if [ -n "$branch" ] && [ "$branch" != "HEAD" ] && git fetch --quiet origin 2>/dev/null; then
    if git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
      behind=$(git rev-list --count "HEAD..origin/$branch" 2>/dev/null || echo 0)
      [ "$behind" -gt 0 ] && echo "⚠️  Local '$branch' is $behind commit(s) behind origin — run: git log --oneline HEAD..origin/$branch"
    fi
  fi
fi

# ── 2. Surface CLAUDE.md ───────────────────────────────────────────────────
[ -f CLAUDE.md ] && echo "📄 CLAUDE.md at repo root — READ IT FIRST (working agreements)."

# ── 3. Dependencies ────────────────────────────────────────────────────────
if [ -f pyproject.toml ]; then
  python3 -m pip install --quiet -e ".[dev]" >/dev/null 2>&1 || true
fi
if [ -f dashboard/package.json ]; then
  echo "▸ Installing dashboard deps…"
  (cd dashboard && npm install --silent --no-audit --no-fund) >/dev/null 2>&1 \
    && echo "  ✓ dashboard deps ready" || echo "  ⚠ dashboard npm install failed"
fi

# ── 4. Headless-browser tooling for GUI verification ───────────────────────
# A Chromium is pre-installed here; expose its path + install the Playwright/
# jsdom drivers (skipping the blocked browser DOWNLOAD — we launch the existing
# binary via $PW_CHROME). Lets Claude `next dev` + screenshot before pushing.
PW_CHROME="$(find /opt/pw-browsers -name chrome -path '*chrome-linux*' 2>/dev/null | head -1)"
TOOLS="$ROOT/.claude/tools"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  [ -n "$PW_CHROME" ] && echo "export PW_CHROME=\"$PW_CHROME\"" >> "$CLAUDE_ENV_FILE"
  echo "export NODE_PATH=\"$TOOLS/node_modules\"" >> "$CLAUDE_ENV_FILE"
fi
if command -v npm >/dev/null 2>&1 && [ ! -d "$TOOLS/node_modules/playwright" ]; then
  mkdir -p "$TOOLS"
  cat > "$TOOLS/package.json" <<'JSON'
{ "name": "claude-gui-tools", "private": true, "dependencies": { "jsdom": "^25.0.0", "playwright": "^1.48.0" } }
JSON
  echo "▸ Installing GUI verification tools (playwright + jsdom)…"
  ( cd "$TOOLS" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund --silent ) \
    && echo "  ✓ GUI tools ready (Chromium: ${PW_CHROME:-NOT FOUND})" || echo "  ⚠ GUI tools install failed"
fi

echo "session-start: ready."

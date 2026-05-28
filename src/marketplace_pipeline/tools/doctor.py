"""Pipeline diagnostics — single command to surface common failure modes.

Run via:
    pipeline doctor

Checks env vars, source-module imports, registry parsing, and (optionally,
with --probe) live Slack + Google auth via the existing smoke tests.

Designed to be the first thing to run when something in production looks
weird. Prints a tidy section per check and a one-line summary at the end.
"""
from __future__ import annotations

import argparse
import importlib
import os
import sys
import traceback
from typing import Any

from .. import config

# Env vars we expect somewhere in the pipeline. Sets are by criticality.
REQUIRED_ENV = ("SLACK_BOT_TOKEN", "GOOGLE_SERVICE_ACCOUNT_JSON")
OPTIONAL_ENV = (
    "SLACK_CHANNEL_SNAP",
    "SLACK_CHANNEL_AUCTIONS",
    "PIPELINE_RAW_CACHE_FOLDER_ID",
    "ANTHROPIC_API_KEY",
    "EFTY_PARTNER_TOKEN",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
    "R2_ENDPOINT",
    "DYNADOT_API_KEY",
    "DYNADOT_API_SECRET",
    "NAMESILO_API_KEY",
    "CF_BROWSER_ACCOUNT_ID",
    "CF_BROWSER_API_TOKEN",
)


def _section(title: str) -> None:
    print()
    print(f"== {title} ==")


def _check_env() -> int:
    _section("Environment variables")
    failures = 0
    for name in REQUIRED_ENV:
        if os.environ.get(name):
            print(f"  OK   {name}")
        else:
            print(f"  FAIL {name} (required)")
            failures += 1
    print("  --")
    for name in OPTIONAL_ENV:
        if os.environ.get(name):
            print(f"  OK   {name}")
        else:
            print(f"  --   {name} (optional, not set)")
    return failures


def _check_registry() -> int:
    _section("Source registry (sources.yaml)")
    try:
        reg = config.load_registry()
    except Exception as e:
        print(f"  FAIL could not load registry: {e}")
        return 1
    sources = reg.get("sources") or []
    refs = reg.get("references") or {}
    profiles = reg.get("filter_profiles") or {}
    print(f"  OK   loaded {len(sources)} sources, {len(refs)} references, "
          f"{len(profiles)} filter profiles")
    enabled = sum(1 for s in sources if s.get("enabled", True))
    disabled = len(sources) - enabled
    print(f"  OK   {enabled} enabled, {disabled} disabled")
    return 0


def _check_source_imports() -> int:
    """Import each enabled source module + the orchestrator/watchdog wrappers.
    Catches missing deps or import-time errors before they hit production."""
    _section("Source module imports")
    reg = config.load_registry()
    failures = 0
    for s in reg.get("sources") or []:
        if not s.get("enabled", True):
            continue
        sid = s["source_id"]
        try:
            mod = importlib.import_module(f"marketplace_pipeline.sources.{sid}")
            run_fn = getattr(mod, "run", None)
            label = getattr(mod, "SOURCE_LABEL", "?")
            if run_fn is None:
                print(f"  FAIL {sid:<26} module has no run() function")
                failures += 1
            else:
                print(f"  OK   {sid:<26} ({label})")
        except ImportError as e:
            # Distinguish 'module not yet written' from broken imports
            if f"sources.{sid}" in str(e) and "No module named" in str(e):
                print(f"  TODO {sid:<26} (not wired yet)")
            else:
                print(f"  FAIL {sid:<26} {e}")
                failures += 1
        except Exception as e:
            print(f"  FAIL {sid:<26} unexpected import-time error: {e}")
            failures += 1
    return failures


def _check_publishers() -> int:
    _section("Publisher modules")
    failures = 0
    for path in (
        "marketplace_pipeline.publishers.slack",
        "marketplace_pipeline.publishers.sheets",
        "marketplace_pipeline.auctions.sheet",
        "marketplace_pipeline.auctions.slack",
        "marketplace_pipeline.auctions.orchestrator",
        "marketplace_pipeline.auctions.watchdog",
        "marketplace_pipeline.drive_cache",
    ):
        try:
            importlib.import_module(path)
            print(f"  OK   {path}")
        except Exception as e:
            print(f"  FAIL {path}: {e}")
            failures += 1
    return failures


def _probe_google() -> int:
    """Live Google Sheets + Drive + Docs probe by reusing the existing
    smoke test. Skipped unless --probe is passed."""
    _section("Google service account probe (live)")
    try:
        from .auth_check import main as run_auth_check
        rc = run_auth_check()
        return 0 if rc == 0 else 1
    except Exception as e:
        print(f"  FAIL probe raised: {e}")
        return 1


def _probe_slack() -> int:
    _section("Slack bot probe (live)")
    try:
        from .slack_check import run as run_slack_check
        rc = run_slack_check(post_all=False, post_to=None)
        return 0 if rc == 0 else 1
    except Exception as e:
        print(f"  FAIL probe raised: {e}")
        return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pipeline doctor")
    parser.add_argument(
        "--probe",
        action="store_true",
        help="Also run live Google + Slack auth checks (requires real credentials)",
    )
    args = parser.parse_args(argv)

    print("Pipeline doctor")
    print("=" * 50)

    issues = 0
    issues += _check_env()
    issues += _check_registry()
    issues += _check_publishers()
    issues += _check_source_imports()
    if args.probe:
        issues += _probe_google()
        issues += _probe_slack()

    print()
    print("=" * 50)
    if issues == 0:
        print("OK -- everything checks out.")
        return 0
    print(f"FAIL -- {issues} issue(s) found. Scroll up for details.")
    return 1


if __name__ == "__main__":
    sys.exit(main())

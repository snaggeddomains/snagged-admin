"""Auctions publish orchestrator.

Runs every enabled + wired producer from the `auctions_publish.orchestrates`
list in sources.yaml, in registry order. Each producer writes its rows to
the auctions sheet and saves a snapshot.json; the orchestrator then reads
all snapshots and posts ONE consolidated message to #auctions with a
section per source.

Partial-failure tolerance (legacy parity): one producer raising does NOT
abort the run. Per-source status is captured in
state/auctions/refresh_status.json so downstream code (watchdog, dashboard,
diagnostics) can see which sources need attention.

Producers detect they are running inside the orchestrator via the
AUCTIONS_ORCHESTRATOR_MODE env var (set here, unset after each call).
"""
from __future__ import annotations

import importlib
import os
import traceback
from datetime import datetime, timezone
from typing import Any

from .. import auctions, config, state
from . import slack as auctions_slack
from . import sheet as auctions_sheet

ORCHESTRATOR_ID = "auctions_publish"
STATE_NAMESPACE = "auctions"
REFRESH_STATUS_FILE = "refresh_status.json"

SHEET_URL_TEMPLATE = "https://docs.google.com/spreadsheets/d/{sheet_id}/edit"


def _label_for(source_id: str) -> str:
    """Pull SOURCE_LABEL from a producer module if present, else humanize."""
    try:
        mod = importlib.import_module(f"marketplace_pipeline.sources.{source_id}")
        return getattr(mod, "SOURCE_LABEL", source_id.replace("_", " ").title())
    except ImportError:
        return source_id.replace("_", " ").title()


def _run_one(source_id: str) -> dict[str, Any]:
    """Run a single producer's run() with orchestrator mode active.
    Catches any exception and returns a status dict."""
    started = datetime.now(timezone.utc)
    os.environ[auctions.ORCHESTRATOR_ENV] = "1"
    try:
        mod = importlib.import_module(f"marketplace_pipeline.sources.{source_id}")
    except ImportError as e:
        return {
            "source": source_id,
            "label": _label_for(source_id),
            "status": "skipped",
            "detail": f"not wired: {e}",
            "generated_at": started.isoformat(),
        }

    label = getattr(mod, "SOURCE_LABEL", source_id)
    try:
        mod.run()
        return {
            "source": source_id,
            "label": label,
            "status": "ok",
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as e:
        tb = traceback.format_exc()
        print(f"  PRODUCER FAILED: {source_id}: {e}")
        print(tb)
        return {
            "source": source_id,
            "label": label,
            "status": "failed",
            "detail": str(e),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
    finally:
        os.environ.pop(auctions.ORCHESTRATOR_ENV, None)


def _build_slack_sections(statuses: list[dict[str, Any]]) -> list[list[str]]:
    """For each OK producer, read its snapshot.json and build a Slack section."""
    sections: list[list[str]] = []
    now = datetime.now(timezone.utc)
    for s in statuses:
        if s["status"] != "ok":
            continue
        snapshot = state.read_json(s["source"], "snapshot.json", default=[])
        if not snapshot:
            sections.append(auctions_slack.format_section(label=s["label"], listings=[]))
            continue
        # Enrich with time_left for nice rendering
        enriched: list[dict[str, Any]] = []
        for L in snapshot:
            end = L.get("end_time_utc")
            if not end:
                continue
            try:
                end_dt = datetime.fromisoformat(str(end).replace("Z", "+00:00"))
            except (ValueError, TypeError):
                continue
            enriched.append({
                **L,
                "time_left": auctions_sheet.format_time_left(end_dt, now=now),
            })
        sections.append(auctions_slack.format_section(label=s["label"], listings=enriched))
    return sections


def run() -> int:
    reg = config.load_registry()
    orch_cfg = config.get_source(ORCHESTRATOR_ID)
    producer_ids: list[str] = list(orch_cfg.get("orchestrates") or [])
    auc_cfg = reg["products"]["auctions"]
    sheet_id = auc_cfg["sheet_id"]
    slack_channel = os.environ.get(auc_cfg["slack_channel_env"], "C096AT8BECS")
    sheet_url = SHEET_URL_TEMPLATE.format(sheet_id=sheet_id)

    print(f"auctions_publish: running {len(producer_ids)} producers")
    statuses: list[dict[str, Any]] = []
    for pid in producer_ids:
        # Skip explicitly disabled producers
        try:
            pcfg = config.get_source(pid)
        except KeyError:
            statuses.append({
                "source": pid,
                "label": pid,
                "status": "skipped",
                "detail": "not in registry",
                "generated_at": datetime.now(timezone.utc).isoformat(),
            })
            print(f"  - {pid}: not in registry, skipping")
            continue
        if pcfg.get("enabled") is False:
            statuses.append({
                "source": pid,
                "label": _label_for(pid),
                "status": "disabled",
                "detail": pcfg.get("reason", ""),
                "generated_at": datetime.now(timezone.utc).isoformat(),
            })
            print(f"  - {pid}: disabled, skipping")
            continue

        print(f"  - {pid}: running")
        result = _run_one(pid)
        statuses.append(result)
        print(f"    -> {result['status']}")

    # Persist consolidated status
    state.write_json(STATE_NAMESPACE, REFRESH_STATUS_FILE, statuses)

    # Build + post consolidated Slack
    print("auctions_publish: building consolidated Slack message")
    sections = _build_slack_sections(statuses)
    failed = [s for s in statuses if s["status"] == "failed"]
    if failed:
        # Footer line about failed sources so they're visible
        fail_line = [f"_Failed sources: {', '.join(s['label'] for s in failed)}_"]
        sections.append(fail_line)

    if sections:
        from ..publishers import slack as slack_pub
        body_lines = ["*Auctions watchlist*"]
        body_lines.append("")
        for sec in sections:
            body_lines.extend(sec)
            body_lines.append("")
        body_lines.append(f"Full sheet: <{sheet_url}|sheet>")
        text = "\n".join(body_lines)
        posted = slack_pub.post(
            channel=slack_channel,
            text=text,
            dedupe_key=slack_pub.make_fingerprint(text),
            source=ORCHESTRATOR_ID,
        )
        print(f"  consolidated slack posted: {posted}")
    else:
        posted = False
        print("  no sections to post (all producers failed/disabled)")

    # Persist orchestrator run_status
    ok_count = sum(1 for s in statuses if s["status"] == "ok")
    failed_count = len(failed)
    state.write_json(ORCHESTRATOR_ID, "run_status.json", {
        "source": ORCHESTRATOR_ID,
        "label": "Auctions publish",
        "status": "ok" if failed_count == 0 else ("failed" if ok_count == 0 else "ok"),
        "detail": f"{ok_count} ok, {failed_count} failed" if failed_count else "all ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "producers_run": len(producer_ids),
        "ok_count": ok_count,
        "failed_count": failed_count,
        "slack_posted": posted,
    })

    print(f"DONE: {ok_count}/{len(producer_ids)} producers ok")
    # Exit 0 even with partial failures — watchdog will retry just the failed ones.
    return 0

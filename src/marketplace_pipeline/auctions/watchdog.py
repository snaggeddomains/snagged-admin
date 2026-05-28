"""Auctions publish watchdog.

Runs ~35 minutes after the orchestrator. Reads
state/auctions/refresh_status.json and re-runs any producers that came
back failed. Other producers are left alone. If nothing is failed, the
watchdog is a no-op.

This is the new equivalent of legacy check_auction_publish.sh, but
operates on the per-source status rather than a 'PUBLISH SUCCESS' grep
of the orchestrator log.
"""
from __future__ import annotations

import importlib
import os
from datetime import datetime, timezone
from typing import Any

from .. import auctions, config, state
from .orchestrator import (
    ORCHESTRATOR_ID,
    STATE_NAMESPACE,
    REFRESH_STATUS_FILE,
    _build_slack_sections,
)

WATCHDOG_ID = "auctions_watchdog"

SHEET_URL_TEMPLATE = "https://docs.google.com/spreadsheets/d/{sheet_id}/edit"


def _retry_one(source_id: str) -> dict[str, Any]:
    started = datetime.now(timezone.utc)
    os.environ[auctions.ORCHESTRATOR_ENV] = "1"
    try:
        mod = importlib.import_module(f"marketplace_pipeline.sources.{source_id}")
        mod.run()
        return {
            "source": source_id,
            "label": getattr(mod, "SOURCE_LABEL", source_id),
            "status": "ok",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "retried": True,
        }
    except Exception as e:
        return {
            "source": source_id,
            "label": getattr(
                importlib.import_module(f"marketplace_pipeline.sources.{source_id}"),
                "SOURCE_LABEL", source_id),
            "status": "failed",
            "detail": str(e),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "retried": True,
        }
    finally:
        os.environ.pop(auctions.ORCHESTRATOR_ENV, None)


def run() -> int:
    statuses: list[dict[str, Any]] = state.read_json(
        STATE_NAMESPACE, REFRESH_STATUS_FILE, default=[]
    )
    if not statuses:
        print("watchdog: no refresh_status.json — orchestrator hasn't run today, nothing to do.")
        state.write_json(WATCHDOG_ID, "run_status.json", {
            "source": WATCHDOG_ID,
            "label": "Auctions watchdog",
            "status": "skipped",
            "detail": "no orchestrator status file",
            "generated_at": datetime.now(timezone.utc).isoformat(),
        })
        return 0

    failed_ids = [s["source"] for s in statuses if s["status"] == "failed"]
    if not failed_ids:
        print(f"watchdog: all {len(statuses)} producers ok, nothing to retry.")
        state.write_json(WATCHDOG_ID, "run_status.json", {
            "source": WATCHDOG_ID,
            "label": "Auctions watchdog",
            "status": "ok",
            "detail": "no failed producers",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "retried": 0,
        })
        return 0

    print(f"watchdog: retrying {len(failed_ids)} failed producer(s): {failed_ids}")

    # Apply retries; replace those status entries
    status_by_id = {s["source"]: s for s in statuses}
    recovered = 0
    for sid in failed_ids:
        new_status = _retry_one(sid)
        status_by_id[sid] = new_status
        if new_status["status"] == "ok":
            recovered += 1
        print(f"  - {sid}: {new_status['status']}")

    updated = list(status_by_id.values())
    state.write_json(STATE_NAMESPACE, REFRESH_STATUS_FILE, updated)

    # If any retries succeeded, repost the consolidated Slack message with
    # the now-complete data. Dedupe will skip if the previous post had the
    # same content.
    if recovered > 0:
        print(f"watchdog: {recovered} producer(s) recovered — reposting consolidated Slack")
        reg = config.load_registry()
        auc_cfg = reg["products"]["auctions"]
        sheet_id = auc_cfg["sheet_id"]
        slack_channel = os.environ.get(auc_cfg["slack_channel_env"], "C096AT8BECS")
        sheet_url = SHEET_URL_TEMPLATE.format(sheet_id=sheet_id)

        sections = _build_slack_sections(updated)
        still_failed = [s for s in updated if s["status"] == "failed"]
        if still_failed:
            sections.append(
                [f"_Failed sources: {', '.join(s['label'] for s in still_failed)}_"],
            )

        from ..publishers import slack as slack_pub
        body_lines = ["*Auctions watchlist* (watchdog repost)"]
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
            source=ORCHESTRATOR_ID,  # share dedupe namespace with orchestrator
        )
        print(f"  reposted: {posted}")
    else:
        posted = False

    final_failed = [s for s in updated if s["status"] == "failed"]
    state.write_json(WATCHDOG_ID, "run_status.json", {
        "source": WATCHDOG_ID,
        "label": "Auctions watchdog",
        "status": "ok" if not final_failed else "failed",
        "detail": (
            f"retried {len(failed_ids)}, {recovered} recovered, "
            f"{len(final_failed)} still failed"
        ),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "retried": len(failed_ids),
        "recovered": recovered,
        "still_failed": [s["source"] for s in final_failed],
        "reposted_slack": posted,
    })
    return 0

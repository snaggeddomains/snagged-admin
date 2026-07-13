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
from zoneinfo import ZoneInfo

from .. import auctions, config, state
from . import slack as auctions_slack
from . import sheet as auctions_sheet

ORCHESTRATOR_ID = "auctions_publish"
STATE_NAMESPACE = "auctions"
# "Closing today" is judged in the business timezone (ET) so it means today on our
# clock, not a UTC calendar day that flips mid-afternoon.
BUSINESS_TZ = ZoneInfo("America/New_York")
# Stay safely under Slack's 40k-char chat.postMessage limit; a heavy day chunks into
# multiple posts so we NEVER drop rows to fit one message.
MAX_MESSAGE_CHARS = 38000
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
        # Stamp the per-source run_status FAILED so the admin panel turns red
        # (the producer only writes run_status on success, so its last 'ok'
        # would otherwise mask the failure).
        try:
            state.write_run_status_failed(source_id, label, str(e))
        except Exception as werr:  # noqa: BLE001 — never mask the real error
            print(f"  (could not write failed run_status for {source_id}: {werr})")
        return {
            "source": source_id,
            "label": label,
            "status": "failed",
            "detail": str(e),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
    finally:
        os.environ.pop(auctions.ORCHESTRATOR_ENV, None)


def _mub_section(all_listings: list[dict[str, Any]]) -> list[str] | None:
    """The body of a STANDALONE "✨ MUB picks" post: every MUB (Made-Up Brandable)
    .com across all auction sources, deduped, ranked best-first, each tagged with its
    source for provenance. None if no hits. (Posted separately, not mixed into the
    per-source watchlist sections.)"""
    from ..filters import mub
    picks: list[tuple[float, dict[str, Any]]] = []
    seen: set[str] = set()
    for L in all_listings:
        d = (L.get("domain") or "").strip().lower()
        if d in seen:
            continue
        score = mub.mub_brandable(d)
        if score is None:
            continue
        seen.add(d)
        picks.append((score, L))
    if not picks:
        return None
    picks.sort(key=lambda x: -x[0])
    lines = [f"✨ *MUB picks* — {len(picks)} made-up brandable .com(s) in today's auctions"]
    for _, L in picks[:20]:
        price = L.get("price")
        if price in (None, ""):
            price_str = "—"
        else:
            try:
                p = float(price); price_str = f"${p:,.0f}"
            except (TypeError, ValueError):
                price_str = f"${price}"
        link = L.get("link")
        link_suffix = f"  <{link}|link>" if link else ""
        src = L.get("platform") or L.get("source") or ""
        src_suffix = f"  _{src}_" if src else ""
        lines.append(f"• {L.get('domain','')}  {price_str}  ends {L.get('time_left','')}"
                     f"{link_suffix}{src_suffix}")
    if len(picks) > 20:
        lines.append(f"… and {len(picks) - 20} more")
    return lines


def _enrich_snapshot(source: str) -> list[dict[str, Any]]:
    """Read a producer's snapshot.json and add time_left for rendering."""
    now = datetime.now(timezone.utc)
    snapshot = state.read_json(source, "snapshot.json", default=[]) or []
    out: list[dict[str, Any]] = []
    for L in snapshot:
        end = L.get("end_time_utc")
        if not end:
            continue
        try:
            end_dt = datetime.fromisoformat(str(end).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            continue
        out.append({**L, "time_left": auctions_sheet.format_time_left(end_dt, now=now)})
    return out


def _build_slack_sections(statuses: list[dict[str, Any]]) -> list[list[str]]:
    """For each OK producer, read its snapshot.json and build a Slack section."""
    sections: list[list[str]] = []
    for s in statuses:
        if s["status"] != "ok":
            continue
        enriched = _enrich_snapshot(s["source"])
        sections.append(auctions_slack.format_section(label=s["label"], listings=enriched))
    return sections


def _all_enriched(statuses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Flat list of all OK producers' enriched listings (for the MUB roundup)."""
    out: list[dict[str, Any]] = []
    for s in statuses:
        if s["status"] == "ok":
            out.extend(_enrich_snapshot(s["source"]))
    return out


def _closes_today(end_dt: datetime, now: datetime) -> bool:
    """True if the auction ends later TODAY (business-tz calendar day)."""
    return end_dt > now and end_dt.astimezone(BUSINESS_TZ).date() == now.astimezone(BUSINESS_TZ).date()


def _closing_today_section(statuses: list[dict[str, Any]], now: datetime) -> list[str] | None:
    """A cross-source '⏰ Closing TODAY' roundup pinned to the top for urgency —
    EVERY name whose auction ends today, soonest first, tagged with its source."""
    rows: list[tuple[datetime, str]] = []
    for s in statuses:
        if s["status"] != "ok":
            continue
        for L in _enrich_snapshot(s["source"]):
            try:
                end_dt = datetime.fromisoformat(str(L.get("end_time_utc")).replace("Z", "+00:00"))
            except (ValueError, TypeError):
                continue
            if _closes_today(end_dt, now):
                rows.append((end_dt, auctions_slack.format_line(L, source_label=s["label"])))
    if not rows:
        return None
    rows.sort(key=lambda r: r[0])  # soonest first
    plural = "s" if len(rows) != 1 else ""
    return [f"*⏰ Closing TODAY — {len(rows)} auction{plural}*  _(soonest first)_", *[line for _, line in rows]]


def _chunk_lines(lines: list[str], max_chars: int = MAX_MESSAGE_CHARS) -> list[str]:
    """Pack lines into message-sized text blocks at line boundaries (never mid-row),
    so a long watchlist posts as several messages instead of being truncated by Slack."""
    chunks: list[str] = []
    cur: list[str] = []
    cur_len = 0
    for ln in lines:
        add = len(ln) + 1
        if cur and cur_len + add > max_chars:
            chunks.append("\n".join(cur))
            cur, cur_len = [], 0
        cur.append(ln)
        cur_len += add
    if cur:
        chunks.append("\n".join(cur))
    return chunks


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
    mub_section = _mub_section(_all_enriched(statuses))
    failed = [s for s in statuses if s["status"] == "failed"]
    if failed:
        # Footer line about failed sources so they're visible
        fail_line = [f"_Failed sources: {', '.join(s['label'] for s in failed)}_"]
        sections.append(fail_line)

    from ..publishers import slack as slack_pub

    # MUB picks go out as their OWN post (own section in the morning report), so
    # they aren't mixed into the per-source watchlist. Posted first => sits on top.
    if mub_section:
        mub_text = "\n".join(mub_section)
        mub_posted = slack_pub.post(
            channel=slack_channel,
            text=mub_text,
            dedupe_key=slack_pub.make_fingerprint(mub_text),
            source=ORCHESTRATOR_ID,
        )
        print(f"  MUB picks slack posted: {mub_posted}")

    if sections:
        # Pin an urgency roundup of everything closing today to the very top.
        closing = _closing_today_section(statuses, datetime.now(timezone.utc))
        body_lines = ["*Auctions watchlist*", ""]
        if closing:
            body_lines.extend(closing)
            body_lines.append("")
        for sec in sections:
            body_lines.extend(sec)
            body_lines.append("")
        body_lines.append(f"Full sheet: <{sheet_url}|sheet>")
        text = "\n".join(body_lines)

        # Show ALL rows: if the message would exceed Slack's limit, split into
        # several posts rather than dropping names. Dedupe on the full report so an
        # identical re-run is skipped; only the first chunk carries the dedupe key.
        chunks = _chunk_lines(body_lines)
        posted = False
        for i, chunk in enumerate(chunks):
            ok = slack_pub.post(
                channel=slack_channel,
                text=chunk,
                dedupe_key=slack_pub.make_fingerprint(text) if i == 0 else None,
                source=ORCHESTRATOR_ID if i == 0 else None,
            )
            if i == 0:
                posted = ok
                if not ok:  # duplicate of the last run → skip the rest too
                    break
        print(f"  consolidated slack posted: {posted} ({len(chunks)} message{'s' if len(chunks) != 1 else ''})")
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

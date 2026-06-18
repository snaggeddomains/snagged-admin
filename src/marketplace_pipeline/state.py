"""Pipeline state read/write helpers.

All state is JSON committed to /state/<source_id>/. A GitHub Actions workflow
reads previous snapshots at run start and commits new ones at run end.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
STATE_DIR = REPO_ROOT / "state"


# ── Secret redaction ─────────────────────────────────────────────────────────
# State JSON is committed to a PUBLIC repo. Source errors often carry the failing
# request URL (e.g. scrape.do `?token=…`, an Efty `/partner/feed/token/<TOKEN>/`),
# which would leak live credentials into git history. Scrub token-like values from
# every string before writing. Patterns are deliberately narrow so they only hit
# secrets in URLs/headers — plain domains and prose are untouched.
_SECRET_QS = re.compile(
    r"(?i)(?:(?<=[?&\s\"'])|^)"  # at a query-param / whitespace / quote boundary, or string start
    r"((?:token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|pwd|signature|sig|auth|authorization|key)=)"
    r"[^&\s\"'#]+"
)
_SECRET_PATH = re.compile(
    r"(?i)(/(?:token|api[_-]?key|apikey|key|secret|access[_-]?token|auth)/)[^/\s\"'#?]+"
)
_BEARER = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{8,}")
_REDACTED = r"\1***REDACTED***"


def redact_secrets(obj: Any) -> Any:
    """Recursively mask credential-like values (URL token/key params, `/token/<x>/`
    path segments, `Bearer <x>` headers) in any JSON-serializable structure."""
    if isinstance(obj, str):
        s = _SECRET_QS.sub(_REDACTED, obj)
        s = _SECRET_PATH.sub(_REDACTED, s)
        s = _BEARER.sub(_REDACTED, s)
        return s
    if isinstance(obj, dict):
        return {k: redact_secrets(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [redact_secrets(v) for v in obj]
    return obj


def state_path(source: str, filename: str) -> Path:
    return STATE_DIR / source / filename


def read_json(source: str, filename: str, default: Any = None) -> Any:
    p = state_path(source, filename)
    if not p.exists():
        return default
    return json.loads(p.read_text())


def write_json(source: str, filename: str, data: Any) -> None:
    p = state_path(source, filename)
    p.parent.mkdir(parents=True, exist_ok=True)
    # Scrub any leaked credentials (token/key URLs in error strings, etc.) before
    # this JSON is committed to the public repo.
    data = redact_secrets(data)
    p.write_text(json.dumps(data, indent=2, default=str, sort_keys=True) + "\n")


def write_run_status_failed(source: str, label: str, error: str) -> None:
    """Record a FAILED run so the admin sources panel turns red and shows the
    real last-run state. Sources write run_status.json only on success, so a
    crashed run would otherwise leave the previous 'ok' in place and the
    dashboard couldn't surface the failure. Call this from the run wrappers."""
    write_json(source, "run_status.json", {
        "source": source,
        "label": label or source,
        "status": "failed",
        "error": str(error)[:1000],
        "generated_at": datetime.now(timezone.utc).isoformat(),
    })


# Cap the persisted list so a huge feed day can't bloat the committed state file
# (the admin dashboard fetches it lazily on toggle; the count still comes from
# run_status.json's new_count).
NEW_TODAY_CAP = 2000


def write_new_today(source: str, domains: list[str]) -> None:
    """Persist the domains a source added 'new today' so the admin dashboard can
    show the names behind the 'new today' count (mirrors the imports drill-down).

    Best-effort: never raise — a failure to record this must not fail the run.
    Domains are de-duped (order-preserving), lowercased, and capped at
    NEW_TODAY_CAP. Writes state/<source>/new_today.json."""
    try:
        seen: set[str] = set()
        clean: list[str] = []
        for d in domains or []:
            dd = str(d).strip().lower()
            if not dd or dd in seen:
                continue
            seen.add(dd)
            clean.append(dd)
            if len(clean) >= NEW_TODAY_CAP:
                break
        write_json(source, "new_today.json", {
            "source": source,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "count": len(clean),
            "capped": len(clean) >= NEW_TODAY_CAP,
            "domains": clean,
        })
    except Exception as e:  # pragma: no cover - defensive
        print(f"(could not write new_today for {source}: {e})")


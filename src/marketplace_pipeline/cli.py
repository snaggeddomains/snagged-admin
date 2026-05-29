"""Pipeline CLI.

Usage:
    pipeline list-sources [--product snap|auctions|aux]
    pipeline run <source_id>
    pipeline status
"""
from __future__ import annotations

import argparse
import sys

from . import config


def cmd_list(args: argparse.Namespace) -> int:
    items = config.list_sources(product=args.product, enabled_only=args.enabled)
    print(f"{'source_id':<30} {'product':<10} {'kind':<18} {'enabled':<8} schedule")
    print("-" * 90)
    for s in items:
        print(
            f"{s['source_id']:<30} "
            f"{s.get('product', '-'):<10} "
            f"{s.get('kind', '-'):<18} "
            f"{'yes' if s.get('enabled', True) else 'no':<8} "
            f"{s.get('schedule_utc', '-')}"
        )
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    import importlib

    config.get_source(args.source_id)  # validates source exists in registry
    try:
        mod = importlib.import_module(f"marketplace_pipeline.sources.{args.source_id}")
    except ImportError as e:
        raise NotImplementedError(
            f"Source '{args.source_id}' has no implementation yet "
            f"(no module marketplace_pipeline.sources.{args.source_id})"
        ) from e
    return mod.run()


def cmd_status(args: argparse.Namespace) -> int:
    raise NotImplementedError("status command lands with the first source port")


def cmd_auth_check(args: argparse.Namespace) -> int:
    from .tools.auth_check import main as _run
    return _run()


def cmd_slack_check(args: argparse.Namespace) -> int:
    from .tools.slack_check import run as _run
    return _run(post_all=args.post, post_to=args.post_to)


def cmd_doctor(args: argparse.Namespace) -> int:
    from .tools.doctor import main as _run
    extra = ["--probe"] if args.probe else []
    return _run(extra)


def cmd_raw_cache_retention(args: argparse.Namespace) -> int:
    from .tools.raw_cache_retention import main as _run
    argv: list[str] = []
    if args.days is not None:
        argv += ["--days", str(args.days)]
    if args.dry_run:
        argv.append("--dry-run")
    return _run(argv)


def cmd_universe_sync(args: argparse.Namespace) -> int:
    from .tools.universe_sync import main as _run
    argv: list[str] = []
    if args.output is not None:
        argv += ["--output", str(args.output)]
    if args.dry_run:
        argv.append("--dry-run")
    if args.skip_supabase:
        argv.append("--skip-supabase")
    return _run(argv)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pipeline")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list-sources", help="List all configured sources")
    p_list.add_argument("--product", choices=["snap", "auctions", "aux"])
    p_list.add_argument("--enabled", action="store_true", help="Only show enabled sources")
    p_list.set_defaults(func=cmd_list)

    p_run = sub.add_parser("run", help="Run a single source end-to-end")
    p_run.add_argument("source_id")
    p_run.set_defaults(func=cmd_run)

    p_status = sub.add_parser("status", help="Print current run status across all sources")
    p_status.set_defaults(func=cmd_status)

    p_auth = sub.add_parser("auth-check", help="Verify Google service account auth")
    p_auth.set_defaults(func=cmd_auth_check)

    p_slack = sub.add_parser("slack-check", help="Verify Slack bot auth and channel access")
    p_slack.add_argument("--post", action="store_true",
                         help="post a test message to BOTH configured channels")
    p_slack.add_argument("--post-to", metavar="CHANNEL_ID", default=None,
                         help="post a test message to a single specific channel")
    p_slack.set_defaults(func=cmd_slack_check)

    p_doc = sub.add_parser("doctor", help="Diagnose env vars, imports, and registry")
    p_doc.add_argument("--probe", action="store_true",
                       help="also run live Google + Slack auth probes")
    p_doc.set_defaults(func=cmd_doctor)

    p_ret = sub.add_parser(
        "raw-cache-retention",
        help="Trash Pipeline Raw Cache date subfolders older than N days",
    )
    p_ret.add_argument("--days", type=int, default=None,
                       help="override retention horizon (default from registry)")
    p_ret.add_argument("--dry-run", action="store_true",
                       help="print actions without trashing anything")
    p_ret.set_defaults(func=cmd_raw_cache_retention)

    p_uni = sub.add_parser(
        "universe-sync",
        help="Walk per-source snapshots, upsert to Supabase, write Parquet archive",
    )
    p_uni.add_argument("--output", default=None,
                       help="local Parquet output path (default under data/universe/)")
    p_uni.add_argument("--dry-run", action="store_true",
                       help="collect + filter but skip Supabase upsert + Parquet write")
    p_uni.add_argument("--skip-supabase", action="store_true",
                       help="don't upsert to Supabase (Parquet only)")
    p_uni.set_defaults(func=cmd_universe_sync)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

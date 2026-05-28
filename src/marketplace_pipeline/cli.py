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
    source = config.get_source(args.source_id)
    raise NotImplementedError(
        f"Source '{source['source_id']}' has no implementation yet. "
        f"First port lands as a separate commit."
    )


def cmd_status(args: argparse.Namespace) -> int:
    raise NotImplementedError("status command lands with the first source port")


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

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

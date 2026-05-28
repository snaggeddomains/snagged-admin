"""Smoke tests for the scaffold — these verify the package imports and the
source registry loads. Real per-source tests land with each source port.
"""
from __future__ import annotations


def test_package_imports():
    import marketplace_pipeline
    from marketplace_pipeline import schemas, config, state, scoring, drive_cache
    from marketplace_pipeline.filters import standard as flt  # noqa: F401
    from marketplace_pipeline.publishers import slack, sheets
    from marketplace_pipeline.universe import duckdb_store
    from marketplace_pipeline.references import supabase_master
    from marketplace_pipeline.sources import namecheap_bin, afternic
    assert afternic.SOURCE_ID == "afternic"
    from marketplace_pipeline.tools import auth_check, slack_check

    assert marketplace_pipeline.__version__
    assert namecheap_bin.SOURCE_ID == "namecheap_bin"


def test_sources_yaml_loads_and_has_known_sources():
    from marketplace_pipeline import config

    reg = config.load_registry()
    ids = {s["source_id"] for s in reg["sources"]}

    expected = {
        "namecheap_bin",
        "afternic",
        "atom_daily",
        "atom_wholesale",
        "dynadot_auctions",
        "namecheap_auctions",
        "drive_auction_uploads",
        "auctions_publish",
        "auctions_watchdog",
        "efty_partner",
    }
    missing = expected - ids
    assert not missing, f"Missing sources in registry: {missing}"


def test_ownership_modes_have_expected_names():
    from marketplace_pipeline.publishers.sheets import OwnershipMode

    assert OwnershipMode.REPLACE_SOURCE_ROWS.value == "replace_source_rows"
    assert OwnershipMode.PREPEND_NEW_ROWS.value == "prepend_new_rows"
    assert OwnershipMode.APPEND_IF_MISSING.value == "append_if_missing"
    assert OwnershipMode.REBUILD_OWNED_SLICE.value == "rebuild_owned_slice"

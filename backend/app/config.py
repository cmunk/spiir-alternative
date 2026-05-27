from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class SpiirRuntimeSettings:
    cutover_date: str = "2026-01-01"


@dataclass(frozen=True)
class RuntimeSettings:
    spiir: SpiirRuntimeSettings


def _env(*names: str) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value:
            return value
    return None


def _path_from_env(names: tuple[str, ...], default: Path) -> Path:
    value = _env(*names)
    if not value:
        return default
    return Path(value).expanduser().resolve()


def get_data_dir() -> Path:
    return _path_from_env(("SPIIR_ALT_DATA_DIR",), ROOT_DIR / "data")


def get_transactions_dir() -> Path:
    return get_data_dir() / "transactions"


def get_spiir_data_dir() -> Path:
    return get_data_dir() / "spiir"


def get_spiir_raw_dir() -> Path:
    return get_spiir_data_dir() / "raw"


def get_spiir_processed_dir() -> Path:
    return get_spiir_data_dir() / "processed"


def get_spiir_local_dir() -> Path:
    return get_spiir_data_dir() / "local"


def get_spiir_raw_export_file() -> Path:
    return get_spiir_raw_dir() / "all_entries.json"


def get_spiir_overview_file() -> Path:
    return get_spiir_processed_dir() / "overview.json"


def get_spiir_transactions_file() -> Path:
    return get_spiir_processed_dir() / "tx.json"


def get_spiir_update_log_file() -> Path:
    return get_spiir_data_dir() / "update.log"


def get_spiir_local_transactions_file() -> Path:
    return get_spiir_local_dir() / "transactions.json"


def get_spiir_local_import_runs_file() -> Path:
    return get_spiir_local_dir() / "import_runs.json"


def get_spiir_local_overrides_file() -> Path:
    return get_spiir_local_dir() / "overrides.json"


def get_spiir_rebuild_state_file() -> Path:
    return get_spiir_local_dir() / "rebuild_state.json"


def get_spiir_income_expense_series_cache_file() -> Path:
    return get_spiir_local_dir() / "cache" / "income_expense_series.json"


def get_storebox_source_dir() -> Path:
    return _path_from_env(("STOREBOX_SOURCE_DIR", "SPIIR_ALT_STOREBOX_SOURCE_DIR"), get_data_dir() / "storebox")


def get_kvitteringer_data_dir() -> Path:
    return get_data_dir() / "kvitteringer"


def get_kvitteringer_category_overrides_file() -> Path:
    return get_kvitteringer_data_dir() / "category_overrides.json"


def get_kvitteringer_db_path() -> Path:
    return _path_from_env(("KVITTERINGER_DB_PATH", "SPIIR_ALT_KVITTERINGER_DB_PATH"), get_kvitteringer_data_dir() / "kvitteringer.sqlite3")


def get_runtime_settings() -> RuntimeSettings:
    return RuntimeSettings(
        spiir=SpiirRuntimeSettings(
            cutover_date=_env("SPIIR_CUTOVER_DATE", "SPIIR_ALT_CUTOVER_DATE") or "2026-01-01",
        ),
    )

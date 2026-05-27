from __future__ import annotations

import shutil
from datetime import UTC, datetime
from pathlib import Path

from .config import (
    get_data_dir,
    get_kvitteringer_data_dir,
    get_spiir_local_dir,
    get_spiir_processed_dir,
    get_spiir_raw_dir,
    get_storebox_source_dir,
    get_transactions_dir,
)


def _timestamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def ensure_runtime_dirs() -> None:
    for path in [
        get_data_dir() / "backups",
        get_transactions_dir(),
        get_spiir_raw_dir(),
        get_spiir_processed_dir(),
        get_spiir_local_dir(),
        get_kvitteringer_data_dir(),
        get_storebox_source_dir(),
    ]:
        path.mkdir(parents=True, exist_ok=True)


def create_backup(path: Path) -> Path | None:
    if not path.exists() or not path.is_file():
        return None
    backup_dir = get_data_dir() / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"{path.name}.{_timestamp()}.bak"
    shutil.copy2(path, backup_path)
    return backup_path

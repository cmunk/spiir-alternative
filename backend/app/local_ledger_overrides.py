from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

LOCAL_LEDGER_OVERRIDE_KEYS = {
    "date",
    "comment",
    "hashtags",
    "is_extraordinary",
    "pending_review",
    "splits",
    "category_type",
    "main_category_id",
    "main_category_name",
    "category_id",
    "category_name",
    "is_excluded",
    "category_source",
    "category_reason",
    "category_confidence",
    "updated_at",
}


def load_local_ledger_overrides(
    *,
    read_json: Callable[[Path], Any],
    overrides_file: Path,
) -> dict[str, dict[str, Any]]:
    if not overrides_file.exists():
        return {}
    payload = read_json(overrides_file)
    if not isinstance(payload, dict):
        return {}
    return {
        str(key): value
        for key, value in payload.items()
        if isinstance(value, dict) and str(key).strip()
    }


def apply_local_ledger_override(
    row: dict[str, Any],
    overrides_by_id: dict[str, dict[str, Any]],
    *,
    mark_provenance: bool = False,
) -> dict[str, Any]:
    row_id = str(row.get("id") or "")
    override = overrides_by_id.get(row_id)
    if override is None:
        return row

    patched = dict(row)
    for key in LOCAL_LEDGER_OVERRIDE_KEYS:
        if key in override:
            patched[key] = override[key]

    if mark_provenance:
        provenance = dict(patched.get("provenance") or {})
        provenance["edited_in_local_ledger"] = True
        patched["provenance"] = provenance

    return patched

from __future__ import annotations

import datetime as dt
import json
import re
import tempfile
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any

from .config import (
    get_runtime_settings,
    get_spiir_local_import_runs_file,
    get_spiir_local_overrides_file,
    get_spiir_local_transactions_file,
    get_spiir_raw_export_file,
)
from .local_ledger_overrides import (
    LOCAL_LEDGER_OVERRIDE_KEYS,
    apply_local_ledger_override,
    load_local_ledger_overrides,
)
from .nordea_service import (
    _sanitize_category,
    _sanitize_split,
    load_nordea_transactions,
    warm_nordea_taxonomy_cache,
)
from .spiir_service import (
    RENAME_MAIN_CATEGORY_NAME,
    SKIP_ACCOUNT_NAMES,
    SKIP_IS_EXTRAORDINARY,
    SKIP_MAIN_CATEGORY_NAMES,
    SKIP_YEAR_STRINGS,
    UNCATEGORIZED_CATEGORY_ID,
    UNCATEGORIZED_CATEGORY_NAME,
    UNCATEGORIZED_MAIN_CATEGORY_ID,
    UNCATEGORIZED_MAIN_CATEGORY_NAME,
    _append_hashtags_to_comment,
    _extract_hashtags,
    _normalize_hashtags,
    _parse_spiir_date,
    _remove_hashtags_from_comment,
    mark_spiir_rebuild_required,
)
from .storage import create_backup, ensure_runtime_dirs

NON_LETTER_RE = re.compile(r"[^a-zæøå]+")
STOP_WORDS = {
    "aps",
    "as",
    "betaling",
    "betalingsservice",
    "bgs",
    "bs",
    "butikk",
    "dankort",
    "dkk",
    "den",
    "dk",
    "fra",
    "gen",
    "kort",
    "konto",
    "koeb",
    "køb",
    "mastercard",
    "mobilepay",
    "nota",
    "overfoersel",
    "overførsel",
    "pending",
    "scti",
    "til",
    "usd",
    "visa",
    "vipps",
}
MIN_LEDGER_AUTOCATEGORY_CONFIDENCE = 0.92
MIN_LEDGER_AUTOCATEGORY_SUPPORT = 2
LOCAL_LEDGER_FIRST_PAGE_CACHE_LIMIT = 300
LOCAL_LEDGER_FIRST_PAGE_CACHE_VERSION = 1
CANONICAL_SPLIT_ROW_KEYS = [
    "amount",
    "split_group_id",
    "split_line_id",
    "split_original_parent_id",
    "split_line_index",
]
CANONICAL_SPLIT_PROVENANCE_KEYS = [
    "canonical_split",
    "canonical_split_source",
    "split_migrated_at",
    "split_migration_source",
    "split_original_parent_id",
    "split_parent_amount",
    "split_parent_description",
    "split_parent_source_id",
]

_LOCAL_LEDGER_TRANSACTIONS_CACHE: dict[str, Any] = {
    "key": None,
    "rows": None,
    "meta": None,
    "full_payload": None,
}

_LOCAL_LEDGER_TRANSACTION_INDEX_CACHE: dict[str, Any] = {
    "key": None,
    "rows_by_id": None,
}


def _iso_utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _file_mtime_ns(path: Path) -> int | None:
    if not path.exists():
        return None
    return path.stat().st_mtime_ns


def _file_cache_stat(path: Path) -> dict[str, int | None]:
    if not path.exists():
        return {"mtime_ns": None, "size": None}
    stat = path.stat()
    return {"mtime_ns": stat.st_mtime_ns, "size": stat.st_size}


def _local_ledger_transactions_cache_key() -> tuple[tuple[int | None, int | None], tuple[int | None, int | None]]:
    return (
        (_file_mtime_ns(get_spiir_local_transactions_file()), get_spiir_local_transactions_file().stat().st_size if get_spiir_local_transactions_file().exists() else None),
        (_file_mtime_ns(get_spiir_local_overrides_file()), get_spiir_local_overrides_file().stat().st_size if get_spiir_local_overrides_file().exists() else None),
    )


def _local_ledger_transaction_index_cache_key() -> tuple[str, int | None, int | None]:
    transactions_file = get_spiir_local_transactions_file()
    stat = _file_cache_stat(transactions_file)
    return (str(transactions_file), stat["mtime_ns"], stat["size"])


def _local_ledger_first_page_cache_file() -> Path:
    return get_spiir_local_transactions_file().parent / "cache" / "transactions_first_page.json"


def _local_ledger_first_page_cache_signature(limit: int) -> dict[str, Any]:
    return {
        "schema_version": LOCAL_LEDGER_FIRST_PAGE_CACHE_VERSION,
        "limit": limit,
        "sources": {
            "transactions": _file_cache_stat(get_spiir_local_transactions_file()),
            "overrides": _file_cache_stat(get_spiir_local_overrides_file()),
        },
    }


def _read_local_ledger_first_page_cache(limit: int) -> dict[str, Any] | None:
    cache_file = _local_ledger_first_page_cache_file()
    if not cache_file.exists():
        return None
    try:
        payload = _read_json(cache_file)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("signature") != _local_ledger_first_page_cache_signature(limit):
        return None
    response = payload.get("response")
    if not isinstance(response, dict):
        return None
    next_response = dict(response)
    next_response["generated_at"] = _iso_utc_now()
    next_response.update(_nordea_retrieve_meta())
    return next_response


def _write_local_ledger_first_page_cache(limit: int, response: dict[str, Any]) -> None:
    cache_file = _local_ledger_first_page_cache_file()
    payload = {
        "signature": _local_ledger_first_page_cache_signature(limit),
        "cached_at": _iso_utc_now(),
        "response": response,
    }
    try:
        _write_json(cache_file, payload)
    except OSError:
        return


def _clear_local_ledger_transactions_memory_cache() -> None:
    _LOCAL_LEDGER_TRANSACTIONS_CACHE["key"] = None
    _LOCAL_LEDGER_TRANSACTIONS_CACHE["rows"] = None
    _LOCAL_LEDGER_TRANSACTIONS_CACHE["meta"] = None
    _LOCAL_LEDGER_TRANSACTIONS_CACHE["full_payload"] = None


def _clear_local_ledger_transaction_index_cache() -> None:
    _LOCAL_LEDGER_TRANSACTION_INDEX_CACHE["key"] = None
    _LOCAL_LEDGER_TRANSACTION_INDEX_CACHE["rows_by_id"] = None


def _sort_local_ledger_rows_desc(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        rows,
        key=lambda item: (str(item.get("date") or ""), str(item.get("source_id") or item.get("id") or "")),
        reverse=True,
    )


def _build_local_ledger_transactions_meta(rows: list[dict[str, Any]]) -> dict[str, Any]:
    account_names = sorted({str(item.get("source_account_name") or "").strip() for item in rows if str(item.get("source_account_name") or "").strip()})
    return {
        **_nordea_retrieve_meta(),
        "transaction_count": len(rows),
        "pending_review_count": sum(1 for item in rows if bool(item.get("pending_review"))),
        "accounts": [{"name": name} for name in account_names],
    }


def _nordea_retrieve_meta() -> dict[str, Any]:
    nordea_meta = load_nordea_transactions()
    return {
        "last_retrieved_at": nordea_meta.get("last_retrieved_at"),
        "last_retrieve_duration_seconds": nordea_meta.get("last_retrieve_duration_seconds"),
    }


def _slice_local_ledger_rows(rows: list[dict[str, Any]], *, limit: int | None, offset: int) -> list[dict[str, Any]]:
    start = max(offset, 0)
    if limit is None:
        return rows[start:]
    return rows[start:start + max(limit, 0)]


def _build_local_ledger_transactions_response(
    rows: list[dict[str, Any]],
    meta: dict[str, Any],
    *,
    limit: int | None,
    offset: int,
) -> dict[str, Any]:
    sliced_rows = _slice_local_ledger_rows(rows, limit=limit, offset=offset)
    transactions = [normalized for row in sliced_rows if (normalized := _normalize_local_ledger_transaction_row(row)) is not None]
    return {
        "generated_at": _iso_utc_now(),
        **meta,
        "loaded_count": len(transactions),
        "offset": max(offset, 0),
        "limit": limit,
        "has_more": max(offset, 0) + len(sliced_rows) < len(rows),
        "transactions": transactions,
    }


def _read_json(path: Path) -> Any:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        temp_path = Path(handle.name)
    temp_path.replace(path)


def _coerce_tags(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        raw_values = value
    else:
        raw_values = [value]
    tags: list[str] = []
    for item in raw_values:
        tag = str(item or "").strip()
        if tag:
            tags.append(tag)
    return tags


def _to_date_string(value: Any) -> str | None:
    if value in (None, ""):
        return None
    try:
        return _parse_spiir_date(str(value)).strftime("%Y-%m-%d")
    except ValueError:
        return None


def _amount_value(value: Any) -> float:
    return float(Decimal(str(value or 0)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _split_group_id(entry: dict[str, Any]) -> str | None:
    value = str(entry.get("SplitGroupId") or "").strip()
    return value or None


def _build_split_groups(entries: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for entry in entries:
        group_id = _split_group_id(entry)
        if not group_id:
            continue
        groups.setdefault(group_id, []).append(entry)
    return groups


def _raw_split_children(split_groups: dict[str, list[dict[str, Any]]], group_id: str | None) -> list[dict[str, Any]]:
    if not group_id:
        return []
    children = [member for member in split_groups.get(group_id) or [] if str(member.get("Id") or "") != group_id]
    return sorted(children, key=lambda item: str(item.get("Id") or ""))


def _is_raw_split_parent_shell(entry: dict[str, Any], split_groups: dict[str, list[dict[str, Any]]]) -> bool:
    source_id = str(entry.get("Id") or "")
    group_id = _split_group_id(entry)
    return bool(group_id and group_id == source_id and _raw_split_children(split_groups, group_id))


def _canonical_spiir_split_group_id(group_id: str) -> str:
    return f"spiir-split:{group_id}"


def _raw_split_line_index(entry: dict[str, Any], split_groups: dict[str, list[dict[str, Any]]]) -> int | None:
    source_id = str(entry.get("Id") or "")
    group_id = _split_group_id(entry)
    if not group_id or group_id == source_id:
        return None
    for index, child in enumerate(_raw_split_children(split_groups, group_id)):
        if str(child.get("Id") or "") == source_id:
            return index
    return None


def _skip_reasons(entry: dict[str, Any], original_date: str | None) -> list[str]:
    reasons: list[str] = []
    if SKIP_IS_EXTRAORDINARY and entry.get("IsExtraordinary"):
        reasons.append("extraordinary")
    if entry.get("MainCategoryName") in SKIP_MAIN_CATEGORY_NAMES:
        reasons.append("vis_ikke")
    if entry.get("AccountName") in SKIP_ACCOUNT_NAMES:
        reasons.append("andelsboliglaan")
    if original_date and original_date[:4] in SKIP_YEAR_STRINGS:
        reasons.append("year_2011")
    return reasons


def _normalize_spiir_row(
    entry: dict[str, Any],
    now: str,
    split_groups: dict[str, list[dict[str, Any]]],
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    source_id = str(entry.get("Id") or "")
    split_group_id = _split_group_id(entry)
    original_date = _to_date_string(entry.get("Date"))
    effective_date = _to_date_string(entry.get("CustomDate")) or original_date
    current_overview_skip_reasons = _skip_reasons(entry, original_date)
    raw_tags = _coerce_tags(entry.get("Tags"))
    main_category_name = entry.get("MainCategoryName") or UNCATEGORIZED_MAIN_CATEGORY_NAME
    normalized_main_category_name = RENAME_MAIN_CATEGORY_NAME.get(main_category_name, main_category_name)
    split_line_index = _raw_split_line_index(entry, split_groups)
    canonical_split_group_id = _canonical_spiir_split_group_id(split_group_id) if split_line_index is not None and split_group_id else None
    return {
        "id": f"spiir:{source_id}",
        "source": "spiir",
        "source_id": source_id,
        "source_account_id": str(entry.get("AccountId") or ""),
        "source_account_name": str(entry.get("AccountName") or ""),
        "date": effective_date,
        "original_date": original_date,
        "amount": _amount_value(entry.get("Amount")),
        "currency": "DKK",
        "description": str(entry.get("Description") or ""),
        "original_description": str(entry.get("OriginalDescription") or entry.get("Description") or ""),
        "counterparty": None,
        "comment": str(entry.get("Comment") or ""),
        "hashtags": _extract_hashtags(entry.get("Comment")),
        "raw_tags": raw_tags,
        "category_type": str(entry.get("CategoryType") or "Expense"),
        "main_category_id": str(entry.get("MainCategoryId") or UNCATEGORIZED_MAIN_CATEGORY_ID),
        "main_category_name": str(normalized_main_category_name),
        "category_id": str(entry.get("CategoryId") or UNCATEGORIZED_CATEGORY_ID),
        "category_name": str(entry.get("CategoryName") or UNCATEGORIZED_CATEGORY_NAME),
        "is_extraordinary": bool(entry.get("IsExtraordinary")),
        "is_excluded": entry.get("MainCategoryName") in SKIP_MAIN_CATEGORY_NAMES,
        "splits": [],
        "split_group_id": canonical_split_group_id,
        "split_line_id": f"spiir:{source_id}" if canonical_split_group_id else None,
        "split_original_parent_id": f"spiir:{split_group_id}" if canonical_split_group_id else None,
        "split_line_index": split_line_index,
        "category_source": "spiir_import",
        "category_reason": None,
        "category_confidence": None,
        "matched_source_ids": [],
        "pending_review": bool((existing or {}).get("pending_review", False)),
        "created_at": (existing or {}).get("created_at") or now,
        "updated_at": now,
        "provenance": {
            "imported_from": "spiir_raw_export",
            "raw_main_category_name": entry.get("MainCategoryName"),
            "raw_category_name": entry.get("CategoryName"),
            "raw_tags": raw_tags,
            "raw_split_group_id": split_group_id,
            "canonical_split": bool(canonical_split_group_id),
            "canonical_split_source": "spiir_import" if canonical_split_group_id else None,
            "split_parent_source_id": split_group_id if canonical_split_group_id else None,
            "current_overview_skip_reasons": current_overview_skip_reasons,
        },
    }


def _cutover_date() -> str:
    value = str(get_runtime_settings().spiir.cutover_date or "2026-05-02").strip()
    try:
        dt.datetime.strptime(value, "%Y-%m-%d")
    except ValueError as exc:
        raise ValueError(f"Invalid SPIIR_CUTOVER_DATE: {value}") from exc
    return value


def _normalize_nordea_row(now: str, transaction: dict[str, Any], existing: dict[str, Any] | None = None) -> dict[str, Any]:
    source_id = str(transaction.get("id") or "").strip()
    original_date = str(transaction.get("original_booking_date") or transaction.get("booking_date") or "").strip() or None
    effective_date = str(transaction.get("custom_booking_date") or transaction.get("booking_date") or original_date or "").strip() or None
    category = _sanitize_category(
        {
            "categoryType": transaction.get("categoryType"),
            "mainCategoryId": transaction.get("mainCategoryId"),
            "mainCategoryName": transaction.get("mainCategoryName"),
            "categoryId": transaction.get("categoryId"),
            "categoryName": transaction.get("categoryName"),
        }
    ) or {
        "categoryType": "Expense",
        "mainCategoryId": UNCATEGORIZED_MAIN_CATEGORY_ID,
        "mainCategoryName": UNCATEGORIZED_MAIN_CATEGORY_NAME,
        "categoryId": UNCATEGORIZED_CATEGORY_ID,
        "categoryName": UNCATEGORIZED_CATEGORY_NAME,
    }
    splits = [split for item in transaction.get("splits") or [] if (split := _sanitize_split(item)) is not None]
    return {
        "id": f"nordea:{source_id}",
        "source": "nordea",
        "source_id": source_id,
        "source_account_id": str(transaction.get("account_iban") or transaction.get("account_name") or ""),
        "source_account_name": str(transaction.get("account_name") or ""),
        "date": effective_date,
        "original_date": original_date,
        "amount": _amount_value(transaction.get("amount")),
        "currency": str(transaction.get("currency") or "DKK"),
        "description": str(transaction.get("description") or ""),
        "original_description": str(transaction.get("remittance_information") or transaction.get("description") or ""),
        "counterparty": str(transaction.get("creditor_name") or transaction.get("debtor_name") or "") or None,
        "comment": str(transaction.get("note") or ""),
        "hashtags": [str(item).strip() for item in transaction.get("hashtags") or [] if str(item).strip()],
        "raw_tags": [],
        "category_type": category["categoryType"],
        "main_category_id": str(category.get("mainCategoryId") or UNCATEGORIZED_MAIN_CATEGORY_ID),
        "main_category_name": str(RENAME_MAIN_CATEGORY_NAME.get(category.get("mainCategoryName"), category.get("mainCategoryName")) or UNCATEGORIZED_MAIN_CATEGORY_NAME),
        "category_id": str(category.get("categoryId") or UNCATEGORIZED_CATEGORY_ID),
        "category_name": str(category.get("categoryName") or UNCATEGORIZED_CATEGORY_NAME),
        "is_extraordinary": bool(transaction.get("is_extraordinary")),
        "is_excluded": str(category.get("mainCategoryName") or "") in SKIP_MAIN_CATEGORY_NAMES,
        "splits": splits,
        "category_source": "nordea_sync",
        "category_reason": None,
        "category_confidence": None,
        "matched_source_ids": [],
        "pending_review": True if existing is None else bool((existing or {}).get("pending_review", False)),
        "created_at": (existing or {}).get("created_at") or now,
        "updated_at": now,
        "provenance": {
            "imported_from": "nordea_processed_transactions",
            "nordea_transaction_id": source_id,
            "cutover_date": _cutover_date(),
        },
    }


def _normalize_lookup_text(*values: Any) -> str:
    raw = " ".join(str(value or "") for value in values).lower().replace("&", " og ")
    tokens = [
        token
        for token in NON_LETTER_RE.sub(" ", raw).split()
        if len(token) >= 3 and token not in STOP_WORDS
    ]
    unique_tokens = list(dict.fromkeys(tokens))
    return " ".join(unique_tokens)


def _ledger_lookup_key(row: dict[str, Any]) -> str:
    return _normalize_lookup_text(
        row.get("description"),
        row.get("original_description"),
        row.get("counterparty"),
        row.get("comment"),
    )


def _nordea_lookup_key(transaction: dict[str, Any]) -> str:
    return _normalize_lookup_text(
        transaction.get("description"),
        transaction.get("remittance_information"),
        transaction.get("creditor_name"),
        transaction.get("debtor_name"),
    )


def _is_uncategorized_category(main_category_id: Any, category_id: Any) -> bool:
    return str(main_category_id or "") == str(UNCATEGORIZED_MAIN_CATEGORY_ID) or str(category_id or "") == str(UNCATEGORIZED_CATEGORY_ID)


def _ledger_category_payload(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "categoryType": str(row.get("category_type") or "Expense"),
        "mainCategoryId": str(row.get("main_category_id") or UNCATEGORIZED_MAIN_CATEGORY_ID),
        "mainCategoryName": str(row.get("main_category_name") or UNCATEGORIZED_MAIN_CATEGORY_NAME),
        "categoryId": str(row.get("category_id") or UNCATEGORIZED_CATEGORY_ID),
        "categoryName": str(row.get("category_name") or UNCATEGORIZED_CATEGORY_NAME),
    }


def _suggest_categories_from_ledger(
    *,
    ledger_rows: list[dict[str, Any]],
    candidate_transactions: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    votes_by_key: dict[str, dict[str, int]] = {}
    categories_by_key: dict[str, dict[str, Any]] = {}

    for row in ledger_rows:
        if str(row.get("source") or "") not in {"spiir", "nordea"}:
            continue
        if bool(row.get("pending_review")):
            continue
        if _is_uncategorized_category(row.get("main_category_id"), row.get("category_id")):
            continue
        if row.get("splits"):
            continue
        lookup_key = _ledger_lookup_key(row)
        if not lookup_key:
            continue
        category = _ledger_category_payload(row)
        category_key = f"{category['mainCategoryId']}|{category['categoryId']}"
        categories_by_key[category_key] = category
        votes_by_key.setdefault(lookup_key, {})
        votes_by_key[lookup_key][category_key] = votes_by_key[lookup_key].get(category_key, 0) + 1

    suggestions: dict[str, dict[str, Any]] = {}
    for transaction in candidate_transactions:
        if not _is_uncategorized_category(transaction.get("mainCategoryId"), transaction.get("categoryId")):
            continue
        lookup_key = _nordea_lookup_key(transaction)
        if not lookup_key:
            continue
        votes = votes_by_key.get(lookup_key) or {}
        if not votes:
            continue
        total = sum(votes.values())
        top_category_key, top_support = max(votes.items(), key=lambda item: item[1])
        confidence = top_support / total if total > 0 else 0.0
        if top_support < MIN_LEDGER_AUTOCATEGORY_SUPPORT or confidence < MIN_LEDGER_AUTOCATEGORY_CONFIDENCE:
            continue
        category = categories_by_key.get(top_category_key)
        if not category:
            continue
        transaction_id = str(transaction.get("id") or "").strip()
        if transaction_id:
            suggestions[transaction_id] = category
    return suggestions


def _load_raw_entries() -> list[dict[str, Any]]:
    raw_file = get_spiir_raw_export_file()
    if not raw_file.exists():
        raise FileNotFoundError(f"Missing Spiir raw export: {raw_file}")
    payload = _read_json(raw_file)
    return [entry for entry in payload if isinstance(entry, dict)]


def _load_local_ledger_overrides() -> dict[str, dict[str, Any]]:
    return load_local_ledger_overrides(
        read_json=_read_json,
        overrides_file=get_spiir_local_overrides_file(),
    )


def _apply_local_ledger_overrides(row: dict[str, Any], overrides_by_id: dict[str, dict[str, Any]]) -> dict[str, Any]:
    return apply_local_ledger_override(row, overrides_by_id, mark_provenance=True)


def _load_existing_transactions(*, apply_overrides: bool = True) -> list[dict[str, Any]]:
    payload = _read_json(get_spiir_local_transactions_file())
    if not isinstance(payload, list):
        return []
    rows = [item for item in payload if isinstance(item, dict)]
    if not apply_overrides:
        return rows
    overrides_by_id = _load_local_ledger_overrides()
    if not overrides_by_id:
        return rows
    return [_apply_local_ledger_overrides(row, overrides_by_id) for row in rows]


def _load_transaction_index() -> dict[str, dict[str, Any]]:
    cache_key = _local_ledger_transaction_index_cache_key()
    cached_rows_by_id = _LOCAL_LEDGER_TRANSACTION_INDEX_CACHE.get("rows_by_id")
    if _LOCAL_LEDGER_TRANSACTION_INDEX_CACHE.get("key") == cache_key and isinstance(cached_rows_by_id, dict):
        return cached_rows_by_id

    payload = _read_json(get_spiir_local_transactions_file())
    rows_by_id: dict[str, dict[str, Any]] = {}
    if isinstance(payload, list):
        for item in payload:
            row_id = str(item.get("id") or "") if isinstance(item, dict) else ""
            if row_id.strip():
                rows_by_id[row_id] = item
    _LOCAL_LEDGER_TRANSACTION_INDEX_CACHE["key"] = cache_key
    _LOCAL_LEDGER_TRANSACTION_INDEX_CACHE["rows_by_id"] = rows_by_id
    return rows_by_id


def _load_import_runs() -> list[dict[str, Any]]:
    payload = _read_json(get_spiir_local_import_runs_file())
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    return []


def _sorted_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(rows, key=lambda item: (str(item.get("date") or ""), str(item.get("id") or "")))


def _normalize_local_ledger_transaction_row(row: dict[str, Any]) -> dict[str, Any] | None:
    if str(row.get("source") or "") not in {"spiir", "nordea"}:
        return None
    splits = []
    for split in row.get("splits") or []:
        category = split.get("category") or {}
        splits.append(
            {
                "id": str(split.get("id") or ""),
                "amount": float(split.get("amount") or 0),
                "note": str(split.get("note") or ""),
                "category": {
                    "mainCategoryId": category.get("mainCategoryId") or row.get("main_category_id") or UNCATEGORIZED_MAIN_CATEGORY_ID,
                    "mainCategoryName": category.get("mainCategoryName") or row.get("main_category_name") or UNCATEGORIZED_MAIN_CATEGORY_NAME,
                    "categoryId": category.get("categoryId") or row.get("category_id") or UNCATEGORIZED_CATEGORY_ID,
                    "categoryName": category.get("categoryName") or row.get("category_name") or UNCATEGORIZED_CATEGORY_NAME,
                    "categoryType": category.get("categoryType") or row.get("category_type") or "Expense",
                    "usage_count": int(category.get("usage_count") or 0),
                },
            }
        )

    return {
        "id": str(row.get("id") or ""),
        "entry_reference": str(row.get("source_id") or row.get("id") or ""),
        "booking_date": str(row.get("date") or ""),
        "original_booking_date": str(row.get("original_date") or row.get("date") or ""),
        "amount": float(row.get("amount") or 0),
        "currency": str(row.get("currency") or "DKK"),
        "description": str(row.get("description") or ""),
        "remittance_information": str(row.get("original_description") or ""),
        "creditor_name": str(row.get("counterparty") or ""),
        "debtor_name": "",
        "bank_transaction_code": None,
        "account_iban": None,
        "account_name": str(row.get("source_account_name") or ""),
        "categoryType": str(row.get("category_type") or "Expense"),
        "mainCategoryId": row.get("main_category_id") or UNCATEGORIZED_MAIN_CATEGORY_ID,
        "mainCategoryName": row.get("main_category_name") or UNCATEGORIZED_MAIN_CATEGORY_NAME,
        "categoryId": row.get("category_id") or UNCATEGORIZED_CATEGORY_ID,
        "categoryName": row.get("category_name") or UNCATEGORIZED_CATEGORY_NAME,
        "note": str(row.get("comment") or ""),
        "hashtags": [str(item) for item in row.get("hashtags") or [] if str(item).strip()],
        "is_extraordinary": bool(row.get("is_extraordinary")),
        "pending_review": bool(row.get("pending_review")),
        "custom_booking_date": str(row.get("date") or ""),
        "splits": splits,
        "split_group_id": row.get("split_group_id"),
        "split_line_id": row.get("split_line_id"),
        "split_original_parent_id": row.get("split_original_parent_id"),
        "split_line_index": row.get("split_line_index"),
        "source": f"{str(row.get('source') or 'local')}-local-ledger",
    }


def _apply_hashtag_text_patch_to_splits(
    splits: Any,
    *,
    append_hashtags: list[str] | None = None,
    remove_hashtags: list[str] | set[str] | None = None,
) -> list[dict[str, Any]]:
    if not isinstance(splits, list):
        return []
    append_tags = _normalize_hashtags(append_hashtags or [])
    remove_tags = _normalize_hashtags(remove_hashtags or [])
    next_splits = []
    for split in splits:
        if not isinstance(split, dict):
            continue
        next_split = dict(split)
        note = str(next_split.get("note") or "")
        if remove_tags:
            note = _remove_hashtags_from_comment(note, remove_tags)
        if append_tags and len(splits) == 1:
            note = _append_hashtags_to_comment(note, append_tags)
        next_split["note"] = note
        next_splits.append(next_split)
    return next_splits


def _refresh_local_ledger_transactions_cache_after_override_save(
    previous_cache_key: tuple[tuple[int | None, int | None], tuple[int | None, int | None]],
    updated_rows_by_id: dict[str, dict[str, Any]],
) -> bool:
    cached_rows = _LOCAL_LEDGER_TRANSACTIONS_CACHE.get("rows")
    cached_meta = _LOCAL_LEDGER_TRANSACTIONS_CACHE.get("meta")
    if _LOCAL_LEDGER_TRANSACTIONS_CACHE.get("key") != previous_cache_key or not isinstance(cached_rows, list) or not isinstance(cached_meta, dict):
        return False

    next_rows = _sort_local_ledger_rows_desc([
        updated_rows_by_id.get(str(row.get("id") or ""), row)
        for row in cached_rows
        if isinstance(row, dict)
    ])
    next_meta = _build_local_ledger_transactions_meta(next_rows)
    _LOCAL_LEDGER_TRANSACTIONS_CACHE["key"] = _local_ledger_transactions_cache_key()
    _LOCAL_LEDGER_TRANSACTIONS_CACHE["rows"] = next_rows
    _LOCAL_LEDGER_TRANSACTIONS_CACHE["meta"] = next_meta
    _LOCAL_LEDGER_TRANSACTIONS_CACHE["full_payload"] = None
    payload = _build_local_ledger_transactions_response(next_rows, next_meta, limit=LOCAL_LEDGER_FIRST_PAGE_CACHE_LIMIT, offset=0)
    _write_local_ledger_first_page_cache(LOCAL_LEDGER_FIRST_PAGE_CACHE_LIMIT, payload)
    return True


def _refresh_local_ledger_first_page_file_cache_after_override_save(
    previous_response: dict[str, Any] | None,
    updated_transactions: list[dict[str, Any]],
) -> None:
    if not isinstance(previous_response, dict):
        return
    previous_transactions = previous_response.get("transactions")
    if not isinstance(previous_transactions, list):
        return

    updated_by_id = {str(transaction.get("id") or ""): transaction for transaction in updated_transactions}
    pending_review_count = int(previous_response.get("pending_review_count") or 0)
    next_transactions = []
    for transaction in previous_transactions:
        if not isinstance(transaction, dict):
            continue
        transaction_id = str(transaction.get("id") or "")
        updated = updated_by_id.get(transaction_id)
        if updated is not None:
            if bool(transaction.get("pending_review")) != bool(updated.get("pending_review")):
                pending_review_count += 1 if bool(updated.get("pending_review")) else -1
            next_transactions.append(updated)
        else:
            next_transactions.append(transaction)

    next_transactions.sort(key=lambda item: (str(item.get("booking_date") or ""), str(item.get("entry_reference") or "")), reverse=True)
    next_response = dict(previous_response)
    next_response["generated_at"] = _iso_utc_now()
    next_response["pending_review_count"] = max(0, pending_review_count)
    next_response["loaded_count"] = len(next_transactions)
    next_response["transactions"] = next_transactions
    _write_local_ledger_first_page_cache(LOCAL_LEDGER_FIRST_PAGE_CACHE_LIMIT, next_response)


def _row_changed(existing: dict[str, Any] | None, candidate: dict[str, Any]) -> bool:
    if existing is None:
        return True
    compare_existing = dict(existing)
    compare_candidate = dict(candidate)
    compare_existing.pop("created_at", None)
    compare_existing.pop("updated_at", None)
    compare_candidate.pop("created_at", None)
    compare_candidate.pop("updated_at", None)
    return compare_existing != compare_candidate


def _is_canonical_split_row(row: dict[str, Any]) -> bool:
    return bool(str(row.get("split_group_id") or "").strip() and str(row.get("split_line_id") or "").strip())


def _split_fragment_issues(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows_by_id = {str(row.get("id") or ""): row for row in rows if str(row.get("id") or "").strip()}
    grouped_rows: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in rows:
        group_id = str(row.get("split_group_id") or "").strip()
        parent_id = str(row.get("split_original_parent_id") or "").strip()
        if not group_id or not parent_id:
            continue
        parent = rows_by_id.get(parent_id)
        if parent is None:
            continue
        parent_group_id = str(parent.get("split_group_id") or "").strip()
        if parent_group_id == group_id:
            continue
        grouped_rows.setdefault((parent_id, group_id), []).append(row)

    issues: list[dict[str, Any]] = []
    for (parent_id, group_id), child_rows in sorted(grouped_rows.items()):
        parent = rows_by_id[parent_id]
        child_sum = _amount_total([row.get("amount") for row in child_rows if str(row.get("id") or "") != parent_id])
        parent_amount = _amount_decimal(parent.get("amount"))
        repaired_parent_amount = (parent_amount - child_sum).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        issues.append(
            {
                "parent_id": parent_id,
                "split_group_id": group_id,
                "parent_row": parent,
                "child_rows": sorted(child_rows, key=_split_row_sort_key),
                "parent_amount": parent_amount,
                "child_sum": child_sum,
                "repaired_parent_amount": repaired_parent_amount,
            }
        )
    return issues


def _split_fragment_issue_summary(issue: dict[str, Any]) -> dict[str, Any]:
    parent = issue["parent_row"]
    child_rows = issue["child_rows"]
    return {
        "parent_id": issue["parent_id"],
        "split_group_id": issue["split_group_id"],
        "parent_description": parent.get("description"),
        "parent_amount": float(issue["parent_amount"]),
        "child_count": len(child_rows),
        "child_sum": float(issue["child_sum"]),
        "repaired_parent_amount": float(issue["repaired_parent_amount"]),
        "child_ids": [str(row.get("id") or "") for row in child_rows],
    }


def _assert_no_split_fragments(rows: list[dict[str, Any]], context: str) -> None:
    issues = _split_fragment_issues(rows)
    if not issues:
        return
    sample = ", ".join(issue["parent_id"] for issue in issues[:5])
    raise ValueError(f"Split invariant violation during {context}: {len(issues)} fragmented split group(s): {sample}")


def _repair_split_fragments(rows: list[dict[str, Any]], now: str) -> dict[str, Any]:
    issues = _split_fragment_issues(rows)
    parent_counts: dict[str, int] = {}
    for issue in issues:
        parent_id = str(issue["parent_id"])
        parent_counts[parent_id] = parent_counts.get(parent_id, 0) + 1
    ambiguous_parent_ids = sorted(parent_id for parent_id, count in parent_counts.items() if count > 1)
    if ambiguous_parent_ids:
        raise ValueError(f"Cannot repair ambiguous split fragments: {', '.join(ambiguous_parent_ids)}")

    rows_by_id = {str(row.get("id") or ""): dict(row) for row in rows if str(row.get("id") or "").strip()}
    for issue in issues:
        parent_id = str(issue["parent_id"])
        parent = dict(rows_by_id[parent_id])
        parent["amount"] = float(issue["repaired_parent_amount"])
        parent["split_group_id"] = issue["split_group_id"]
        parent["split_line_id"] = parent_id
        parent["split_original_parent_id"] = parent_id
        parent["split_line_index"] = 0
        parent["updated_at"] = now
        provenance = dict(parent.get("provenance") or {})
        provenance["canonical_split"] = True
        provenance["canonical_split_source"] = provenance.get("canonical_split_source") or "manual"
        provenance["split_repaired_at"] = now
        provenance["split_repair_source"] = "fragmented_parent_restore"
        provenance["split_original_parent_id"] = parent_id
        provenance["split_parent_amount"] = float(issue["parent_amount"])
        provenance["split_parent_description"] = parent.get("description")
        provenance["split_parent_source_id"] = parent.get("source_id")
        parent["provenance"] = provenance
        rows_by_id[parent_id] = parent

    repaired_rows = _sorted_rows(list(rows_by_id.values()))
    _assert_no_split_fragments(repaired_rows, "split_fragment_repair")
    return {
        "rows": repaired_rows,
        "issues": issues,
    }


def _preserve_reviewed_provenance(existing: dict[str, Any], candidate: dict[str, Any]) -> None:
    existing_provenance = existing.get("provenance")
    if not isinstance(existing_provenance, dict):
        return
    candidate_provenance = candidate.get("provenance")
    if not isinstance(candidate_provenance, dict):
        candidate_provenance = {}
    if existing_provenance.get("edited_in_local_ledger"):
        candidate_provenance["edited_in_local_ledger"] = True
    if _is_canonical_split_row(existing):
        for key in CANONICAL_SPLIT_PROVENANCE_KEYS:
            if key in existing_provenance:
                candidate_provenance[key] = existing_provenance[key]
    candidate["provenance"] = candidate_provenance


def _preserve_reviewed_local_fields(existing: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    """Keep local reviewed/edit fields when refreshing an existing non-pending Nordea row."""
    next_candidate = dict(candidate)
    preserved_keys = [
        "category_type",
        "main_category_id",
        "main_category_name",
        "category_id",
        "category_name",
        "comment",
        "hashtags",
        "is_extraordinary",
        "splits",
        "category_source",
        "category_reason",
        "category_confidence",
    ]
    for key in preserved_keys:
        next_candidate[key] = existing.get(key)
    if _is_canonical_split_row(existing):
        for key in CANONICAL_SPLIT_ROW_KEYS:
            next_candidate[key] = existing.get(key)
    next_candidate["is_excluded"] = str(next_candidate.get("main_category_name") or "") in SKIP_MAIN_CATEGORY_NAMES
    _preserve_reviewed_provenance(existing, next_candidate)
    return next_candidate


def preview_spiir_local_ledger_import(sample_limit: int = 25) -> dict[str, Any]:
    ensure_runtime_dirs()
    now = _iso_utc_now()
    raw_entries = _load_raw_entries()
    split_groups = _build_split_groups(raw_entries)
    existing_transactions = _load_existing_transactions()
    existing_by_id = {str(item.get("id") or ""): item for item in existing_transactions}

    preview_rows: list[dict[str, Any]] = []
    would_create_count = 0
    would_update_count = 0
    visible_count = 0
    skip_reason_counts = {"extraordinary": 0, "vis_ikke": 0, "andelsboliglaan": 0, "year_2011": 0}

    for entry in raw_entries:
        if _is_raw_split_parent_shell(entry, split_groups):
            continue
        source_id = str(entry.get("Id") or "")
        candidate = _normalize_spiir_row(
            entry,
            now=now,
            split_groups=split_groups,
            existing=existing_by_id.get(f"spiir:{source_id}"),
        )
        preview_rows.append(candidate)
        if candidate["id"] not in existing_by_id:
            would_create_count += 1
        elif _row_changed(existing_by_id.get(candidate["id"]), candidate):
            would_update_count += 1
        reasons = list(candidate["provenance"]["current_overview_skip_reasons"])
        if not reasons:
            visible_count += 1
        for reason in reasons:
            skip_reason_counts[reason] += 1

    sorted_rows = _sorted_rows(preview_rows)
    sample_rows = [
        {
            "id": item["id"],
            "date": item["date"],
            "original_date": item["original_date"],
            "amount": item["amount"],
            "description": item["description"],
            "main_category_name": item["main_category_name"],
            "category_name": item["category_name"],
            "hashtags": item["hashtags"],
            "raw_tags": item["raw_tags"],
            "is_excluded": item["is_excluded"],
            "current_overview_skip_reasons": item["provenance"]["current_overview_skip_reasons"],
        }
        for item in sorted_rows[:sample_limit]
    ]
    return {
        "generated_at": now,
        "source_row_count": len(raw_entries),
        "existing_row_count": len(existing_transactions),
        "preview_row_count": len(sorted_rows),
        "would_create_count": would_create_count,
        "would_update_count": would_update_count,
        "visible_under_current_overview_count": visible_count,
        "skip_reason_counts": skip_reason_counts,
        "sample_rows": sample_rows,
        "transactions_path": str(get_spiir_local_transactions_file()),
        "import_runs_path": str(get_spiir_local_import_runs_file()),
    }


def apply_spiir_local_ledger_import() -> dict[str, Any]:
    ensure_runtime_dirs()
    now = _iso_utc_now()
    raw_entries = _load_raw_entries()
    split_groups = _build_split_groups(raw_entries)
    existing_transactions = _load_existing_transactions()
    existing_by_id = {str(item.get("id") or ""): item for item in existing_transactions}

    merged_by_id = dict(existing_by_id)
    created_count = 0
    updated_count = 0
    visible_count = 0
    skip_reason_counts = {"extraordinary": 0, "vis_ikke": 0, "andelsboliglaan": 0, "year_2011": 0}

    for entry in raw_entries:
        if _is_raw_split_parent_shell(entry, split_groups):
            continue
        source_id = str(entry.get("Id") or "")
        candidate = _normalize_spiir_row(
            entry,
            now=now,
            split_groups=split_groups,
            existing=existing_by_id.get(f"spiir:{source_id}"),
        )
        existing = existing_by_id.get(candidate["id"])
        if existing is None:
            created_count += 1
        elif _row_changed(existing, candidate):
            updated_count += 1
        else:
            candidate = existing
        merged_by_id[candidate["id"]] = candidate
        reasons = list(candidate.get("provenance", {}).get("current_overview_skip_reasons", []))
        if not reasons:
            visible_count += 1
        for reason in reasons:
            skip_reason_counts[reason] += 1

    transactions = _sorted_rows(list(merged_by_id.values()))
    _assert_no_split_fragments(transactions, "spiir_raw_import")
    transactions_file = get_spiir_local_transactions_file()
    import_runs_file = get_spiir_local_import_runs_file()
    create_backup(transactions_file)
    _write_json(transactions_file, transactions)

    import_runs = _load_import_runs()
    import_runs.append(
        {
            "id": len(import_runs) + 1,
            "type": "spiir_raw_import",
            "applied_at": now,
            "source_path": str(get_spiir_raw_export_file()),
            "source_row_count": len(raw_entries),
            "created_count": created_count,
            "updated_count": updated_count,
            "ledger_row_count": len(transactions),
            "visible_under_current_overview_count": visible_count,
            "skip_reason_counts": skip_reason_counts,
        }
    )
    create_backup(import_runs_file)
    _write_json(import_runs_file, import_runs)
    mark_spiir_rebuild_required("spiir_raw_import")
    warm_spiir_local_ledger_first_page_cache()

    return {
        "applied_at": now,
        "source_row_count": len(raw_entries),
        "created_count": created_count,
        "updated_count": updated_count,
        "ledger_row_count": len(transactions),
        "visible_under_current_overview_count": visible_count,
        "skip_reason_counts": skip_reason_counts,
        "transactions_path": str(transactions_file),
        "import_runs_path": str(import_runs_file),
        "import_run_count": len(import_runs),
    }


def load_spiir_local_ledger_transactions(limit: int | None = None, offset: int = 0) -> dict[str, Any]:
    ensure_runtime_dirs()
    if limit == LOCAL_LEDGER_FIRST_PAGE_CACHE_LIMIT and offset == 0:
        cached_page = _read_local_ledger_first_page_cache(limit)
        if cached_page is not None:
            return cached_page

    cache_key = _local_ledger_transactions_cache_key()
    cached_rows = _LOCAL_LEDGER_TRANSACTIONS_CACHE.get("rows")
    cached_meta = _LOCAL_LEDGER_TRANSACTIONS_CACHE.get("meta")
    if _LOCAL_LEDGER_TRANSACTIONS_CACHE.get("key") != cache_key or cached_rows is None or cached_meta is None:
        cached_rows = _sort_local_ledger_rows_desc(_load_existing_transactions())
        cached_meta = _build_local_ledger_transactions_meta(cached_rows)
        _LOCAL_LEDGER_TRANSACTIONS_CACHE["key"] = cache_key
        _LOCAL_LEDGER_TRANSACTIONS_CACHE["rows"] = cached_rows
        _LOCAL_LEDGER_TRANSACTIONS_CACHE["meta"] = cached_meta
        _LOCAL_LEDGER_TRANSACTIONS_CACHE["full_payload"] = None

    if limit is None and offset == 0:
        cached_full_payload = _LOCAL_LEDGER_TRANSACTIONS_CACHE.get("full_payload")
        if cached_full_payload is not None:
            payload = dict(cached_full_payload)
            payload["generated_at"] = _iso_utc_now()
            return payload
        payload = _build_local_ledger_transactions_response(cached_rows, cached_meta, limit=None, offset=0)
        _LOCAL_LEDGER_TRANSACTIONS_CACHE["full_payload"] = dict(payload)
        return payload

    payload = _build_local_ledger_transactions_response(cached_rows, cached_meta, limit=limit, offset=offset)
    if limit == LOCAL_LEDGER_FIRST_PAGE_CACHE_LIMIT and offset == 0:
        _write_local_ledger_first_page_cache(limit, payload)
    return payload


def warm_spiir_local_ledger_first_page_cache() -> None:
    _clear_local_ledger_transactions_memory_cache()
    load_spiir_local_ledger_transactions(limit=LOCAL_LEDGER_FIRST_PAGE_CACHE_LIMIT, offset=0)
    warm_nordea_taxonomy_cache()


def preview_nordea_sync_into_spiir_local_ledger() -> dict[str, Any]:
    ensure_runtime_dirs()
    now = _iso_utc_now()
    cutover_date = _cutover_date()
    nordea_transactions = [item for item in load_nordea_transactions().get("transactions", []) if isinstance(item, dict)]
    existing_transactions = _load_existing_transactions()
    existing_by_id = {str(item.get("id") or ""): item for item in existing_transactions}

    preview_rows: list[dict[str, Any]] = []
    would_create_count = 0
    would_update_count = 0
    skipped_before_cutover_count = 0
    skipped_missing_booking_date_count = 0

    for transaction in nordea_transactions:
        booking_date = str(transaction.get("booking_date") or "").strip()
        if not booking_date:
            skipped_missing_booking_date_count += 1
            continue
        if booking_date <= cutover_date:
            skipped_before_cutover_count += 1
            continue
        candidate = _normalize_nordea_row(now=now, transaction=transaction, existing=existing_by_id.get(f"nordea:{transaction.get('id') or ''}"))
        preview_rows.append(candidate)
        if candidate["id"] not in existing_by_id:
            would_create_count += 1
        elif _row_changed(existing_by_id.get(candidate["id"]), candidate):
            would_update_count += 1

    sorted_rows = _sorted_rows(preview_rows)
    return {
        "generated_at": now,
        "cutover_date": cutover_date,
        "source_row_count": len(nordea_transactions),
        "eligible_row_count": len(sorted_rows),
        "existing_row_count": len(existing_transactions),
        "would_create_count": would_create_count,
        "would_update_count": would_update_count,
        "skipped_before_cutover_count": skipped_before_cutover_count,
        "skipped_missing_booking_date_count": skipped_missing_booking_date_count,
        "sample_rows": [
            {
                "id": item["id"],
                "date": item["date"],
                "amount": item["amount"],
                "description": item["description"],
                "category_name": item["category_name"],
                "source_account_name": item["source_account_name"],
            }
            for item in sorted_rows[:25]
        ],
    }


def apply_nordea_sync_into_spiir_local_ledger() -> dict[str, Any]:
    ensure_runtime_dirs()
    now = _iso_utc_now()
    cutover_date = _cutover_date()
    existing_transactions = _load_existing_transactions()
    existing_by_id = {str(item.get("id") or ""): item for item in existing_transactions}
    raw_nordea_transactions = [item for item in load_nordea_transactions().get("transactions", []) if isinstance(item, dict)]
    eligible_new_transactions = [
        item
        for item in raw_nordea_transactions
        if str(item.get("booking_date") or "").strip() > cutover_date
        and f"nordea:{str(item.get('id') or '').strip()}" not in existing_by_id
    ]
    category_suggestions_by_transaction_id = _suggest_categories_from_ledger(
        ledger_rows=existing_transactions,
        candidate_transactions=eligible_new_transactions,
    )
    autocategorized_count = len(category_suggestions_by_transaction_id)
    nordea_transactions = raw_nordea_transactions
    merged_by_id = dict(existing_by_id)
    created_count = 0
    updated_count = 0
    skipped_before_cutover_count = 0
    skipped_missing_booking_date_count = 0

    for transaction in nordea_transactions:
        booking_date = str(transaction.get("booking_date") or "").strip()
        if not booking_date:
            skipped_missing_booking_date_count += 1
            continue
        if booking_date <= cutover_date:
            skipped_before_cutover_count += 1
            continue
        transaction_id = str(transaction.get("id") or "").strip()
        suggested_category = category_suggestions_by_transaction_id.get(transaction_id)
        candidate_source = dict(transaction)
        if suggested_category:
            candidate_source["categoryType"] = suggested_category.get("categoryType")
            candidate_source["mainCategoryId"] = suggested_category.get("mainCategoryId")
            candidate_source["mainCategoryName"] = suggested_category.get("mainCategoryName")
            candidate_source["categoryId"] = suggested_category.get("categoryId")
            candidate_source["categoryName"] = suggested_category.get("categoryName")
        candidate = _normalize_nordea_row(now=now, transaction=candidate_source, existing=existing_by_id.get(f"nordea:{transaction.get('id') or ''}"))
        existing = existing_by_id.get(candidate["id"])
        if existing is None:
            created_count += 1
        elif bool(existing.get("pending_review")):
            candidate = existing
        elif str(existing.get("source") or "") == "nordea":
            candidate = _preserve_reviewed_local_fields(existing, candidate)
            if _row_changed(existing, candidate):
                updated_count += 1
            else:
                candidate = existing
        else:
            if _row_changed(existing, candidate):
                updated_count += 1
            else:
                candidate = existing
        merged_by_id[candidate["id"]] = candidate

    transactions = _sorted_rows(list(merged_by_id.values()))
    _assert_no_split_fragments(transactions, "nordea_sync")
    transactions_file = get_spiir_local_transactions_file()
    import_runs_file = get_spiir_local_import_runs_file()
    create_backup(transactions_file)
    _write_json(transactions_file, transactions)

    import_runs = _load_import_runs()
    import_runs.append(
        {
            "id": len(import_runs) + 1,
            "type": "nordea_sync",
            "applied_at": now,
            "cutover_date": cutover_date,
            "source_row_count": len(nordea_transactions),
            "created_count": created_count,
            "updated_count": updated_count,
            "skipped_before_cutover_count": skipped_before_cutover_count,
            "skipped_missing_booking_date_count": skipped_missing_booking_date_count,
            "ledger_row_count": len(transactions),
        }
    )
    create_backup(import_runs_file)
    _write_json(import_runs_file, import_runs)
    if created_count > 0 or updated_count > 0 or autocategorized_count > 0:
        mark_spiir_rebuild_required("nordea_sync")
    warm_spiir_local_ledger_first_page_cache()

    return {
        "applied_at": now,
        "cutover_date": cutover_date,
        "source_row_count": len(nordea_transactions),
        "created_count": created_count,
        "updated_count": updated_count,
        "autocategorized_count": autocategorized_count,
        "pending_review_count": sum(1 for item in transactions if item.get("pending_review")),
        "skipped_before_cutover_count": skipped_before_cutover_count,
        "skipped_missing_booking_date_count": skipped_missing_booking_date_count,
        "ledger_row_count": len(transactions),
        "import_run_count": len(import_runs),
    }


def _amount_decimal(value: Any) -> Decimal:
    return Decimal(str(value or 0)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _amount_total(values: list[Any]) -> Decimal:
    total = sum((_amount_decimal(value) for value in values), Decimal("0.00"))
    return total.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _set_row_category(row: dict[str, Any], category: dict[str, Any], source: str) -> None:
    row["category_type"] = category.get("categoryType") or "Expense"
    row["main_category_id"] = category.get("mainCategoryId") or UNCATEGORIZED_MAIN_CATEGORY_ID
    row["main_category_name"] = category.get("mainCategoryName") or UNCATEGORIZED_MAIN_CATEGORY_NAME
    row["category_id"] = category.get("categoryId") or UNCATEGORIZED_CATEGORY_ID
    row["category_name"] = category.get("categoryName") or UNCATEGORIZED_CATEGORY_NAME
    row["is_excluded"] = row["main_category_name"] in SKIP_MAIN_CATEGORY_NAMES
    row["category_source"] = source
    row["category_reason"] = None
    row["category_confidence"] = None


def _row_category(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "categoryType": row.get("category_type") or "Expense",
        "mainCategoryId": row.get("main_category_id") or UNCATEGORIZED_MAIN_CATEGORY_ID,
        "mainCategoryName": row.get("main_category_name") or UNCATEGORIZED_MAIN_CATEGORY_NAME,
        "categoryId": row.get("category_id") or UNCATEGORIZED_CATEGORY_ID,
        "categoryName": row.get("category_name") or UNCATEGORIZED_CATEGORY_NAME,
    }


def _split_category(split: dict[str, Any], fallback_row: dict[str, Any]) -> dict[str, Any]:
    category = split.get("category") or {}
    return {
        "categoryType": category.get("categoryType") or fallback_row.get("category_type") or "Expense",
        "mainCategoryId": category.get("mainCategoryId") or fallback_row.get("main_category_id") or UNCATEGORIZED_MAIN_CATEGORY_ID,
        "mainCategoryName": category.get("mainCategoryName") or fallback_row.get("main_category_name") or UNCATEGORIZED_MAIN_CATEGORY_NAME,
        "categoryId": category.get("categoryId") or fallback_row.get("category_id") or UNCATEGORIZED_CATEGORY_ID,
        "categoryName": category.get("categoryName") or fallback_row.get("category_name") or UNCATEGORIZED_CATEGORY_NAME,
    }


def _clear_split_metadata(row: dict[str, Any]) -> None:
    row["splits"] = []
    row.pop("split_group_id", None)
    row.pop("split_line_id", None)
    row.pop("split_original_parent_id", None)
    row.pop("split_line_index", None)


def _manual_split_group_id(transaction_id: str) -> str:
    return f"manual-split:{transaction_id}"


def _canonical_split_row_id(parent_id: str, split_id: str, index: int) -> str:
    if index == 0:
        return parent_id
    clean_split_id = re.sub(r"[^A-Za-z0-9_.:-]+", "-", split_id.strip()) or str(index)
    return f"{parent_id}::split:{clean_split_id}"


def _split_row_sort_key(row: dict[str, Any]) -> tuple[int, str]:
    try:
        index = int(row.get("split_line_index"))
    except (TypeError, ValueError):
        index = 999999
    return (index, str(row.get("id") or ""))


def _group_rows_for_transaction(transactions_by_id: dict[str, dict[str, Any]], transaction_id: str) -> list[dict[str, Any]]:
    current = transactions_by_id.get(transaction_id)
    if current is None:
        return []
    group_id = str(current.get("split_group_id") or "").strip()
    if not group_id:
        return [current]
    rows = [row for row in transactions_by_id.values() if str(row.get("split_group_id") or "") == group_id]
    return sorted(rows, key=_split_row_sort_key)


def _materialize_split_line(
    base_row: dict[str, Any],
    split: dict[str, Any],
    *,
    row_id: str,
    group_id: str,
    original_parent_id: str,
    index: int,
    now: str,
    source: str,
) -> dict[str, Any]:
    row = dict(base_row)
    row["id"] = row_id
    if row_id != base_row.get("id"):
        row["source_id"] = f"{base_row.get('source_id') or base_row.get('id')}::split:{index}"
    row["amount"] = _amount_value(split.get("amount"))
    row["comment"] = str(split.get("note") or "")
    _set_row_category(row, _split_category(split, base_row), source)
    row["splits"] = []
    row["split_group_id"] = group_id
    row["split_line_id"] = row_id
    row["split_original_parent_id"] = original_parent_id
    row["split_line_index"] = index
    row["updated_at"] = now
    if index > 0:
        row["created_at"] = now
    provenance = dict(row.get("provenance") or {})
    provenance["canonical_split"] = True
    provenance["canonical_split_source"] = source
    provenance["split_migrated_at"] = now
    provenance["split_migration_source"] = "manual_override_split" if source == "manual" else source
    provenance["split_original_parent_id"] = original_parent_id
    provenance["split_parent_amount"] = base_row.get("amount")
    provenance["split_parent_description"] = base_row.get("description")
    provenance["split_parent_source_id"] = base_row.get("source_id")
    row["provenance"] = provenance
    return row


def _collapse_split_group(
    group_rows: list[dict[str, Any]],
    split: dict[str, Any] | None,
    *,
    keep_id: str,
    now: str,
    source: str,
) -> tuple[dict[str, Any], list[str]]:
    base_row = next((row for row in group_rows if str(row.get("id") or "") == keep_id), group_rows[0])
    row = dict(base_row)
    row["id"] = keep_id
    row["amount"] = float(_amount_total([item.get("amount") for item in group_rows]))
    if split is not None:
        row["comment"] = str(split.get("note") or "")
        _set_row_category(row, _split_category(split, base_row), source)
    _clear_split_metadata(row)
    row["updated_at"] = now
    provenance = dict(row.get("provenance") or {})
    provenance["canonical_split_collapsed"] = True
    row["provenance"] = provenance
    deleted_ids = [str(item.get("id") or "") for item in group_rows if str(item.get("id") or "") != keep_id]
    return row, deleted_ids


def _build_canonical_split_rows(
    group_rows: list[dict[str, Any]],
    splits: list[dict[str, Any]],
    *,
    keep_id: str,
    group_id: str,
    original_parent_id: str,
    now: str,
    source: str,
) -> tuple[list[dict[str, Any]], list[str]]:
    expected_total = _amount_total([row.get("amount") for row in group_rows])
    actual_total = _amount_total([split.get("amount") for split in splits])
    if abs(expected_total - actual_total) > Decimal("0.01"):
        raise ValueError(f"Split lines sum to {actual_total}, expected {expected_total}")

    base_row = next((row for row in group_rows if str(row.get("id") or "") == keep_id), group_rows[0])
    existing_ids = {str(row.get("id") or "") for row in group_rows}
    new_rows: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    for index, split in enumerate(splits):
        raw_split_id = str(split.get("id") or "").strip()
        row_id = raw_split_id if raw_split_id in existing_ids else _canonical_split_row_id(keep_id, raw_split_id, index)
        if row_id in used_ids:
            row_id = _canonical_split_row_id(keep_id, f"{raw_split_id}-{index}", index)
        used_ids.add(row_id)
        line_base = next((row for row in group_rows if str(row.get("id") or "") == row_id), base_row)
        new_rows.append(
            _materialize_split_line(
                line_base,
                split,
                row_id=row_id,
                group_id=group_id,
                original_parent_id=original_parent_id,
                index=index,
                now=now,
                source=source,
            )
        )
    deleted_ids = [str(item.get("id") or "") for item in group_rows if str(item.get("id") or "") not in used_ids]
    return new_rows, deleted_ids


def _legacy_split_parent(row: dict[str, Any]) -> bool:
    source_id = str(row.get("source_id") or "")
    raw_split_group_id = str((row.get("provenance") or {}).get("raw_split_group_id") or "")
    splits = row.get("splits") or []
    return str(row.get("source") or "") == "spiir" and bool(splits) and raw_split_group_id == source_id


def _build_split_canonicalization(
    rows: list[dict[str, Any]],
    overrides_by_id: dict[str, dict[str, Any]],
    *,
    now: str,
    sample_limit: int,
) -> dict[str, Any]:
    rows_by_id = {str(row.get("id") or ""): dict(row) for row in rows}
    new_overrides = {key: dict(value) for key, value in overrides_by_id.items()}
    parent_ids: set[str] = set()
    tagged_child_ids: set[str] = set()
    manual_source_ids: set[str] = set()
    materialized_rows_by_id: dict[str, dict[str, Any]] = {}
    deleted_ids: set[str] = set()
    samples: list[dict[str, Any]] = []

    for parent in rows:
        if not _legacy_split_parent(parent):
            continue
        parent_id = str(parent.get("id") or "")
        source_id = str(parent.get("source_id") or parent_id)
        group_id = _canonical_spiir_split_group_id(source_id)
        parent_ids.add(parent_id)
        deleted_ids.add(parent_id)
        for index, split in enumerate(parent.get("splits") or []):
            child_id = str(split.get("id") or "")
            child = rows_by_id.get(child_id)
            if child is None:
                continue
            next_child = dict(child)
            next_child["splits"] = []
            next_child["split_group_id"] = group_id
            next_child["split_line_id"] = child_id
            next_child["split_original_parent_id"] = parent_id
            next_child["split_line_index"] = index
            next_child["updated_at"] = now
            provenance = dict(next_child.get("provenance") or {})
            provenance["canonical_split"] = True
            provenance["canonical_split_source"] = "spiir_import"
            provenance["split_migrated_at"] = now
            provenance["split_migration_source"] = "legacy_spiir_split_group"
            provenance["split_original_parent_id"] = parent_id
            provenance["split_parent_amount"] = parent.get("amount")
            provenance["split_parent_description"] = parent.get("description")
            provenance["split_parent_source_id"] = parent.get("source_id")
            next_child["provenance"] = provenance
            rows_by_id[child_id] = next_child
            tagged_child_ids.add(child_id)
        if len(samples) < sample_limit:
            samples.append({"id": parent_id, "action": "remove_legacy_parent", "split_count": len(parent.get("splits") or [])})

    for transaction_id, override in overrides_by_id.items():
        raw_splits = override.get("splits")
        if raw_splits is None:
            continue
        splits = [split for item in raw_splits or [] if (split := _sanitize_split(item)) is not None]
        if not splits:
            continue
        base = rows_by_id.get(transaction_id)
        if base is None or transaction_id in parent_ids:
            continue
        effective_base = apply_local_ledger_override(base, {transaction_id: override}, mark_provenance=True)
        if len(splits) <= 1:
            collapsed, removed = _collapse_split_group([effective_base], splits[0] if splits else None, keep_id=transaction_id, now=now, source="manual")
            materialized_rows_by_id[transaction_id] = collapsed
            deleted_ids.update(removed)
        else:
            group_rows = _group_rows_for_transaction(rows_by_id, transaction_id)
            if not group_rows:
                group_rows = [effective_base]
            else:
                group_rows = [_apply_local_ledger_overrides(row, overrides_by_id) for row in group_rows]
            split_rows, removed = _build_canonical_split_rows(
                group_rows,
                splits,
                keep_id=transaction_id,
                group_id=_manual_split_group_id(transaction_id),
                original_parent_id=transaction_id,
                now=now,
                source="manual",
            )
            for row in split_rows:
                materialized_rows_by_id[str(row.get("id") or "")] = row
            deleted_ids.update(removed)
        manual_source_ids.add(transaction_id)
        new_overrides.pop(transaction_id, None)
        if len(samples) < sample_limit:
            samples.append({"id": transaction_id, "action": "materialize_manual_split", "split_count": len(splits)})

    final_rows: list[dict[str, Any]] = []
    for row in rows:
        row_id = str(row.get("id") or "")
        if row_id in parent_ids or row_id in deleted_ids:
            continue
        final_rows.append(materialized_rows_by_id.get(row_id) or rows_by_id.get(row_id) or row)

    existing_final_ids = {str(row.get("id") or "") for row in final_rows}
    for row_id, row in materialized_rows_by_id.items():
        if row_id not in existing_final_ids and row_id not in deleted_ids:
            final_rows.append(row)

    return {
        "rows": _sorted_rows(final_rows),
        "overrides": new_overrides,
        "legacy_parent_count": len(parent_ids),
        "legacy_child_count": len(tagged_child_ids),
        "manual_split_count": len(manual_source_ids),
        "created_split_row_count": max(0, len(materialized_rows_by_id) - len(manual_source_ids)),
        "deleted_transaction_ids": sorted(deleted_ids),
        "sample_rows": samples,
    }


def preview_spiir_local_ledger_split_canonicalization(sample_limit: int = 25) -> dict[str, Any]:
    ensure_runtime_dirs()
    now = _iso_utc_now()
    transactions = _load_existing_transactions(apply_overrides=False)
    overrides_by_id = _load_local_ledger_overrides()
    result = _build_split_canonicalization(transactions, overrides_by_id, now=now, sample_limit=sample_limit)
    return {
        "generated_at": now,
        "existing_row_count": len(transactions),
        "preview_row_count": len(result["rows"]),
        "legacy_parent_count": result["legacy_parent_count"],
        "legacy_child_count": result["legacy_child_count"],
        "manual_split_count": result["manual_split_count"],
        "created_split_row_count": result["created_split_row_count"],
        "deleted_transaction_ids": result["deleted_transaction_ids"],
        "sample_rows": result["sample_rows"],
        "transactions_path": str(get_spiir_local_transactions_file()),
        "overrides_path": str(get_spiir_local_overrides_file()),
    }


def apply_spiir_local_ledger_split_canonicalization() -> dict[str, Any]:
    ensure_runtime_dirs()
    now = _iso_utc_now()
    transactions = _load_existing_transactions(apply_overrides=False)
    overrides_by_id = _load_local_ledger_overrides()
    result = _build_split_canonicalization(transactions, overrides_by_id, now=now, sample_limit=25)
    _assert_no_split_fragments(result["rows"], "local_ledger_split_migration")

    transactions_file = get_spiir_local_transactions_file()
    overrides_file = get_spiir_local_overrides_file()
    create_backup(transactions_file)
    create_backup(overrides_file)
    _write_json(transactions_file, result["rows"])
    _write_json(overrides_file, result["overrides"])
    mark_spiir_rebuild_required("local_ledger_split_migration")

    return {
        "applied_at": now,
        "previous_row_count": len(transactions),
        "ledger_row_count": len(result["rows"]),
        "legacy_parent_count": result["legacy_parent_count"],
        "legacy_child_count": result["legacy_child_count"],
        "manual_split_count": result["manual_split_count"],
        "created_split_row_count": result["created_split_row_count"],
        "deleted_transaction_ids": result["deleted_transaction_ids"],
        "transactions_path": str(transactions_file),
        "overrides_path": str(overrides_file),
    }


def preview_spiir_local_ledger_split_fragment_repair(sample_limit: int = 25) -> dict[str, Any]:
    ensure_runtime_dirs()
    now = _iso_utc_now()
    transactions = _load_existing_transactions(apply_overrides=False)
    issues = _split_fragment_issues(transactions)
    return {
        "generated_at": now,
        "existing_row_count": len(transactions),
        "broken_group_count": len(issues),
        "sample_rows": [_split_fragment_issue_summary(issue) for issue in issues[:sample_limit]],
        "transactions_path": str(get_spiir_local_transactions_file()),
    }


def apply_spiir_local_ledger_split_fragment_repair() -> dict[str, Any]:
    ensure_runtime_dirs()
    now = _iso_utc_now()
    transactions = _load_existing_transactions(apply_overrides=False)
    result = _repair_split_fragments(transactions, now)
    issues = result["issues"]

    if issues:
        transactions_file = get_spiir_local_transactions_file()
        create_backup(transactions_file)
        _write_json(transactions_file, result["rows"])
        mark_spiir_rebuild_required("local_ledger_split_fragment_repair")
        warm_spiir_local_ledger_first_page_cache()

    return {
        "applied_at": now,
        "previous_row_count": len(transactions),
        "ledger_row_count": len(result["rows"]),
        "broken_group_count": len(issues),
        "repaired_group_count": len(issues),
        "sample_rows": [_split_fragment_issue_summary(issue) for issue in issues[:25]],
        "transactions_path": str(get_spiir_local_transactions_file()),
    }


def _save_canonical_splits(
    transaction_id: str,
    splits: list[dict[str, Any]],
    now: str,
    collapse_patch: dict[str, Any] | None = None,
) -> dict[str, Any]:
    transactions = _load_existing_transactions(apply_overrides=False)
    overrides_by_id = _load_local_ledger_overrides()
    transactions_by_id = {str(item.get("id") or ""): dict(item) for item in transactions}
    if transaction_id not in transactions_by_id:
        raise ValueError(f"Unknown local ledger transaction: {transaction_id}")

    group_rows = _group_rows_for_transaction(transactions_by_id, transaction_id)
    effective_group_rows = [_apply_local_ledger_overrides(row, overrides_by_id) for row in group_rows]
    keep_id = str(group_rows[0].get("id") or transaction_id) if group_rows else transaction_id
    if len(splits) <= 1:
        single_split = splits[0] if splits else None
        if single_split is None and collapse_patch:
            category = _sanitize_category(collapse_patch.get("category")) or _row_category(effective_group_rows[0])
            single_split = {
                "id": transaction_id,
                "amount": float(_amount_total([row.get("amount") for row in effective_group_rows])),
                "note": str(collapse_patch.get("note") if "note" in collapse_patch else effective_group_rows[0].get("comment") or ""),
                "category": category,
            }
        next_row, deleted_ids = _collapse_split_group(
            effective_group_rows,
            single_split,
            keep_id=keep_id,
            now=now,
            source="manual",
        )
        new_rows = [next_row]
    else:
        current = transactions_by_id[transaction_id]
        group_id = str(current.get("split_group_id") or "").strip() or _manual_split_group_id(transaction_id)
        original_parent_id = str(current.get("split_original_parent_id") or transaction_id)
        new_rows, deleted_ids = _build_canonical_split_rows(
            effective_group_rows,
            splits,
            keep_id=keep_id,
            group_id=group_id,
            original_parent_id=original_parent_id,
            now=now,
            source="manual",
        )

    for deleted_id in deleted_ids:
        transactions_by_id.pop(deleted_id, None)
        overrides_by_id.pop(deleted_id, None)
    for row in new_rows:
        row_id = str(row.get("id") or "")
        transactions_by_id[row_id] = row
        overrides_by_id.pop(row_id, None)

    transactions_file = get_spiir_local_transactions_file()
    overrides_file = get_spiir_local_overrides_file()
    transactions = _sorted_rows(list(transactions_by_id.values()))
    _assert_no_split_fragments(transactions, "local_ledger_split")
    create_backup(transactions_file)
    create_backup(overrides_file)
    _write_json(transactions_file, transactions)
    _write_json(overrides_file, overrides_by_id)

    updated_transactions = [
        normalized
        for row in new_rows
        if (normalized := _normalize_local_ledger_transaction_row(row)) is not None
    ]
    mark_spiir_rebuild_required("local_ledger_split")
    return {
        "updated_count": len(updated_transactions),
        "updated_at": now,
        "updated_transactions": updated_transactions,
        "deleted_transaction_ids": deleted_ids,
    }


def save_spiir_local_ledger_overrides(transaction_ids: list[str], patch: dict[str, Any]) -> dict[str, Any]:
    if not transaction_ids:
        raise ValueError("No local ledger transactions selected")

    now = _iso_utc_now()
    previous_transactions_cache_key = _local_ledger_transactions_cache_key()
    previous_first_page_response = _read_local_ledger_first_page_cache(LOCAL_LEDGER_FIRST_PAGE_CACHE_LIMIT)
    transactions_by_id = _load_transaction_index()
    overrides_by_id = _load_local_ledger_overrides()
    category = _sanitize_category(patch.get("category")) if "category" in patch else None
    sanitized_splits = None
    if "splits" in patch:
        sanitized_splits = [split for item in patch.get("splits") or [] if (split := _sanitize_split(item)) is not None]

    if sanitized_splits is not None:
        if len(transaction_ids) != 1:
            raise ValueError("Split edits must target one local ledger transaction")
        return _save_canonical_splits(transaction_ids[0], sanitized_splits, now, collapse_patch=patch)

    updated_rows_by_id: dict[str, dict[str, Any]] = {}
    for transaction_id in transaction_ids:
        base_row = transactions_by_id.get(transaction_id)
        if base_row is None:
            raise ValueError(f"Unknown local ledger transaction: {transaction_id}")
        current = _apply_local_ledger_overrides(dict(base_row), overrides_by_id)
        if "category" in patch:
            next_category = category or {
                "categoryType": "Expense",
                "mainCategoryId": UNCATEGORIZED_MAIN_CATEGORY_ID,
                "mainCategoryName": UNCATEGORIZED_MAIN_CATEGORY_NAME,
                "categoryId": UNCATEGORIZED_CATEGORY_ID,
                "categoryName": UNCATEGORIZED_CATEGORY_NAME,
            }
            current["category_type"] = next_category["categoryType"]
            current["main_category_id"] = next_category["mainCategoryId"] or UNCATEGORIZED_MAIN_CATEGORY_ID
            current["main_category_name"] = next_category["mainCategoryName"] or UNCATEGORIZED_MAIN_CATEGORY_NAME
            current["category_id"] = next_category["categoryId"] or UNCATEGORIZED_CATEGORY_ID
            current["category_name"] = next_category["categoryName"] or UNCATEGORIZED_CATEGORY_NAME
            current["is_excluded"] = current["main_category_name"] in SKIP_MAIN_CATEGORY_NAMES
            current["category_source"] = "manual"
            current["category_reason"] = None
            current["category_confidence"] = None
        if "booking_date" in patch:
            booking_date = str(patch.get("booking_date") or "").strip()
            current["date"] = booking_date or current.get("original_date")
        if "note" in patch:
            current["comment"] = str(patch.get("note") or "")
        if "hashtags" in patch:
            requested_hashtags = _normalize_hashtags(patch.get("hashtags"))
            current_split_hashtags = [
                tag
                for split in current.get("splits") or []
                if isinstance(split, dict)
                for tag in _extract_hashtags(split.get("note"))
            ]
            removed_hashtags = [
                tag
                for tag in _normalize_hashtags([*_normalize_hashtags(current.get("hashtags")), *_extract_hashtags(current.get("comment")), *current_split_hashtags])
                if tag not in requested_hashtags
            ]
            current["comment"] = _append_hashtags_to_comment(
                _remove_hashtags_from_comment(current.get("comment"), removed_hashtags),
                requested_hashtags,
            )
            current["splits"] = _apply_hashtag_text_patch_to_splits(
                current.get("splits"),
                append_hashtags=requested_hashtags,
                remove_hashtags=removed_hashtags,
            )
            current["hashtags"] = _normalize_hashtags([
                *_extract_hashtags(current.get("comment")),
                *(tag for split in current.get("splits") or [] for tag in _extract_hashtags(split.get("note") if isinstance(split, dict) else "")),
                *requested_hashtags,
            ])
        if "append_hashtags" in patch:
            append_hashtags = _normalize_hashtags(patch.get("append_hashtags"))
            current["comment"] = _append_hashtags_to_comment(current.get("comment"), append_hashtags)
            current["splits"] = _apply_hashtag_text_patch_to_splits(current.get("splits"), append_hashtags=append_hashtags)
            current["hashtags"] = _normalize_hashtags([*_normalize_hashtags(current.get("hashtags")), *_extract_hashtags(current.get("comment"))])
        if "remove_hashtags" in patch:
            removed_hashtags = _normalize_hashtags(patch.get("remove_hashtags"))
            removed_hashtag_set = set(removed_hashtags)
            current["comment"] = _remove_hashtags_from_comment(current.get("comment"), removed_hashtags)
            current["splits"] = _apply_hashtag_text_patch_to_splits(current.get("splits"), remove_hashtags=removed_hashtags)
            current["hashtags"] = [
                tag for tag in _normalize_hashtags([
                    *_normalize_hashtags(current.get("hashtags")),
                    *_extract_hashtags(current.get("comment")),
                    *(tag for split in current.get("splits") or [] for tag in _extract_hashtags(split.get("note") if isinstance(split, dict) else "")),
                ])
                if tag not in removed_hashtag_set
            ]
        if any(key in patch for key in ("note", "hashtags", "append_hashtags")):
            current["hashtags"] = _extract_hashtags(current.get("comment"))
        if "is_extraordinary" in patch:
            current["is_extraordinary"] = bool(patch.get("is_extraordinary"))
        if "pending_review" in patch:
            current["pending_review"] = bool(patch.get("pending_review"))
        if sanitized_splits is not None:
            current["splits"] = sanitized_splits

        provenance = dict(current.get("provenance") or {})
        provenance["edited_in_local_ledger"] = True
        current["provenance"] = provenance
        current["updated_at"] = now
        updated_rows_by_id[transaction_id] = current
        overrides_by_id[transaction_id] = {
            key: current.get(key)
            for key in LOCAL_LEDGER_OVERRIDE_KEYS
            if key in current
        }

    overrides_file = get_spiir_local_overrides_file()
    create_backup(overrides_file)
    _write_json(overrides_file, overrides_by_id)

    updated_transactions = [
        normalized
        for transaction_id in transaction_ids
        if (normalized := _normalize_local_ledger_transaction_row(updated_rows_by_id[transaction_id])) is not None
    ]
    if not _refresh_local_ledger_transactions_cache_after_override_save(previous_transactions_cache_key, updated_rows_by_id):
        _refresh_local_ledger_first_page_file_cache_after_override_save(previous_first_page_response, updated_transactions)
    mark_spiir_rebuild_required("local_ledger_override")
    return {
        "updated_count": len(transaction_ids),
        "updated_at": now,
        "updated_transactions": updated_transactions,
    }

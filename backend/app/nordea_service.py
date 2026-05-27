from __future__ import annotations

import datetime as dt
import json
import os
import re
import threading
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable

import jwt
import requests

from .config import (
    get_data_dir,
    get_spiir_local_overrides_file,
    get_spiir_local_transactions_file,
    get_spiir_raw_export_file,
)
from .spiir_service import (
    RENAME_MAIN_CATEGORY_NAME,
    UNCATEGORIZED_CATEGORY_ID,
    UNCATEGORIZED_CATEGORY_NAME,
    UNCATEGORIZED_MAIN_CATEGORY_ID,
    UNCATEGORIZED_MAIN_CATEGORY_NAME,
    _append_hashtags_to_comment,
    _extract_hashtags,
    _normalize_hashtags,
    _remove_hashtags_from_comment,
)
from .storage import create_backup

APP_ID = os.getenv("ENABLEBANKING_APP_ID", "").strip()
API_BASE = "https://api.enablebanking.com"
ALIAS_RE = re.compile(r"[0-9A-Za-z_æøåÆØÅ-]{3,}")
NORDEA_TAXONOMY_CACHE_VERSION = 1
NORDEA_INCREMENTAL_LOOKBACK_DAYS = 7

_NORDEA_TAXONOMY_CACHE: dict[str, Any] = {
    "key": None,
    "payload": None,
}
_NORDEA_RETRIEVE_STATE: dict[str, Any] = {"thread": None}
_NORDEA_RETRIEVE_LOCK = threading.Lock()


def _iso_utc_now() -> str:
    return dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z")


def _file_cache_stat(path: Path) -> dict[str, int | None]:
    if not path.exists():
        return {"mtime_ns": None, "size": None}
    stat = path.stat()
    return {"mtime_ns": stat.st_mtime_ns, "size": stat.st_size}


def _transactions_dir() -> Path:
    return get_data_dir() / "transactions"


def _enablebanking_dir() -> Path:
    return _transactions_dir() / "enablebanking"


def _raw_dir() -> Path:
    return _transactions_dir() / "raw" / "enablebanking"


def _processed_file() -> Path:
    return _transactions_dir() / "nordea" / "transactions.json"


def _retrieve_status_file() -> Path:
    return _transactions_dir() / "nordea" / "retrieve_status.json"


def _overrides_file() -> Path:
    return _transactions_dir() / "nordea" / "overrides.json"


def _session_file() -> Path:
    return _enablebanking_dir() / "latest_session.json"


def _key_path() -> Path:
    app_id = _enablebanking_app_id()
    configured_path = os.getenv("ENABLEBANKING_PRIVATE_KEY_PATH")
    if configured_path:
        return Path(configured_path).expanduser().resolve()
    return get_data_dir() / "local_secrets" / "enablebanking" / f"{app_id}.pem"


def _enablebanking_app_id() -> str:
    if not APP_ID:
        raise RuntimeError("Set ENABLEBANKING_APP_ID before calling Enable Banking")
    return APP_ID


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _read_retrieve_status() -> dict[str, Any] | None:
    path = _retrieve_status_file()
    if not path.exists():
        return None
    try:
        payload = _read_json(path)
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _write_retrieve_status(payload: dict[str, Any]) -> dict[str, Any]:
    payload["updated_at"] = _iso_utc_now()
    _write_json(_retrieve_status_file(), payload)
    return payload


def _new_retrieve_status(job_id: str) -> dict[str, Any]:
    now = _iso_utc_now()
    return {
        "job_id": job_id,
        "status": "queued",
        "started_at": now,
        "updated_at": now,
        "completed_at": None,
        "progress": 1,
        "current_phase": "Starter Nordea-hentning",
        "events": [
            {
                "at": now,
                "label": "Starter Nordea-hentning",
                "progress": 1,
            }
        ],
        "result": None,
        "sync_result": None,
        "error": None,
    }


def _append_retrieve_event(status_payload: dict[str, Any], label: str, progress: int, **extra: Any) -> dict[str, Any]:
    now = _iso_utc_now()
    events = status_payload.setdefault("events", [])
    if isinstance(events, list) and events:
        previous = events[-1]
        previous_at = previous.get("at") if isinstance(previous, dict) else None
        if isinstance(previous, dict) and isinstance(previous_at, str) and previous.get("duration_seconds") is None:
            try:
                started = dt.datetime.fromisoformat(previous_at.replace("Z", "+00:00"))
                previous["duration_seconds"] = round((dt.datetime.now(dt.UTC) - started).total_seconds(), 3)
            except ValueError:
                pass
    event = {"at": now, "label": label, "progress": progress}
    event.update({key: value for key, value in extra.items() if value is not None})
    if isinstance(events, list):
        events.append(event)
    status_payload["current_phase"] = label
    status_payload["progress"] = progress
    return _write_retrieve_status(status_payload)


def _write_json_with_backup(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    create_backup(path)
    _write_json(path, payload)


def _nordea_taxonomy_cache_file() -> Path:
    return get_spiir_local_transactions_file().parent / "cache" / "nordea_taxonomy.json"


def _nordea_taxonomy_cache_signature() -> dict[str, Any]:
    local_transactions_path = get_spiir_local_transactions_file()
    local_overrides_path = get_spiir_local_overrides_file()
    raw_path = get_spiir_raw_export_file()
    if local_transactions_path.exists():
        return {
            "schema_version": NORDEA_TAXONOMY_CACHE_VERSION,
            "source": "local",
            "sources": {
                "transactions": _file_cache_stat(local_transactions_path),
                "overrides": _file_cache_stat(local_overrides_path),
            },
        }
    return {
        "schema_version": NORDEA_TAXONOMY_CACHE_VERSION,
        "source": "raw",
        "sources": {
            "raw_export": _file_cache_stat(raw_path),
        },
    }


def _read_nordea_taxonomy_file_cache(signature: dict[str, Any]) -> dict[str, Any] | None:
    cache_file = _nordea_taxonomy_cache_file()
    if not cache_file.exists():
        return None
    try:
        payload = _read_json(cache_file)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("signature") != signature:
        return None
    response = payload.get("response")
    return response if isinstance(response, dict) else None


def _write_nordea_taxonomy_file_cache(signature: dict[str, Any], response: dict[str, Any]) -> None:
    payload = {
        "signature": signature,
        "cached_at": _iso_utc_now(),
        "response": response,
    }
    try:
        _write_json(_nordea_taxonomy_cache_file(), payload)
    except OSError:
        return


def _set_nordea_taxonomy_memory_cache(signature: dict[str, Any], payload: dict[str, Any]) -> None:
    _NORDEA_TAXONOMY_CACHE["key"] = signature
    _NORDEA_TAXONOMY_CACHE["payload"] = payload


def _auth_headers() -> dict[str, str]:
    key_path = _key_path()
    if not key_path.exists():
        raise FileNotFoundError(f"Missing Enable Banking private key: {key_path}")
    issued_at = int(dt.datetime.now(dt.UTC).timestamp())
    token = jwt.encode(
        {
            "iss": "enablebanking.com",
            "aud": "api.enablebanking.com",
            "iat": issued_at,
            "exp": issued_at + 3600,
        },
        key_path.read_bytes(),
        algorithm="RS256",
        headers={"kid": _enablebanking_app_id()},
    )
    return {"Authorization": f"Bearer {token}", "Accept": "application/json"}


def _request_json(method: str, path: str, **kwargs: Any) -> Any:
    response = requests.request(method, f"{API_BASE}{path}", headers=_auth_headers(), timeout=60, **kwargs)
    try:
        payload = response.json()
    except ValueError:
        payload = {"text": response.text}
    if response.status_code >= 400:
        raise RuntimeError(f"{method} {path} failed: {response.status_code} {payload}")
    return payload


def _signed_amount(transaction: dict[str, Any]) -> float:
    amount = float(transaction.get("transaction_amount", {}).get("amount") or 0)
    if transaction.get("credit_debit_indicator") == "DBIT":
        return -amount
    return amount


def _join_lines(value: Any) -> str:
    if isinstance(value, list):
        return "\n".join(str(item) for item in value if item is not None).strip()
    return str(value or "").strip()


def _party_name(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    name = str(value.get("name") or "").strip()
    return name or None


def _description(transaction: dict[str, Any]) -> str:
    remittance = _join_lines(transaction.get("remittance_information"))
    if remittance:
        return remittance.splitlines()[0].strip()
    return (
        _party_name(transaction.get("creditor"))
        or _party_name(transaction.get("debtor"))
        or transaction.get("bank_transaction_code", {}).get("description")
        or transaction.get("entry_reference")
        or ""
    )


def _normalize_transaction(account: dict[str, Any], transaction: dict[str, Any]) -> dict[str, Any]:
    entry_reference = str(transaction.get("entry_reference") or "")
    booking_date = transaction.get("booking_date") or transaction.get("transaction_date") or transaction.get("value_date")
    bank_code = transaction.get("bank_transaction_code") or {}
    account_key = account.get("uid") or account.get("identification_hash") or account.get("account_id", {}).get("iban") or "unknown"
    return {
        "id": f"enablebanking:nordea:{account_key}:{entry_reference}",
        "entry_reference": entry_reference,
        "booking_date": booking_date,
        "transaction_date": transaction.get("transaction_date"),
        "value_date": transaction.get("value_date"),
        "amount": _signed_amount(transaction),
        "currency": transaction.get("transaction_amount", {}).get("currency") or account.get("currency") or "DKK",
        "description": _description(transaction),
        "remittance_information": _join_lines(transaction.get("remittance_information")),
        "creditor_name": _party_name(transaction.get("creditor")),
        "debtor_name": _party_name(transaction.get("debtor")),
        "bank_transaction_code": bank_code.get("description"),
        "merchant_category_code": transaction.get("merchant_category_code"),
        "status": transaction.get("status"),
        "credit_debit_indicator": transaction.get("credit_debit_indicator"),
        "account_iban": account.get("account_id", {}).get("iban"),
        "account_name": account.get("name"),
        "categoryType": "Expense",
        "mainCategoryId": UNCATEGORIZED_MAIN_CATEGORY_ID,
        "mainCategoryName": UNCATEGORIZED_MAIN_CATEGORY_NAME,
        "categoryId": UNCATEGORIZED_CATEGORY_ID,
        "categoryName": UNCATEGORIZED_CATEGORY_NAME,
        "note": "",
        "hashtags": [],
        "is_extraordinary": False,
        "splits": [],
        "source": "enablebanking:nordea",
    }


def _load_overrides() -> dict[str, Any]:
    path = _overrides_file()
    if not path.exists():
        return {"schema_version": "1.0", "updated_at": None, "transactions": {}}
    payload = _read_json(path)
    if not isinstance(payload, dict):
        return {"schema_version": "1.0", "updated_at": None, "transactions": {}}
    payload.setdefault("schema_version", "1.0")
    payload.setdefault("updated_at", None)
    payload.setdefault("transactions", {})
    return payload


def _sanitize_category(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    category_id = value.get("categoryId")
    if category_id in (None, ""):
        return None
    return {
        "categoryType": value.get("categoryType") or "Expense",
        "mainCategoryId": value.get("mainCategoryId"),
        "mainCategoryName": value.get("mainCategoryName") or UNCATEGORIZED_MAIN_CATEGORY_NAME,
        "categoryId": category_id,
        "categoryName": value.get("categoryName") or UNCATEGORIZED_CATEGORY_NAME,
    }


def _sanitize_split(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    try:
        amount = float(value.get("amount") or 0)
    except (TypeError, ValueError):
        return None
    category = _sanitize_category(value.get("category"))
    if category is None:
        return None
    return {
        "id": str(value.get("id") or f"split-{abs(hash(json.dumps(value, sort_keys=True, default=str)))}"),
        "amount": amount,
        "note": str(value.get("note") or ""),
        "category": category,
    }


def _apply_override(transaction: dict[str, Any], override: dict[str, Any] | None) -> dict[str, Any]:
    next_transaction = dict(transaction)
    next_transaction["original_booking_date"] = transaction.get("booking_date")
    next_transaction.setdefault("categoryType", "Expense")
    next_transaction.setdefault("mainCategoryId", UNCATEGORIZED_MAIN_CATEGORY_ID)
    next_transaction.setdefault("mainCategoryName", UNCATEGORIZED_MAIN_CATEGORY_NAME)
    next_transaction.setdefault("categoryId", UNCATEGORIZED_CATEGORY_ID)
    next_transaction.setdefault("categoryName", UNCATEGORIZED_CATEGORY_NAME)
    next_transaction.setdefault("note", "")
    next_transaction.setdefault("hashtags", [])
    next_transaction.setdefault("is_extraordinary", False)
    next_transaction.setdefault("splits", [])
    if not override:
        return next_transaction
    category = _sanitize_category(override.get("category"))
    if category:
        next_transaction.update(category)
    custom_date = str(override.get("booking_date") or "").strip()
    if custom_date:
        next_transaction["booking_date"] = custom_date
        next_transaction["custom_booking_date"] = custom_date
    next_transaction["note"] = str(override.get("note") or "")
    next_transaction["hashtags"] = [str(item).strip() for item in override.get("hashtags") or [] if str(item).strip()]
    next_transaction["is_extraordinary"] = bool(override.get("is_extraordinary"))
    next_transaction["splits"] = [split for item in override.get("splits") or [] if (split := _sanitize_split(item)) is not None]
    return next_transaction


def _apply_overrides(payload: dict[str, Any]) -> dict[str, Any]:
    overrides = _load_overrides().get("transactions", {})
    next_payload = dict(payload)
    next_payload["transactions"] = [
        _apply_override(transaction, overrides.get(transaction.get("id")))
        for transaction in payload.get("transactions", [])
    ]
    return next_payload


def _dedupe_key(transaction: dict[str, Any]) -> str:
    account_key = transaction.get("account_iban") or transaction.get("account_name") or "unknown"
    reference = transaction.get("entry_reference") or transaction.get("id") or "unknown"
    return f"{account_key}:{reference}"


def _latest_local_raw_file() -> Path | None:
    files = sorted(_raw_dir().glob("transactions_*.json"))
    return files[-1] if files else None


def _load_processed() -> dict[str, Any]:
    path = _processed_file()
    if path.exists():
        return _read_json(path)
    raw_file = _latest_local_raw_file()
    if not raw_file:
        return {
            "generated_at": None,
            "last_retrieved_at": None,
            "last_retrieve_duration_seconds": None,
            "transaction_count": 0,
            "accounts": [],
            "transactions": [],
        }
    payload = _read_json(raw_file)
    return _merge_raw_payload(payload)


def _merge_raw_payload(raw_payload: dict[str, Any]) -> dict[str, Any]:
    current = _load_processed() if _processed_file().exists() else {"transactions": [], "accounts": []}
    account = raw_payload.get("account") or {}
    normalized = [_normalize_transaction(account, transaction) for transaction in raw_payload.get("transactions", [])]
    by_id = {_dedupe_key(transaction): transaction for transaction in current.get("transactions", [])}
    for transaction in normalized:
        by_id[_dedupe_key(transaction)] = transaction
    transactions = sorted(by_id.values(), key=lambda item: (item.get("booking_date") or "", item.get("entry_reference") or ""), reverse=True)
    accounts_by_iban = {
        str(item.get("account_id", {}).get("iban") or item.get("account_iban") or ""): item
        for item in current.get("accounts", [])
    }
    if account.get("account_id", {}).get("iban"):
        accounts_by_iban[account["account_id"]["iban"]] = account
    payload = {
        "generated_at": _iso_utc_now(),
        "last_retrieved_at": raw_payload.get("fetched_at"),
        "last_retrieve_duration_seconds": current.get("last_retrieve_duration_seconds"),
        "transaction_count": len(transactions),
        "accounts": list(accounts_by_iban.values()),
        "transactions": transactions,
    }
    _write_json(_processed_file(), payload)
    return payload


def _latest_processed_booking_date() -> dt.date | None:
    current = _load_processed()
    dates: list[dt.date] = []
    for transaction in current.get("transactions", []):
        if not isinstance(transaction, dict):
            continue
        raw_date = str(transaction.get("booking_date") or "").strip()
        if not raw_date:
            continue
        try:
            dates.append(dt.date.fromisoformat(raw_date[:10]))
        except ValueError:
            continue
    return max(dates) if dates else None


def _retrieve_params_for_existing_data(*, incremental: bool) -> tuple[dict[str, Any], dict[str, Any]]:
    if not incremental:
        return {"strategy": "longest", "transaction_status": "BOOK"}, {"mode": "full", "lookback_days": None, "latest_booking_date": None}
    latest_booking_date = _latest_processed_booking_date()
    if latest_booking_date is None:
        return {"strategy": "longest", "transaction_status": "BOOK"}, {"mode": "full", "lookback_days": None, "latest_booking_date": None}

    date_from = latest_booking_date - dt.timedelta(days=NORDEA_INCREMENTAL_LOOKBACK_DAYS)
    date_to = dt.datetime.now(dt.UTC).date()
    return (
        {
            "transaction_status": "BOOK",
            "date_from": date_from.isoformat(),
            "date_to": date_to.isoformat(),
        },
        {
            "mode": "incremental",
            "lookback_days": NORDEA_INCREMENTAL_LOOKBACK_DAYS,
            "latest_booking_date": latest_booking_date.isoformat(),
            "date_from": date_from.isoformat(),
            "date_to": date_to.isoformat(),
        },
    )


def load_nordea_transactions() -> dict[str, Any]:
    return _apply_overrides(_load_processed())


def _local_ledger_taxonomy_entries() -> list[dict[str, Any]]:
    transactions_path = get_spiir_local_transactions_file()
    overrides_path = get_spiir_local_overrides_file()
    transactions = _read_json(transactions_path)
    if not isinstance(transactions, list):
        return []

    overrides_payload: Any = {}
    if overrides_path.exists():
        overrides_payload = _read_json(overrides_path)
    overrides_by_id = overrides_payload if isinstance(overrides_payload, dict) else {}

    entries: list[dict[str, Any]] = []
    for transaction in transactions:
        if not isinstance(transaction, dict):
            continue
        transaction_id = str(transaction.get("id") or "")
        override = overrides_by_id.get(transaction_id)
        override_category = override.get("category") if isinstance(override, dict) else None

        main_category_id = str(
            (override_category.get("mainCategoryId") if isinstance(override_category, dict) else None)
            or transaction.get("main_category_id")
            or transaction.get("mainCategoryId")
            or UNCATEGORIZED_MAIN_CATEGORY_ID
        )
        category_id = str(
            (override_category.get("categoryId") if isinstance(override_category, dict) else None)
            or transaction.get("category_id")
            or transaction.get("categoryId")
            or UNCATEGORIZED_CATEGORY_ID
        )
        main_category_name = (
            (override_category.get("mainCategoryName") if isinstance(override_category, dict) else None)
            or transaction.get("main_category_name")
            or transaction.get("mainCategoryName")
            or UNCATEGORIZED_MAIN_CATEGORY_NAME
        )
        category_name = (
            (override_category.get("categoryName") if isinstance(override_category, dict) else None)
            or transaction.get("category_name")
            or transaction.get("categoryName")
            or UNCATEGORIZED_CATEGORY_NAME
        )
        category_type = (
            (override_category.get("categoryType") if isinstance(override_category, dict) else None)
            or transaction.get("category_type")
            or transaction.get("categoryType")
            or "Expense"
        )

        if isinstance(override, dict) and "hashtags" in override:
            raw_hashtags = override.get("hashtags") or []
        else:
            raw_hashtags = transaction.get("hashtags") or []
        hashtags = [str(tag).strip() for tag in raw_hashtags if str(tag).strip()]

        note_value = ""
        if isinstance(override, dict) and "note" in override:
            note_value = str(override.get("note") or "")
        elif isinstance(override, dict) and "comment" in override:
            note_value = str(override.get("comment") or "")
        else:
            note_value = str(transaction.get("note") or transaction.get("comment") or "")

        alias_text = " ".join([
            str(transaction.get("description") or transaction.get("original_description") or ""),
            note_value,
            " ".join(hashtags),
        ])
        date_value = str(
            (override.get("booking_date") if isinstance(override, dict) else None)
            or transaction.get("date")
            or transaction.get("booking_date")
            or ""
        )

        entries.append({
            "main_category_id": main_category_id,
            "main_category_name": main_category_name,
            "category_id": category_id,
            "category_name": category_name,
            "category_type": category_type,
            "alias_text": alias_text,
            "hashtags": hashtags,
            "date": date_value,
        })

    return entries


def _raw_spiir_taxonomy_entries(raw_entries: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_entries, list):
        return []
    entries: list[dict[str, Any]] = []
    for entry in raw_entries:
        if not isinstance(entry, dict):
            continue
        main_name = RENAME_MAIN_CATEGORY_NAME.get(entry.get("MainCategoryName"), entry.get("MainCategoryName")) or UNCATEGORIZED_MAIN_CATEGORY_NAME
        tags = [str(tag).strip() for tag in entry.get("Tags") or [] if str(tag).strip()]
        entries.append({
            "main_category_id": str(entry.get("MainCategoryId") or UNCATEGORIZED_MAIN_CATEGORY_ID),
            "main_category_name": main_name,
            "category_id": str(entry.get("CategoryId") or UNCATEGORIZED_CATEGORY_ID),
            "category_name": entry.get("CategoryName") or UNCATEGORIZED_CATEGORY_NAME,
            "category_type": entry.get("CategoryType") or "Expense",
            "alias_text": " ".join([
                str(entry.get("Description") or ""),
                str(entry.get("Comment") or ""),
                " ".join(tags),
            ]),
            "hashtags": tags,
            "date": str(entry.get("CustomDate") or entry.get("Date") or ""),
        })
    return entries


def _build_taxonomy_payload(entries: list[dict[str, Any]]) -> dict[str, Any]:
    categories: dict[tuple[str, str], dict[str, Any]] = {}
    category_alias_counts: dict[tuple[str, str], dict[str, int]] = {}
    hashtags: dict[str, dict[str, Any]] = {}

    for entry in entries:
        category_key = (str(entry.get("main_category_id") or UNCATEGORIZED_MAIN_CATEGORY_ID), str(entry.get("category_id") or UNCATEGORIZED_CATEGORY_ID))
        current = categories.get(category_key) or {
            "categoryType": entry.get("category_type") or "Expense",
            "mainCategoryId": category_key[0],
            "mainCategoryName": entry.get("main_category_name") or UNCATEGORIZED_MAIN_CATEGORY_NAME,
            "categoryId": category_key[1],
            "categoryName": entry.get("category_name") or UNCATEGORIZED_CATEGORY_NAME,
            "usage_count": 0,
        }
        current["usage_count"] += 1
        categories[category_key] = current

        alias_counts = category_alias_counts.setdefault(category_key, {})
        for match in ALIAS_RE.finditer(str(entry.get("alias_text") or "")):
            alias = match.group(0).strip("#").strip()
            if not alias:
                continue
            alias_counts[alias] = alias_counts.get(alias, 0) + 1

        date_value = str(entry.get("date") or "")
        for tag in entry.get("hashtags") or []:
            tag_name = str(tag).strip()
            if not tag_name:
                continue
            current_tag = hashtags.get(tag_name) or {"name": tag_name, "usage_count": 0, "last_seen": ""}
            current_tag["usage_count"] += 1
            current_tag["last_seen"] = max(current_tag["last_seen"], date_value)
            hashtags[tag_name] = current_tag

    uncategorized_key = (UNCATEGORIZED_MAIN_CATEGORY_ID, UNCATEGORIZED_CATEGORY_ID)
    categories.setdefault(uncategorized_key, {
        "categoryType": "Expense",
        "mainCategoryId": UNCATEGORIZED_MAIN_CATEGORY_ID,
        "mainCategoryName": UNCATEGORIZED_MAIN_CATEGORY_NAME,
        "categoryId": UNCATEGORIZED_CATEGORY_ID,
        "categoryName": UNCATEGORIZED_CATEGORY_NAME,
        "usage_count": 0,
    })

    for key, category in categories.items():
        alias_counts = category_alias_counts.get(key, {})
        main_words = set(str(category["mainCategoryName"]).lower().split())
        category_words = set(str(category["categoryName"]).lower().split())
        category["search_aliases"] = [
            alias
            for alias, _ in sorted(alias_counts.items(), key=lambda item: item[1], reverse=True)
            if alias.lower() not in main_words and alias.lower() not in category_words
        ][:16]

    return {
        "categories": sorted(categories.values(), key=lambda item: (str(item["mainCategoryName"]), str(item["categoryName"]))),
        "hashtags": sorted(hashtags.values(), key=lambda item: (str(item["last_seen"]), item["usage_count"]), reverse=True),
    }


def load_nordea_taxonomy() -> dict[str, Any]:
    local_transactions_path = get_spiir_local_transactions_file()
    raw_path = get_spiir_raw_export_file()
    signature = _nordea_taxonomy_cache_signature()

    if _NORDEA_TAXONOMY_CACHE.get("key") == signature and _NORDEA_TAXONOMY_CACHE.get("payload") is not None:
        return deepcopy(_NORDEA_TAXONOMY_CACHE["payload"])

    file_cached_payload = _read_nordea_taxonomy_file_cache(signature)
    if file_cached_payload is not None:
        _set_nordea_taxonomy_memory_cache(signature, file_cached_payload)
        return deepcopy(file_cached_payload)

    if local_transactions_path.exists():
        payload = _build_taxonomy_payload(_local_ledger_taxonomy_entries())
        _set_nordea_taxonomy_memory_cache(signature, payload)
        _write_nordea_taxonomy_file_cache(signature, payload)
        return deepcopy(payload)

    if not raw_path.exists():
        payload = {"categories": [], "hashtags": []}
        _set_nordea_taxonomy_memory_cache(signature, payload)
        _write_nordea_taxonomy_file_cache(signature, payload)
        return deepcopy(payload)

    payload = _build_taxonomy_payload(_raw_spiir_taxonomy_entries(_read_json(raw_path)))
    _set_nordea_taxonomy_memory_cache(signature, payload)
    _write_nordea_taxonomy_file_cache(signature, payload)
    return deepcopy(payload)


def warm_nordea_taxonomy_cache() -> None:
    load_nordea_taxonomy()


def save_nordea_overrides(transaction_ids: list[str], patch: dict[str, Any]) -> dict[str, Any]:
    if not transaction_ids:
        raise ValueError("No Nordea transactions selected")
    payload = _load_overrides()
    transactions = payload.setdefault("transactions", {})
    category = _sanitize_category(patch.get("category"))
    for transaction_id in transaction_ids:
        current = dict(transactions.get(transaction_id) or {})
        if "category" in patch:
            if category is None:
                current.pop("category", None)
            else:
                current["category"] = category
        if "booking_date" in patch:
            booking_date = str(patch.get("booking_date") or "").strip()
            if booking_date:
                current["booking_date"] = booking_date
            else:
                current.pop("booking_date", None)
        if "note" in patch:
            current["note"] = str(patch.get("note") or "")
        if "hashtags" in patch:
            requested_hashtags = _normalize_hashtags(patch.get("hashtags"))
            removed_hashtags = [tag for tag in _normalize_hashtags(current.get("hashtags")) if tag not in requested_hashtags]
            current["note"] = _append_hashtags_to_comment(
                _remove_hashtags_from_comment(current.get("note"), removed_hashtags),
                requested_hashtags,
            )
            current["hashtags"] = _normalize_hashtags([*_extract_hashtags(current.get("note")), *requested_hashtags])
        if "append_hashtags" in patch:
            current["note"] = _append_hashtags_to_comment(current.get("note"), patch.get("append_hashtags"))
            current["hashtags"] = _normalize_hashtags([*_normalize_hashtags(current.get("hashtags")), *_extract_hashtags(current.get("note"))])
        if "remove_hashtags" in patch:
            removed_hashtags = _normalize_hashtags(patch.get("remove_hashtags"))
            removed_hashtag_set = set(removed_hashtags)
            current["note"] = _remove_hashtags_from_comment(current.get("note"), removed_hashtags)
            current["hashtags"] = [
                tag for tag in _normalize_hashtags([*_normalize_hashtags(current.get("hashtags")), *_extract_hashtags(current.get("note"))])
                if tag not in removed_hashtag_set
            ]
        if any(key in patch for key in ("note", "hashtags", "append_hashtags")):
            current["hashtags"] = _extract_hashtags(current.get("note"))
        if "is_extraordinary" in patch:
            current["is_extraordinary"] = bool(patch.get("is_extraordinary"))
        if "splits" in patch:
            current["splits"] = [split for item in patch.get("splits") or [] if (split := _sanitize_split(item)) is not None]
        transactions[transaction_id] = current
    payload["updated_at"] = _iso_utc_now()
    _write_json_with_backup(_overrides_file(), payload)
    return {"updated_count": len(transaction_ids), "updated_at": payload["updated_at"]}


def retrieve_nordea_transactions(
    *,
    incremental: bool = True,
    progress: Callable[[str, int, dict[str, Any] | None], None] | None = None,
) -> dict[str, Any]:
    started = dt.datetime.now(dt.UTC)
    def notify(label: str, progress_value: int, extra: dict[str, Any] | None = None) -> None:
        if progress is not None:
            progress(label, progress_value, extra)

    notify("Læser Enable Banking-session", 5, None)
    if not _session_file().exists():
        raise FileNotFoundError("Missing Enable Banking session. Re-authorize account access first.")
    session = _read_json(_session_file())
    accounts = session.get("accounts") or []
    if not accounts:
        raise RuntimeError("Enable Banking session has no linked accounts")

    params, fetch_window = _retrieve_params_for_existing_data(incremental=incremental)
    notify("Kontrollerer tilknyttede konti", 10, {"account_count": len(accounts), "fetch_window": fetch_window})
    raw_outputs: list[Path] = []
    all_transactions = 0
    for account_index, account in enumerate(accounts, start=1):
        account_uid = account["uid"]
        transactions: list[dict[str, Any]] = []
        continuation_key = None
        page_number = 0
        while True:
            page_number += 1
            notify(
                f"Henter konto {account_index} af {len(accounts)} · side {page_number}",
                min(75, 15 + account_index * 10 + page_number * 3),
                {"account_index": account_index, "account_count": len(accounts), "page_number": page_number, "fetch_window": fetch_window},
            )
            page_params = dict(params)
            if continuation_key:
                page_params["continuation_key"] = continuation_key
            payload = _request_json("GET", f"/accounts/{account_uid}/transactions", params=page_params)
            transactions.extend(payload.get("transactions", []))
            continuation_key = payload.get("continuation_key")
            if not continuation_key:
                break

        raw_payload = {
            "fetched_at": _iso_utc_now(),
            "session_id": session.get("session_id"),
            "account": account,
            "params": params,
            "transaction_count": len(transactions),
            "transactions": transactions,
        }
        notify("Gemmer rå Nordea-data", 78, {"account_index": account_index, "transaction_count": len(transactions), "fetch_window": fetch_window})
        out_path = _raw_dir() / f"transactions_{account_uid}_{dt.datetime.now(dt.UTC).strftime('%Y%m%dT%H%M%SZ')}.json"
        _write_json(out_path, raw_payload)
        raw_outputs.append(out_path)
        all_transactions += len(transactions)
        notify("Normaliserer og fletter Nordea-data", 86, {"transaction_count": len(transactions), "fetch_window": fetch_window})
        _merge_raw_payload(raw_payload)

    elapsed_seconds = (dt.datetime.now(dt.UTC) - started).total_seconds()
    processed = _load_processed()
    processed["last_retrieve_duration_seconds"] = round(elapsed_seconds, 3)
    _write_json(_processed_file(), processed)
    notify("Nordea-hentning færdig", 92, {"retrieved_count": all_transactions, "transaction_count": processed["transaction_count"], "fetch_window": fetch_window})
    return {
        "retrieved_count": all_transactions,
        "transaction_count": processed["transaction_count"],
        "raw_files": [str(path) for path in raw_outputs],
        "last_retrieved_at": processed.get("last_retrieved_at"),
        "last_retrieve_duration_seconds": processed.get("last_retrieve_duration_seconds"),
        "fetch_window": fetch_window,
    }


def get_nordea_retrieve_status() -> dict[str, Any]:
    status_payload = _read_retrieve_status()
    if status_payload is None:
        return {
            "job_id": None,
            "status": "idle",
            "started_at": None,
            "updated_at": None,
            "completed_at": None,
            "progress": 0,
            "current_phase": None,
            "events": [],
            "result": None,
            "sync_result": None,
            "error": None,
        }
    thread = _NORDEA_RETRIEVE_STATE.get("thread")
    if status_payload.get("status") in {"queued", "running"} and not isinstance(thread, threading.Thread):
        status_payload["status"] = "failed"
        status_payload["completed_at"] = status_payload.get("completed_at") or _iso_utc_now()
        status_payload["error"] = status_payload.get("error") or "Nordea-hentning blev afbrudt. Start igen."
        _write_retrieve_status(status_payload)
    return status_payload


def _run_nordea_retrieve_job(job_id: str, *, sync_local_ledger: bool) -> None:
    status_payload = _read_retrieve_status() or _new_retrieve_status(job_id)

    def progress(label: str, progress_value: int, extra: dict[str, Any] | None) -> None:
        current = _read_retrieve_status() or status_payload
        if current.get("job_id") != job_id:
            return
        current["status"] = "running"
        _append_retrieve_event(current, label, progress_value, **(extra or {}))

    try:
        status_payload["status"] = "running"
        _write_retrieve_status(status_payload)
        result = retrieve_nordea_transactions(incremental=True, progress=progress)
        sync_result = None
        if sync_local_ledger:
            progress("Synkroniserer til lokal Spiir-ledger", 96, None)
            from .spiir_local_ledger_service import (
                apply_nordea_sync_into_spiir_local_ledger,
            )

            sync_result = apply_nordea_sync_into_spiir_local_ledger()
        completed = _read_retrieve_status() or status_payload
        completed["status"] = "succeeded"
        completed["completed_at"] = _iso_utc_now()
        completed["progress"] = 100
        completed["current_phase"] = "Færdig"
        completed["result"] = result
        completed["sync_result"] = sync_result
        _append_retrieve_event(completed, "Færdig", 100, retrieved_count=result.get("retrieved_count"), transaction_count=result.get("transaction_count"))
    except (OSError, RuntimeError, ValueError, KeyError, TypeError, requests.RequestException) as exc:
        failed = _read_retrieve_status() or status_payload
        failed["status"] = "failed"
        failed["completed_at"] = _iso_utc_now()
        failed["error"] = str(exc)
        _append_retrieve_event(failed, "Fejlede", int(failed.get("progress") or 0), error=str(exc))


def start_nordea_retrieve_job(*, sync_local_ledger: bool = True) -> dict[str, Any]:
    with _NORDEA_RETRIEVE_LOCK:
        thread = _NORDEA_RETRIEVE_STATE.get("thread")
        current = _read_retrieve_status()
        if isinstance(thread, threading.Thread) and thread.is_alive() and isinstance(current, dict):
            return current

        job_id = uuid.uuid4().hex
        status_payload = _write_retrieve_status(_new_retrieve_status(job_id))
        next_thread = threading.Thread(target=_run_nordea_retrieve_job, kwargs={"job_id": job_id, "sync_local_ledger": sync_local_ledger}, daemon=True)
        _NORDEA_RETRIEVE_STATE["thread"] = next_thread
        next_thread.start()
        return status_payload
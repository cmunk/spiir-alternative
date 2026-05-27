from __future__ import annotations

import datetime as dt
import json
import math
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any

import pandas as pd

from .config import (
    get_spiir_income_expense_series_cache_file,
    get_spiir_local_overrides_file,
    get_spiir_local_transactions_file,
    get_spiir_overview_file,
    get_spiir_processed_dir,
    get_spiir_raw_dir,
    get_spiir_raw_export_file,
    get_spiir_rebuild_state_file,
    get_spiir_transactions_file,
    get_spiir_update_log_file,
)
from .local_ledger_overrides import (
    apply_local_ledger_override,
    load_local_ledger_overrides,
)
from .storage import create_backup

SKIP_IS_EXTRAORDINARY = True
SKIP_MAIN_CATEGORY_NAMES = {"Vis ikke"}
SKIP_ACCOUNT_NAMES = {"Andelsboliglån"}
SKIP_YEAR_STRINGS = {"2011"}
INCOME_EXPENSE_SERIES_CACHE_VERSION = 1
SPIIR_REBUILD_IDLE_DELAY_SECONDS = 10.0

RENAME_MAIN_CATEGORY_NAME = {
    "Andre leveomkostninger": "Andet",
}

UNCATEGORIZED_MAIN_CATEGORY_NAME = "Diverse"
UNCATEGORIZED_MAIN_CATEGORY_ID = "synthetic-diverse"
UNCATEGORIZED_CATEGORY_NAME = "Ikke kategoriseret"
UNCATEGORIZED_CATEGORY_ID = "synthetic-uncategorized"

_SPIIR_REBUILD_STATE: dict[str, Any] = {"timer": None, "running": False, "rerun_requested": False}
_SPIIR_REBUILD_LOCK = threading.Lock()

SHOP_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("Netto", re.compile(r"\bnetto\b", re.I)),
    ("Købmand", re.compile(r"købmand|koebmand", re.I)),
    ("SuperBrugsen", re.compile(r"super\s*brugsen|\bsb\b|coop\s*app", re.I)),
    ("Irma", re.compile(r"\birma\b", re.I)),
    ("Bilka", re.compile(r"\bbilka\b", re.I)),
    ("Føtex", re.compile(r"føtex|føt\b|foetex", re.I)),
    ("Meny", re.compile(r"\bmeny\b", re.I)),
    ("Kvickly", re.compile(r"\bkvickly\b", re.I)),
    ("Fakta", re.compile(r"\bfakta\b", re.I)),
    ("Rema", re.compile(r"\brema\b", re.I)),
    ("Lidl", re.compile(r"\blidl\b", re.I)),
    ("Nemlig", re.compile(r"nemlig\.com", re.I)),
    ("Aarstiderne", re.compile(r"aarstiderne", re.I)),
    ("Grønthandler", re.compile(r"soran|kervan", re.I)),
    ("Fiskehallen", re.compile(r"fiskehallen", re.I)),
    ("Slagter", re.compile(r"spis\s*min\s*gris", re.I)),
    ("TooGoodToGo", re.compile(r"toogood", re.I)),
    ("Tiger", re.compile(r"\btiger\b", re.I)),
    ("MobilePay", re.compile(r"mobilepay", re.I)),
    ("Tesco", re.compile(r"\btesco\b", re.I)),
    ("Other", re.compile(r"superbest|kiwi|skelhøje|skelhoeje|dagli\s*b|coop", re.I)),
]

GROCERY_HINT_RULES: list[re.Pattern[str]] = [
    re.compile(r"\bnetto\b", re.I),
    re.compile(r"nemlig\.com", re.I),
    re.compile(r"super\s*brugsen|\bsb\b|coop\s*app", re.I),
    re.compile(r"føtex|foetex|bilka|irma|meny|kvickly|lidl|rema|fakta", re.I),
    re.compile(r"aarstiderne|fiskehallen|kervan|soran|spis\s*min\s*gris", re.I),
]

HASHTAG_RE = re.compile(r"(?<![0-9A-Za-z_æøåÆØÅ-])#([0-9A-Za-z_æøåÆØÅ-]+)", re.I)


def _iso_utc_now() -> str:
    return dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z")


def _ensure_spiir_dirs() -> None:
    for path in [get_spiir_raw_dir(), get_spiir_processed_dir(), get_spiir_update_log_file().parent]:
        path.mkdir(parents=True, exist_ok=True)


def _log_update(message: str) -> None:
    _ensure_spiir_dirs()
    timestamp = dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    with get_spiir_update_log_file().open("a", encoding="utf-8") as handle:
        handle.write(f"{timestamp} {message}\n")


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False, allow_nan=False)
        handle.write("\n")
        temp_path = Path(handle.name)
    temp_path.replace(path)


def _file_cache_stat(path: Path) -> dict[str, int | None]:
    if not path.exists():
        return {"mtime_ns": None, "size": None}
    stat = path.stat()
    return {"mtime_ns": stat.st_mtime_ns, "size": stat.st_size}


def load_spiir_rebuild_state() -> dict[str, Any]:
    state_file = get_spiir_rebuild_state_file()
    if not state_file.exists():
        return {
            "rebuild_required": False,
            "rebuild_marked_at": None,
            "rebuild_reason": None,
            "rebuild_cleared_at": None,
        }
    payload = _read_json(state_file)
    if not isinstance(payload, dict):
        return {
            "rebuild_required": False,
            "rebuild_marked_at": None,
            "rebuild_reason": None,
            "rebuild_cleared_at": None,
        }
    return {
        "rebuild_required": bool(payload.get("rebuild_required")),
        "rebuild_marked_at": payload.get("rebuild_marked_at"),
        "rebuild_reason": payload.get("rebuild_reason"),
        "rebuild_cleared_at": payload.get("rebuild_cleared_at"),
    }


def mark_spiir_rebuild_required(reason: str) -> dict[str, Any]:
    _ensure_spiir_dirs()
    state_file = get_spiir_rebuild_state_file()
    current = load_spiir_rebuild_state()
    reason_text = str(reason or "local_ledger_changed")
    if current.get("rebuild_required") and current.get("rebuild_reason") == reason_text:
        schedule_spiir_rebuild_if_due(delay_seconds=SPIIR_REBUILD_IDLE_DELAY_SECONDS)
        return current
    next_state = {
        "rebuild_required": True,
        "rebuild_marked_at": current.get("rebuild_marked_at") or _iso_utc_now(),
        "rebuild_reason": reason_text,
        "rebuild_cleared_at": current.get("rebuild_cleared_at"),
    }
    create_backup(state_file)
    _write_json(state_file, next_state)
    schedule_spiir_rebuild_if_due(delay_seconds=SPIIR_REBUILD_IDLE_DELAY_SECONDS)
    return next_state


def clear_spiir_rebuild_required() -> dict[str, Any]:
    _ensure_spiir_dirs()
    state_file = get_spiir_rebuild_state_file()
    next_state = {
        "rebuild_required": False,
        "rebuild_marked_at": None,
        "rebuild_reason": None,
        "rebuild_cleared_at": _iso_utc_now(),
    }
    create_backup(state_file)
    _write_json(state_file, next_state)
    return next_state


def _run_scheduled_spiir_rebuild() -> None:
    with _SPIIR_REBUILD_LOCK:
        if _SPIIR_REBUILD_STATE["running"]:
            return
        _SPIIR_REBUILD_STATE["running"] = True
        _SPIIR_REBUILD_STATE["timer"] = None
    try:
        state = load_spiir_rebuild_state()
        if not state.get("rebuild_required"):
            return
        if not get_spiir_local_transactions_file().exists():
            _log_update("scheduled local rebuild skipped missing local ledger")
            return
        rebuild_spiir_processed(source="local")
    except (OSError, RuntimeError, ValueError, KeyError, TypeError) as exc:
        _log_update(f"scheduled local rebuild failed {type(exc).__name__}: {exc}")
    finally:
        with _SPIIR_REBUILD_LOCK:
            rerun_requested = bool(_SPIIR_REBUILD_STATE["rerun_requested"])
            _SPIIR_REBUILD_STATE["rerun_requested"] = False
            _SPIIR_REBUILD_STATE["running"] = False
        if rerun_requested:
            mark_spiir_rebuild_required("local_ledger_changed")


def schedule_spiir_rebuild_if_due(delay_seconds: float = SPIIR_REBUILD_IDLE_DELAY_SECONDS) -> dict[str, Any]:
    if os.getenv("SPIIR_ALT_DISABLE_BACKGROUND_SPIIR_REBUILD") == "1":
        state = load_spiir_rebuild_state()
        return {"scheduled": False, "running": False, "rebuild_required": bool(state.get("rebuild_required"))}
    state = load_spiir_rebuild_state()
    if not state.get("rebuild_required"):
        return {"scheduled": False, "running": False, "rebuild_required": False}
    if not get_spiir_local_transactions_file().exists():
        return {"scheduled": False, "running": False, "rebuild_required": True}

    delay = max(0.0, float(delay_seconds))
    with _SPIIR_REBUILD_LOCK:
        if _SPIIR_REBUILD_STATE["running"]:
            _SPIIR_REBUILD_STATE["rerun_requested"] = True
            return {"scheduled": False, "running": True, "rebuild_required": True}
        existing_timer = _SPIIR_REBUILD_STATE["timer"]
        if isinstance(existing_timer, threading.Timer):
            existing_timer.cancel()
        timer = threading.Timer(delay, _run_scheduled_spiir_rebuild)
        timer.daemon = True
        _SPIIR_REBUILD_STATE["timer"] = timer
        timer.start()
    return {"scheduled": True, "running": False, "rebuild_required": True, "delay_seconds": delay}


def _parse_spiir_date(value: str) -> dt.datetime:
    if not value:
        raise ValueError("missing date")
    if "." in value:
        return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")


def _normalize_entry(entry: dict[str, Any]) -> dict[str, Any] | None:
    if SKIP_IS_EXTRAORDINARY and entry.get("IsExtraordinary"):
        return None
    main_category_name = entry.get("MainCategoryName")
    main_category_id = entry.get("MainCategoryId")
    category_type = entry.get("CategoryType")
    category_name = entry.get("CategoryName") or ""
    category_id = entry.get("CategoryId")
    if main_category_name is None:
        main_category_name = UNCATEGORIZED_MAIN_CATEGORY_NAME
        main_category_id = UNCATEGORIZED_MAIN_CATEGORY_ID
        category_name = UNCATEGORIZED_CATEGORY_NAME
        category_id = UNCATEGORIZED_CATEGORY_ID
        category_type = "Expense"
    elif main_category_name in SKIP_MAIN_CATEGORY_NAMES:
        return None
    if entry.get("AccountName") in SKIP_ACCOUNT_NAMES:
        return None

    date_value = entry.get("CustomDate") or entry.get("Date")
    date = _parse_spiir_date(date_value)
    if date.strftime("%Y") in SKIP_YEAR_STRINGS:
        return None

    if "Dagpenge" in category_name:
        category_name = "Dagpenge"

    description = entry.get("Description") or ""
    original_description = entry.get("OriginalDescription") or ""

    return {
        "id": entry.get("Id"),
        "accountId": entry.get("AccountId"),
        "categoryId": category_id,
        "mainCategoryId": main_category_id,
        "categoryType": category_type,
        "expenseType": entry.get("ExpenseType"),
        "mainCategoryName": RENAME_MAIN_CATEGORY_NAME.get(main_category_name, main_category_name),
        "categoryName": category_name,
        "tags": entry.get("Tags"),
        "description": description,
        "originalDescription": original_description,
        "comment": entry.get("Comment"),
        "amount": float(entry.get("Amount") or 0),
        "date": date,
    }


def _load_entries(json_path: Path) -> pd.DataFrame:
    normalized = [item for entry in _read_json(json_path) if (item := _normalize_entry(entry)) is not None]
    if not normalized:
        return pd.DataFrame(
            columns=[
                "categoryType",
                "mainCategoryName",
                "categoryName",
                "categoryId",
                "mainCategoryId",
                "description",
                "originalDescription",
                "comment",
                "amount",
                "date",
                "year",
                "yyyymm",
                "yyyymm_int",
                "yyyymmdd",
                "week",
                "runningTotal",
            ]
        )

    df = pd.DataFrame(normalized).sort_values("date")
    df["year"] = df["date"].dt.strftime("%Y")
    df["yyyymm"] = df["date"].dt.strftime("%Y-%m")
    df["yyyymm_int"] = df["date"].dt.strftime("%Y%m").astype(int)
    df["yyyymmdd"] = df["date"].dt.strftime("%Y-%m-%d")
    df["week"] = df["date"].dt.strftime("%Y-W%V")
    df["runningTotal"] = df["amount"].cumsum()
    return df


def _normalize_local_ledger_entry(entry: dict[str, Any]) -> dict[str, Any] | None:
    if str(entry.get("source") or "") not in {"spiir", "nordea"}:
        return None
    if SKIP_IS_EXTRAORDINARY and entry.get("is_extraordinary"):
        return None

    main_category_name = entry.get("main_category_name") or UNCATEGORIZED_MAIN_CATEGORY_NAME
    main_category_id = entry.get("main_category_id") or UNCATEGORIZED_MAIN_CATEGORY_ID
    category_name = entry.get("category_name") or UNCATEGORIZED_CATEGORY_NAME
    category_id = entry.get("category_id") or UNCATEGORIZED_CATEGORY_ID
    category_type = entry.get("category_type") or "Expense"

    if main_category_name in SKIP_MAIN_CATEGORY_NAMES:
        return None
    if entry.get("source_account_name") in SKIP_ACCOUNT_NAMES:
        return None

    date_value = entry.get("date") or entry.get("original_date")
    if not date_value:
        return None
    date = dt.datetime.strptime(str(date_value), "%Y-%m-%d")
    if date.strftime("%Y") in SKIP_YEAR_STRINGS:
        return None

    if "Dagpenge" in str(category_name):
        category_name = "Dagpenge"

    description = entry.get("description") or ""
    original_description = entry.get("original_description") or ""

    return {
        "id": entry.get("source_id") or entry.get("id"),
        "accountId": entry.get("source_account_id"),
        "categoryId": category_id,
        "mainCategoryId": main_category_id,
        "categoryType": category_type,
        "expenseType": None,
        "mainCategoryName": RENAME_MAIN_CATEGORY_NAME.get(main_category_name, main_category_name),
        "categoryName": category_name,
        "tags": entry.get("raw_tags"),
        "description": description,
        "originalDescription": original_description,
        "comment": entry.get("comment"),
        "hashtags": entry.get("hashtags") or _extract_hashtags(entry.get("comment")),
        "amount": float(entry.get("amount") or 0),
        "date": date,
    }


def _load_entries_from_local_ledger(local_transactions_path: Path) -> pd.DataFrame:
    overrides_payload = load_local_ledger_overrides(
        read_json=_read_json,
        overrides_file=get_spiir_local_overrides_file(),
    )

    normalized = [
        item
        for entry in _read_json(local_transactions_path)
        if isinstance(entry, dict)
        and (item := _normalize_local_ledger_entry(apply_local_ledger_override(entry, overrides_payload))) is not None
    ]
    if not normalized:
        return pd.DataFrame(
            columns=[
                "categoryType",
                "mainCategoryName",
                "categoryName",
                "categoryId",
                "mainCategoryId",
                "description",
                "originalDescription",
                "comment",
                "hashtags",
                "amount",
                "date",
                "year",
                "yyyymm",
                "yyyymm_int",
                "yyyymmdd",
                "week",
                "runningTotal",
            ]
        )

    df = pd.DataFrame(normalized).sort_values("date")
    df["year"] = df["date"].dt.strftime("%Y")
    df["yyyymm"] = df["date"].dt.strftime("%Y-%m")
    df["yyyymm_int"] = df["date"].dt.strftime("%Y%m").astype(int)
    df["yyyymmdd"] = df["date"].dt.strftime("%Y-%m-%d")
    df["week"] = df["date"].dt.strftime("%Y-W%V")
    df["runningTotal"] = df["amount"].cumsum()
    return df


def _format_int(value: Any) -> int:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return 0
    return int(round(float(value)))


def _format_month(value: Any) -> str:
    text = str(value or "").strip()
    if re.fullmatch(r"\d{6}", text):
        return f"{text[:4]}-{text[4:]}"
    return text


def _overview_row(rows: list[dict[str, Any]], key: str) -> dict[str, Any]:
    for row in rows:
        if row.get("key") == key:
            return row
    raise ValueError(f"Spiir overview is missing {key} row")


def _overview_value(row: dict[str, Any], month: str) -> int:
    values = row.get("values")
    if not isinstance(values, dict):
        return 0
    return _format_int(values.get(month, 0))


def _months_in_range(months: list[str], start_month: str, end_month: str) -> list[str]:
    return [month for month in months if start_month <= month <= end_month]


def _build_income_expense_periods(months: list[str]) -> list[dict[str, Any]]:
    if not months:
        return []
    current_month = months[-1]
    last_twelve = months[-12:]
    periods = [
        {
            "label": "12 mdr.",
            "totals_title": "Sidste 12 mdr.",
            "start_month": last_twelve[0],
            "end_month": current_month,
            "months": last_twelve,
        }
    ]
    for year in sorted({month[:4] for month in months}, reverse=True):
        year_months = _months_in_range(months, f"{year}-01", f"{year}-12")
        periods.append(
            {
                "label": year,
                "totals_title": year,
                "start_month": year_months[0],
                "end_month": year_months[-1],
                "months": year_months,
            }
        )
    return periods


def _build_income_expense_series_from_overview(payload: dict[str, Any]) -> dict[str, Any]:
    monthly = payload.get("monthly")
    if not isinstance(monthly, dict):
        raise ValueError("Spiir overview is missing monthly data")
    raw_months = monthly.get("periods")
    raw_rows = monthly.get("rows")
    if not isinstance(raw_months, list) or not isinstance(raw_rows, list):
        raise ValueError("Spiir overview has invalid monthly data")

    months = [str(month) for month in raw_months if isinstance(month, str) and re.fullmatch(r"\d{4}-\d{2}", month)]
    rows = [row for row in raw_rows if isinstance(row, dict)]
    income_row = _overview_row(rows, "income")
    expense_row = _overview_row(rows, "expense")
    diff_row = _overview_row(rows, "diff")

    series_months = []
    for month in months:
        expense = abs(_overview_value(expense_row, month))
        series_months.append(
            {
                "month": month,
                "income": _overview_value(income_row, month),
                "expense": expense,
                "fixed_expense": None,
                "variable_expense": None,
                "net": _overview_value(diff_row, month),
                "income_count": None,
                "expense_count": None,
                "is_current_month": False,
                "source": "spiir_processed_overview",
            }
        )

    non_zero_months = [row for row in series_months if row["income"] != 0 or row["expense"] != 0 or row["net"] != 0]
    if non_zero_months:
        non_zero_months[-1]["is_current_month"] = True

    years = sorted({int(row["month"][:4]) for row in series_months}, reverse=True)
    return {
        "generated_at": _iso_utc_now(),
        "source": "spiir_processed_overview",
        "source_generated_at": payload.get("generated_at"),
        "months": series_months,
        "years": years,
        "periods": _build_income_expense_periods(months),
    }


def _income_expense_series_cache_signature() -> dict[str, Any]:
    return {
        "schema_version": INCOME_EXPENSE_SERIES_CACHE_VERSION,
        "sources": {
            "overview": _file_cache_stat(get_spiir_overview_file()),
        },
    }


def _read_income_expense_series_cache() -> dict[str, Any] | None:
    cache_file = get_spiir_income_expense_series_cache_file()
    if not cache_file.exists():
        return None
    try:
        payload = _read_json(cache_file)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("signature") != _income_expense_series_cache_signature():
        return None
    response = payload.get("response")
    return response if isinstance(response, dict) else None


def _write_income_expense_series_cache(response: dict[str, Any]) -> None:
    try:
        _write_json(
            get_spiir_income_expense_series_cache_file(),
            {
                "signature": _income_expense_series_cache_signature(),
                "cached_at": _iso_utc_now(),
                "response": response,
            },
        )
    except OSError:
        return


def load_spiir_income_expense_series() -> dict[str, Any]:
    cached = _read_income_expense_series_cache()
    if cached is not None:
        return {**cached, "generated_at": _iso_utc_now()}

    overview_file = get_spiir_overview_file()
    if not overview_file.exists():
        raise FileNotFoundError(f"Missing Spiir processed overview: {overview_file}")
    payload = _read_json(overview_file)
    if not isinstance(payload, dict):
        raise ValueError("Spiir processed overview is invalid")
    response = _build_income_expense_series_from_overview(payload)
    _write_income_expense_series_cache(response)
    return response


def _nan_to_none(value: Any) -> Any:
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, list):
        return [_nan_to_none(item) for item in value]
    if isinstance(value, dict):
        return {key: _nan_to_none(item) for key, item in value.items()}
    return value


def _extract_hashtags(value: Any) -> list[str]:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return []
    text = str(value)
    if "#" not in text:
        return []
    seen: set[str] = set()
    hashtags: list[str] = []
    for match in HASHTAG_RE.finditer(text):
        tag = (match.group(1) or "").strip().lower()
        if not tag or tag in seen:
            continue
        seen.add(tag)
        hashtags.append(tag)
    return hashtags


def _normalize_hashtags(value: Any) -> list[str]:
    if value is None:
        return []
    raw_values = value if isinstance(value, list) else [value]
    seen: set[str] = set()
    hashtags: list[str] = []
    for item in raw_values:
        tag = str(item or "").strip().lstrip("#").lower()
        if not tag or tag in seen:
            continue
        if not re.fullmatch(r"[0-9A-Za-z_æøåÆØÅ-]+", tag):
            continue
        seen.add(tag)
        hashtags.append(tag)
    return hashtags


def _append_hashtags_to_comment(comment: Any, hashtags: Any) -> str:
    text = str(comment or "").strip()
    existing = set(_extract_hashtags(text))
    missing = [tag for tag in _normalize_hashtags(hashtags) if tag not in existing]
    if not missing:
        return text
    suffix = " ".join(f"#{tag}" for tag in missing)
    return f"{text} {suffix}".strip()


def _remove_hashtags_from_comment(comment: Any, hashtags: Any) -> str:
    text = str(comment or "")
    for tag in _normalize_hashtags(hashtags):
        pattern = re.compile(rf"(?<![0-9A-Za-z_æøåÆØÅ-])#{re.escape(tag)}(?![0-9A-Za-z_æøåÆØÅ-])", re.I)
        text = pattern.sub("", text)
    return re.sub(r"[ \t]{2,}", " ", text).strip()


def _make_period_overview(df: pd.DataFrame, periods: list[str], period_column: str) -> dict[str, Any]:
    filtered = df[df[period_column].isin(periods)]
    by_main = filtered.groupby(["mainCategoryName", period_column])["amount"].sum().unstack(fill_value=0)
    by_cat = filtered.groupby(["mainCategoryName", "categoryName", "categoryId", period_column])["amount"].sum().unstack(fill_value=0)
    income = filtered[filtered["categoryType"] == "Income"].groupby([period_column])["amount"].sum()
    expense = filtered[filtered["categoryType"] == "Expense"].groupby([period_column])["amount"].sum()

    rows: list[dict[str, Any]] = []

    def add_row(key: str, label: str, level: int, parent: str | None, values: dict[str, float], meta: dict[str, Any] | None = None) -> None:
        period_values = {period: _format_int(values.get(period, 0)) for period in periods}
        row = {
            "key": key,
            "label": label,
            "level": level,
            "parent": parent,
            "values": period_values,
            "total": sum(period_values.values()),
            "avg": int(round(sum(period_values.values()) / len(periods))) if periods else 0,
        }
        if meta:
            row.update(meta)
        rows.append(row)

    add_row("diff", "Diff", 0, None, {period: income.get(period, 0) + expense.get(period, 0) for period in periods}, {"kind": "diff"})
    add_row("income", "Indkomst", 0, None, income.to_dict(), {"kind": "income", "categoryType": "Income"})

    income_df = filtered[filtered["categoryType"] == "Income"]
    income_main_name = None
    income_main_id = None
    if len(income_df):
        income_main_name = income_df.iloc[0]["mainCategoryName"]
        income_main_id = income_df.iloc[0]["mainCategoryId"]
        income_by_cat = income_df.groupby(["categoryName", "categoryId", period_column])["amount"].sum().unstack(fill_value=0)
        for (category_name, category_id), row_values in income_by_cat.groupby(level=[0, 1]).sum().iterrows():
            add_row(
                f"sub:income:{category_id}",
                str(category_name),
                1,
                "income",
                row_values.to_dict(),
                {
                    "kind": "sub",
                    "mainCategoryName": income_main_name,
                    "mainCategoryId": income_main_id,
                    "categoryName": str(category_name),
                    "categoryId": category_id,
                },
            )

    add_row("expense", "Expense", 0, None, expense.to_dict(), {"kind": "expense", "categoryType": "Expense"})

    for main_name in by_main.index:
        if income_main_name and main_name == income_main_name:
            continue
        sample = filtered[filtered["mainCategoryName"] == main_name]
        main_id = sample.iloc[0]["mainCategoryId"] if len(sample) else None
        add_row(
            f"main:{main_name}",
            str(main_name),
            1,
            "expense",
            by_main.loc[main_name].to_dict(),
            {"kind": "main", "mainCategoryName": main_name, "mainCategoryId": main_id},
        )

        if main_name not in by_cat.index.get_level_values(0):
            continue
        sub = by_cat.loc[main_name]
        if isinstance(sub, pd.Series):
            continue
        for (category_name, category_id), row_values in sub.groupby(level=[0, 1]).sum().iterrows():
            add_row(
                f"sub:{main_name}:{category_id}",
                str(category_name),
                2,
                f"main:{main_name}",
                row_values.to_dict(),
                {
                    "kind": "sub",
                    "mainCategoryName": main_name,
                    "categoryName": str(category_name),
                    "categoryId": category_id,
                },
            )

    tags = filtered["comment"].apply(_extract_hashtags)
    if "hashtags" in filtered.columns:
        tags = filtered["hashtags"].apply(lambda value: value if isinstance(value, list) else _extract_hashtags(value))
    mask = tags.apply(bool)
    if mask.any():
        tagged = filtered.loc[mask].copy()
        tagged["hashtags"] = tags.loc[mask]
        add_row("hashtag", "Hashtag", 0, None, tagged.groupby([period_column])["amount"].sum().to_dict(), {"kind": "hashtag"})
        exploded = tagged[[period_column, "amount", "hashtags"]].explode("hashtags").rename(columns={"hashtags": "hashtag"})
        by_tag = exploded.groupby(["hashtag", period_column])["amount"].sum().unstack(fill_value=0)
        totals = by_tag.sum(axis=1).to_dict()
        sorted_tags = sorted(
            by_tag.index,
            key=lambda tag: (
                0 if totals.get(tag, 0) < 0 else 1,
                totals.get(tag, 0) if totals.get(tag, 0) < 0 else -totals.get(tag, 0),
                str(tag),
            ),
        )
        for tag in sorted_tags:
            add_row(
                f"tag:{tag}",
                f"#{tag}",
                1,
                "hashtag",
                by_tag.loc[tag].to_dict(),
                {"kind": "hashtag_item", "hashtag": tag},
            )

    return {"periods": periods, "rows": rows}


def _classify_shop(text: str) -> str:
    for name, rule in SHOP_RULES:
        if rule.search(text or ""):
            return name
    return "Unknown"


def _build_shopping(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    grocery = df[df["categoryName"] == "Dagligvarer"].copy()
    if len(grocery) == 0:
        return grocery, pd.DataFrame(), {"unknownTop": [], "suspects": []}

    grocery["shop"] = grocery.apply(
        lambda row: _classify_shop(f"{row.get('originalDescription') or ''} {row.get('description') or ''}"),
        axis=1,
    )

    by_month = grocery.groupby(["yyyymm", "shop"])["amount"].sum().reset_index()
    by_month["amount"] = -by_month["amount"]

    unknown = grocery[grocery["shop"] == "Unknown"].copy()
    if len(unknown):
        unknown["desc_key"] = unknown.apply(
            lambda row: (row.get("originalDescription") or row.get("description") or "").strip(),
            axis=1,
        )
        unknown_top = unknown.groupby(["desc_key"])["amount"].sum().reset_index()
        unknown_top["amount"] = -unknown_top["amount"]
        unknown_top = unknown_top.sort_values("amount", ascending=False).head(30)
    else:
        unknown_top = pd.DataFrame(columns=["desc_key", "amount"])

    non_grocery = df[df["categoryName"] != "Dagligvarer"].copy()
    if len(non_grocery) == 0:
        return grocery, by_month, {
            "unknownTop": unknown_top.to_dict(orient="records"),
            "suspects": [],
        }

    suspects = non_grocery[
        non_grocery.apply(
            lambda row: any(
                rule.search(f"{row.get('originalDescription') or ''} {row.get('description') or ''}")
                for rule in GROCERY_HINT_RULES
            ),
            axis=1,
        )
    ].copy()
    suspects = suspects[suspects["categoryType"] == "Expense"]
    suspects["amount_pos"] = -suspects["amount"]
    suspect_rows = [
        {
            "date": row["yyyymmdd"],
            "amount": _format_int(-row["amount"]),
            "description": row["description"],
            "mainCategoryName": row["mainCategoryName"],
            "categoryName": row["categoryName"],
            "categoryId": row["categoryId"],
            "mainCategoryId": row["mainCategoryId"],
            "yyyymm": row["yyyymm"],
        }
        for _, row in suspects.sort_values("amount_pos", ascending=False).head(50).iterrows()
    ]

    return grocery, by_month, {
        "unknownTop": unknown_top.to_dict(orient="records"),
        "suspects": suspect_rows,
    }


def _build_transactions_payload(df: pd.DataFrame) -> list[dict[str, Any]]:
    if len(df) == 0:
        return []
    records = []
    for _, row in df.iterrows():
        records.append(
            {
                "yyyymm": row["yyyymm"],
                "year": row["year"],
                "ymd": row["yyyymmdd"],
                "amount": _format_int(row["amount"]),
                "categoryType": row["categoryType"],
                "mainCategoryName": row["mainCategoryName"],
                "categoryName": row["categoryName"],
                "categoryId": row["categoryId"],
                "mainCategoryId": row["mainCategoryId"],
                "description": row["description"],
                "comment": row["comment"],
                "hashtags": row["hashtags"] if isinstance(row.get("hashtags"), list) else _extract_hashtags(row["comment"]),
            }
        )
    return _nan_to_none(records)


def _default_processed_source() -> str:
    return "local" if get_spiir_local_transactions_file().exists() else "raw"


def rebuild_spiir_processed(source: str = "raw") -> dict[str, Any]:
    _ensure_spiir_dirs()
    raw_file = get_spiir_raw_export_file()
    local_transactions_file = get_spiir_local_transactions_file()
    normalized_source = str(source or "raw").strip().lower()
    _log_update(f"start source={normalized_source}")

    if normalized_source == "local":
        if not local_transactions_file.exists():
            _log_update(f"missing local_ledger={local_transactions_file}")
            raise FileNotFoundError(f"Missing Spiir local ledger transactions: {local_transactions_file}")
        df = _load_entries_from_local_ledger(local_transactions_file)
    else:
        if not raw_file.exists():
            _log_update(f"missing raw_export={raw_file}")
            raise FileNotFoundError(f"Missing Spiir raw export: {raw_file}")
        df = _load_entries(raw_file)
    _, _, shopping_extras = _build_shopping(df)

    months = sorted(df["yyyymm"].unique()) if len(df) else []
    years = sorted(df["year"].unique()) if len(df) else []
    overview_payload = {
        "generated_at": _iso_utc_now(),
        "monthly": _make_period_overview(df, months, "yyyymm"),
        "yearly": _make_period_overview(df, years, "year"),
        "shopping_extras": _nan_to_none(shopping_extras),
    }
    transactions_payload = _build_transactions_payload(df)
    _write_json(get_spiir_overview_file(), overview_payload)
    _write_json(get_spiir_transactions_file(), transactions_payload)
    clear_spiir_rebuild_required()
    _log_update(
        "done "
        f"transactions={len(transactions_payload)} generated_at={overview_payload['generated_at']} source={normalized_source}"
    )
    return {
        "source": normalized_source,
        "generated_at": overview_payload["generated_at"],
        "transaction_count": len(transactions_payload),
    }


def _load_or_rebuild_json(path: Path, rebuild: bool) -> Any:
    if not path.exists():
        if not rebuild:
            raise FileNotFoundError(path)
        default_source = _default_processed_source()
        if default_source == "local":
            raise FileNotFoundError(path)
        rebuild_spiir_processed(source=default_source)
    return _read_json(path)


def load_spiir_overview() -> dict[str, Any]:
    return _load_or_rebuild_json(get_spiir_overview_file(), rebuild=True)


def load_spiir_transactions() -> list[dict[str, Any]]:
    return _load_or_rebuild_json(get_spiir_transactions_file(), rebuild=True)


def get_spiir_status() -> dict[str, Any]:
    overview = _read_json(get_spiir_overview_file()) if get_spiir_overview_file().exists() else None
    transactions = _read_json(get_spiir_transactions_file()) if get_spiir_transactions_file().exists() else None
    raw_file = get_spiir_raw_export_file()
    rebuild_state = load_spiir_rebuild_state()
    processed_exists = get_spiir_overview_file().exists() and get_spiir_transactions_file().exists()
    local_ledger_exists = get_spiir_local_transactions_file().exists()
    rebuild_required = bool(rebuild_state.get("rebuild_required")) or (local_ledger_exists and not processed_exists)
    rebuild_reason = rebuild_state.get("rebuild_reason")
    if rebuild_required and not rebuild_reason and local_ledger_exists and not processed_exists:
        rebuild_reason = "processed_missing"
    return {
        "raw_exists": raw_file.exists(),
        "processed_exists": processed_exists,
        "raw_file": str(raw_file),
        "processed_dir": str(get_spiir_processed_dir()),
        "generated_at": overview.get("generated_at") if isinstance(overview, dict) else None,
        "transaction_count": len(transactions) if isinstance(transactions, list) else 0,
        "update_log_file": str(get_spiir_update_log_file()),
        "rebuild_required": rebuild_required,
        "rebuild_marked_at": rebuild_state.get("rebuild_marked_at"),
        "rebuild_reason": rebuild_reason,
    }


def read_spiir_update_log() -> str:
    log_file = get_spiir_update_log_file()
    if not log_file.exists():
        return ""
    return log_file.read_text(encoding="utf-8")
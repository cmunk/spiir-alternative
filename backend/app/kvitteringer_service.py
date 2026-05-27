from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import statistics
import tempfile
import threading
import unicodedata
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any

from .config import (
    get_kvitteringer_category_overrides_file,
    get_kvitteringer_db_path,
    get_storebox_source_dir,
)
from .storage import create_backup, ensure_runtime_dirs

SCHEMA_VERSION = "2026-04-12"
SCHEMA_LOCK = threading.Lock()
STOREBOX_UPLOAD_FILENAME = "receipts-upload.json"
STOREBOX_STATIC_SUPPLEMENT_FILENAMES = {"receipts-netto-dump-missing.json"}
DISCOUNT_PREFIX = "RABAT"
GROCERY_MERCHANT_KEYS = {
    "aldi",
    "bilka",
    "foetex",
    "fakta",
    "irma",
    "kvickly",
    "lidl",
    "meny",
    "nemlig",
    "netto",
    "rema1000",
    "rema",
    "superbrugsen",
}
MERCHANT_GROUP_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("Netto", re.compile(r"\bnetto\b", re.I)),
    ("Rema 1000", re.compile(r"\brema\s*1000\b|\brema1000\b", re.I)),
    ("Meny", re.compile(r"\bmeny\b", re.I)),
]
VARIANT_PATTERNS = [
    re.compile(r"\b\d+(?:[.,]\d+)?\s?(?:KG|G|GRAM|GR)\b", re.I),
    re.compile(r"\b\d+(?:[.,]\d+)?\s?(?:L|DL|CL|ML)\b", re.I),
    re.compile(r"\b\d+\s?(?:STK|PK|POSER|RUL|BREVE|TAB|KAPSLER)\b", re.I),
    re.compile(r"\b\d+\s?(?:M/L|XL|L|M|S)\b", re.I),
]
ECO_MARKERS = {"ØKO", "ØKOLOGISK", "ØKOLOGISKE"}
EGG_ECO_MARKERS = ECO_MARKERS | {"ØGO"}
SAFE_CUCUMBER_TOKENS = ECO_MARKERS | {"AGURK", "AGURKER", "DK", "DANSK", "UDL", "GB", "STK"}
EGG_COUNT_TOKENS = {"4", "6", "8", "10", "12", "15", "20", "30"}
DISQUALIFY_EGG_TOKENS = {"FRILANDSÆG", "JUMBO", "MORGENÆG", "HEDEG", "MADSPILD"}
SPIIR_LINK_REASON = "same_day_exact_amount_merchant_match"
RECEIPT_BASKET_OUTLIER_FACTOR = Decimal("1.8")
CATEGORY_LABELS = {
    "bolig": "Bolig",
    "broed_bager": "Brød/Bager",
    "drikke": "Drikke",
    "frost": "Frost",
    "frugt": "Frugt",
    "groentsager": "Grøntsager",
    "husholdning": "Husholdning",
    "kolonial": "Kolonial",
    "koed": "Kød",
    "legetoej": "Legetøj",
    "mejeri": "Mejeri",
    "paalaeg": "Pålæg",
    "refund": "Retur",
    "slik": "Slik",
    "uncategorized": "Uden type",
}
CATEGORY_ORDER = [
    "mejeri",
    "koed",
    "paalaeg",
    "groentsager",
    "frugt",
    "broed_bager",
    "drikke",
    "kolonial",
    "slik",
    "frost",
    "husholdning",
    "bolig",
    "legetoej",
    "refund",
    "uncategorized",
]
CATEGORY_CODE_FALLBACKS = {
    "80": "kolonial",
    "81": "kolonial",
    "84": "drikke",
    "87": "slik",
    "88": "husholdning",
    "89": "groentsager",
    "90": "koed",
    "92": "paalaeg",
    "93": "drikke",
    "96": "paalaeg",
    "97": "frost",
    "112": "slik",
    "120": "frost",
    "130": "broed_bager",
    "293": "mejeri",
    "294": "mejeri",
    "295": "koed",
    "296": "paalaeg",
    "591": "paalaeg",
    "594": "mejeri",
    "598": "paalaeg",
}
NAME_TOKEN_PATTERN = re.compile(r"[0-9A-ZÆØÅ]+")
LEGETOEJ_FRAGMENTS = {
    "BARBIE",
    "BAMSE",
    "DUKKE",
    "LEGETØJ",
    "LEGO",
    "NERF",
    "PLAYMOBIL",
    "POLITIBIL",
    "PUSLESPIL",
}
BOLIG_FRAGMENTS = {
    "BORD",
    "DYNE",
    "GARDEROB",
    "GARDIN",
    "HYLDE",
    "KOMMODE",
    "KONTORSTOL",
    "LAMP",
    "MADRAS",
    "PUDE",
    "REOL",
    "SENG",
    "SKAB",
    "SKUMMADRAS",
    "SOFA",
    "SPEJL",
    "STOL",
    "UNDERSENG",
}
HUSHOLDNING_FRAGMENTS = {
    "AFFALDSPOS",
    "ALUFOIL",
    "BAGEPAPIR",
    "BALSAM",
    "BIND",
    "BABYBLE",
    "BLEER",
    "DEODORANT",
    "KØKKENRULLE",
    "OPVASK",
    "PAPIRHÅNDKLÆDE",
    "RENGØR",
    "SERVIET",
    "SHAMPOO",
    "SÆBE",
    "TAMPON",
    "TANDPASTA",
    "TOILETPAPIR",
    "VASKEMIDDEL",
    "WC BLOK",
}
FROST_FRAGMENTS = {"FROSSEN", "FROSNE", "FROST", "FRYS"}
BROED_BAGER_FRAGMENTS = {
    "BAGEL",
    "BOLLE",
    "BOLLER",
    "BRØD",
    "CROISSANT",
    "FRANSKBRØD",
    "KNÆKBRØD",
    "PITA",
    "RUGBRØD",
    "TOAST",
    "WRAP",
}
PAALAEG_FRAGMENTS = {
    "BRIE",
    "CHORIZO",
    "FLØDEOST",
    "GOUDA",
    "HUMMUS",
    "LAKS",
    "LEVERPOSTEJ",
    "MOZZARELLA",
    "OST",
    "PÅLÆG",
    "PEPPERONI",
    "PØLSE",
    "SALAMI",
    "SKINKE",
}
KOED_FRAGMENTS = {
    "BACON",
    "CULOTTE",
    "FILET",
    "FLÆSK",
    "GRIS",
    "HAKKET",
    "KØD",
    "KYLLING",
    "MEDISTER",
    "OKSE",
    "SVIN",
}
MEJERI_FRAGMENTS = {
    "CREME FRAICHE",
    "FLØDE",
    "HAVREDRIK",
    "HYTTEOST",
    "KEFIR",
    "KVARK",
    "MÆLK",
    "SKYR",
    "SMØR",
    "YMER",
    "YOGH",
    "YOGHURT",
    "ÆG",
}
DRIKKE_FRAGMENTS = {
    "COLA",
    "DRIK",
    "ENERGIDRIK",
    "FANTA",
    "ISTE",
    "JUICE",
    "KAKAO",
    "LIMONADE",
    "SAFT",
    "SMOOTHIE",
    "SODAVAND",
    "SPRITE",
    "VAND",
    "VIN",
    "ØL",
}
FRUGT_FRAGMENTS = {
    "ANANAS",
    "APPELSIN",
    "AVOCADO",
    "BANAN",
    "BLÅBÆR",
    "CITRON",
    "CLEMENTIN",
    "DRUE",
    "HINDBÆR",
    "JORDBÆR",
    "KIWI",
    "LIME",
    "MANDARIN",
    "MANGO",
    "MELON",
    "PÆRE",
    "ÆBLE",
}
GROENTSAGER_FRAGMENTS = {
    "AGURK",
    "BLOMKÅL",
    "BROCCOLI",
    "CHAMPIGNON",
    "GULERØD",
    "KARTOFFEL",
    "KÅL",
    "LØG",
    "PEBERFRUGT",
    "RUCOLA",
    "SALAT",
    "SPINAT",
    "SQUASH",
    "TOMAT",
}
SLIK_FRAGMENTS = {
    "BOLSJE",
    "CHIPS",
    "CHOKOLADE",
    "COOKIE",
    "COOKIES",
    "FAZERMINT",
    "KARAMEL",
    "KEKS",
    "LAKRIDS",
    "MARCIPAN",
    "TYGGEGUMMI",
    "VINGUMMI",
}
KOLONIAL_FRAGMENTS = {
    "BØNNER",
    "BULGUR",
    "DÅSETOMAT",
    "EDDIKE",
    "HAVREGRYN",
    "KETCHUP",
    "KOKOSMÆLK",
    "KRYDDERI",
    "KAKAOPULVER",
    "LINSER",
    "MAYONNAISE",
    "MEL",
    "NUDLER",
    "OLIE",
    "OLIVENOLIE",
    "PASTA",
    "PASSATA",
    "PULVER",
    "QUINOA",
    "REMOULADE",
    "RIS",
    "ROSINER",
    "SALT",
    "SENNEP",
    "SUKKER",
}


@dataclass(frozen=True)
class ReceiptCandidate:
    receipt_id: str
    source_file: Path
    source_mtime: float
    raw_receipt: dict[str, Any]


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _slugify(value: str | None) -> str:
    if not value:
        return "unknown"
    normalized = unicodedata.normalize("NFKD", value)
    ascii_like = "".join(character for character in normalized if not unicodedata.combining(character))
    slug = re.sub(r"[^A-Za-z0-9]+", "-", ascii_like).strip("-").lower()
    return slug or "unknown"


def _normalize_name(value: str | None) -> str:
    if value is None:
        return ""
    normalized = unicodedata.normalize("NFKC", value).strip()
    normalized = re.sub(r"[‐‑‒–—―_/]+", " ", normalized)
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized.upper()


def _variant_signature(normalized_name: str) -> str:
    tokens: set[str] = set()
    for pattern in VARIANT_PATTERNS:
        for match in pattern.finditer(normalized_name):
            tokens.add(match.group(0).replace(" ", ""))
    return "|".join(sorted(tokens))


def _extract_size_class(normalized_name: str) -> str | None:
    if re.search(r"\bS\s+M\b", normalized_name):
        return "S/M"
    if re.search(r"\bM\s+L\b", normalized_name):
        return "M/L"
    if re.search(r"\bL\s+(?:XL|X)\b", normalized_name):
        return "L/XL"
    if re.search(r"\bXL\b", normalized_name):
        return "XL"
    if re.search(r"\bL\b", normalized_name):
        return "L"
    if re.search(r"\bM\b", normalized_name):
        return "M"
    if re.search(r"\bS\b", normalized_name):
        return "S"
    return None


def _high_confidence_semantic_key(normalized_name: str) -> str | None:
    tokens = re.findall(r"[0-9A-ZÆØÅ]+", normalized_name)
    token_set = set(tokens)

    if token_set & ECO_MARKERS and token_set & {"AGURK", "AGURKER"}:
        if token_set.issubset(SAFE_CUCUMBER_TOKENS):
            return "semantic:ØKO AGURK"

    if not (token_set & EGG_ECO_MARKERS and "ÆG" in token_set):
        return None
    if token_set & DISQUALIFY_EGG_TOKENS:
        return None

    count = next((token for token in tokens if token in EGG_COUNT_TOKENS), None)
    if count:
        return f"semantic:ØKO ÆG:{count}"
    return None


def _normalize_category_key(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if not normalized:
        return ""
    if normalized.isdigit():
        return str(int(normalized))
    return normalized


def _contains_any_fragment(normalized_name: str, fragments: set[str]) -> bool:
    return any(fragment in normalized_name for fragment in fragments)


def _classify_cluster_category(
    *,
    preferred_display_name: str,
    normalized_name: str,
    raw_category_counts: dict[str, int] | None,
) -> tuple[str, str, str]:
    category_counts = {
        _normalize_category_key(category_key): count
        for category_key, count in (raw_category_counts or {}).items()
        if _normalize_category_key(category_key)
    }
    normalized_display_name = normalized_name or _normalize_name(preferred_display_name)
    normalized_category_keys = set(category_counts)
    tokens = set(NAME_TOKEN_PATTERN.findall(normalized_display_name))

    if "refund" in normalized_category_keys or "PANT" in tokens or "RETUR" in tokens:
        return "refund", "taxonomy_name", "high"
    if _contains_any_fragment(normalized_display_name, LEGETOEJ_FRAGMENTS):
        return "legetoej", "taxonomy_name", "high"
    if _contains_any_fragment(normalized_display_name, BOLIG_FRAGMENTS):
        return "bolig", "taxonomy_name", "high"
    if _contains_any_fragment(normalized_display_name, HUSHOLDNING_FRAGMENTS):
        return "husholdning", "taxonomy_name", "high"
    if _contains_any_fragment(normalized_display_name, FROST_FRAGMENTS):
        return "frost", "taxonomy_name", "high"
    if _contains_any_fragment(normalized_display_name, BROED_BAGER_FRAGMENTS):
        return "broed_bager", "taxonomy_name", "high"
    if _contains_any_fragment(normalized_display_name, PAALAEG_FRAGMENTS):
        return "paalaeg", "taxonomy_name", "high"
    if _contains_any_fragment(normalized_display_name, KOED_FRAGMENTS):
        return "koed", "taxonomy_name", "high"
    if _contains_any_fragment(normalized_display_name, MEJERI_FRAGMENTS):
        return "mejeri", "taxonomy_name", "high"
    if _contains_any_fragment(normalized_display_name, DRIKKE_FRAGMENTS):
        return "drikke", "taxonomy_name", "high"
    if _contains_any_fragment(normalized_display_name, FRUGT_FRAGMENTS):
        return "frugt", "taxonomy_name", "high"
    if _contains_any_fragment(normalized_display_name, GROENTSAGER_FRAGMENTS):
        return "groentsager", "taxonomy_name", "high"
    if _contains_any_fragment(normalized_display_name, SLIK_FRAGMENTS):
        return "slik", "taxonomy_name", "high"
    if _contains_any_fragment(normalized_display_name, KOLONIAL_FRAGMENTS):
        return "kolonial", "taxonomy_name", "high"

    for raw_category in sorted(category_counts, key=lambda key: (-category_counts[key], key)):
        fallback_category = CATEGORY_CODE_FALLBACKS.get(raw_category)
        if fallback_category:
            return fallback_category, "taxonomy_code", "medium"

    return "uncategorized", "taxonomy_fallback", "low"


def _to_minor(value: Any) -> int:
    decimal_value = Decimal(str(value or 0))
    return int((decimal_value * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _count_non_null_fields(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, dict):
        return sum(_count_non_null_fields(item) for item in value.values())
    if isinstance(value, list):
        return sum(_count_non_null_fields(item) for item in value)
    if value == "":
        return 0
    return 1


def _parse_purchase_timestamp(raw_receipt: dict[str, Any]) -> tuple[str, str, str | None, int | None]:
    raw_timestamp = raw_receipt.get("purchaseDateTimeString")
    epoch_raw = raw_receipt.get("purchaseDate")
    if raw_timestamp:
        parsed = datetime.fromisoformat(str(raw_timestamp).replace("Z", "+00:00"))
    elif epoch_raw is not None:
        parsed = datetime.fromtimestamp(int(epoch_raw) / 1000, tz=UTC)
        raw_timestamp = parsed.isoformat().replace("+00:00", "Z")
    else:
        raise ValueError("Receipt is missing purchase timestamp")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    utc_timestamp = parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")
    return utc_timestamp, parsed.astimezone(UTC).date().isoformat(), raw_timestamp, int(epoch_raw) if epoch_raw is not None else None


def _merchant_group(display_name: str, merchant_key: str) -> str | None:
    normalized_name = _normalize_name(display_name)
    for group_name, pattern in MERCHANT_GROUP_RULES:
        if pattern.search(display_name) or pattern.search(normalized_name) or pattern.search(merchant_key):
            return group_name
    return display_name or None


def _is_grocery_merchant(merchant_key: str, display_name: str) -> bool:
    if merchant_key.lower() in GROCERY_MERCHANT_KEYS:
        return True
    normalized_name = _normalize_name(display_name)
    return any(pattern.search(normalized_name) for _, pattern in MERCHANT_GROUP_RULES)


def _coerce_quantity(count_raw: Any, total_price_minor: int, is_discount_line: bool) -> float:
    if count_raw is None:
        return 1.0 if not is_discount_line else 1.0
    try:
        quantity = float(count_raw)
    except (TypeError, ValueError):
        return 1.0
    if quantity == 0:
        return 1.0 if total_price_minor >= 0 else quantity
    return quantity


def _safe_unit_price_minor(net_total_minor: int, quantity: float) -> int | None:
    if quantity == 0:
        return None
    decimal_value = (Decimal(net_total_minor) / Decimal(str(quantity))).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return int(decimal_value)


def _occurrence_id(receipt_id: str, line_index: int) -> str:
    return f"{receipt_id}:{line_index}"


def _cluster_key(product_number: str | None, normalized_name: str, variant_signature: str) -> tuple[str, str, str]:
    semantic_key = _high_confidence_semantic_key(normalized_name)
    if semantic_key:
        return semantic_key, "semantic_name", "high"
    if product_number:
        return f"product:{product_number}", "product_number", "high"
    return f"name:{normalized_name}|{variant_signature}", "normalized_name", "medium"


def _cluster_id(cluster_key: str) -> str:
    return hashlib.sha1(cluster_key.encode("utf-8")).hexdigest()[:16]


def _item_key(merchant_key: str, product_number: str | None, normalized_name: str, variant_signature: str) -> str:
    if product_number:
        return product_number
    return f"{merchant_key}|{normalized_name}|{variant_signature}"


def _receipt_hash(raw_receipt: dict[str, Any]) -> str:
    payload = json.dumps(raw_receipt, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _best_candidate(candidates: list[ReceiptCandidate]) -> ReceiptCandidate:
    return max(
        candidates,
        key=lambda candidate: (
            _count_non_null_fields(candidate.raw_receipt),
            len(candidate.raw_receipt.get("receiptLines") or []),
            candidate.source_mtime,
        ),
    )


def _semantic_receipt_identity_key(raw_receipt: dict[str, Any]) -> tuple[str, str, int, str] | None:
    merchant_payload = raw_receipt.get("merchant") or {}
    merchant_name_raw = (merchant_payload.get("name") or raw_receipt.get("merchantName") or "").strip()
    merchant_id_raw = merchant_payload.get("merchantId")
    merchant_key = _slugify(str(merchant_id_raw or merchant_name_raw))
    if merchant_key == "unknown":
        return None
    try:
        purchase_timestamp, _, _, _ = _parse_purchase_timestamp(raw_receipt)
    except (TypeError, ValueError):
        return None
    receipt_total_minor = _to_minor(((raw_receipt.get("price") or {}).get("amount")) or 0)
    currency = str(((raw_receipt.get("price") or {}).get("currency")) or "DKK").upper()
    return merchant_key, purchase_timestamp, receipt_total_minor, currency


def _database_exists() -> bool:
    return get_kvitteringer_db_path().exists() and get_kvitteringer_db_path().is_file()


def _schema_exists(connection: sqlite3.Connection) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kvitteringer_meta' LIMIT 1"
    ).fetchone()
    return row is not None


def _schema_version(connection: sqlite3.Connection) -> str | None:
    if not _schema_exists(connection):
        return None
    try:
        row = connection.execute(
            "SELECT value FROM kvitteringer_meta WHERE key = 'schema_version'"
        ).fetchone()
    except sqlite3.OperationalError:
        return None
    if row is None:
        return None
    return str(row[0]) if row[0] is not None else None


def _open_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(get_kvitteringer_db_path(), timeout=30.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 30000")
    return connection


def _delete_database_files() -> None:
    database_path = get_kvitteringer_db_path()
    for path in [
        database_path,
        Path(f"{database_path}-shm"),
        Path(f"{database_path}-wal"),
    ]:
        path.unlink(missing_ok=True)


def _purge_outdated_database_file() -> bool:
    database_path = get_kvitteringer_db_path()
    if not database_path.exists():
        return False
    try:
        with sqlite3.connect(database_path, timeout=30.0) as connection:
            version = _schema_version(connection)
    except sqlite3.DatabaseError:
        version = None
    if version == SCHEMA_VERSION:
        return False
    _delete_database_files()
    return True


def _connect() -> sqlite3.Connection:
    ensure_runtime_dirs()
    connection = _open_connection()
    if not _schema_exists(connection) or _schema_version(connection) != SCHEMA_VERSION:
        with SCHEMA_LOCK:
            if _schema_exists(connection) and _schema_version(connection) != SCHEMA_VERSION:
                connection.close()
                _purge_outdated_database_file()
                connection = _open_connection()
            if not _schema_exists(connection) or _schema_version(connection) != SCHEMA_VERSION:
                _ensure_schema(connection)
    return connection


def _ensure_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS kvitteringer_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS import_run (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            source_path TEXT NOT NULL,
            source_type TEXT NOT NULL,
            status TEXT NOT NULL,
            notes TEXT,
            source_file_count INTEGER NOT NULL DEFAULT 0,
            deduplicated_receipt_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS raw_receipt (
            raw_receipt_id INTEGER PRIMARY KEY AUTOINCREMENT,
            receipt_id TEXT NOT NULL UNIQUE,
            import_run_id INTEGER NOT NULL,
            source_file TEXT NOT NULL,
            source_type TEXT NOT NULL,
            raw_hash TEXT NOT NULL,
            purchase_datetime_raw TEXT,
            purchase_date_epoch_raw INTEGER,
            merchant_id_raw TEXT,
            merchant_name_raw TEXT,
            total_amount_raw REAL,
            line_count_raw INTEGER NOT NULL,
            FOREIGN KEY(import_run_id) REFERENCES import_run(id)
        );

        CREATE TABLE IF NOT EXISTS merchant (
            merchant_key TEXT PRIMARY KEY,
            merchant_id_raw TEXT,
            display_name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            merchant_group TEXT,
            is_grocery INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS merchant_alias (
            alias_key TEXT PRIMARY KEY,
            merchant_key TEXT NOT NULL,
            raw_merchant_id TEXT,
            raw_name TEXT,
            normalized_name TEXT NOT NULL,
            first_seen_receipt_id TEXT,
            last_seen_receipt_id TEXT,
            FOREIGN KEY(merchant_key) REFERENCES merchant(merchant_key)
        );

        CREATE TABLE IF NOT EXISTS receipt (
            receipt_id TEXT PRIMARY KEY,
            merchant_key TEXT NOT NULL,
            purchase_timestamp TEXT NOT NULL,
            purchase_date TEXT NOT NULL,
            currency TEXT NOT NULL,
            receipt_total_minor INTEGER NOT NULL,
            parsed_item_total_minor INTEGER NOT NULL,
            attributed_discount_total_minor INTEGER NOT NULL,
            unassigned_discount_total_minor INTEGER NOT NULL,
            gap_minor INTEGER NOT NULL,
            source_type TEXT NOT NULL,
            has_ambiguous_discount_block INTEGER NOT NULL DEFAULT 0,
            raw_receipt_id INTEGER NOT NULL,
            FOREIGN KEY(merchant_key) REFERENCES merchant(merchant_key),
            FOREIGN KEY(raw_receipt_id) REFERENCES raw_receipt(raw_receipt_id)
        );

        CREATE TABLE IF NOT EXISTS receipt_line (
            receipt_id TEXT NOT NULL,
            line_index INTEGER NOT NULL,
            line_number_raw INTEGER,
            product_number_raw TEXT,
            name_raw TEXT,
            name_normalized TEXT NOT NULL,
            count_raw REAL,
            item_price_minor INTEGER,
            total_price_minor INTEGER,
            is_discount_line INTEGER NOT NULL,
            is_negative_non_discount_line INTEGER NOT NULL,
            PRIMARY KEY(receipt_id, line_index),
            FOREIGN KEY(receipt_id) REFERENCES receipt(receipt_id)
        );

        CREATE TABLE IF NOT EXISTS item_cluster (
            cluster_id TEXT PRIMARY KEY,
            preferred_display_name TEXT NOT NULL,
            cluster_key TEXT NOT NULL UNIQUE,
            product_number TEXT,
            normalized_name TEXT NOT NULL,
            variant_signature TEXT NOT NULL,
            collapse_strategy TEXT NOT NULL,
            confidence TEXT NOT NULL,
            is_manual INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS item_occurrence (
            occurrence_id TEXT PRIMARY KEY,
            receipt_id TEXT NOT NULL,
            merchant_key TEXT NOT NULL,
            purchase_timestamp TEXT NOT NULL,
            purchase_date TEXT NOT NULL,
            source_line_index INTEGER NOT NULL,
            product_number TEXT,
            display_name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            variant_signature TEXT NOT NULL,
            item_key TEXT NOT NULL,
            cluster_id TEXT NOT NULL,
            quantity REAL NOT NULL,
            gross_total_minor INTEGER NOT NULL,
            discount_minor INTEGER NOT NULL,
            net_total_minor INTEGER NOT NULL,
            unit_price_minor INTEGER,
            is_return INTEGER NOT NULL,
            is_refund INTEGER NOT NULL,
            category_key TEXT,
            FOREIGN KEY(receipt_id) REFERENCES receipt(receipt_id),
            FOREIGN KEY(merchant_key) REFERENCES merchant(merchant_key),
            FOREIGN KEY(cluster_id) REFERENCES item_cluster(cluster_id)
        );

        CREATE TABLE IF NOT EXISTS receipt_discount (
            receipt_id TEXT NOT NULL,
            line_index INTEGER NOT NULL,
            amount_minor INTEGER NOT NULL,
            attribution_status TEXT NOT NULL,
            attributed_occurrence_id TEXT,
            reason TEXT NOT NULL,
            PRIMARY KEY(receipt_id, line_index),
            FOREIGN KEY(receipt_id) REFERENCES receipt(receipt_id),
            FOREIGN KEY(attributed_occurrence_id) REFERENCES item_occurrence(occurrence_id)
        );

        CREATE TABLE IF NOT EXISTS item_alias (
            alias_key TEXT PRIMARY KEY,
            cluster_id TEXT NOT NULL,
            product_number TEXT,
            raw_name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            variant_signature TEXT NOT NULL,
            first_seen_receipt_id TEXT,
            last_seen_receipt_id TEXT,
            FOREIGN KEY(cluster_id) REFERENCES item_cluster(cluster_id)
        );

        CREATE TABLE IF NOT EXISTS category_assignment (
            cluster_id TEXT NOT NULL,
            category_key TEXT NOT NULL,
            source TEXT NOT NULL,
            confidence TEXT NOT NULL,
            PRIMARY KEY(cluster_id, category_key),
            FOREIGN KEY(cluster_id) REFERENCES item_cluster(cluster_id)
        );

        CREATE TABLE IF NOT EXISTS spiir_receipt_link (
            transaction_id TEXT PRIMARY KEY,
            receipt_id TEXT NOT NULL,
            confidence TEXT NOT NULL,
            reason TEXT NOT NULL,
            transaction_payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(receipt_id) REFERENCES receipt(receipt_id)
        );

        CREATE INDEX IF NOT EXISTS idx_receipt_purchase_date ON receipt(purchase_date);
        CREATE INDEX IF NOT EXISTS idx_receipt_merchant ON receipt(merchant_key);
        CREATE INDEX IF NOT EXISTS idx_receipt_merchant_date ON receipt(merchant_key, purchase_date);
        CREATE INDEX IF NOT EXISTS idx_occurrence_cluster_date ON item_occurrence(cluster_id, purchase_date);
        CREATE INDEX IF NOT EXISTS idx_occurrence_merchant_date ON item_occurrence(merchant_key, purchase_date);
        CREATE INDEX IF NOT EXISTS idx_occurrence_receipt_source_line ON item_occurrence(receipt_id, source_line_index);
        CREATE INDEX IF NOT EXISTS idx_occurrence_receipt_cluster ON item_occurrence(receipt_id, cluster_id);
        CREATE INDEX IF NOT EXISTS idx_discount_receipt ON receipt_discount(receipt_id);
        CREATE INDEX IF NOT EXISTS idx_item_alias_cluster_raw ON item_alias(cluster_id, raw_name);
        """
    )
    connection.execute(
        "INSERT INTO kvitteringer_meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (SCHEMA_VERSION,),
    )
    connection.commit()


def _clear_imported_tables(connection: sqlite3.Connection) -> None:
    for table_name in [
        "spiir_receipt_link",
        "category_assignment",
        "item_alias",
        "receipt_discount",
        "item_occurrence",
        "item_cluster",
        "receipt_line",
        "receipt",
        "merchant_alias",
        "merchant",
        "raw_receipt",
    ]:
        connection.execute(f"DELETE FROM {table_name}")


def _storebox_files(source_dir: Path) -> list[Path]:
    return sorted(path for path in source_dir.glob("receipts-*.json") if path.is_file())


def _validate_uploaded_storebox_receipts(content: bytes, filename: str) -> list[dict[str, Any]]:
    if not content:
        raise ValueError("Uploaded Storebox JSON is empty")
    try:
        payload = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in {filename}: {exc.msg}") from exc
    if not isinstance(payload, list):
        raise ValueError(f"Expected receipt array in {filename}")
    if any(not isinstance(receipt, dict) for receipt in payload):
        raise ValueError(f"Expected receipt objects in {filename}")
    return payload


def _deduplicated_receipts(source_dir: Path) -> tuple[dict[str, ReceiptCandidate], int, int]:
    candidates_by_id: dict[str, list[ReceiptCandidate]] = {}
    raw_receipt_count = 0
    files = _storebox_files(source_dir)
    for path in files:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, list):
            raise ValueError(f"Expected receipt array in {path.name}")
        for raw_receipt in payload:
            receipt_id = str(raw_receipt.get("receiptId") or "").strip()
            if not receipt_id:
                continue
            raw_receipt_count += 1
            candidates_by_id.setdefault(receipt_id, []).append(
                ReceiptCandidate(
                    receipt_id=receipt_id,
                    source_file=path,
                    source_mtime=path.stat().st_mtime,
                    raw_receipt=raw_receipt,
                )
            )
    selected_by_id = {receipt_id: _best_candidate(candidates) for receipt_id, candidates in candidates_by_id.items()}

    semantic_candidates: dict[tuple[str, str, int, str], list[ReceiptCandidate]] = {}
    selected: dict[str, ReceiptCandidate] = {}
    for candidate in selected_by_id.values():
        semantic_key = _semantic_receipt_identity_key(candidate.raw_receipt)
        if semantic_key is None:
            selected[candidate.receipt_id] = candidate
            continue
        semantic_candidates.setdefault(semantic_key, []).append(candidate)

    for candidates in semantic_candidates.values():
        winner = _best_candidate(candidates)
        selected[winner.receipt_id] = winner

    return selected, len(files), raw_receipt_count


def import_storebox_folder(path: str | None = None) -> dict[str, object]:
    ensure_runtime_dirs()
    source_dir = Path(path).expanduser().resolve() if path else get_storebox_source_dir().resolve()
    if not source_dir.exists() or not source_dir.is_dir():
        raise FileNotFoundError(f"Storebox folder not found: {source_dir}")

    selected_receipts, source_file_count, raw_receipt_count = _deduplicated_receipts(source_dir)
    if source_file_count == 0:
        raise FileNotFoundError(f"No receipts-*.json files found in {source_dir}")

    database_path = get_kvitteringer_db_path()
    if database_path.exists():
        if not _purge_outdated_database_file():
            create_backup(database_path)

    connection = _connect()
    import_run_id = connection.execute(
        "INSERT INTO import_run(started_at, source_path, source_type, status, notes, source_file_count, deduplicated_receipt_count) VALUES(?, ?, ?, ?, ?, ?, ?)",
        (_utc_now(), str(source_dir), "storebox_json", "running", None, source_file_count, len(selected_receipts)),
    ).lastrowid

    cluster_stats: dict[str, dict[str, Any]] = {}
    alias_stats: dict[str, dict[str, Any]] = {}
    merchant_alias_stats: dict[str, dict[str, Any]] = {}
    category_stats: dict[str, dict[str, int]] = {}
    manual_category_overrides = _load_manual_category_overrides(connection)

    try:
        _clear_imported_tables(connection)
        connection.execute(
            "UPDATE import_run SET source_file_count = ?, deduplicated_receipt_count = ? WHERE id = ?",
            (source_file_count, len(selected_receipts), import_run_id),
        )

        for receipt_id, candidate in sorted(selected_receipts.items(), key=lambda item: item[1].receipt_id):
            raw_receipt = candidate.raw_receipt
            merchant_payload = raw_receipt.get("merchant") or {}
            merchant_name_raw = (merchant_payload.get("name") or raw_receipt.get("merchantName") or "Ukendt butik").strip()
            merchant_id_raw = merchant_payload.get("merchantId")
            merchant_key = _slugify(str(merchant_id_raw or merchant_name_raw))
            display_name = merchant_name_raw or merchant_key
            normalized_merchant_name = _normalize_name(display_name)
            connection.execute(
                "INSERT INTO merchant(merchant_key, merchant_id_raw, display_name, normalized_name, merchant_group, is_grocery) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(merchant_key) DO UPDATE SET merchant_id_raw=excluded.merchant_id_raw, display_name=excluded.display_name, normalized_name=excluded.normalized_name, merchant_group=excluded.merchant_group, is_grocery=excluded.is_grocery",
                (
                    merchant_key,
                    merchant_id_raw,
                    display_name,
                    normalized_merchant_name,
                    _merchant_group(display_name, merchant_key),
                    1 if _is_grocery_merchant(merchant_key, display_name) else 0,
                ),
            )
            merchant_alias_key = hashlib.sha1(f"{merchant_key}|{merchant_id_raw}|{display_name}".encode("utf-8")).hexdigest()[:16]
            merchant_alias_stats[merchant_alias_key] = {
                "alias_key": merchant_alias_key,
                "merchant_key": merchant_key,
                "raw_merchant_id": merchant_id_raw,
                "raw_name": display_name,
                "normalized_name": normalized_merchant_name,
                "first_seen_receipt_id": merchant_alias_stats.get(merchant_alias_key, {}).get("first_seen_receipt_id", receipt_id),
                "last_seen_receipt_id": receipt_id,
            }

            purchase_timestamp, purchase_date, purchase_datetime_raw, purchase_date_epoch_raw = _parse_purchase_timestamp(raw_receipt)
            receipt_total_minor = _to_minor(((raw_receipt.get("price") or {}).get("amount")) or 0)
            currency = ((raw_receipt.get("price") or {}).get("currency")) or "DKK"
            raw_receipt_id = connection.execute(
                "INSERT INTO raw_receipt(receipt_id, import_run_id, source_file, source_type, raw_hash, purchase_datetime_raw, purchase_date_epoch_raw, merchant_id_raw, merchant_name_raw, total_amount_raw, line_count_raw) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    receipt_id,
                    import_run_id,
                    candidate.source_file.name,
                    "storebox_json",
                    _receipt_hash(raw_receipt),
                    purchase_datetime_raw,
                    purchase_date_epoch_raw,
                    merchant_id_raw,
                    merchant_name_raw,
                    ((raw_receipt.get("price") or {}).get("amount")) or 0,
                    len(raw_receipt.get("receiptLines") or []),
                ),
            ).lastrowid

            line_rows: list[dict[str, Any]] = []
            occurrences: list[dict[str, Any]] = []
            discounts: list[dict[str, Any]] = []
            last_non_discount_occurrence_id: str | None = None
            previous_was_discount = False

            for line_index, raw_line in enumerate(raw_receipt.get("receiptLines") or []):
                name_raw = str(raw_line.get("name") or "").strip()
                normalized_name = _normalize_name(name_raw)
                product_number = str(raw_line.get("productNumber") or "").strip() or None
                total_price_minor = _to_minor(((raw_line.get("totalPrice") or {}).get("amount")) or 0)
                item_price_minor = _to_minor(((raw_line.get("itemPrice") or {}).get("amount")) or 0)
                is_discount_line = normalized_name == DISCOUNT_PREFIX or normalized_name.startswith(f"{DISCOUNT_PREFIX} ")
                count_raw = raw_line.get("count")
                is_negative_non_discount_line = (not is_discount_line) and (
                    (count_raw is not None and float(count_raw) < 0)
                    or total_price_minor < 0
                )
                line_rows.append(
                    {
                        "receipt_id": receipt_id,
                        "line_index": line_index,
                        "line_number_raw": raw_line.get("lineNumber"),
                        "product_number_raw": product_number,
                        "name_raw": name_raw,
                        "name_normalized": normalized_name,
                        "count_raw": float(count_raw) if count_raw is not None else None,
                        "item_price_minor": item_price_minor,
                        "total_price_minor": total_price_minor,
                        "is_discount_line": 1 if is_discount_line else 0,
                        "is_negative_non_discount_line": 1 if is_negative_non_discount_line else 0,
                    }
                )

                if is_discount_line:
                    amount_minor = abs(total_price_minor)
                    attribution_status = "unassigned"
                    attributed_occurrence_id = None
                    reason = "no_previous_item"
                    if last_non_discount_occurrence_id and not previous_was_discount:
                        attribution_status = "attributed"
                        attributed_occurrence_id = last_non_discount_occurrence_id
                        reason = "adjacent_previous_item"
                        for occurrence in occurrences:
                            if occurrence["occurrence_id"] != attributed_occurrence_id:
                                continue
                            occurrence["discount_minor"] += amount_minor
                            occurrence["net_total_minor"] = occurrence["gross_total_minor"] - occurrence["discount_minor"]
                            occurrence["unit_price_minor"] = _safe_unit_price_minor(
                                occurrence["net_total_minor"],
                                occurrence["quantity"],
                            )
                            break
                    elif previous_was_discount:
                        reason = "consecutive_discount_block"

                    discounts.append(
                        {
                            "receipt_id": receipt_id,
                            "line_index": line_index,
                            "amount_minor": amount_minor,
                            "attribution_status": attribution_status,
                            "attributed_occurrence_id": attributed_occurrence_id,
                            "reason": reason,
                        }
                    )
                    previous_was_discount = True
                    continue

                quantity = _coerce_quantity(count_raw, total_price_minor, is_discount_line)
                variant_signature = _variant_signature(normalized_name)
                cluster_key, collapse_strategy, confidence = _cluster_key(product_number, normalized_name, variant_signature)
                cluster_id = _cluster_id(cluster_key)
                occurrence = {
                    "occurrence_id": _occurrence_id(receipt_id, line_index),
                    "receipt_id": receipt_id,
                    "merchant_key": merchant_key,
                    "purchase_timestamp": purchase_timestamp,
                    "purchase_date": purchase_date,
                    "source_line_index": line_index,
                    "product_number": product_number,
                    "display_name": name_raw,
                    "normalized_name": normalized_name,
                    "variant_signature": variant_signature,
                    "item_key": _item_key(merchant_key, product_number, normalized_name, variant_signature),
                    "cluster_id": cluster_id,
                    "quantity": quantity,
                    "gross_total_minor": total_price_minor,
                    "discount_minor": 0,
                    "net_total_minor": total_price_minor,
                    "unit_price_minor": _safe_unit_price_minor(total_price_minor, quantity),
                    "is_return": 1 if is_negative_non_discount_line else 0,
                    "is_refund": 1 if is_negative_non_discount_line else 0,
                    "category_key": raw_line.get("category"),
                }
                occurrences.append(occurrence)
                last_non_discount_occurrence_id = occurrence["occurrence_id"]
                previous_was_discount = False

                cluster_state = cluster_stats.setdefault(
                    cluster_id,
                    {
                        "cluster_id": cluster_id,
                        "cluster_key": cluster_key,
                        "product_number": product_number if collapse_strategy != "semantic_name" else None,
                        "normalized_name": normalized_name,
                        "variant_signature": variant_signature,
                        "collapse_strategy": collapse_strategy,
                        "confidence": confidence,
                        "display_name_counts": {},
                    },
                )
                cluster_state["display_name_counts"][name_raw] = cluster_state["display_name_counts"].get(name_raw, 0) + 1

                alias_key = hashlib.sha1(f"{cluster_id}|{product_number}|{name_raw}|{normalized_name}|{variant_signature}".encode("utf-8")).hexdigest()[:16]
                alias_state = alias_stats.setdefault(
                    alias_key,
                    {
                        "alias_key": alias_key,
                        "cluster_id": cluster_id,
                        "product_number": product_number,
                        "raw_name": name_raw,
                        "normalized_name": normalized_name,
                        "variant_signature": variant_signature,
                        "first_seen_receipt_id": receipt_id,
                        "last_seen_receipt_id": receipt_id,
                    },
                )
                alias_state["last_seen_receipt_id"] = receipt_id

                if raw_line.get("category"):
                    category_counts = category_stats.setdefault(cluster_id, {})
                    category_key = str(raw_line.get("category"))
                    category_counts[category_key] = category_counts.get(category_key, 0) + 1

            attributed_discount_total_minor = sum(item["amount_minor"] for item in discounts if item["attribution_status"] == "attributed")
            unassigned_discount_total_minor = sum(item["amount_minor"] for item in discounts if item["attribution_status"] == "unassigned")
            parsed_item_total_minor = sum(item["net_total_minor"] for item in occurrences)
            gap_minor = receipt_total_minor - (parsed_item_total_minor - unassigned_discount_total_minor)

            connection.execute(
                "INSERT INTO receipt(receipt_id, merchant_key, purchase_timestamp, purchase_date, currency, receipt_total_minor, parsed_item_total_minor, attributed_discount_total_minor, unassigned_discount_total_minor, gap_minor, source_type, has_ambiguous_discount_block, raw_receipt_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    receipt_id,
                    merchant_key,
                    purchase_timestamp,
                    purchase_date,
                    currency,
                    receipt_total_minor,
                    parsed_item_total_minor,
                    attributed_discount_total_minor,
                    unassigned_discount_total_minor,
                    gap_minor,
                    "storebox_json",
                    1 if unassigned_discount_total_minor > 0 else 0,
                    raw_receipt_id,
                ),
            )

            for line_row in line_rows:
                connection.execute(
                    "INSERT INTO receipt_line(receipt_id, line_index, line_number_raw, product_number_raw, name_raw, name_normalized, count_raw, item_price_minor, total_price_minor, is_discount_line, is_negative_non_discount_line) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        line_row["receipt_id"],
                        line_row["line_index"],
                        line_row["line_number_raw"],
                        line_row["product_number_raw"],
                        line_row["name_raw"],
                        line_row["name_normalized"],
                        line_row["count_raw"],
                        line_row["item_price_minor"],
                        line_row["total_price_minor"],
                        line_row["is_discount_line"],
                        line_row["is_negative_non_discount_line"],
                    ),
                )

            for occurrence in occurrences:
                connection.execute(
                    "INSERT OR IGNORE INTO item_cluster(cluster_id, preferred_display_name, cluster_key, product_number, normalized_name, variant_signature, collapse_strategy, confidence, is_manual) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0)",
                    (
                        occurrence["cluster_id"],
                        occurrence["display_name"],
                        _cluster_key(occurrence["product_number"], occurrence["normalized_name"], occurrence["variant_signature"])[0],
                        occurrence["product_number"],
                        occurrence["normalized_name"],
                        occurrence["variant_signature"],
                        _cluster_key(occurrence["product_number"], occurrence["normalized_name"], occurrence["variant_signature"])[1],
                        _cluster_key(occurrence["product_number"], occurrence["normalized_name"], occurrence["variant_signature"])[2],
                    ),
                )

            for occurrence in occurrences:
                connection.execute(
                    "INSERT INTO item_occurrence(occurrence_id, receipt_id, merchant_key, purchase_timestamp, purchase_date, source_line_index, product_number, display_name, normalized_name, variant_signature, item_key, cluster_id, quantity, gross_total_minor, discount_minor, net_total_minor, unit_price_minor, is_return, is_refund, category_key) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        occurrence["occurrence_id"],
                        occurrence["receipt_id"],
                        occurrence["merchant_key"],
                        occurrence["purchase_timestamp"],
                        occurrence["purchase_date"],
                        occurrence["source_line_index"],
                        occurrence["product_number"],
                        occurrence["display_name"],
                        occurrence["normalized_name"],
                        occurrence["variant_signature"],
                        occurrence["item_key"],
                        occurrence["cluster_id"],
                        occurrence["quantity"],
                        occurrence["gross_total_minor"],
                        occurrence["discount_minor"],
                        occurrence["net_total_minor"],
                        occurrence["unit_price_minor"],
                        occurrence["is_return"],
                        occurrence["is_refund"],
                        occurrence["category_key"],
                    ),
                )

            for discount in discounts:
                connection.execute(
                    "INSERT INTO receipt_discount(receipt_id, line_index, amount_minor, attribution_status, attributed_occurrence_id, reason) VALUES(?, ?, ?, ?, ?, ?)",
                    (
                        discount["receipt_id"],
                        discount["line_index"],
                        discount["amount_minor"],
                        discount["attribution_status"],
                        discount["attributed_occurrence_id"],
                        discount["reason"],
                    ),
                )

        cluster_remap, created_cluster_ids = _merge_uncategorized_exact_name_clusters(
            cluster_stats=cluster_stats,
            alias_stats=alias_stats,
            category_stats=category_stats,
            manual_category_overrides=manual_category_overrides,
        )

        for cluster_id in created_cluster_ids:
            cluster_state = cluster_stats[cluster_id]
            connection.execute(
                "INSERT OR IGNORE INTO item_cluster(cluster_id, preferred_display_name, cluster_key, product_number, normalized_name, variant_signature, collapse_strategy, confidence, is_manual) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0)",
                (
                    cluster_id,
                    _preferred_display_name_from_counts(cluster_state["display_name_counts"]),
                    cluster_state["cluster_key"],
                    cluster_state["product_number"],
                    cluster_state["normalized_name"],
                    cluster_state["variant_signature"],
                    cluster_state["collapse_strategy"],
                    cluster_state["confidence"],
                ),
            )

        for original_cluster_id, merged_cluster_id in cluster_remap.items():
            connection.execute(
                "UPDATE item_occurrence SET cluster_id = ? WHERE cluster_id = ?",
                (merged_cluster_id, original_cluster_id),
            )
            connection.execute("DELETE FROM item_cluster WHERE cluster_id = ?", (original_cluster_id,))

        for cluster_id, cluster_state in cluster_stats.items():
            preferred_display_name = sorted(
                cluster_state["display_name_counts"].items(),
                key=lambda item: (-item[1], -len(item[0]), item[0]),
            )[0][0]
            connection.execute(
                "INSERT INTO item_cluster(cluster_id, preferred_display_name, cluster_key, product_number, normalized_name, variant_signature, collapse_strategy, confidence, is_manual) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(cluster_id) DO UPDATE SET preferred_display_name=excluded.preferred_display_name, cluster_key=excluded.cluster_key, product_number=excluded.product_number, normalized_name=excluded.normalized_name, variant_signature=excluded.variant_signature, collapse_strategy=excluded.collapse_strategy, confidence=excluded.confidence",
                (
                    cluster_id,
                    preferred_display_name,
                    cluster_state["cluster_key"],
                    cluster_state["product_number"],
                    cluster_state["normalized_name"],
                    cluster_state["variant_signature"],
                    cluster_state["collapse_strategy"],
                    cluster_state["confidence"],
                ),
            )

        for alias_state in alias_stats.values():
            connection.execute(
                "INSERT INTO item_alias(alias_key, cluster_id, product_number, raw_name, normalized_name, variant_signature, first_seen_receipt_id, last_seen_receipt_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    alias_state["alias_key"],
                    alias_state["cluster_id"],
                    alias_state["product_number"],
                    alias_state["raw_name"],
                    alias_state["normalized_name"],
                    alias_state["variant_signature"],
                    alias_state["first_seen_receipt_id"],
                    alias_state["last_seen_receipt_id"],
                ),
            )

        for merchant_alias_state in merchant_alias_stats.values():
            connection.execute(
                "INSERT INTO merchant_alias(alias_key, merchant_key, raw_merchant_id, raw_name, normalized_name, first_seen_receipt_id, last_seen_receipt_id) VALUES(?, ?, ?, ?, ?, ?, ?)",
                (
                    merchant_alias_state["alias_key"],
                    merchant_alias_state["merchant_key"],
                    merchant_alias_state["raw_merchant_id"],
                    merchant_alias_state["raw_name"],
                    merchant_alias_state["normalized_name"],
                    merchant_alias_state["first_seen_receipt_id"],
                    merchant_alias_state["last_seen_receipt_id"],
                ),
            )

        for cluster_id, cluster_state in cluster_stats.items():
            category_key, source, confidence = _resolved_cluster_category_preview(
                cluster_id=cluster_id,
                cluster_state=cluster_state,
                category_stats=category_stats,
                manual_category_overrides=manual_category_overrides,
            )
            _set_category_assignment(
                connection,
                cluster_id=cluster_id,
                category_key=category_key,
                source=source,
                confidence=confidence,
            )

        completed_at = _utc_now()
        connection.execute(
            "UPDATE import_run SET completed_at = ?, status = ?, deduplicated_receipt_count = ? WHERE id = ?",
            (completed_at, "completed", len(selected_receipts), import_run_id),
        )
        connection.commit()
    except Exception as exc:
        connection.execute(
            "UPDATE import_run SET completed_at = ?, status = ?, notes = ? WHERE id = ?",
            (_utc_now(), "failed", str(exc), import_run_id),
            )
        connection.commit()
        connection.close()
        raise

    merchant_count = connection.execute("SELECT COUNT(*) FROM merchant").fetchone()[0]
    item_cluster_count = connection.execute("SELECT COUNT(*) FROM item_cluster").fetchone()[0]
    connection.close()
    return {
        "import_run_id": import_run_id,
        "source_path": str(source_dir),
        "source_file_count": source_file_count,
        "raw_receipt_count": raw_receipt_count,
        "deduplicated_receipt_count": len(selected_receipts),
        "duplicate_receipt_count": raw_receipt_count - len(selected_receipts),
        "merchant_count": merchant_count,
        "item_cluster_count": item_cluster_count,
    }


def rebuild_kvitteringer_indexes() -> dict[str, object]:
    return import_storebox_folder()


def replace_storebox_upload(content: bytes, filename: str | None = None) -> dict[str, object]:
    ensure_runtime_dirs()
    source_dir = get_storebox_source_dir().resolve()
    uploaded_original_filename = (filename or STOREBOX_UPLOAD_FILENAME).strip() or STOREBOX_UPLOAD_FILENAME
    validated_receipts = _validate_uploaded_storebox_receipts(content, uploaded_original_filename)
    replaceable_source_files = [path for path in _storebox_files(source_dir) if path.name not in STOREBOX_STATIC_SUPPLEMENT_FILENAMES]
    replaced_source_files = [path.name for path in replaceable_source_files]
    target_path = source_dir / STOREBOX_UPLOAD_FILENAME

    for path in replaceable_source_files:
        path.unlink()

    with tempfile.NamedTemporaryFile("wb", dir=source_dir, delete=False) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    temp_path.replace(target_path)

    result = import_storebox_folder()
    result.update(
        {
            "validated_receipt_count": len(validated_receipts),
            "uploaded_original_filename": uploaded_original_filename,
            "uploaded_source_file": target_path.name,
            "replaced_source_files": replaced_source_files,
        }
    )
    return result


def _last_import_run() -> dict[str, Any] | None:
    if not _database_exists():
        return None
    with _connect() as connection:
        row = connection.execute(
            "SELECT id, started_at, completed_at, source_path, status, source_file_count, deduplicated_receipt_count FROM import_run ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        return dict(row)


def get_kvitteringer_status() -> dict[str, object]:
    source_dir = get_storebox_source_dir().resolve()
    database_path = get_kvitteringer_db_path().resolve()
    source_file_count = len(_storebox_files(source_dir)) if source_dir.exists() else 0
    if not _database_exists():
        return {
            "source_dir": str(source_dir),
            "database_path": str(database_path),
            "database_exists": False,
            "source_file_count": source_file_count,
            "receipt_count": 0,
            "merchant_count": 0,
            "item_cluster_count": 0,
            "last_import_run": None,
        }

    with _connect() as connection:
        counts = {
            "receipt_count": connection.execute("SELECT COUNT(*) FROM receipt").fetchone()[0],
            "merchant_count": connection.execute("SELECT COUNT(*) FROM merchant").fetchone()[0],
            "item_cluster_count": connection.execute("SELECT COUNT(*) FROM item_cluster").fetchone()[0],
        }
    return {
        "source_dir": str(source_dir),
        "database_path": str(database_path),
        "database_exists": True,
        "source_file_count": source_file_count,
        **counts,
        "last_import_run": _last_import_run(),
    }


def _build_filters(
    *,
    table_alias: str,
    date_from: date | None = None,
    date_to: date | None = None,
    merchant_keys: list[str] | None = None,
) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    args: list[Any] = []
    if date_from is not None:
        clauses.append(f"{table_alias}.purchase_date >= ?")
        args.append(date_from.isoformat())
    if date_to is not None:
        clauses.append(f"{table_alias}.purchase_date <= ?")
        args.append(date_to.isoformat())
    if merchant_keys:
        placeholders = ", ".join("?" for _ in merchant_keys)
        clauses.append(f"{table_alias}.merchant_key IN ({placeholders})")
        args.extend(merchant_keys)
    if not clauses:
        return "", args
    return " WHERE " + " AND ".join(clauses), args


def _period_expr(granularity: str, table_alias: str) -> str:
    if granularity == "month":
        return f"substr({table_alias}.purchase_date, 1, 7)"
    if granularity == "year":
        return f"substr({table_alias}.purchase_date, 1, 4)"
    raise ValueError("Unsupported granularity")


def _category_label(category_key: str | None) -> str:
    normalized = str(category_key or "").strip().lower()
    if not normalized:
        return CATEGORY_LABELS["uncategorized"]
    if normalized in CATEGORY_LABELS:
        return CATEGORY_LABELS[normalized]
    return str(category_key).replace("_", " ").strip().title()


def _category_options_payload() -> list[dict[str, str]]:
    return [{"key": key, "label": CATEGORY_LABELS[key]} for key in CATEGORY_ORDER]


def _preferred_display_name_from_counts(display_name_counts: dict[str, int]) -> str:
    return sorted(
        display_name_counts.items(),
        key=lambda item: (-item[1], -len(item[0]), item[0]),
    )[0][0]


def _resolved_cluster_category_preview(
    *,
    cluster_id: str,
    cluster_state: dict[str, Any],
    category_stats: dict[str, dict[str, int]],
    manual_category_overrides: dict[str, dict[str, str]],
) -> tuple[str, str, str]:
    manual_override = manual_category_overrides.get(cluster_id)
    if manual_override:
        return str(manual_override["category_key"]), "manual", "high"
    return _classify_cluster_category(
        preferred_display_name=_preferred_display_name_from_counts(cluster_state["display_name_counts"]),
        normalized_name=cluster_state["normalized_name"],
        raw_category_counts=category_stats.get(cluster_id),
    )


def _merge_uncategorized_exact_name_clusters(
    *,
    cluster_stats: dict[str, dict[str, Any]],
    alias_stats: dict[str, dict[str, Any]],
    category_stats: dict[str, dict[str, int]],
    manual_category_overrides: dict[str, dict[str, str]],
) -> tuple[dict[str, str], set[str]]:
    merge_groups: dict[tuple[str, str, str], list[str]] = {}
    for cluster_id, cluster_state in cluster_stats.items():
        category_key, _, _ = _resolved_cluster_category_preview(
            cluster_id=cluster_id,
            cluster_state=cluster_state,
            category_stats=category_stats,
            manual_category_overrides=manual_category_overrides,
        )
        if category_key != "uncategorized" or cluster_id in manual_category_overrides:
            continue
        preferred_display_name = _preferred_display_name_from_counts(cluster_state["display_name_counts"])
        merge_groups.setdefault(
            (preferred_display_name, cluster_state["normalized_name"], cluster_state["variant_signature"]),
            [],
        ).append(cluster_id)

    cluster_remap: dict[str, str] = {}
    created_cluster_ids: set[str] = set()
    for preferred_display_name, normalized_name, variant_signature in sorted(merge_groups):
        group_cluster_ids = merge_groups[(preferred_display_name, normalized_name, variant_signature)]
        if len(group_cluster_ids) < 2:
            continue
        merged_cluster_key = f"exact_name:{preferred_display_name}|{normalized_name}|{variant_signature}"
        merged_cluster_id = _cluster_id(merged_cluster_key)
        merged_state = {
            "cluster_id": merged_cluster_id,
            "cluster_key": merged_cluster_key,
            "product_number": None,
            "normalized_name": normalized_name,
            "variant_signature": variant_signature,
            "collapse_strategy": "exact_name",
            "confidence": "low",
            "display_name_counts": {},
        }
        merged_category_counts: dict[str, int] = {}

        for cluster_id in group_cluster_ids:
            cluster_remap[cluster_id] = merged_cluster_id
            cluster_state = cluster_stats.pop(cluster_id)
            for display_name, count in cluster_state["display_name_counts"].items():
                merged_state["display_name_counts"][display_name] = merged_state["display_name_counts"].get(display_name, 0) + count
            for category_key, count in category_stats.pop(cluster_id, {}).items():
                merged_category_counts[category_key] = merged_category_counts.get(category_key, 0) + count

        cluster_stats[merged_cluster_id] = merged_state
        if merged_category_counts:
            category_stats[merged_cluster_id] = merged_category_counts
        created_cluster_ids.add(merged_cluster_id)

    if cluster_remap:
        for alias_state in alias_stats.values():
            alias_state["cluster_id"] = cluster_remap.get(alias_state["cluster_id"], alias_state["cluster_id"])

    return cluster_remap, created_cluster_ids


def _set_category_assignment(
    connection: sqlite3.Connection,
    *,
    cluster_id: str,
    category_key: str,
    source: str,
    confidence: str,
) -> None:
    connection.execute("DELETE FROM category_assignment WHERE cluster_id = ?", (cluster_id,))
    connection.execute(
        "INSERT INTO category_assignment(cluster_id, category_key, source, confidence) VALUES(?, ?, ?, ?)",
        (cluster_id, category_key, source, confidence),
    )


def _category_override_record(cluster_id: str, preferred_display_name: str, category_key: str) -> dict[str, str]:
    return {
        "cluster_id": cluster_id,
        "preferred_display_name": preferred_display_name,
        "category_key": category_key,
        "category_label": _category_label(category_key),
    }


def _read_category_override_file() -> dict[str, dict[str, str]]:
    path = get_kvitteringer_category_overrides_file()
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    overrides = payload.get("overrides", []) if isinstance(payload, dict) else []
    if not isinstance(overrides, list):
        return {}
    result: dict[str, dict[str, str]] = {}
    for item in overrides:
        if not isinstance(item, dict):
            continue
        cluster_id = str(item.get("cluster_id") or "").strip()
        category_key = _validated_category_override_key(item.get("category_key"))
        if not cluster_id or category_key is None:
            continue
        preferred_display_name = str(item.get("preferred_display_name") or cluster_id).strip() or cluster_id
        result[cluster_id] = _category_override_record(cluster_id, preferred_display_name, category_key)
    return result


def _write_category_override_file(overrides: dict[str, dict[str, str]]) -> None:
    ensure_runtime_dirs()
    path = get_kvitteringer_category_overrides_file()
    create_backup(path)
    payload = {
        "updated_at": _utc_now(),
        "overrides": sorted(
            overrides.values(),
            key=lambda item: (str(item.get("preferred_display_name") or ""), str(item.get("cluster_id") or "")),
        ),
    }
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=False)
        handle.write("\n")
        temp_path = Path(handle.name)
    temp_path.replace(path)


def _load_manual_category_overrides(connection: sqlite3.Connection) -> dict[str, dict[str, str]]:
    file_overrides = _read_category_override_file()
    if file_overrides:
        return file_overrides
    rows = connection.execute(
        "SELECT ca.cluster_id, ca.category_key, c.preferred_display_name "
        "FROM category_assignment ca JOIN item_cluster c ON c.cluster_id = ca.cluster_id "
        "WHERE ca.source = 'manual'"
    ).fetchall()
    if not rows:
        return {}
    migrated = {
        str(row["cluster_id"]): _category_override_record(
            str(row["cluster_id"]),
            str(row["preferred_display_name"]),
            str(row["category_key"]),
        )
        for row in rows
    }
    _write_category_override_file(migrated)
    return migrated


def _validated_category_override_key(category_key: str | None) -> str | None:
    if category_key is None:
        return None
    normalized = _normalize_category_key(category_key)
    if not normalized:
        return None
    if normalized not in CATEGORY_LABELS:
        raise ValueError(f"Unknown category key: {category_key}")
    return normalized


def _resolve_cluster_category_assignment(
    connection: sqlite3.Connection,
    *,
    cluster_id: str,
    preferred_display_name: str,
    normalized_name: str,
) -> tuple[str, str, str]:
    category_counts = {
        str(row["category_key"]): int(row["match_count"] or 0)
        for row in connection.execute(
            "SELECT category_key, COUNT(*) AS match_count FROM item_occurrence WHERE cluster_id = ? AND category_key IS NOT NULL GROUP BY category_key",
            (cluster_id,),
        ).fetchall()
    }
    return _classify_cluster_category(
        preferred_display_name=preferred_display_name,
        normalized_name=normalized_name,
        raw_category_counts=category_counts,
    )


def list_receipts(
    *,
    date_from: date | None = None,
    date_to: date | None = None,
    merchant_keys: list[str] | None = None,
) -> list[dict[str, object]]:
    if not _database_exists():
        return []
    where_clause, args = _build_filters(table_alias="r", date_from=date_from, date_to=date_to, merchant_keys=merchant_keys)
    query = (
        "SELECT r.receipt_id, r.merchant_key, m.display_name AS merchant_name, r.purchase_timestamp, r.purchase_date, r.currency, "
        "r.receipt_total_minor, r.parsed_item_total_minor, r.attributed_discount_total_minor, r.unassigned_discount_total_minor, "
        "r.gap_minor, r.has_ambiguous_discount_block "
        "FROM receipt r JOIN merchant m ON m.merchant_key = r.merchant_key"
        f"{where_clause} ORDER BY r.purchase_timestamp DESC, r.receipt_id DESC"
    )
    with _connect() as connection:
        rows = connection.execute(query, args).fetchall()
    return [
        {
            "receipt_id": row["receipt_id"],
            "merchant_key": row["merchant_key"],
            "merchant_name": row["merchant_name"],
            "purchase_timestamp": row["purchase_timestamp"],
            "purchase_date": row["purchase_date"],
            "currency": row["currency"],
            "receipt_total_minor": row["receipt_total_minor"],
            "parsed_item_total_minor": row["parsed_item_total_minor"],
            "attributed_discount_total_minor": row["attributed_discount_total_minor"],
            "unassigned_discount_total_minor": row["unassigned_discount_total_minor"],
            "gap_minor": row["gap_minor"],
            "has_ambiguous_discount_block": bool(row["has_ambiguous_discount_block"]),
        }
        for row in rows
    ]


def get_receipt(receipt_id: str) -> dict[str, object] | None:
    if not _database_exists():
        return None
    with _connect() as connection:
        receipt_row = connection.execute(
            "SELECT r.*, m.display_name AS merchant_name FROM receipt r JOIN merchant m ON m.merchant_key = r.merchant_key WHERE r.receipt_id = ?",
            (receipt_id,),
        ).fetchone()
        if receipt_row is None:
            return None
        line_rows = connection.execute(
            "SELECT * FROM receipt_line WHERE receipt_id = ? ORDER BY line_index",
            (receipt_id,),
        ).fetchall()
        occurrence_rows = connection.execute(
            "SELECT * FROM item_occurrence WHERE receipt_id = ? ORDER BY source_line_index",
            (receipt_id,),
        ).fetchall()
        discount_rows = connection.execute(
            "SELECT * FROM receipt_discount WHERE receipt_id = ? ORDER BY line_index",
            (receipt_id,),
        ).fetchall()
    return {
        "receipt": {
            "receipt_id": receipt_row["receipt_id"],
            "merchant_key": receipt_row["merchant_key"],
            "merchant_name": receipt_row["merchant_name"],
            "purchase_timestamp": receipt_row["purchase_timestamp"],
            "purchase_date": receipt_row["purchase_date"],
            "currency": receipt_row["currency"],
            "receipt_total_minor": receipt_row["receipt_total_minor"],
            "parsed_item_total_minor": receipt_row["parsed_item_total_minor"],
            "attributed_discount_total_minor": receipt_row["attributed_discount_total_minor"],
            "unassigned_discount_total_minor": receipt_row["unassigned_discount_total_minor"],
            "gap_minor": receipt_row["gap_minor"],
            "has_ambiguous_discount_block": bool(receipt_row["has_ambiguous_discount_block"]),
        },
        "lines": [
            {
                "line_index": row["line_index"],
                "line_number_raw": row["line_number_raw"],
                "product_number_raw": row["product_number_raw"],
                "name_raw": row["name_raw"],
                "name_normalized": row["name_normalized"],
                "count_raw": row["count_raw"],
                "item_price_minor": row["item_price_minor"],
                "total_price_minor": row["total_price_minor"],
                "is_discount_line": bool(row["is_discount_line"]),
                "is_negative_non_discount_line": bool(row["is_negative_non_discount_line"]),
            }
            for row in line_rows
        ],
        "occurrences": _aggregate_occurrences(
            [
                {
                    **dict(row),
                    "is_return": bool(row["is_return"]),
                    "is_refund": bool(row["is_refund"]),
                }
                for row in occurrence_rows
            ]
        ),
        "discounts": [dict(row) for row in discount_rows],
    }


def _aggregate_occurrences(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[Any, ...], dict[str, Any]] = {}
    ordered: list[dict[str, Any]] = []
    for row in rows:
        group_key = (
            row.get("receipt_id"),
            row.get("merchant_key"),
            row.get("cluster_id"),
            row.get("display_name"),
            row.get("product_number"),
            row.get("variant_signature"),
            row.get("unit_price_minor"),
            row.get("is_return"),
            row.get("is_refund"),
            row.get("category_key"),
        )
        existing = grouped.get(group_key)
        if existing is None:
            grouped[group_key] = dict(row)
            ordered.append(grouped[group_key])
            continue
        existing["quantity"] += row.get("quantity") or 0
        existing["gross_total_minor"] += row.get("gross_total_minor") or 0
        existing["discount_minor"] += row.get("discount_minor") or 0
        existing["net_total_minor"] += row.get("net_total_minor") or 0
    return ordered


def list_merchants(
    *,
    date_from: date | None = None,
    date_to: date | None = None,
    merchant_keys: list[str] | None = None,
) -> list[dict[str, object]]:
    if not _database_exists():
        return []
    where_clause, args = _build_filters(table_alias="r", date_from=date_from, date_to=date_to, merchant_keys=merchant_keys)
    query = (
        "WITH merchant_receipts AS ("
        "SELECT r.merchant_key, COUNT(*) AS receipt_count, SUM(r.receipt_total_minor) AS spend_minor, "
        "AVG(r.receipt_total_minor) AS average_basket_minor, SUM(r.attributed_discount_total_minor) AS attributed_discount_minor, "
        "SUM(r.unassigned_discount_total_minor) AS unassigned_discount_minor "
        "FROM receipt r "
        f"{where_clause} GROUP BY r.merchant_key"
        "), merchant_diversity AS ("
        "SELECT r.merchant_key, COUNT(DISTINCT o.cluster_id) AS item_diversity "
        "FROM receipt r LEFT JOIN item_occurrence o ON o.receipt_id = r.receipt_id "
        f"{where_clause} GROUP BY r.merchant_key"
        ") "
        "SELECT mr.merchant_key, m.display_name, mr.receipt_count, mr.spend_minor, mr.average_basket_minor, "
        "mr.attributed_discount_minor, mr.unassigned_discount_minor, COALESCE(md.item_diversity, 0) AS item_diversity "
        "FROM merchant_receipts mr "
        "JOIN merchant m ON m.merchant_key = mr.merchant_key "
        "LEFT JOIN merchant_diversity md ON md.merchant_key = mr.merchant_key "
        "ORDER BY mr.spend_minor DESC, m.display_name"
    )
    with _connect() as connection:
        rows = connection.execute(query, [*args, *args]).fetchall()
    return [
        {
            "merchant_key": row["merchant_key"],
            "display_name": row["display_name"],
            "receipt_count": row["receipt_count"],
            "spend_minor": row["spend_minor"] or 0,
            "average_basket_minor": int(round(row["average_basket_minor"] or 0)),
            "attributed_discount_minor": row["attributed_discount_minor"] or 0,
            "unassigned_discount_minor": row["unassigned_discount_minor"] or 0,
            "item_diversity": row["item_diversity"] or 0,
        }
        for row in rows
    ]


def kvitteringer_overview(
    *,
    granularity: str = "month",
    date_from: date | None = None,
    date_to: date | None = None,
    merchant_keys: list[str] | None = None,
) -> dict[str, object]:
    if granularity not in {"month", "year"}:
        raise ValueError("Unsupported granularity")
    if not _database_exists():
        return {
            "granularity": granularity,
            "periods": [],
            "period_summaries": [],
            "totals": {
                "receipt_count": 0,
                "total_spend_minor": 0,
                "attributed_discount_minor": 0,
                "unassigned_discount_minor": 0,
                "gap_minor": 0,
                "values": {},
            },
            "merchants": [],
            "items": [],
        }

    receipt_where_clause, receipt_args = _build_filters(
        table_alias="r",
        date_from=date_from,
        date_to=date_to,
        merchant_keys=merchant_keys,
    )
    item_where_clause, item_args = _build_filters(
        table_alias="o",
        date_from=date_from,
        date_to=date_to,
        merchant_keys=merchant_keys,
    )
    receipt_period_expr = _period_expr(granularity, "r")
    item_period_expr = _period_expr(granularity, "o")
    period_query = (
        f"SELECT {receipt_period_expr} AS period, COUNT(*) AS receipt_count, SUM(r.receipt_total_minor) AS total_spend_minor, "
        "AVG(r.receipt_total_minor) AS average_receipt_minor, SUM(r.attributed_discount_total_minor) AS attributed_discount_minor, "
        "SUM(r.unassigned_discount_total_minor) AS unassigned_discount_minor, SUM(CASE WHEN r.gap_minor != 0 THEN 1 ELSE 0 END) AS gap_receipt_count, "
        "SUM(r.gap_minor) AS gap_minor FROM receipt r"
        f"{receipt_where_clause} GROUP BY period ORDER BY period"
    )
    merchant_query = (
        f"SELECT r.merchant_key, m.display_name, {receipt_period_expr} AS period, COUNT(*) AS receipt_count, "
        "SUM(r.receipt_total_minor) AS spend_minor "
        "FROM receipt r JOIN merchant m ON m.merchant_key = r.merchant_key "
        f"{receipt_where_clause} GROUP BY r.merchant_key, m.display_name, period ORDER BY m.display_name, period"
    )
    item_query = (
        f"SELECT c.cluster_id, c.preferred_display_name, COALESCE(ca.category_key, 'uncategorized') AS resolved_category_key, {item_period_expr} AS period, "
        "COUNT(DISTINCT o.receipt_id) AS receipt_count, SUM(o.quantity) AS quantity_total, SUM(o.net_total_minor) AS spend_minor "
        "FROM item_occurrence o "
        "JOIN item_cluster c ON c.cluster_id = o.cluster_id "
        "LEFT JOIN category_assignment ca ON ca.cluster_id = c.cluster_id "
        f"{item_where_clause} GROUP BY c.cluster_id, c.preferred_display_name, resolved_category_key, period ORDER BY c.preferred_display_name, period"
    )

    with _connect() as connection:
        period_rows = connection.execute(period_query, receipt_args).fetchall()
        merchant_rows = connection.execute(merchant_query, receipt_args).fetchall()
        item_rows = connection.execute(item_query, item_args).fetchall()

    period_summaries = [
        {
            "period": row["period"],
            "receipt_count": row["receipt_count"],
            "total_spend_minor": row["total_spend_minor"] or 0,
            "average_receipt_minor": int(round(row["average_receipt_minor"] or 0)),
            "attributed_discount_minor": row["attributed_discount_minor"] or 0,
            "unassigned_discount_minor": row["unassigned_discount_minor"] or 0,
            "gap_receipt_count": row["gap_receipt_count"] or 0,
            "gap_minor": row["gap_minor"] or 0,
        }
        for row in period_rows
    ]

    merchant_map: dict[str, dict[str, Any]] = {}
    for row in merchant_rows:
        merchant_key = str(row["merchant_key"])
        merchant_entry = merchant_map.setdefault(
            merchant_key,
            {
                "merchant_key": merchant_key,
                "display_name": row["display_name"],
                "receipt_count": 0,
                "total_spend_minor": 0,
                "values": {},
            },
        )
        period = str(row["period"])
        spend_minor = int(row["spend_minor"] or 0)
        merchant_entry["receipt_count"] += int(row["receipt_count"] or 0)
        merchant_entry["total_spend_minor"] += spend_minor
        merchant_entry["values"][period] = spend_minor

    item_map: dict[str, dict[str, Any]] = {}
    for row in item_rows:
        cluster_id = str(row["cluster_id"])
        category_key = str(row["resolved_category_key"] or "uncategorized")
        item_entry = item_map.setdefault(
            cluster_id,
            {
                "cluster_id": cluster_id,
                "preferred_display_name": row["preferred_display_name"],
                "category_key": category_key,
                "category_label": _category_label(category_key),
                "receipt_count": 0,
                "quantity_total": 0.0,
                "total_spend_minor": 0,
                "values": {},
            },
        )
        period = str(row["period"])
        spend_minor = int(row["spend_minor"] or 0)
        item_entry["receipt_count"] += int(row["receipt_count"] or 0)
        item_entry["quantity_total"] += float(row["quantity_total"] or 0)
        item_entry["total_spend_minor"] += spend_minor
        item_entry["values"][period] = spend_minor

    return {
        "granularity": granularity,
        "periods": [item["period"] for item in period_summaries],
        "period_summaries": period_summaries,
        "totals": {
            "receipt_count": sum(item["receipt_count"] for item in period_summaries),
            "total_spend_minor": sum(item["total_spend_minor"] for item in period_summaries),
            "attributed_discount_minor": sum(item["attributed_discount_minor"] for item in period_summaries),
            "unassigned_discount_minor": sum(item["unassigned_discount_minor"] for item in period_summaries),
            "gap_minor": sum(item["gap_minor"] for item in period_summaries),
            "values": {item["period"]: item["total_spend_minor"] for item in period_summaries},
        },
        "merchants": sorted(
            merchant_map.values(),
            key=lambda item: (-int(item["total_spend_minor"]), str(item["display_name"])),
        ),
        "items": sorted(
            item_map.values(),
            key=lambda item: (-int(item["total_spend_minor"]), str(item["preferred_display_name"])),
        ),
    }


def kvitteringer_overview_sunburst(
    *,
    granularity: str = "month",
    periods: list[str],
    merchant_keys: list[str] | None = None,
) -> dict[str, object]:
    if granularity not in {"month", "year"}:
        raise ValueError("Unsupported granularity")

    normalized_periods = sorted({str(period).strip() for period in periods if str(period).strip()})
    if not normalized_periods:
        raise ValueError("At least one period is required")

    if not _database_exists():
        return {
            "granularity": granularity,
            "periods": normalized_periods,
            "positive_net_spend_minor": 0,
            "receipt_total_minor": 0,
            "unassigned_discount_minor": 0,
            "excluded_negative_net_spend_minor": 0,
            "nodes": [],
        }

    occurrence_period_expr = _period_expr(granularity, "o")
    receipt_period_expr = _period_expr(granularity, "r")
    period_placeholders = ", ".join("?" for _ in normalized_periods)
    occurrence_args: list[Any] = [*normalized_periods]
    receipt_args: list[Any] = [*normalized_periods]
    merchant_occurrence_clause = ""
    merchant_receipt_clause = ""

    if merchant_keys:
        merchant_placeholders = ", ".join("?" for _ in merchant_keys)
        merchant_occurrence_clause = f" AND o.merchant_key IN ({merchant_placeholders})"
        merchant_receipt_clause = f" AND r.merchant_key IN ({merchant_placeholders})"
        occurrence_args.extend(merchant_keys)
        receipt_args.extend(merchant_keys)

    hierarchy_query = (
        f"SELECT o.merchant_key, m.display_name AS merchant_name, COALESCE(ca.category_key, 'uncategorized') AS category_key, "
        "c.cluster_id, c.preferred_display_name, SUM(o.net_total_minor) AS spend_minor "
        "FROM item_occurrence o "
        "JOIN merchant m ON m.merchant_key = o.merchant_key "
        "JOIN item_cluster c ON c.cluster_id = o.cluster_id "
        "LEFT JOIN category_assignment ca ON ca.cluster_id = c.cluster_id "
        f"WHERE {occurrence_period_expr} IN ({period_placeholders}) AND o.net_total_minor > 0{merchant_occurrence_clause} "
            "GROUP BY o.merchant_key, m.display_name, COALESCE(ca.category_key, 'uncategorized'), c.cluster_id, c.preferred_display_name "
            "ORDER BY m.display_name, COALESCE(ca.category_key, 'uncategorized'), spend_minor DESC, c.preferred_display_name"
    )
    receipt_totals_query = (
            f"SELECT SUM(r.receipt_total_minor) AS receipt_total_minor, SUM(r.unassigned_discount_total_minor) AS unassigned_discount_total_minor "
        "FROM receipt r "
        f"WHERE {receipt_period_expr} IN ({period_placeholders}){merchant_receipt_clause}"
    )
    negative_totals_query = (
        f"SELECT ABS(SUM(CASE WHEN o.net_total_minor < 0 THEN o.net_total_minor ELSE 0 END)) AS excluded_negative_net_spend_minor "
        "FROM item_occurrence o "
        f"WHERE {occurrence_period_expr} IN ({period_placeholders}){merchant_occurrence_clause}"
    )

    with _connect() as connection:
        hierarchy_rows = connection.execute(hierarchy_query, occurrence_args).fetchall()
        receipt_totals_row = connection.execute(receipt_totals_query, receipt_args).fetchone()
        negative_totals_row = connection.execute(negative_totals_query, occurrence_args).fetchone()

    merchant_nodes: dict[str, dict[str, Any]] = {}
    category_nodes: dict[str, dict[str, Any]] = {}
    item_nodes: list[dict[str, Any]] = []
    positive_net_spend_minor = 0

    for row in hierarchy_rows:
        merchant_key = str(row["merchant_key"])
        merchant_name = str(row["merchant_name"])
        category_key = str(row["category_key"] or "uncategorized")
        cluster_id = str(row["cluster_id"])
        preferred_display_name = str(row["preferred_display_name"] or "").strip() or cluster_id
        spend_minor = int(row["spend_minor"] or 0)
        if spend_minor <= 0:
            continue

        positive_net_spend_minor += spend_minor
        merchant_id = f"merchant:{merchant_key}"
        category_id = f"category:{merchant_key}:{category_key}"
        merchant_entry = merchant_nodes.setdefault(
            merchant_id,
            {
                "id": merchant_id,
                "parent_id": "root",
                "kind": "merchant",
                "label": merchant_name,
                "value_minor": 0,
                "merchant_key": merchant_key,
            },
        )
        merchant_entry["value_minor"] += spend_minor

        category_entry = category_nodes.setdefault(
            category_id,
            {
                "id": category_id,
                "parent_id": merchant_id,
                "kind": "category",
                "label": _category_label(category_key),
                "value_minor": 0,
                "merchant_key": merchant_key,
                "category_key": category_key,
            },
        )
        category_entry["value_minor"] += spend_minor

        item_nodes.append(
            {
                "id": f"item:{merchant_key}:{category_key}:{cluster_id}",
                "parent_id": category_id,
                "kind": "item",
                "label": preferred_display_name,
                "value_minor": spend_minor,
                "merchant_key": merchant_key,
                "category_key": category_key,
                "cluster_id": cluster_id,
            }
        )

    nodes: list[dict[str, Any]] = []
    if positive_net_spend_minor > 0:
        nodes.append(
            {
                "id": "root",
                "parent_id": "",
                "kind": "root",
                "label": "Varenetto",
                "value_minor": positive_net_spend_minor,
            }
        )
        nodes.extend(
            sorted(
                merchant_nodes.values(),
                key=lambda item: (-int(item["value_minor"]), str(item["label"])),
            )
        )
        nodes.extend(
            sorted(
                category_nodes.values(),
                key=lambda item: (-int(item["value_minor"]), str(item["label"]), str(item["merchant_key"])),
            )
        )
        nodes.extend(
            sorted(
                item_nodes,
                key=lambda item: (-int(item["value_minor"]), str(item["label"]), str(item["merchant_key"])),
            )
        )

    return {
        "granularity": granularity,
        "periods": normalized_periods,
        "positive_net_spend_minor": positive_net_spend_minor,
        "receipt_total_minor": int((receipt_totals_row["receipt_total_minor"] or 0) if receipt_totals_row else 0),
        "unassigned_discount_minor": int((receipt_totals_row["unassigned_discount_total_minor"] or 0) if receipt_totals_row else 0),
        "excluded_negative_net_spend_minor": int((negative_totals_row["excluded_negative_net_spend_minor"] or 0) if negative_totals_row else 0),
        "nodes": nodes,
    }


def list_item_clusters(
    *,
    search: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    merchant_keys: list[str] | None = None,
) -> list[dict[str, object]]:
    if not _database_exists():
        return []
    where_clause, args = _build_filters(table_alias="o", date_from=date_from, date_to=date_to, merchant_keys=merchant_keys)
    search_clause = ""
    if search:
        search_clause = " AND (UPPER(c.preferred_display_name) LIKE ? OR UPPER(c.normalized_name) LIKE ?)" if where_clause else " WHERE (UPPER(c.preferred_display_name) LIKE ? OR UPPER(c.normalized_name) LIKE ?)"
        search_term = f"%{search.upper()}%"
        args.extend([search_term, search_term])
    query = (
        "SELECT c.cluster_id, c.preferred_display_name, c.product_number, c.normalized_name, c.variant_signature, c.collapse_strategy, c.confidence, "
        "COALESCE(ca.category_key, 'uncategorized') AS category_key, COALESCE(ca.source, 'taxonomy_fallback') AS category_source, COALESCE(ca.confidence, 'low') AS category_confidence, "
        "COUNT(DISTINCT o.receipt_id) AS receipt_count, SUM(o.quantity) AS quantity_total, SUM(o.gross_total_minor) AS gross_spend_minor, "
        "SUM(o.net_total_minor) AS net_spend_minor, SUM(o.discount_minor) AS total_discount_minor, "
        "AVG(CASE WHEN o.net_total_minor > 0 AND o.quantity > 0 THEN o.unit_price_minor END) AS avg_unit_price_minor, "
        "MIN(CASE WHEN o.net_total_minor > 0 AND o.quantity > 0 THEN o.unit_price_minor END) AS min_unit_price_minor, "
        "MAX(CASE WHEN o.net_total_minor > 0 AND o.quantity > 0 THEN o.unit_price_minor END) AS max_unit_price_minor, "
        "MIN(o.purchase_date) AS first_purchase_date, MAX(o.purchase_date) AS last_purchase_date "
        "FROM item_cluster c JOIN item_occurrence o ON o.cluster_id = c.cluster_id "
        "LEFT JOIN category_assignment ca ON ca.cluster_id = c.cluster_id"
        f"{where_clause}{search_clause} GROUP BY c.cluster_id, COALESCE(ca.category_key, 'uncategorized'), COALESCE(ca.source, 'taxonomy_fallback'), COALESCE(ca.confidence, 'low') ORDER BY net_spend_minor DESC, c.preferred_display_name"
    )
    with _connect() as connection:
        rows = connection.execute(query, args).fetchall()
    return [
        {
            "cluster_id": row["cluster_id"],
            "preferred_display_name": row["preferred_display_name"],
            "product_number": row["product_number"],
            "normalized_name": row["normalized_name"],
            "variant_signature": row["variant_signature"],
            "collapse_strategy": row["collapse_strategy"],
            "confidence": row["confidence"],
            "category_key": row["category_key"],
            "category_label": _category_label(row["category_key"]),
            "category_source": row["category_source"],
            "category_confidence": row["category_confidence"],
            "category_is_override": row["category_source"] == "manual",
            "receipt_count": row["receipt_count"],
            "quantity_total": row["quantity_total"],
            "gross_spend_minor": row["gross_spend_minor"] or 0,
            "net_spend_minor": row["net_spend_minor"] or 0,
            "total_discount_minor": row["total_discount_minor"] or 0,
            "avg_unit_price_minor": int(round(row["avg_unit_price_minor"] or 0)),
            "min_unit_price_minor": row["min_unit_price_minor"],
            "max_unit_price_minor": row["max_unit_price_minor"],
            "first_purchase_date": row["first_purchase_date"],
            "last_purchase_date": row["last_purchase_date"],
        }
        for row in rows
    ]


def get_item_cluster(cluster_id: str) -> dict[str, object] | None:
    if not _database_exists():
        return None
    with _connect() as connection:
        cluster_row = connection.execute(
            "SELECT * FROM item_cluster WHERE cluster_id = ?",
            (cluster_id,),
        ).fetchone()
        if cluster_row is None:
            return None
        alias_rows = connection.execute(
            "SELECT raw_name, normalized_name, variant_signature, product_number, first_seen_receipt_id, last_seen_receipt_id FROM item_alias WHERE cluster_id = ? ORDER BY raw_name",
            (cluster_id,),
        ).fetchall()
        metric_rows = list_item_clusters()
        metric = next((item for item in metric_rows if item["cluster_id"] == cluster_id), None)
    return {
        "cluster": metric or dict(cluster_row),
        "aliases": [dict(row) for row in alias_rows],
        "category_options": _category_options_payload(),
    }


def set_item_cluster_category_override(cluster_id: str, category_key: str | None) -> dict[str, object] | None:
    normalized_category_key = _validated_category_override_key(category_key)
    if not _database_exists():
        return None

    with _connect() as connection:
        cluster_row = connection.execute(
            "SELECT cluster_id, preferred_display_name, normalized_name FROM item_cluster WHERE cluster_id = ?",
            (cluster_id,),
        ).fetchone()
        if cluster_row is None:
            return None
        override_records = _load_manual_category_overrides(connection)

        if normalized_category_key is None:
            override_records.pop(cluster_id, None)
        else:
            override_records[cluster_id] = _category_override_record(
                cluster_id,
                str(cluster_row["preferred_display_name"]),
                normalized_category_key,
            )

    _write_category_override_file(override_records)

    database_path = get_kvitteringer_db_path()
    if database_path.exists():
        if not _purge_outdated_database_file():
            create_backup(database_path)

    with _connect() as connection:
        if normalized_category_key is None:
            resolved_category_key, source, confidence = _resolve_cluster_category_assignment(
                connection,
                cluster_id=cluster_id,
                preferred_display_name=str(cluster_row["preferred_display_name"]),
                normalized_name=str(cluster_row["normalized_name"]),
            )
        else:
            resolved_category_key, source, confidence = normalized_category_key, "manual", "high"

        _set_category_assignment(
            connection,
            cluster_id=cluster_id,
            category_key=resolved_category_key,
            source=source,
            confidence=confidence,
        )
        connection.commit()

    return get_item_cluster(cluster_id)


def item_purchase_history(
    cluster_id: str,
    *,
    date_from: date | None = None,
    date_to: date | None = None,
    merchant_keys: list[str] | None = None,
) -> list[dict[str, object]]:
    if not _database_exists():
        return []
    where_clause, args = _build_filters(table_alias="o", date_from=date_from, date_to=date_to, merchant_keys=merchant_keys)
    cluster_clause = " AND o.cluster_id = ?" if where_clause else " WHERE o.cluster_id = ?"
    args.append(cluster_id)
    query = (
        "SELECT o.occurrence_id, o.receipt_id, o.merchant_key, o.cluster_id, o.purchase_timestamp, o.purchase_date, o.display_name, o.product_number, o.variant_signature, o.quantity, o.gross_total_minor, o.discount_minor, "
        "o.net_total_minor, o.unit_price_minor, o.is_return, o.is_refund, o.category_key, m.display_name AS merchant_name "
        "FROM item_occurrence o JOIN merchant m ON m.merchant_key = o.merchant_key"
        f"{where_clause}{cluster_clause} ORDER BY o.purchase_timestamp, o.receipt_id, o.source_line_index"
    )
    with _connect() as connection:
        rows = connection.execute(query, args).fetchall()
    return _aggregate_occurrences(
        [
            {
                **dict(row),
                "is_return": bool(row["is_return"]),
                "is_refund": bool(row["is_refund"]),
            }
            for row in rows
        ]
    )


def item_price_history(
    cluster_id: str,
    *,
    date_from: date | None = None,
    date_to: date | None = None,
    merchant_keys: list[str] | None = None,
) -> list[dict[str, object]]:
    return [
        item
        for item in item_purchase_history(cluster_id, date_from=date_from, date_to=date_to, merchant_keys=merchant_keys)
        if (item.get("unit_price_minor") or 0) > 0 and not item.get("is_return")
    ]


def _item_price_outliers(
    *,
    cluster_id: str | None = None,
    merchant_key: str | None = None,
) -> list[dict[str, object]]:
    if not _database_exists():
        return []
    query = (
        "SELECT o.cluster_id, c.preferred_display_name, o.receipt_id, o.purchase_date, o.unit_price_minor, o.net_total_minor, o.quantity, o.merchant_key "
        "FROM item_occurrence o JOIN item_cluster c ON c.cluster_id = o.cluster_id "
        "WHERE o.unit_price_minor IS NOT NULL AND o.unit_price_minor > 0 AND o.is_return = 0"
    )
    args: list[Any] = []
    if cluster_id:
        query += " AND o.cluster_id = ?"
        args.append(cluster_id)
    if merchant_key:
        query += " AND o.merchant_key = ?"
        args.append(merchant_key)
    query += " ORDER BY o.cluster_id, o.purchase_date"
    with _connect() as connection:
        rows = connection.execute(query, args).fetchall()

    grouped: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        grouped.setdefault(row["cluster_id"], []).append(row)

    outliers: list[dict[str, object]] = []
    for current_cluster_id, cluster_rows in grouped.items():
        values = [int(row["unit_price_minor"]) for row in cluster_rows]
        if len(values) < 4:
            continue
        quartiles = statistics.quantiles(values, n=4, method="inclusive")
        q1 = quartiles[0]
        q3 = quartiles[2]
        iqr = q3 - q1
        lower_bound = q1 - 1.5 * iqr
        upper_bound = q3 + 1.5 * iqr
        baseline = int(round(statistics.median(values)))
        for row in cluster_rows:
            metric_value = int(row["unit_price_minor"])
            if lower_bound <= metric_value <= upper_bound:
                continue
            outliers.append(
                {
                    "outlier_type": "iqr_unit_price",
                    "cluster_id": current_cluster_id,
                    "preferred_display_name": row["preferred_display_name"],
                    "receipt_id": row["receipt_id"],
                    "purchase_date": row["purchase_date"],
                    "metric_value_minor": metric_value,
                    "baseline_value_minor": baseline,
                    "reason": f"Unit price {metric_value} outside IQR bounds [{int(round(lower_bound))}, {int(round(upper_bound))}]",
                }
            )
    return outliers


def _receipt_outliers() -> list[dict[str, object]]:
    if not _database_exists():
        return []
    with _connect() as connection:
        rows = connection.execute(
            "SELECT receipt_id, purchase_date, receipt_total_minor, unassigned_discount_total_minor, gap_minor FROM receipt WHERE gap_minor != 0 OR unassigned_discount_total_minor > 0 ORDER BY purchase_timestamp"
        ).fetchall()
    outliers: list[dict[str, object]] = []
    for row in rows:
        if row["unassigned_discount_total_minor"] > 0:
            outliers.append(
                {
                    "outlier_type": "unassigned_discount",
                    "receipt_id": row["receipt_id"],
                    "purchase_date": row["purchase_date"],
                    "metric_value_minor": row["unassigned_discount_total_minor"],
                    "baseline_value_minor": 0,
                    "reason": "Receipt contains unassigned discount lines",
                }
            )
        if row["gap_minor"] != 0:
            outliers.append(
                {
                    "outlier_type": "receipt_gap",
                    "receipt_id": row["receipt_id"],
                    "purchase_date": row["purchase_date"],
                    "metric_value_minor": row["gap_minor"],
                    "baseline_value_minor": 0,
                    "reason": "Receipt total does not match reconstructed total",
                }
            )
    return outliers


def _basket_outliers() -> list[dict[str, object]]:
    if not _database_exists():
        return []
    with _connect() as connection:
        merchant_rows = connection.execute(
            "SELECT merchant_key FROM receipt GROUP BY merchant_key HAVING COUNT(*) >= 3"
        ).fetchall()
        outliers: list[dict[str, object]] = []
        for merchant_row in merchant_rows:
            merchant_key = merchant_row["merchant_key"]
            receipt_rows = connection.execute(
                "SELECT receipt_id, purchase_date, receipt_total_minor FROM receipt WHERE merchant_key = ? AND receipt_total_minor > 0 ORDER BY purchase_date",
                (merchant_key,),
            ).fetchall()
            values = [int(row["receipt_total_minor"]) for row in receipt_rows]
            if len(values) < 3:
                continue
            baseline = int(round(statistics.median(values)))
            threshold = int((Decimal(baseline) * RECEIPT_BASKET_OUTLIER_FACTOR).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
            for row in receipt_rows:
                if row["receipt_total_minor"] <= threshold:
                    continue
                outliers.append(
                    {
                        "outlier_type": "basket_total",
                        "receipt_id": row["receipt_id"],
                        "purchase_date": row["purchase_date"],
                        "merchant_key": merchant_key,
                        "metric_value_minor": row["receipt_total_minor"],
                        "baseline_value_minor": baseline,
                        "reason": f"Receipt total exceeds merchant median threshold {threshold}",
                    }
                )
        return outliers


def kvitteringer_outliers() -> dict[str, object]:
    return {
        "receipt_outliers": _receipt_outliers(),
        "item_price_outliers": _item_price_outliers(),
        "basket_outliers": _basket_outliers(),
    }


def _transaction_date(payload: dict[str, Any]) -> date | None:
    booking_date = payload.get("booking_date")
    if isinstance(booking_date, date):
        return booking_date
    if booking_date:
        return date.fromisoformat(str(booking_date))
    posted_at = payload.get("posted_at")
    if posted_at:
        return datetime.fromisoformat(str(posted_at).replace("Z", "+00:00")).date()
    return None


def _description_matches_merchant(description: str | None, merchant_name: str, merchant_key: str) -> bool:
    if not description:
        return False
    normalized_description = re.sub(r"[^A-Z0-9]+", "", _normalize_name(description))
    normalized_merchant_name = re.sub(r"[^A-Z0-9]+", "", _normalize_name(merchant_name))
    normalized_merchant_key = re.sub(r"[^A-Z0-9]+", "", merchant_key.upper())
    return bool(normalized_merchant_name and normalized_merchant_name in normalized_description) or bool(
        normalized_merchant_key and normalized_merchant_key in normalized_description
    )


def link_spiir_transaction_to_receipt(payload: dict[str, Any]) -> dict[str, object]:
    if not _database_exists():
        return {
            "linked": False,
            "receipt_id": None,
            "confidence": None,
            "reason": "kvitteringer_database_missing",
            "cached": False,
        }

    transaction_id = str(payload.get("transaction_id") or "").strip()
    if not transaction_id:
        raise ValueError("transaction_id is required")

    with _connect() as connection:
        cached = connection.execute(
            "SELECT receipt_id, confidence, reason FROM spiir_receipt_link WHERE transaction_id = ?",
            (transaction_id,),
        ).fetchone()
        if cached is not None:
            return {
                "linked": True,
                "receipt_id": cached["receipt_id"],
                "confidence": cached["confidence"],
                "reason": cached["reason"],
                "cached": True,
            }

        transaction_date = _transaction_date(payload)
        if transaction_date is None:
            return {
                "linked": False,
                "receipt_id": None,
                "confidence": None,
                "reason": "missing_transaction_date",
                "cached": False,
            }
        target_amount_minor = abs(_to_minor(payload.get("amount") or 0))
        rows = connection.execute(
            "SELECT r.receipt_id, r.purchase_date, r.receipt_total_minor, m.display_name AS merchant_name, r.merchant_key "
            "FROM receipt r JOIN merchant m ON m.merchant_key = r.merchant_key "
            "WHERE r.purchase_date BETWEEN ? AND ? AND r.receipt_total_minor = ? ORDER BY r.purchase_timestamp",
            (
                (transaction_date - timedelta(days=1)).isoformat(),
                (transaction_date + timedelta(days=1)).isoformat(),
                target_amount_minor,
            ),
        ).fetchall()

        strong_candidates = [
            row
            for row in rows
            if row["purchase_date"] == transaction_date.isoformat()
            and _description_matches_merchant(payload.get("description"), row["merchant_name"], row["merchant_key"])
        ]
        if len(strong_candidates) != 1:
            return {
                "linked": False,
                "receipt_id": None,
                "confidence": None,
                "reason": "no_high_confidence_match",
                "cached": False,
            }

        receipt_id = strong_candidates[0]["receipt_id"]
        connection.execute(
            "INSERT OR REPLACE INTO spiir_receipt_link(transaction_id, receipt_id, confidence, reason, transaction_payload_json, created_at) VALUES(?, ?, ?, ?, ?, ?)",
            (
                transaction_id,
                receipt_id,
                "high",
                SPIIR_LINK_REASON,
                json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str),
                _utc_now(),
            ),
        )
        connection.commit()
    return {
        "linked": True,
        "receipt_id": receipt_id,
        "confidence": "high",
        "reason": SPIIR_LINK_REASON,
        "cached": False,
    }
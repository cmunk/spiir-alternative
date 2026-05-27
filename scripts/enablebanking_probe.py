from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import uuid
from pathlib import Path
from typing import Any

import jwt
import requests

ROOT_DIR = Path(__file__).resolve().parents[1]
APP_ID = os.getenv("ENABLEBANKING_APP_ID", "").strip()
API_BASE = "https://api.enablebanking.com"
DATA_ROOT = Path(os.getenv("SPIIR_ALT_DATA_DIR", ROOT_DIR / "data")).expanduser().resolve()
KEY_PATH = Path(
    os.getenv("ENABLEBANKING_PRIVATE_KEY_PATH", DATA_ROOT / "local_secrets" / "enablebanking" / f"{APP_ID or 'app-id'}.pem")
).expanduser().resolve()
DATA_DIR = DATA_ROOT / "transactions" / "enablebanking"
RAW_DIR = DATA_ROOT / "transactions" / "raw" / "enablebanking"
REDIRECT_URL = os.getenv("ENABLEBANKING_REDIRECT_URL", "http://127.0.0.1:8000/enablebanking/callback")


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def auth_headers() -> dict[str, str]:
    if not APP_ID:
        raise RuntimeError("Set ENABLEBANKING_APP_ID")
    private_key = KEY_PATH.read_bytes()
    issued_at = int(utc_now().timestamp())
    token = jwt.encode(
        {
            "iss": "enablebanking.com",
            "aud": "api.enablebanking.com",
            "iat": issued_at,
            "exp": issued_at + 3600,
        },
        private_key,
        algorithm="RS256",
        headers={"kid": APP_ID},
    )
    return {"Authorization": f"Bearer {token}", "Accept": "application/json"}


def request_json(method: str, path: str, **kwargs: Any) -> Any:
    response = requests.request(method, f"{API_BASE}{path}", headers=auth_headers(), timeout=60, **kwargs)
    try:
        payload = response.json()
    except ValueError:
        payload = {"text": response.text}
    if response.status_code >= 400:
        raise RuntimeError(f"{method} {path} failed: {response.status_code} {payload}")
    return payload


def command_aspsps() -> None:
    payload = request_json("GET", "/aspsps", params={"country": "DK", "service": "AIS", "psu_type": "personal"})
    write_json(DATA_DIR / "aspsps_dk_personal_ais.json", payload)
    matches = [item for item in payload.get("aspsps", []) if "nordea" in item.get("name", "").lower()]
    print(json.dumps(matches, indent=2, ensure_ascii=False))
    print(f"\nSaved full ASPSP list: {DATA_DIR / 'aspsps_dk_personal_ais.json'}")


def command_auth_url(days: int) -> None:
    state = str(uuid.uuid4())
    valid_until = (utc_now() + dt.timedelta(days=days)).isoformat().replace("+00:00", "Z")
    body = {
        "access": {"balances": True, "transactions": True, "valid_until": valid_until},
        "aspsp": {"name": "Nordea", "country": "DK"},
        "psu_type": "personal",
        "redirect_url": REDIRECT_URL,
        "state": state,
        "language": "da",
        "psu_id": os.getenv("ENABLEBANKING_PSU_ID", "spiir-alternative-local"),
    }
    payload = request_json("POST", "/auth", json=body)
    write_json(DATA_DIR / "latest_auth_request.json", {"request": body, "response": payload})
    print(payload["url"])
    print("\nAfter consent, copy the `code` query parameter from the callback URL.")


def command_session(code: str) -> None:
    payload = request_json("POST", "/sessions", json={"code": code})
    session_id = payload["session_id"]
    write_json(DATA_DIR / "latest_session.json", payload)
    write_json(DATA_DIR / f"session_{session_id}.json", payload)
    print(json.dumps({"session_id": session_id, "accounts": payload.get("accounts", [])}, indent=2, ensure_ascii=False))


def command_transactions(args: argparse.Namespace) -> None:
    session = read_json(DATA_DIR / "latest_session.json")
    accounts = session.get("accounts") or []
    if not accounts:
        raise RuntimeError("No accounts in latest session")
    account = accounts[args.account_index]
    account_uid = account["uid"]
    params: dict[str, Any] = {"strategy": args.strategy, "transaction_status": "BOOK"}
    if args.date_from:
        params["date_from"] = args.date_from
    if args.date_to:
        params["date_to"] = args.date_to

    transactions: list[dict[str, Any]] = []
    continuation_key = None
    while True:
        page_params = dict(params)
        if continuation_key:
            page_params["continuation_key"] = continuation_key
        payload = request_json("GET", f"/accounts/{account_uid}/transactions", params=page_params)
        transactions.extend(payload.get("transactions", []))
        continuation_key = payload.get("continuation_key")
        if not continuation_key:
            break

    out = {
        "fetched_at": utc_now().isoformat().replace("+00:00", "Z"),
        "session_id": session.get("session_id"),
        "account": account,
        "params": params,
        "transaction_count": len(transactions),
        "transactions": transactions,
    }
    out_path = RAW_DIR / f"transactions_{account_uid}_{utc_now().strftime('%Y%m%dT%H%M%SZ')}.json"
    write_json(out_path, out)
    print(json.dumps({"transaction_count": len(transactions), "out_path": str(out_path)}, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="Enable Banking local feasibility probe")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("aspsps")

    auth_parser = subparsers.add_parser("auth-url")
    auth_parser.add_argument("--days", type=int, default=170)

    session_parser = subparsers.add_parser("session")
    session_parser.add_argument("--code", required=True)

    tx_parser = subparsers.add_parser("transactions")
    tx_parser.add_argument("--account-index", type=int, default=0)
    tx_parser.add_argument("--strategy", choices=["default", "longest"], default="longest")
    tx_parser.add_argument("--date-from")
    tx_parser.add_argument("--date-to")

    args = parser.parse_args()
    if args.command == "aspsps":
        command_aspsps()
    elif args.command == "auth-url":
        command_auth_url(args.days)
    elif args.command == "session":
        command_session(args.code)
    elif args.command == "transactions":
        command_transactions(args)


if __name__ == "__main__":
    main()
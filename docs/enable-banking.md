# Enable Banking Setup

This guide documents the reusable Enable Banking/Nordea transaction fetch path in `spiir-alternative`. It is meant for a person, or an AI agent helping that person, who wants to build their own Spiir replacement around the same idea.

It covers the bank-connectivity slice only: developer account, app/key setup, account consent, session exchange, transaction fetch, and how the fetched rows enter this repo. It is not a public AIS/compliance guide.

## How This Repo Uses Enable Banking

Enable Banking is the bank connectivity layer. The rest of the repo is local app code built around the fetched transactions.

Useful files to mirror:

- `scripts/enablebanking_probe.py`: setup/probe helper for listing banks, creating consent URLs, exchanging codes, and fetching raw transactions.
- `backend/app/nordea_service.py`: backend fetcher, status tracking, raw storage, and transaction normalization.
- `backend/app/reference_api.py`: optional FastAPI route wiring around the backend service.
- `backend/app/config.py`: data directory lookup used by the backend code.
- `.gitignore`: keeps local secrets and bank data out of git.

Runtime output lives under `data/transactions/...`, which should stay local and ignored.

The flow is:

1. Create an Enable Banking developer account.
2. Create a production restricted account-information app.
3. Save the app private key locally.
4. Link your own Nordea accounts in Enable Banking.
5. Generate a Nordea consent URL.
6. Approve consent through Nordea/MitID.
7. Exchange the returned `code` for an Enable Banking session.
8. Fetch booked account transactions and archive the raw JSON locally.

The code signs RS256 JWTs with your app private key. The JWT uses:

- `iss`: `enablebanking.com`
- `aud`: `api.enablebanking.com`
- `kid`: your Enable Banking app id

The relevant API endpoints are:

- `GET /aspsps?country=DK&service=AIS&psu_type=personal`
- `POST /auth`
- `POST /sessions`
- `GET /accounts/{uid}/transactions`

## Production Restricted Vs Sandbox

For a single-person Spiir replacement, production restricted mode is usually the shortest useful path. Sandbox can prove that JWT signing and request plumbing work, but it will not prove that your real Nordea accounts and transaction history work.

Use the restricted production setup when:

- you only need your own accounts
- you are comfortable linking those accounts in Enable Banking
- you are not offering this as a public multi-user service

In restricted production, only explicitly linked accounts can be accessed. Unrestricted/general activation is outside the scope of this reference repo.

## What You Need

- an Enable Banking developer account
- an Enable Banking app id
- Account Information / AIS access
- an RSA private key PEM for the app
- a redirect URL registered in the Enable Banking app
- Python dependencies from `backend/requirements.txt`
- somewhere outside git to store the private key and bank data

The repo is already set up to ignore `data/*`. Keep it that way.

## Create The Enable Banking App

In the Enable Banking portal, create an app similar to this:

- Environment: `PRODUCTION`
- Service: `Account Information Restricted` or equivalent AIS/restricted option
- Description: `Local personal finance app for importing my own bank transactions.`
- Privacy policy URL: a page you control
- Terms of service URL: a page you control
- Redirect URL: `https://your-domain.example/enablebanking/callback`

If the portal allows a local redirect, `http://127.0.0.1:8000/enablebanking/callback` is convenient. If it requires public HTTPS, use a small endpoint or page on a domain you control.

The reference API does not include a callback route. That is fine for the first manual run: after Nordea redirects back, copy the `code` query parameter from the browser address bar. Even a `404 Not Found` page is usable if the final URL contains `?code=...`.

Generate or register the app key in the portal and download/save the private key PEM. The app id must be the value used as the JWT `kid` header.

## Store The Key Locally

From the repo root:

```bash
mkdir -p data/local_secrets/enablebanking
mv ~/Downloads/<downloaded-private-key>.pem data/local_secrets/enablebanking/<app-id>.pem
chmod 600 data/local_secrets/enablebanking/<app-id>.pem
```

Set the environment variables:

```bash
export SPIIR_ALT_DATA_DIR="$PWD/data"
export ENABLEBANKING_APP_ID="<app-id>"
export ENABLEBANKING_PRIVATE_KEY_PATH="$PWD/data/local_secrets/enablebanking/$ENABLEBANKING_APP_ID.pem"
export ENABLEBANKING_REDIRECT_URL="https://your-domain.example/enablebanking/callback"
export ENABLEBANKING_PSU_ID="spiir-alternative-local"
```

The root `env.example` contains the same variables if you prefer to copy and source a local `.env` file.

`ENABLEBANKING_PSU_ID` is optional. It is just a stable local identifier sent in the auth request.

## Install Dependencies

Use Python 3.11 or newer.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
```

## Verify Nordea Availability

Run the ASPSP lookup first. It confirms that JWT signing works and that Enable Banking lists Nordea for Danish personal AIS.

```bash
python scripts/enablebanking_probe.py aspsps
```

For Nordea Denmark, the useful things to look for are:

- personal AIS is available
- auth is redirect-based
- BIC is `NDEADKKK`
- max consent is around 180 days, observed as `15552000` seconds

Use a little less than the max consent when creating the auth URL. The examples below use 170 days.

## Link Your Own Accounts

In the Enable Banking portal, activate/link your own bank accounts for the restricted production app.

Choose Nordea Denmark, complete the bank login/MitID flow, and select the accounts you want available. In restricted mode, Enable Banking should only allow access to those linked accounts.

## Generate A Consent URL

```bash
python scripts/enablebanking_probe.py auth-url --days 170
```

Open the printed URL in your browser. Complete the Nordea consent flow.

After consent, the browser redirects to your registered redirect URL with query parameters like:

```text
https://your-domain.example/enablebanking/callback?state=<state>&code=<code>
```

Copy only the `code` value. The code is short-lived, so exchange it promptly.

## Exchange The Code For A Session

```bash
python scripts/enablebanking_probe.py session --code "<code>"
```

This writes:

- `data/transactions/enablebanking/latest_session.json`
- `data/transactions/enablebanking/session_<session-id>.json`

The session contains the accounts that Enable Banking returned for the consent.

## Fetch Transactions

For the first fetch, ask for the longest available booked history:

```bash
python scripts/enablebanking_probe.py transactions --account-index 0 --strategy longest
```

Repeat with `--account-index 1`, `--account-index 2`, and so on if the session contains multiple accounts.

The probe archives raw responses under:

```text
data/transactions/raw/enablebanking/
```

The script follows `continuation_key` pagination for you. If you write your own client, keep fetching pages until there is no continuation key.

For later incremental fetches, use explicit dates when useful:

```bash
python scripts/enablebanking_probe.py transactions --account-index 0 --strategy default --date-from 2026-01-01 --date-to 2026-01-31
```

Consent/session access may need renewal around the bank's consent limit.

## Mirror Or Adapt The Pieces

If you use this repo with an AI agent, give it this section plus the files listed near the top.

1. Make `scripts/enablebanking_probe.py` work first. It is smaller and easier to debug than the backend service.
2. Keep these env vars or map them explicitly: `SPIIR_ALT_DATA_DIR`, `ENABLEBANKING_APP_ID`, `ENABLEBANKING_PRIVATE_KEY_PATH`, `ENABLEBANKING_REDIRECT_URL`.
3. If your bank is not Nordea DK, change the `/aspsps` country/service lookup and the `aspsp` body sent to `/auth`.
4. Keep raw transaction archives before normalization. They are the easiest way to debug mapping mistakes.
5. Keep session storage explicit. This repo writes `data/transactions/enablebanking/latest_session.json`; `nordea_service.py` reads that file.
6. Keep bank fetch separate from categorisation and UI. First prove you can fetch stable raw transactions.
7. Do not hardcode app ids, private key paths, account ids, IBANs, consent codes, or session ids.

For a minimal independent project, copy the probe script first. Add the backend service only after the consent/session/fetch flow works.

## Wire Into This Repo

Start the API:

```bash
uvicorn app.reference_api:app --app-dir backend --reload --port 8000
```

Start a Nordea retrieval job and poll status:

```bash
curl -X POST http://127.0.0.1:8000/api/nordea/retrieve/start
curl http://127.0.0.1:8000/api/nordea/retrieve/status
```

Then sync Nordea rows into the local ledger and rebuild the Spiir-style overview:

```bash
curl -X POST http://127.0.0.1:8000/api/spiir/local-ledger/nordea-sync/apply
curl -X POST http://127.0.0.1:8000/api/spiir/rebuild-from-local
```

The reference API has no auth gate. Do not expose it directly. Add a password/session layer before using it outside your own machine.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Set ENABLEBANKING_APP_ID` | env var is missing | export `ENABLEBANKING_APP_ID` before running the probe |
| `Missing Enable Banking private key` | key path is wrong | check `ENABLEBANKING_PRIVATE_KEY_PATH` and file permissions |
| `401` or `403` | wrong app id/key, inactive app, or unlinked account | confirm the app id matches the key, app is active, and accounts are linked |
| Redirect URL mismatch | URL differs from portal value | make `ENABLEBANKING_REDIRECT_URL` exactly match the registered redirect |
| Browser shows `Not Found` after consent | no callback route exists | copy `code` from the URL if it is present |
| Session has no accounts | account linking or consent did not include accounts | link accounts in the portal and redo consent |
| Few or no transactions | history window, status, or strategy | try `--strategy longest` soon after consent and fetch booked transactions |
| Duplicate or missing pages in your own client | pagination not handled | follow `continuation_key` until it disappears |

## Do Not Commit

Before sharing a fork, prompt, generated patch, screenshot, or debug log:

1. Remove any real `data/` files.
2. Remove `.env` and shell history snippets with secrets.
3. Remove all PEM/private key files.
4. Remove `latest_session.json`, raw Enable Banking JSON, and account metadata.
5. Redact screenshots with account numbers, merchant names, amounts, notes, and receipt lines.
6. Rotate any Enable Banking key that was exposed in public, chat, CI, or a screenshot.
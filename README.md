# VoiceKhata backend

FastAPI backend for merchant accounts, customers, udhaar/jama ledger entries, and Gnani speech integration.

## Start locally

Requires Python 3.11 or newer.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Set a private `SECRET_KEY` in `.env` (for example, generate one with `python -c 'import secrets; print(secrets.token_urlsafe(48))'`). Set `GNANI_API_KEY` to the key from your Gnani account to enable speech endpoints. The key stays on the server and is never returned to the browser.

```bash
uvicorn app.main:app --reload
```

Interactive API docs: <http://127.0.0.1:8000/docs>

If you forget the local merchant password, run `./reset-password.sh` from the project folder. It prompts for the account email and a new password without displaying the password.

By default, local data is stored in `voicekhata.db`. To use PostgreSQL, set `DATABASE_URL` to a SQLAlchemy URL such as `postgresql+psycopg://user:password@localhost:5432/voicekhata`. Configure a persistent database before deployment; local SQLite is suitable for development and a single-machine demo.

## API flow

1. `POST /api/v1/auth/register` with `{ "name", "email", "password" }`; save the returned bearer token in the frontend's session state.
2. Send `Authorization: Bearer <access_token>` for authenticated routes.
3. Create customers with `POST /api/v1/customers`.
4. Add entries with `POST /api/v1/ledger/entries`; `entry_type` is `udhaar` or `jama`.
5. Load a customer's history and calculated balance from `GET /api/v1/customers/{customer_id}/ledger`.
6. For voice: upload `audio` plus `language_code` to `POST /api/v1/voice/sessions`. Show the returned transcript, let the merchant select the customer and verify amount/type, then call `/api/v1/voice/sessions/{session_id}/confirm`. The backend saves only after explicit confirmation. Use `/cancel` to discard a pending session.
7. `POST /api/v1/voice/speak` with `{ "text", "language_code" }` returns Gnani's SSE audio stream for playback.

Voice uploads are processed in memory and not stored. The recognized transcript and session state are retained for the ledger audit trail. This starter does not infer or commit an amount from transcript text; the frontend must show the transcript and collect explicit structured confirmation to avoid incorrect financial entries.

## Frontend contract

Use the OpenAPI page at `/docs` while integrating. Customer and ledger endpoints are merchant-scoped by the login token, so the frontend should not send a merchant ID. Set `CORS_ORIGINS` to the exact URL where the frontend runs.

## Before production

Add database migrations, HTTPS deployment, backups, rate limits, monitoring, account recovery, and a reviewed privacy/retention policy. Configure a managed PostgreSQL database for multi-device use. Keep secrets in the host's secret manager, not in the repository.

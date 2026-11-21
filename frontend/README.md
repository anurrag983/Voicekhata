# VoiceKhata frontend

Responsive static frontend connected to the FastAPI backend. Customer accounts and ledger entries are read from and saved to the backend database; they no longer live only in browser memory.

## Configure and run

1. Start the backend in the project root with `./start.sh`.
2. Open <http://127.0.0.1:8000>. The backend serves the UI and API from one address, so no separate frontend server or IP setting is needed on the same Mac.
3. Create the shop account once with shop name, owner, area/city, email, and password. Later logins ask only for email and password. The UI sends the bearer token to the backend and loads the saved shop profile, customers, balances, and ledger history.

The API key stays in the backend `.env`; it does not belong in `config.js`. If you later run the frontend on a second Mac, set that copy's `config.js` to the backend Mac's URL and follow the two-Mac instructions in `FRONTEND_HANDOFF.md`.

## Voice behavior

When `GNANI_API_KEY` is set in the backend `.env`, the voice button records up to 59 seconds, converts the recording to mono WAV, and sends it to the backend for Gnani transcription and speech output. The app reads the customer, amount, and entry type aloud, then listens for a spoken confirmation before saving. If the spoken name is ambiguous or close to another account, it asks the user to say the account name/number or choose on screen. Audio is processed in memory and is not stored in the database. Without Gnani, the browser uses its built-in speech recognition and speech synthesis when supported; otherwise it falls back to on-screen confirmation.

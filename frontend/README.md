# VoiceKhata frontend

Responsive static frontend connected to the FastAPI backend. Customer accounts and ledger entries are read from and saved to the backend database; they no longer live only in browser memory.

## Configure and run

1. Start the backend in the project root with `./start.sh`.
2. Open <http://127.0.0.1:8000>. The backend serves the UI and API from one address, so no separate frontend server or IP setting is needed on the same Mac.
3. Create the shop account once with shop name, owner, area/city, email, and password. Later logins ask only for email and password. The UI sends the bearer token to the backend and loads the saved shop profile, customers, balances, and ledger history.

The API key stays in the backend `.env`; it does not belong in `config.js`. If you later run the frontend on a second Mac, set that copy's `config.js` to the backend Mac's URL and follow the two-Mac instructions in `FRONTEND_HANDOFF.md`.

## Voice behavior

When `GNANI_API_KEY` is set in the backend `.env`, the voice button records up to 29 seconds, stops after a brief pause, converts the recording to mono WAV, and sends it to the backend for Gnani transcription and speech output. Follow-up answers also use Gnani transcription when available. The app asks for a missing amount or transaction type, asks whether a matching customer is the existing person or a new person, requests a distinguishing name for a new same-name person, then reads the complete entry aloud and waits for a spoken yes before saving. If the spoken name is close to another account, it asks which account to use. Audio is processed in memory and is not stored in the database. Without Gnani, the browser uses built-in speech recognition and speech synthesis when supported; otherwise it falls back to the manual entry form.

## Customer history

Select a customer in the digital khata or on the overview page to open their account history. The detail page loads the customer's complete ledger from the backend and shows the current balance, total udhaar, total payments, transaction dates and notes, and the running balance after each entry.

The customer history page has a **Request payment on WhatsApp** action. Save the shop's UPI ID once in **Profile**; the app opens a pre-filled WhatsApp message with the customer's current outstanding balance and that UPI ID. This is a manual UPI flow: VoiceKhata cannot confirm whether a transfer succeeded. Check the shop's UPI app or bank statement, then add a `jama` entry only after confirming the money arrived.

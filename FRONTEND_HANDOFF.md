# VoiceKhata frontend handoff

Use this contract to connect the UI to the backend. Local API base URL:

```text
http://127.0.0.1:8000
```

The backend must be running in Terminal. That address works only on the same Mac. For two Macs on the same trusted Wi-Fi, use the LAN setup below. For different networks, deploy the API and database before connecting them.

## Connecting a second Mac on the same Wi-Fi

On the Mac running the backend, stop the current server with Control+C. Find that Mac's Wi-Fi address:

```bash
ipconfig getifaddr en0
```

Then start the API so other devices on the local network can reach it:

```bash
HOST=0.0.0.0 ./start.sh
```

If macOS asks whether Python may accept incoming connections, allow it for this local development session. Give the frontend developer the backend Mac's IP address (for example, `192.168.1.25`) and set the frontend API base URL to `http://192.168.1.25:8000`. Replace the example IP with the value from `ipconfig`.

The frontend can keep running at `http://localhost:5173`; that origin is already allowed by the default CORS settings. If it uses another port or hostname, add that exact frontend origin to `CORS_ORIGINS` in the backend `.env`, then restart the backend. Both Macs need to stay on the same trusted Wi-Fi. Do not use this unencrypted development setup on public Wi-Fi or expose port 8000 to the public internet.

## 1. Register or log in

Register once:

```http
POST /api/v1/auth/register
Content-Type: application/json
```

```json
{"name":"My Shop","email":"owner@example.com","password":"use-a-private-password"}
```

For later sessions, log in:

```http
POST /api/v1/auth/login
Content-Type: application/json
```

```json
{"email":"owner@example.com","password":"use-a-private-password"}
```

Both return `access_token`. Keep it in frontend session state and send it on each protected request:

```http
Authorization: Bearer <access_token>
```

Never send the token or the Gnani API key in screenshots, source code, or chat. The Gnani key belongs only in the backend `.env` file.

## 2. Customer and ledger flow

Create a customer:

```http
POST /api/v1/customers
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{"name":"Ramesh","phone":"9876543210"}
```

List customers and balances: `GET /api/v1/customers` (optional search: `?q=Ram`).

Create an udhaar or repayment entry:

```http
POST /api/v1/ledger/entries
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{"customer_id":"<id from the customer response>","amount":340,"entry_type":"udhaar","note":"demo sale"}
```

`entry_type` must be `udhaar` or `jama`. Load history and current balance using `GET /api/v1/customers/{customer_id}/ledger`.

## 3. Voice flow

Upload audio as multipart form data to `POST /api/v1/voice/sessions`, with fields `audio` (file) and `language_code` (for example `hi-IN`). The response contains the recognized transcript and a `session_id`.

Show the transcript and let the merchant select the customer, amount, and entry type. Only after the merchant confirms, call `POST /api/v1/voice/sessions/{session_id}/confirm` with:

```json
{"customer_id":"<customer id>","amount":340,"entry_type":"udhaar","note":"voice entry"}
```

The speech endpoint does not currently extract customer and amount into structured fields. The UI must collect and confirm those fields. For spoken replies, `POST /api/v1/voice/speak` accepts `{"text":"Ramesh ka 340 rupaye udhaar save hua","language_code":"hi-IN"}` and returns an SSE stream.

Voice routes need `GNANI_API_KEY` set in the backend `.env`. Configure `CORS_ORIGINS` in `.env` if the UI runs on a different local port, then restart the backend.

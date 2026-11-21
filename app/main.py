from __future__ import annotations

from contextlib import asynccontextmanager
from decimal import Decimal
from pathlib import Path
from typing import Optional
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Response, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import case, func, inspect, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import Base, engine, get_db
from app.models import Customer, EntryType, LedgerEntry, Merchant, VoiceSession, VoiceStatus, normalize_customer_name
from app.schemas import (
    CustomerCreate,
    CustomerOut,
    LedgerEntryCreate,
    LedgerEntryOut,
    LedgerSummary,
    MerchantCreate,
    MerchantLogin,
    MerchantOut,
    MerchantUpdate,
    TTSRequest,
    TokenOut,
    VoiceConfirm,
    VoiceSessionOut,
)
from app.security import create_access_token, get_current_merchant, hash_password, verify_password


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    # Add profile columns to existing starter databases without deleting shop or ledger data.
    with engine.begin() as connection:
        merchant_columns = {column["name"] for column in inspect(connection).get_columns("merchants")}
        if "owner_name" not in merchant_columns:
            connection.exec_driver_sql("ALTER TABLE merchants ADD COLUMN owner_name VARCHAR(120)")
        if "location" not in merchant_columns:
            connection.exec_driver_sql("ALTER TABLE merchants ADD COLUMN location VARCHAR(160)")
        customer_columns = {column["name"] for column in inspect(connection).get_columns("customers")}
        if "name_key" not in customer_columns:
            connection.exec_driver_sql("ALTER TABLE customers ADD COLUMN name_key VARCHAR(512)")
        seen_customer_keys = set()
        customer_rows = connection.execute(
            text("SELECT id, merchant_id, name, name_key FROM customers ORDER BY created_at, id")
        ).mappings()
        for row in customer_rows:
            base_key = row["name_key"] or normalize_customer_name(row["name"] or "")
            candidate = base_key
            marker = (str(row["merchant_id"]), candidate)
            if marker in seen_customer_keys:
                candidate = f"{base_key}::legacy-duplicate::{row['id']}"
                marker = (str(row["merchant_id"]), candidate)
            seen_customer_keys.add(marker)
            if row["name_key"] != candidate:
                connection.execute(
                    text("UPDATE customers SET name_key = :name_key WHERE id = :id"),
                    {"name_key": candidate, "id": row["id"]},
                )
        connection.exec_driver_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_merchant_name_key "
            "ON customers (merchant_id, name_key)"
        )
        ledger_columns = {column["name"] for column in inspect(connection).get_columns("ledger_entries")}
        if "request_key" not in ledger_columns:
            connection.exec_driver_sql("ALTER TABLE ledger_entries ADD COLUMN request_key VARCHAR(64)")
        connection.exec_driver_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_entries_request_key "
            "ON ledger_entries (request_key)"
        )
    yield


app = FastAPI(title="VoiceKhata API", version="0.1.0", lifespan=lifespan)
settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
)


@app.middleware("http")
async def prevent_api_caching(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/") or request.url.path == "/health":
        response.headers["Cache-Control"] = "no-store"
    return response


def mint_token(merchant: Merchant) -> TokenOut:
    return TokenOut(access_token=create_access_token(merchant.id), merchant=MerchantOut.model_validate(merchant))


def customer_balance(db: Session, merchant_id: UUID, customer_id: UUID) -> Decimal:
    credit = case((LedgerEntry.entry_type == EntryType.udhaar, LedgerEntry.amount), else_=0)
    payment = case((LedgerEntry.entry_type == EntryType.jama, LedgerEntry.amount), else_=0)
    value = db.scalar(
        select(func.coalesce(func.sum(credit - payment), 0)).where(
            LedgerEntry.merchant_id == merchant_id,
            LedgerEntry.customer_id == customer_id,
        )
    )
    return Decimal(str(value or 0)).quantize(Decimal("0.01"))


def owned_customer(db: Session, merchant_id: UUID, customer_id: UUID) -> Customer:
    customer = db.scalar(
        select(Customer).where(Customer.id == customer_id, Customer.merchant_id == merchant_id)
    )
    if customer is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    return customer


@app.get("/health")
def health():
    return {"status": "ok", "service": "voicekhata-api"}


@app.get("/api/v1/voice/capabilities")
def voice_capabilities(merchant: Merchant = Depends(get_current_merchant)):
    del merchant
    enabled = bool((settings.gnani_api_key or "").strip())
    return {"speech_to_text": enabled, "speech_output": enabled}


async def transcribe_gnani_audio(content: bytes, filename: str, content_type: str, language_code: str) -> tuple[str, str]:
    gnani_api_key = (settings.gnani_api_key or "").strip()
    if not gnani_api_key:
        raise HTTPException(status_code=503, detail="Voice transcription is not configured on the server")
    language = language_code.strip() or "hi-IN"
    form = {
        "language_code": language,
        "preferred_language": language,
        "format": "codemix",
        "itn_native_numerals": "true",
        "topic": "An Indian shop ledger entry in Hindi and Hinglish. Customer names, rupee amounts, udhaar (credit), and jama (payment).",
    }
    if settings.gnani_stt_model:
        form["model"] = settings.gnani_stt_model
    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            upstream = await client.post(
                settings.gnani_stt_url,
                headers={"X-API-Key-ID": gnani_api_key},
                data=form,
                files={"audio_file": (filename, content, content_type or "application/octet-stream")},
            )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Gnani took too long to transcribe this recording. Please try a shorter recording.")
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Could not connect to Gnani. Check your internet connection and try again.")
    if upstream.is_error:
        if upstream.status_code in {401, 403}:
            detail = "Gnani rejected the API credentials. Check the GNANI_API_KEY in the backend .env file."
        elif upstream.status_code in {400, 413, 415, 422}:
            detail = "Gnani could not process this audio. Keep the recording under 30 seconds and speak clearly."
        elif upstream.status_code == 429:
            detail = "Gnani is receiving too many requests. Wait a moment and try again."
        else:
            detail = f"Gnani transcription failed (HTTP {upstream.status_code}). Please try again shortly."
        raise HTTPException(status_code=502, detail=detail)
    try:
        result = upstream.json()
        transcript = result.get("transcript", "").strip()
        detected_language = result.get("detected_language_code") or language
    except (ValueError, AttributeError):
        raise HTTPException(status_code=502, detail="Gnani returned an invalid transcription response. Please try again.")
    if not transcript:
        raise HTTPException(status_code=422, detail="No speech was recognized. Move closer to the microphone and try again.")
    return transcript, detected_language


@app.post("/api/v1/auth/register", response_model=TokenOut, status_code=status.HTTP_201_CREATED)
def register(payload: MerchantCreate, db: Session = Depends(get_db)):
    merchant = Merchant(
        name=payload.name,
        email=str(payload.email).lower(),
        password_hash=hash_password(payload.password),
        owner_name=payload.owner_name,
        location=payload.location,
    )
    db.add(merchant)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="An account with this email already exists")
    db.refresh(merchant)
    return mint_token(merchant)


@app.post("/api/v1/auth/login", response_model=TokenOut)
def login(payload: MerchantLogin, db: Session = Depends(get_db)):
    merchant = db.scalar(select(Merchant).where(Merchant.email == str(payload.email).lower()))
    if merchant is None or not verify_password(payload.password, merchant.password_hash):
        raise HTTPException(status_code=401, detail="Email or password is incorrect", headers={"WWW-Authenticate": "Bearer"})
    return mint_token(merchant)


@app.get("/api/v1/auth/me", response_model=MerchantOut)
def me(merchant: Merchant = Depends(get_current_merchant)):
    return merchant


@app.patch("/api/v1/auth/me", response_model=MerchantOut)
def update_merchant_profile(
    payload: MerchantUpdate,
    db: Session = Depends(get_db),
    merchant: Merchant = Depends(get_current_merchant),
):
    updates = payload.model_dump(exclude_unset=True)
    if "name" in updates and updates["name"] is None:
        raise HTTPException(status_code=422, detail="Shop name cannot be blank")
    for field, value in updates.items():
        setattr(merchant, field, value)
    db.commit()
    db.refresh(merchant)
    return merchant


@app.post("/api/v1/customers", response_model=CustomerOut, status_code=status.HTTP_201_CREATED)
def create_customer(payload: CustomerCreate, db: Session = Depends(get_db), merchant: Merchant = Depends(get_current_merchant)):
    name_key = normalize_customer_name(payload.name)
    duplicate_name = db.scalar(
        select(Customer.id).where(
            Customer.merchant_id == merchant.id,
            Customer.name_key == name_key,
        )
    )
    if duplicate_name is not None:
        raise HTTPException(
            status_code=409,
            detail="A customer with this name already exists. Select that customer or give the new customer a distinguishing name, such as 'Ramesh - Doodh wale'.",
        )
    customer = Customer(merchant_id=merchant.id, name=payload.name, name_key=name_key,
                        phone=payload.phone.strip() if payload.phone else None)
    db.add(customer)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        duplicate_name = db.scalar(
            select(Customer.id).where(Customer.merchant_id == merchant.id, Customer.name_key == name_key)
        )
        if duplicate_name is not None:
            raise HTTPException(
                status_code=409,
                detail="A customer with this name already exists. Select that customer or give the new customer a distinguishing name, such as 'Ramesh - Doodh wale'.",
            )
        raise HTTPException(status_code=409, detail="This phone number is already used for another customer")
    db.refresh(customer)
    return CustomerOut.model_validate(customer).model_copy(update={"balance": Decimal("0.00")})


@app.get("/api/v1/customers", response_model=list[CustomerOut])
def list_customers(q: Optional[str] = None, db: Session = Depends(get_db), merchant: Merchant = Depends(get_current_merchant)):
    query = select(Customer).where(Customer.merchant_id == merchant.id).order_by(Customer.name)
    if q and q.strip():
        query = query.where(Customer.name.ilike(f"%{q.strip()}%"))
    customers = db.scalars(query).all()
    return [CustomerOut.model_validate(c).model_copy(update={"balance": customer_balance(db, merchant.id, c.id)}) for c in customers]


@app.post("/api/v1/ledger/entries", response_model=LedgerEntryOut, status_code=status.HTTP_201_CREATED)
def create_ledger_entry(
    payload: LedgerEntryCreate,
    idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key", max_length=64),
    db: Session = Depends(get_db),
    merchant: Merchant = Depends(get_current_merchant),
):
    request_key = None
    if idempotency_key:
        try:
            request_key = str(UUID(idempotency_key.strip()))
        except ValueError:
            raise HTTPException(status_code=422, detail="Idempotency-Key must be a UUID")
        prior = db.scalar(
            select(LedgerEntry).where(
                LedgerEntry.merchant_id == merchant.id,
                LedgerEntry.request_key == request_key,
            )
        )
        if prior is not None:
            if (prior.customer_id != payload.customer_id or prior.amount != payload.amount
                    or prior.entry_type != payload.entry_type
                    or prior.note != (payload.note.strip() if payload.note else None)):
                raise HTTPException(status_code=409, detail="This save key was already used for a different entry")
            return prior
    owned_customer(db, merchant.id, payload.customer_id)
    entry = LedgerEntry(merchant_id=merchant.id, customer_id=payload.customer_id, amount=payload.amount,
                        entry_type=payload.entry_type, note=payload.note.strip() if payload.note else None,
                        request_key=request_key)
    db.add(entry)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if request_key:
            prior = db.scalar(
                select(LedgerEntry).where(
                    LedgerEntry.merchant_id == merchant.id,
                    LedgerEntry.request_key == request_key,
                )
            )
            expected_note = payload.note.strip() if payload.note else None
            if (prior is not None and prior.customer_id == payload.customer_id and prior.amount == payload.amount
                    and prior.entry_type == payload.entry_type and prior.note == expected_note):
                return prior
        raise HTTPException(status_code=409, detail="This entry could not be saved because a matching save was already processed")
    db.refresh(entry)
    return entry


@app.get("/api/v1/ledger/entries", response_model=list[LedgerEntryOut])
def list_ledger_entries(
    limit: int = Query(default=500, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    merchant: Merchant = Depends(get_current_merchant),
):
    return db.scalars(
        select(LedgerEntry)
        .where(LedgerEntry.merchant_id == merchant.id)
        .order_by(LedgerEntry.created_at.desc())
        .limit(limit)
        .offset(offset)
    ).all()


@app.get("/api/v1/customers/{customer_id}/ledger", response_model=LedgerSummary)
def get_customer_ledger(customer_id: UUID, db: Session = Depends(get_db), merchant: Merchant = Depends(get_current_merchant)):
    customer = owned_customer(db, merchant.id, customer_id)
    entries = db.scalars(
        select(LedgerEntry).where(LedgerEntry.merchant_id == merchant.id, LedgerEntry.customer_id == customer.id)
        .order_by(LedgerEntry.created_at.desc())
    ).all()
    customer_out = CustomerOut.model_validate(customer).model_copy(update={"balance": customer_balance(db, merchant.id, customer.id)})
    return LedgerSummary(customer=customer_out, entries=entries, balance=customer_out.balance)


async def read_voice_upload(audio: UploadFile) -> tuple[bytes, str, str]:
    allowed_types = {"audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/ogg", "audio/flac", "audio/aac", "audio/mp4", "audio/x-m4a", "application/octet-stream"}
    content_type = (audio.content_type or "").split(";", 1)[0].strip().lower()
    if content_type and content_type not in allowed_types:
        raise HTTPException(status_code=415, detail="Upload a WAV, MP3, OGG, FLAC, AAC, or M4A audio file")
    content = await audio.read(settings.max_audio_bytes + 1)
    if not content:
        raise HTTPException(status_code=400, detail="Audio file is empty")
    if len(content) > settings.max_audio_bytes:
        raise HTTPException(status_code=413, detail=f"Audio file exceeds the {settings.max_audio_bytes // (1024 * 1024)} MB limit")
    return content, audio.filename or "voice-upload.wav", audio.content_type or "application/octet-stream"


@app.post("/api/v1/voice/transcribe")
async def transcribe_voice_reply(
    audio: UploadFile = File(...),
    language_code: str = Form("hi-IN"),
    merchant: Merchant = Depends(get_current_merchant),
):
    del merchant
    content, filename, content_type = await read_voice_upload(audio)
    transcript, detected_language = await transcribe_gnani_audio(content, filename, content_type, language_code)
    return {"transcript": transcript, "detected_language_code": detected_language}


@app.post("/api/v1/voice/sessions", response_model=VoiceSessionOut, status_code=status.HTTP_201_CREATED)
async def transcribe_voice(
    audio: UploadFile = File(...),
    language_code: str = Form("hi-IN"),
    db: Session = Depends(get_db),
    merchant: Merchant = Depends(get_current_merchant),
):
    content, filename, content_type = await read_voice_upload(audio)
    transcript, detected_language = await transcribe_gnani_audio(content, filename, content_type, language_code)
    # Audio is processed in memory only; only transcript and status are retained.
    session = VoiceSession(merchant_id=merchant.id, transcript=transcript, language_code=detected_language,
                           status=VoiceStatus.pending_confirmation)
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


@app.post("/api/v1/voice/sessions/{session_id}/confirm", response_model=LedgerEntryOut, status_code=status.HTTP_201_CREATED)
def confirm_voice_entry(
    session_id: UUID,
    payload: VoiceConfirm,
    db: Session = Depends(get_db),
    merchant: Merchant = Depends(get_current_merchant),
):
    session = db.scalar(select(VoiceSession).where(VoiceSession.id == session_id, VoiceSession.merchant_id == merchant.id))
    if session is None:
        raise HTTPException(status_code=404, detail="Voice session not found")
    if session.status != VoiceStatus.pending_confirmation:
        raise HTTPException(status_code=409, detail="Voice session has already been confirmed or cancelled")
    owned_customer(db, merchant.id, payload.customer_id)
    entry = LedgerEntry(merchant_id=merchant.id, customer_id=payload.customer_id, voice_session_id=session.id,
                        amount=payload.amount, entry_type=payload.entry_type, note=payload.note.strip() if payload.note else None)
    session.status = VoiceStatus.confirmed
    db.add(entry)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Voice entry has already been confirmed")
    db.refresh(entry)
    return entry


@app.post("/api/v1/voice/sessions/{session_id}/cancel", response_model=VoiceSessionOut)
def cancel_voice_session(session_id: UUID, db: Session = Depends(get_db), merchant: Merchant = Depends(get_current_merchant)):
    session = db.scalar(select(VoiceSession).where(VoiceSession.id == session_id, VoiceSession.merchant_id == merchant.id))
    if session is None:
        raise HTTPException(status_code=404, detail="Voice session not found")
    if session.status != VoiceStatus.pending_confirmation:
        raise HTTPException(status_code=409, detail="Only pending voice sessions can be cancelled")
    session.status = VoiceStatus.cancelled
    db.commit()
    db.refresh(session)
    return session


@app.post("/api/v1/voice/speak")
async def speak(payload: TTSRequest, merchant: Merchant = Depends(get_current_merchant)):
    del merchant  # Authentication is required even though Gnani receives only the requested text.
    gnani_api_key = (settings.gnani_api_key or "").strip()
    if not gnani_api_key:
        raise HTTPException(status_code=503, detail="Voice output is not configured on the server")
    provider_payload = {
        "text": payload.text,
        "voice": settings.gnani_tts_voice,
        "model": settings.gnani_tts_model,
        "language": payload.language_code,
        "audio_config": {
            "encoding": "linear_pcm",
            "container": "wav",
            "num_channels": 1,
            "sample_rate": 48000,
            "sample_width": 2,
        },
    }
    client = httpx.AsyncClient(timeout=None)
    try:
        request = client.build_request(
            "POST", settings.gnani_tts_url,
            headers={"X-API-Key-ID": gnani_api_key, "Content-Type": "application/json"},
            json=provider_payload,
        )
        upstream = await client.send(request, stream=True)
    except httpx.HTTPError:
        await client.aclose()
        raise HTTPException(status_code=502, detail="Could not reach the speech synthesis service")
    if upstream.is_error:
        await upstream.aclose()
        await client.aclose()
        raise HTTPException(status_code=502, detail="Speech synthesis failed; check Gnani access and try again")

    async def stream_provider():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    # Gnani sends server-sent events containing base64 audio chunks.
    return StreamingResponse(stream_provider(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


# Serve the UI and API from one local origin, so a single Mac needs no IP/CORS setup.
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

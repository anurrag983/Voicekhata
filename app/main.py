from __future__ import annotations

from contextlib import asynccontextmanager
from decimal import Decimal
from typing import Optional
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI, File, Form, HTTPException, Response, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy import case, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import Base, engine, get_db
from app.models import Customer, EntryType, LedgerEntry, Merchant, VoiceSession, VoiceStatus
from app.schemas import (
    CustomerCreate,
    CustomerOut,
    LedgerEntryCreate,
    LedgerEntryOut,
    LedgerSummary,
    MerchantCreate,
    MerchantLogin,
    MerchantOut,
    TTSRequest,
    TokenOut,
    VoiceConfirm,
    VoiceSessionOut,
)
from app.security import create_access_token, get_current_merchant, hash_password, verify_password


@asynccontextmanager
async def lifespan(_: FastAPI):
    # For this starter, create missing tables automatically. Use migrations before production schema changes.
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(title="VoiceKhata API", version="0.1.0", lifespan=lifespan)
settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


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


@app.post("/api/v1/auth/register", response_model=TokenOut, status_code=status.HTTP_201_CREATED)
def register(payload: MerchantCreate, db: Session = Depends(get_db)):
    merchant = Merchant(name=payload.name, email=str(payload.email).lower(), password_hash=hash_password(payload.password))
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


@app.post("/api/v1/customers", response_model=CustomerOut, status_code=status.HTTP_201_CREATED)
def create_customer(payload: CustomerCreate, db: Session = Depends(get_db), merchant: Merchant = Depends(get_current_merchant)):
    customer = Customer(merchant_id=merchant.id, name=payload.name, phone=payload.phone.strip() if payload.phone else None)
    db.add(customer)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
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
def create_ledger_entry(payload: LedgerEntryCreate, db: Session = Depends(get_db), merchant: Merchant = Depends(get_current_merchant)):
    owned_customer(db, merchant.id, payload.customer_id)
    entry = LedgerEntry(merchant_id=merchant.id, customer_id=payload.customer_id, amount=payload.amount,
                        entry_type=payload.entry_type, note=payload.note.strip() if payload.note else None)
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


@app.get("/api/v1/customers/{customer_id}/ledger", response_model=LedgerSummary)
def get_customer_ledger(customer_id: UUID, db: Session = Depends(get_db), merchant: Merchant = Depends(get_current_merchant)):
    customer = owned_customer(db, merchant.id, customer_id)
    entries = db.scalars(
        select(LedgerEntry).where(LedgerEntry.merchant_id == merchant.id, LedgerEntry.customer_id == customer.id)
        .order_by(LedgerEntry.created_at.desc())
    ).all()
    customer_out = CustomerOut.model_validate(customer).model_copy(update={"balance": customer_balance(db, merchant.id, customer.id)})
    return LedgerSummary(customer=customer_out, entries=entries, balance=customer_out.balance)


@app.post("/api/v1/voice/sessions", response_model=VoiceSessionOut, status_code=status.HTTP_201_CREATED)
async def transcribe_voice(
    audio: UploadFile = File(...),
    language_code: str = Form("hi-IN"),
    db: Session = Depends(get_db),
    merchant: Merchant = Depends(get_current_merchant),
):
    if not settings.gnani_api_key:
        raise HTTPException(status_code=503, detail="Voice transcription is not configured on the server")
    allowed_types = {"audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/ogg", "audio/flac", "audio/aac", "audio/mp4", "audio/x-m4a", "application/octet-stream"}
    if audio.content_type and audio.content_type not in allowed_types:
        raise HTTPException(status_code=415, detail="Upload a WAV, MP3, OGG, FLAC, AAC, or M4A audio file")
    content = await audio.read(settings.max_audio_bytes + 1)
    if not content:
        raise HTTPException(status_code=400, detail="Audio file is empty")
    if len(content) > settings.max_audio_bytes:
        raise HTTPException(status_code=413, detail=f"Audio file exceeds the {settings.max_audio_bytes // (1024 * 1024)} MB limit")
    filename = audio.filename or "voice-upload.wav"
    form = {"language_code": language_code.strip()}
    if settings.gnani_stt_model:
        form["model"] = settings.gnani_stt_model
    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            upstream = await client.post(
                settings.gnani_stt_url,
                headers={"X-API-Key-ID": settings.gnani_api_key},
                data=form,
                files={"audio_file": (filename, content, audio.content_type or "application/octet-stream")},
            )
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Could not reach the speech recognition service")
    if upstream.is_error:
        # Do not send provider details or credentials back to the browser.
        raise HTTPException(status_code=502, detail="Speech recognition failed; check Gnani access and try again")
    try:
        result = upstream.json()
        transcript = result.get("transcript", "").strip()
        detected_language = result.get("detected_language_code") or language_code
    except (ValueError, AttributeError):
        raise HTTPException(status_code=502, detail="Speech recognition returned an invalid response")
    if not transcript:
        raise HTTPException(status_code=422, detail="No speech was recognized; please try again")
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
    db.commit()
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
    if not settings.gnani_api_key:
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
            headers={"X-API-Key-ID": settings.gnani_api_key, "Content-Type": "application/json"},
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

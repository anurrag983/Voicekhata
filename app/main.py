from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import date, datetime, time as datetime_time, timedelta, timezone
from decimal import Decimal, InvalidOperation
import logging
from pathlib import Path
import re
from time import perf_counter
from typing import Optional
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Response, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import case, func, inspect, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import Base, engine, get_db
from app.models import (Customer, EntryType, LedgerEntry, Merchant, VoiceSession, VoiceStatus,
                        normalize_customer_name)
from app.otp_service import issue_otp, normalize_target, verify_and_consume_otp
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
    RegisterWithOTP,
    ResetPasswordWithOTP,
    SendOTPRequest,
    SendOTPResponse,
    TTSRequest,
    TokenOut,
    VoiceConfirm,
    VoiceQuestionOut,
    VoiceQuestionRequest,
    VoiceReplyOut,
    VoiceReplyRequest,
    VoiceSessionProcessOut,
    VoiceSessionOut,
)

logger = logging.getLogger(__name__)
provider_http = httpx.AsyncClient(
    limits=httpx.Limits(max_keepalive_connections=10, keepalive_expiry=30.0),
)
from app.security import create_access_token, get_current_merchant, hash_password, verify_password
from app.gemini_service import (make_short_voice_question, normalize_local_name as normalize_voice_name,
                                parse_followup, parse_transcript)


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
        if "phone" not in merchant_columns:
            connection.exec_driver_sql("ALTER TABLE merchants ADD COLUMN phone VARCHAR(20)")
            connection.exec_driver_sql(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_merchants_phone ON merchants (phone)"
            )
        if "upi_id" not in merchant_columns:
            connection.exec_driver_sql("ALTER TABLE merchants ADD COLUMN upi_id VARCHAR(255)")
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
        if "transaction_date" not in ledger_columns:
            connection.exec_driver_sql("ALTER TABLE ledger_entries ADD COLUMN transaction_date DATE")
        connection.exec_driver_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_entries_request_key "
            "ON ledger_entries (request_key)"
        )
        voice_columns = {column["name"] for column in inspect(connection).get_columns("voice_sessions")}
        if "parsed_entries" not in voice_columns:
            connection.exec_driver_sql("ALTER TABLE voice_sessions ADD COLUMN parsed_entries JSON")
    yield
    await provider_http.aclose()


app = FastAPI(title="VoiceKhata API", version="0.1.0", lifespan=lifespan)
settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_origin_regex=r"^https://.*\.vercel\.app$",
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


def customer_balances(db: Session, merchant_id: UUID) -> dict[UUID, Decimal]:
    """Fetch all balances for one shop in a single grouped database query."""
    balance_value = case(
        (LedgerEntry.entry_type == EntryType.udhaar, LedgerEntry.amount),
        else_=-LedgerEntry.amount,
    )
    rows = db.execute(
        select(LedgerEntry.customer_id, func.coalesce(func.sum(balance_value), 0))
        .where(LedgerEntry.merchant_id == merchant_id)
        .group_by(LedgerEntry.customer_id)
    ).all()
    return {
        customer_id: Decimal(str(value or 0)).quantize(Decimal("0.01"))
        for customer_id, value in rows
    }


def owned_customer(db: Session, merchant_id: UUID, customer_id: UUID) -> Customer:
    customer = db.scalar(
        select(Customer).where(Customer.id == customer_id, Customer.merchant_id == merchant_id)
    )
    if customer is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    return customer


def amount_words(amount: Decimal) -> str:
    return f"₹{amount:,.0f}"


def today_summary_reply(amount: Decimal, payment: bool, language: str) -> str:
    amount_text = amount_words(amount)
    templates = {
        "hi": f"Aaj kul {amount_text} ka {'jama' if payment else 'udhaar'} hua hai.",
        "en": f"Today's total {'payments received' if payment else 'credit given'} is {amount_text}.",
        "ta": f"இன்று மொத்தம் {amount_text} {'வரவு' if payment else 'கடன்'}.",
        "te": f"ఈ రోజు మొత్తం {amount_text} {'జమ' if payment else 'అప్పు'} నమోదైంది.",
        "bn": f"আজ মোট {amount_text} {'জমা' if payment else 'বাকি'} হয়েছে।",
        "mr": f"आज एकूण {amount_text} {'जमा' if payment else 'उधार'} झाले.",
        "kn": f"ಇಂದು ಒಟ್ಟು {amount_text} {'ಪಾವತಿ' if payment else 'ಸಾಲ'} ಆಗಿದೆ.",
        "gu": f"આજે કુલ {amount_text} {'જમા' if payment else 'ઉધાર'} થયું છે.",
    }
    return templates.get(language, templates["hi"])


def balance_reply(name: str, balance: Decimal, language: str) -> str:
    amount_text = amount_words(balance)
    templates = {
        "hi": f"{name} par abhi {amount_text} baaki hain.",
        "en": f"{name} currently has {amount_text} outstanding.",
        "ta": f"{name} கணக்கில் இப்போது {amount_text} நிலுவை உள்ளது.",
        "te": f"{name} ఖాతాలో ప్రస్తుతం {amount_text} బాకీ ఉంది.",
        "bn": f"{name}-এর এখন {amount_text} বাকি আছে।",
        "mr": f"{name} कडे सध्या {amount_text} बाकी आहेत.",
        "kn": f"{name} ಅವರ ಖಾತೆಯಲ್ಲಿ ಈಗ {amount_text} ಬಾಕಿ ಇದೆ.",
        "gu": f"{name}ના ખાતામાં અત્યારે {amount_text} બાકી છે.",
    }
    return templates.get(language, templates["hi"])


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
        "topic": "An Indian shop ledger command in Hindi and Hinglish. Customer names, rupee amounts, udhaar (credit), and jama (payment). Common phrasing: 'Akshay Kumar ke 500 rupaye udhaar likho' and 'Ramesh ko 200 rupaye jama'.",
    }
    if settings.gnani_stt_model:
        form["model"] = settings.gnani_stt_model
    try:
        upstream = await provider_http.post(
            settings.gnani_stt_url,
            headers={"X-API-Key-ID": gnani_api_key},
            data=form,
            files={"audio_file": (filename, content, content_type or "application/octet-stream")},
            timeout=45.0,
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


@app.post("/api/v1/auth/otp/send", response_model=SendOTPResponse)
async def send_otp_endpoint(payload: SendOTPRequest, db: Session = Depends(get_db)):
    normalized, target_type = normalize_target(payload.target)

    # Check existing account by email
    existing = db.scalar(select(Merchant).where(Merchant.email == normalized))

    if payload.purpose == "registration" and existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists. Please log in.",
        )

    if payload.purpose == "reset_password" and existing is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No account found with this email. Please check the address or register first.",
        )

    target_clean, t_type, dev_otp = await issue_otp(db, payload.target, payload.purpose)
    msg = (
        f"OTP sent to your Gmail ({target_clean}). Valid for 10 minutes."
        if not dev_otp
        else f"OTP generated for {target_clean}."
    )
    return SendOTPResponse(
        status="sent",
        target=target_clean,
        target_type=t_type,
        message=msg,
        dev_otp=dev_otp,
        cooldown_seconds=30,
    )


@app.post("/api/v1/auth/otp/register", response_model=TokenOut, status_code=status.HTTP_201_CREATED)
def register_with_otp(payload: RegisterWithOTP, db: Session = Depends(get_db)):
    normalized, _ = normalize_target(payload.target)
    verify_and_consume_otp(db, normalized, "registration", payload.otp)

    merchant = Merchant(
        name=payload.name,
        email=normalized,
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


@app.post("/api/v1/auth/otp/reset-password", response_model=TokenOut)
def reset_password_with_otp(payload: ResetPasswordWithOTP, db: Session = Depends(get_db)):
    normalized, _ = normalize_target(payload.target)
    verify_and_consume_otp(db, normalized, "reset_password", payload.otp)

    merchant = db.scalar(select(Merchant).where(Merchant.email == normalized))
    if merchant is None:
        raise HTTPException(status_code=404, detail="No account found with this email.")

    merchant.password_hash = hash_password(payload.new_password)
    db.commit()
    db.refresh(merchant)
    return mint_token(merchant)


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
    raw_identifier = (payload.identifier or payload.email or "").strip().lower()
    if not raw_identifier:
        raise HTTPException(status_code=422, detail="Email is required")

    merchant = db.scalar(select(Merchant).where(Merchant.email == raw_identifier))
    if merchant is None or not verify_password(payload.password, merchant.password_hash):
        raise HTTPException(
            status_code=401,
            detail="Email or password is incorrect",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return mint_token(merchant)
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


@app.delete("/api/v1/auth/me", status_code=status.HTTP_204_NO_CONTENT)
def delete_merchant_account(db: Session = Depends(get_db), merchant: Merchant = Depends(get_current_merchant)):
    """Permanently remove the authenticated shop and its owned ledger data."""
    db.delete(merchant)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.post("/api/v1/customers", response_model=CustomerOut, status_code=status.HTTP_201_CREATED)
def create_customer(payload: CustomerCreate, db: Session = Depends(get_db), merchant: Merchant = Depends(get_current_merchant)):
    name_key = normalize_customer_name(payload.name)
    duplicate_name = db.scalar(
        select(Customer.id).where(
            Customer.merchant_id == merchant.id,
            Customer.name_key == name_key,
        )
    )
    if duplicate_name is None:
        existing_customers = db.scalars(select(Customer).where(Customer.merchant_id == merchant.id)).all()
        duplicate_name = next(
            (customer.id for customer in existing_customers
             if normalize_voice_name(customer.name) == normalize_voice_name(payload.name)),
            None,
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
    balances = customer_balances(db, merchant.id)
    return [CustomerOut.model_validate(c).model_copy(update={"balance": balances.get(c.id, Decimal("0.00"))}) for c in customers]


@app.delete("/api/v1/customers/{customer_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_customer(customer_id: UUID, db: Session = Depends(get_db), merchant: Merchant = Depends(get_current_merchant)):
    """Permanently remove a customer and their ledger entries from this shop."""
    customer = owned_customer(db, merchant.id, customer_id)
    db.delete(customer)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
                        request_key=request_key, transaction_date=date.today())
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


@app.post("/api/v1/voice/sessions", response_model=VoiceSessionProcessOut, status_code=status.HTTP_201_CREATED)
async def transcribe_voice(
    audio: UploadFile = File(...),
    language_code: str = Form("hi-IN"),
    db: Session = Depends(get_db),
    merchant: Merchant = Depends(get_current_merchant),
):
    pipeline_started = perf_counter()
    content, filename, content_type = await read_voice_upload(audio)
    # Start network transcription before gathering the independent shop context.
    # The provider can process audio while the database queries run, without
    # changing the transcript or parser path.
    async def transcribe_timed():
        started = perf_counter()
        result = await transcribe_gnani_audio(content, filename, content_type, language_code)
        return result[0], result[1], (perf_counter() - started) * 1000

    transcription_task = asyncio.create_task(transcribe_timed())
    await asyncio.sleep(0)
    # Include shop-owned customer records and today's computed totals, never another shop's data.
    context_started = perf_counter()
    customers = db.scalars(select(Customer).where(Customer.merchant_id == merchant.id).order_by(Customer.name)).all()
    balance_value = case((LedgerEntry.entry_type == EntryType.udhaar, LedgerEntry.amount), else_=-LedgerEntry.amount)
    balances = dict(db.execute(
        select(LedgerEntry.customer_id, func.coalesce(func.sum(balance_value), 0))
        .where(LedgerEntry.merchant_id == merchant.id)
        .group_by(LedgerEntry.customer_id)
    ).all())
    customer_context = [{"name": c.name, "phone": c.phone,
                         "balance": str(Decimal(str(balances.get(c.id) or 0)).quantize(Decimal("0.01")))} for c in customers]
    today = datetime.now(timezone.utc).date()
    start = datetime.combine(today, datetime_time.min, tzinfo=timezone.utc)
    end = start + timedelta(days=1)
    on_today = or_(LedgerEntry.transaction_date == today, (
        LedgerEntry.transaction_date.is_(None) & (LedgerEntry.created_at >= start) & (LedgerEntry.created_at < end)
    ))
    today_totals = dict(db.execute(
        select(LedgerEntry.entry_type, func.coalesce(func.sum(LedgerEntry.amount), 0))
        .where(LedgerEntry.merchant_id == merchant.id, on_today)
        .group_by(LedgerEntry.entry_type)
    ).all())
    total_credit = today_totals.get(EntryType.udhaar, 0)
    total_payment = today_totals.get(EntryType.jama, 0)
    recent_rows = db.execute(
        select(LedgerEntry, Customer.name)
        .join(Customer, Customer.id == LedgerEntry.customer_id)
        .where(LedgerEntry.merchant_id == merchant.id)
        .order_by(LedgerEntry.created_at.desc())
        .limit(20)
    ).all()
    recent_ledger = [{"customer_name": customer_name, "amount": str(entry.amount),
                      "entry_type": entry.entry_type.value,
                      "date": (entry.transaction_date.isoformat() if entry.transaction_date else entry.created_at.date().isoformat()),
                      "note": entry.note or ""} for entry, customer_name in recent_rows]
    context = {"customers": customer_context, "current_utc_date": today.isoformat(),
               "today_total_credit": str(total_credit), "today_total_payment": str(total_payment),
               "recent_ledger": recent_ledger,
               "first_interaction": db.scalar(select(func.count(VoiceSession.id)).where(VoiceSession.merchant_id == merchant.id)) == 0}
    context_ms = (perf_counter() - context_started) * 1000
    transcript, detected_language, stt_ms = await transcription_task
    parse_started = perf_counter()
    parsed = await parse_transcript(transcript, context)
    parse_ms = (perf_counter() - parse_started) * 1000
    if parsed.intent == "TRANSACTION" and not parsed.entries:
        parsed.intent = "UNKNOWN"
    if parsed.intent == "UNKNOWN" and not parsed.spoken_response:
        parsed.spoken_response = "माफ़ कीजिए, मैं समझ नहीं पाया। ग्राहक का नाम, रकम और उधार या जमा दोबारा बोलिए।"
    prepared_entries = []
    for item in parsed.entries:
        name_key = normalize_voice_name(item.customer_name)
        candidates = [c for c in customers if normalize_voice_name(c.name) == name_key] if name_key else []
        if not candidates and name_key:
            candidates = [c for c in customers if normalize_voice_name(c.name).startswith(name_key)]
        if len(candidates) > 1:
            parsed.intent = "DISAMBIGUATION"
            parsed.needs_clarification = True
            parsed.spoken_response = "Aap " + " ya ".join(c.name for c in candidates[:3]) + " ki baat kar rahe hain?"
        prepared_entries.append({"customer_name": item.customer_name, "amount": str(item.amount),
                                 "entry_type": item.entry_type, "relative_date": item.relative_date,
                                 "note": item.note, "customer_id": str(candidates[0].id) if len(candidates) == 1 else None})
    if parsed.intent == "QUERY_TODAY_SUMMARY":
        is_payment = parsed.query_target.query_type == "total_payment_today"
        total = total_payment if is_payment else total_credit
        parsed.spoken_response = today_summary_reply(Decimal(str(total)), is_payment, parsed.language_detected)
    elif parsed.intent == "QUERY_CUSTOMER_BALANCE" and parsed.query_target.customer_name:
        target_key = normalize_voice_name(parsed.query_target.customer_name)
        candidates = [c for c in customers if normalize_voice_name(c.name) == target_key]
        if not candidates:
            candidates = [c for c in customers if normalize_voice_name(c.name).startswith(target_key)]
        if len(candidates) > 1:
            parsed.intent = "DISAMBIGUATION"
            parsed.needs_clarification = True
            parsed.spoken_response = "Aap " + " ya ".join(c.name for c in candidates[:3]) + " ki baat kar rahe hain?"
        elif candidates:
            candidate = candidates[0]
            balance = Decimal(str(balances.get(candidate.id) or 0)).quantize(Decimal("0.01"))
            parsed.spoken_response = balance_reply(candidate.name, balance, parsed.language_detected)
    if context["first_interaction"] and "main voicekhata ai assistant hoon" not in parsed.spoken_response.casefold():
        parsed.spoken_response = (parsed.spoken_response + " Main VoiceKhata AI assistant hoon.").strip()
    status_value = VoiceStatus.pending_confirmation if parsed.intent == "TRANSACTION" else VoiceStatus.confirmed
    session = VoiceSession(merchant_id=merchant.id, transcript=transcript, language_code=detected_language,
                           status=status_value, parsed_entries=prepared_entries)
    db.add(session)
    db.commit()
    db.refresh(session)
    logger.info(
        "voice_pipeline_timing_ms stt=%.0f context=%.0f parse=%.0f total=%.0f",
        stt_ms, context_ms, parse_ms, (perf_counter() - pipeline_started) * 1000,
    )
    base_response = VoiceSessionOut.model_validate(session).model_dump()
    return VoiceSessionProcessOut.model_validate({**base_response,
        "intent": parsed.intent, "entries": prepared_entries,
        "query_target": parsed.query_target.model_dump(), "needs_clarification": parsed.needs_clarification,
        "spoken_response": parsed.spoken_response, "detected_language_code": parsed.language_detected or detected_language,
        "parser_notice": parsed._fallback_issue,
    })


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
    parsed_date = datetime.now(timezone.utc).date()
    if session.parsed_entries:
        relative = session.parsed_entries[0].get("relative_date", "today")
        if relative == "yesterday":
            parsed_date -= timedelta(days=1)
        elif relative not in {"today", ""}:
            try:
                parsed_date = date.fromisoformat(relative)
            except ValueError:
                pass
    entry = LedgerEntry(merchant_id=merchant.id, customer_id=payload.customer_id, voice_session_id=session.id,
                        amount=payload.amount, entry_type=payload.entry_type, note=payload.note.strip() if payload.note else None)
    entry.transaction_date = parsed_date
    session.status = VoiceStatus.confirmed
    db.add(entry)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Voice entry has already been confirmed")
    db.refresh(entry)
    return entry


@app.post("/api/v1/voice/sessions/{session_id}/confirm-all", response_model=list[LedgerEntryOut], status_code=status.HTTP_201_CREATED)
def confirm_all_voice_entries(
    session_id: UUID,
    db: Session = Depends(get_db),
    merchant: Merchant = Depends(get_current_merchant),
):
    session = db.scalar(select(VoiceSession).where(VoiceSession.id == session_id, VoiceSession.merchant_id == merchant.id))
    if session is None:
        raise HTTPException(status_code=404, detail="Voice session not found")
    if session.status != VoiceStatus.pending_confirmation:
        raise HTTPException(status_code=409, detail="Voice session has already been confirmed or cancelled")
    prepared = session.parsed_entries or []
    if len(prepared) < 2:
        raise HTTPException(status_code=422, detail="This session does not contain multiple parsed entries")
    unresolved = [entry.get("customer_name") for entry in prepared if not entry.get("customer_id")]
    if unresolved:
        raise HTTPException(status_code=409, detail="Resolve each customer before confirming: " + ", ".join(unresolved))
    entries = []
    for index, item in enumerate(prepared):
        try:
            customer_id = UUID(item["customer_id"])
            amount = Decimal(str(item["amount"]))
            entry_type = EntryType(item["entry_type"])
        except (KeyError, ValueError, TypeError, InvalidOperation):
            raise HTTPException(status_code=422, detail="The saved voice entry data is invalid")
        if amount <= 0:
            raise HTTPException(status_code=422, detail="Parsed entry amounts must be greater than zero")
        owned_customer(db, merchant.id, customer_id)
        relative = item.get("relative_date", "today")
        entry_date = datetime.now(timezone.utc).date()
        if relative == "yesterday":
            entry_date -= timedelta(days=1)
        elif relative not in {"today", ""}:
            try:
                entry_date = date.fromisoformat(relative)
            except ValueError:
                raise HTTPException(status_code=422, detail="The parsed transaction date is invalid")
        entries.append(LedgerEntry(merchant_id=merchant.id, customer_id=customer_id,
                                   voice_session_id=session.id if index == 0 else None,
                                   amount=amount, entry_type=entry_type,
                                   note=(item.get("note") or session.transcript)[:500],
                                   transaction_date=entry_date))
    session.status = VoiceStatus.confirmed
    db.add_all(entries)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Voice entries have already been confirmed")
    for entry in entries:
        db.refresh(entry)
    return entries


@app.post("/api/v1/voice/sessions/{session_id}/reply", response_model=VoiceReplyOut)
async def interpret_voice_reply(
    session_id: UUID,
    payload: VoiceReplyRequest,
    db: Session = Depends(get_db),
    merchant: Merchant = Depends(get_current_merchant),
):
    session = db.scalar(select(VoiceSession).where(VoiceSession.id == session_id, VoiceSession.merchant_id == merchant.id))
    if session is None:
        raise HTTPException(status_code=404, detail="Voice session not found")
    if session.status != VoiceStatus.pending_confirmation:
        raise HTTPException(status_code=409, detail="This voice session is no longer awaiting confirmation")
    customers = db.scalars(select(Customer).where(Customer.merchant_id == merchant.id).order_by(Customer.name)).all()
    balances = customer_balances(db, merchant.id)
    context = {"customers": [{"id": str(c.id), "name": c.name, "phone": c.phone,
                               "balance": str(balances.get(c.id, Decimal("0.00")))} for c in customers]}
    result = await parse_followup(payload.question, payload.transcript, payload.current_entry, context)
    updated = result.updated_entry.model_dump(mode="json")
    customer_name = updated.get("customer_name", "").strip()
    candidates = [c for c in customers if normalize_voice_name(c.name) == normalize_voice_name(customer_name)] if customer_name else []
    if len(candidates) == 1:
        updated["customer_id"] = str(candidates[0].id)
        updated["customer_name"] = candidates[0].name
    elif len(candidates) > 1:
        result.action = "CLARIFY"
        result.spoken_response = "Aap " + " ya ".join(c.name for c in candidates[:3]) + " ki baat kar rahe hain?"
        updated["customer_id"] = None
    else:
        updated["customer_id"] = None
    prepared_entries = list(session.parsed_entries or [])
    if prepared_entries:
        prepared_entries[0] = {**prepared_entries[0], **updated}
    else:
        prepared_entries = [updated]
    session.parsed_entries = prepared_entries
    db.commit()
    return VoiceReplyOut.model_validate({
        "action": result.action,
        "normalized_answer": result.normalized_answer,
        "updated_entry": updated,
        "spoken_response": result.spoken_response,
        "parser_notice": result._fallback_issue or ("Gemini is not configured; reply was interpreted locally." if not (settings.gemini_api_key or "").strip() else None),
    })


@app.post("/api/v1/voice/sessions/{session_id}/question", response_model=VoiceQuestionOut)
async def generate_voice_question(
    session_id: UUID,
    payload: VoiceQuestionRequest,
    db: Session = Depends(get_db),
    merchant: Merchant = Depends(get_current_merchant),
):
    session = db.scalar(select(VoiceSession).where(VoiceSession.id == session_id, VoiceSession.merchant_id == merchant.id))
    if session is None:
        raise HTTPException(status_code=404, detail="Voice session not found")
    if session.status != VoiceStatus.pending_confirmation:
        raise HTTPException(status_code=409, detail="This voice session is no longer awaiting clarification")
    question, notice = await make_short_voice_question(
        payload.draft_question,
        payload.current_entry,
        payload.candidate_names,
        payload.language_code,
    )
    return VoiceQuestionOut(question=question, parser_notice=notice)


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
    timeout = httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0)
    tts_started = perf_counter()
    try:
        request = provider_http.build_request(
            "POST", settings.gnani_tts_url,
            headers={"X-API-Key-ID": gnani_api_key, "Content-Type": "application/json"},
            json=provider_payload,
            timeout=timeout,
        )
        upstream = await provider_http.send(request, stream=True)
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Could not reach the speech synthesis service")
    if upstream.is_error:
        await upstream.aclose()
        raise HTTPException(status_code=502, detail="Speech synthesis failed; check Gnani access and try again")

    async def stream_provider():
        first_chunk_ms = None
        total_bytes = 0
        try:
            async for chunk in upstream.aiter_bytes():
                if first_chunk_ms is None:
                    first_chunk_ms = (perf_counter() - tts_started) * 1000
                total_bytes += len(chunk)
                yield chunk
        finally:
            logger.info(
                "voice_tts_timing_ms first_chunk=%s stream=%.0f bytes=%d",
                f"{first_chunk_ms:.0f}" if first_chunk_ms is not None else "none",
                (perf_counter() - tts_started) * 1000, total_bytes,
            )
            await upstream.aclose()

    # Gnani sends server-sent events containing base64 audio chunks.
    return StreamingResponse(stream_provider(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


# Serve the UI and API from one local origin, so a single Mac needs no IP/CORS setup.
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

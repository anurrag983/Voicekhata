from __future__ import annotations

import enum
import unicodedata
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional

from sqlalchemy import DateTime, Enum, ForeignKey, Index, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import TypeDecorator, Uuid

from app.database import Base


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def normalize_customer_name(name: str) -> str:
    return " ".join(unicodedata.normalize("NFC", name).split()).casefold()


class UTCDateTime(TypeDecorator[datetime]):
    """Store timestamps in UTC and return timezone-aware UTC values on every database."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: Optional[datetime], dialect):
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            value = value.replace(tzinfo=timezone.utc)
        value = value.astimezone(timezone.utc)
        return value.replace(tzinfo=None) if dialect.name == "sqlite" else value

    def process_result_value(self, value: Optional[datetime], dialect):
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)


class EntryType(str, enum.Enum):
    udhaar = "udhaar"
    jama = "jama"


class VoiceStatus(str, enum.Enum):
    pending_confirmation = "pending_confirmation"
    confirmed = "confirmed"
    cancelled = "cancelled"


class Merchant(Base):
    __tablename__ = "merchants"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(512), nullable=False)
    owner_name: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    location: Mapped[Optional[str]] = mapped_column(String(160), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now_utc, nullable=False)

    customers: Mapped[list["Customer"]] = relationship(back_populates="merchant", cascade="all, delete-orphan")
    entries: Mapped[list["LedgerEntry"]] = relationship(back_populates="merchant", cascade="all, delete-orphan")
    voice_sessions: Mapped[list["VoiceSession"]] = relationship(back_populates="merchant", cascade="all, delete-orphan")


class Customer(Base):
    __tablename__ = "customers"
    __table_args__ = (
        UniqueConstraint("merchant_id", "phone", name="uq_customer_merchant_phone"),
        Index("uq_customer_merchant_name_key", "merchant_id", "name_key", unique=True),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    name_key: Mapped[str] = mapped_column(String(512), nullable=False)
    phone: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now_utc, nullable=False)

    merchant: Mapped[Merchant] = relationship(back_populates="customers")
    entries: Mapped[list["LedgerEntry"]] = relationship(back_populates="customer", cascade="all, delete-orphan")


class VoiceSession(Base):
    __tablename__ = "voice_sessions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    transcript: Mapped[str] = mapped_column(Text, nullable=False)
    language_code: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[VoiceStatus] = mapped_column(Enum(VoiceStatus, native_enum=False), default=VoiceStatus.pending_confirmation, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now_utc, nullable=False)

    merchant: Mapped[Merchant] = relationship(back_populates="voice_sessions")
    entry: Mapped[Optional["LedgerEntry"]] = relationship(back_populates="voice_session", uselist=False)


class LedgerEntry(Base):
    __tablename__ = "ledger_entries"
    __table_args__ = (Index("uq_ledger_entries_request_key", "request_key", unique=True),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    customer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("customers.id", ondelete="CASCADE"), index=True)
    voice_session_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("voice_sessions.id", ondelete="SET NULL"), unique=True, nullable=True)
    request_key: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    entry_type: Mapped[EntryType] = mapped_column(Enum(EntryType, native_enum=False), nullable=False)
    note: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now_utc, nullable=False)

    merchant: Mapped[Merchant] = relationship(back_populates="entries")
    customer: Mapped[Customer] = relationship(back_populates="entries")
    voice_session: Mapped[Optional[VoiceSession]] = relationship(back_populates="entry")

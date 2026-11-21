from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.models import EntryType, VoiceStatus


class MerchantCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)

    @field_validator("name")
    @classmethod
    def trim_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Name cannot be blank")
        return value


class MerchantLogin(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class MerchantOut(BaseModel):
    id: uuid.UUID
    name: str
    email: EmailStr
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    merchant: MerchantOut


class CustomerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    phone: Optional[str] = Field(default=None, max_length=20)

    @field_validator("name")
    @classmethod
    def trim_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Name cannot be blank")
        return value


class CustomerOut(BaseModel):
    id: uuid.UUID
    name: str
    phone: Optional[str]
    balance: Decimal = Decimal("0.00")
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class LedgerEntryCreate(BaseModel):
    customer_id: uuid.UUID
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    entry_type: EntryType
    note: Optional[str] = Field(default=None, max_length=500)


class LedgerEntryOut(BaseModel):
    id: uuid.UUID
    customer_id: uuid.UUID
    voice_session_id: Optional[uuid.UUID]
    amount: Decimal
    entry_type: EntryType
    note: Optional[str]
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class LedgerSummary(BaseModel):
    customer: CustomerOut
    entries: list[LedgerEntryOut]
    balance: Decimal


class VoiceSessionOut(BaseModel):
    id: uuid.UUID
    transcript: str
    language_code: str
    status: VoiceStatus
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class VoiceConfirm(BaseModel):
    customer_id: uuid.UUID
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    entry_type: EntryType
    note: Optional[str] = Field(default=None, max_length=500)


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    language_code: str = "hi-IN"

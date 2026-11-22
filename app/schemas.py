from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.models import EntryType, VoiceStatus


class MerchantCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)
    owner_name: Optional[str] = Field(default=None, max_length=120)
    location: Optional[str] = Field(default=None, max_length=160)

    @field_validator("name")
    @classmethod
    def trim_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Name cannot be blank")
        return value

    @field_validator("owner_name", "location")
    @classmethod
    def trim_optional_text(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        return value or None


class SendOTPRequest(BaseModel):
    target: str = Field(min_length=3, max_length=320)
    purpose: str = Field(pattern="^(registration|reset_password)$")

    @field_validator("target")
    @classmethod
    def clean_target(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Target cannot be blank")
        return value


class SendOTPResponse(BaseModel):
    status: str = "sent"
    target: str
    target_type: str
    message: str
    dev_otp: Optional[str] = None
    cooldown_seconds: int = 30


class RegisterWithOTP(BaseModel):
    target: str = Field(min_length=3, max_length=320)
    otp: str = Field(min_length=4, max_length=10)
    password: str = Field(min_length=10, max_length=128)
    name: str = Field(min_length=1, max_length=120)
    owner_name: Optional[str] = Field(default=None, max_length=120)
    location: Optional[str] = Field(default=None, max_length=160)
    email: Optional[EmailStr] = None
    phone: Optional[str] = Field(default=None, max_length=20)

    @field_validator("name")
    @classmethod
    def trim_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Name cannot be blank")
        return value

    @field_validator("owner_name", "location")
    @classmethod
    def trim_optional_text(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        return value or None


class ResetPasswordWithOTP(BaseModel):
    target: str = Field(min_length=3, max_length=320)
    otp: str = Field(min_length=4, max_length=10)
    new_password: str = Field(min_length=10, max_length=128)


class MerchantLogin(BaseModel):
    identifier: Optional[str] = None
    email: Optional[str] = None
    password: str = Field(min_length=1, max_length=128)


class MerchantOut(BaseModel):
    id: uuid.UUID
    name: str
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    owner_name: Optional[str]
    location: Optional[str]
    upi_id: Optional[str]
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class MerchantUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    owner_name: Optional[str] = Field(default=None, max_length=120)
    location: Optional[str] = Field(default=None, max_length=160)
    upi_id: Optional[str] = Field(default=None, max_length=255)

    @field_validator("name", "owner_name", "location")
    @classmethod
    def trim_optional_text(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        if not value:
            return None
        return value

    @field_validator("upi_id")
    @classmethod
    def validate_upi_id(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        if not value:
            return None
        import re
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,254}@[A-Za-z0-9][A-Za-z0-9.-]{0,63}", value):
            raise ValueError("Enter a valid UPI ID, for example shop@bank")
        return value


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
    transaction_date: Optional[date] = None
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


class ParsedVoiceEntryOut(BaseModel):
    customer_name: str
    amount: Decimal
    entry_type: EntryType
    relative_date: str
    note: str = ""
    customer_id: Optional[uuid.UUID] = None


class VoiceSessionProcessOut(VoiceSessionOut):
    intent: str = "UNKNOWN"
    entries: list[ParsedVoiceEntryOut] = Field(default_factory=list)
    query_target: dict = Field(default_factory=dict)
    needs_clarification: bool = False
    spoken_response: str = ""
    detected_language_code: Optional[str] = None
    parser_notice: Optional[str] = None


class VoiceReplyRequest(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    transcript: str = Field(min_length=1, max_length=1000)
    current_entry: dict


class VoiceReplyOut(BaseModel):
    action: str
    normalized_answer: str = ""
    updated_entry: ParsedVoiceEntryOut
    spoken_response: str = ""
    parser_notice: Optional[str] = None


class VoiceQuestionRequest(BaseModel):
    draft_question: str = Field(min_length=1, max_length=500)
    current_entry: dict = Field(default_factory=dict)
    candidate_names: list[str] = Field(default_factory=list, max_length=10)
    language_code: str = Field(default="hi-IN", max_length=20)


class VoiceQuestionOut(BaseModel):
    question: str = Field(min_length=1, max_length=240)
    parser_notice: Optional[str] = None


class VoiceConfirm(BaseModel):
    customer_id: uuid.UUID
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    entry_type: EntryType
    note: Optional[str] = Field(default=None, max_length=500)


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    language_code: str = "hi-IN"

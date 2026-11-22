from __future__ import annotations

import email.message
import hashlib
import logging
import re
import secrets
import smtplib
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple
from uuid import UUID

import httpx
from fastapi import HTTPException, status
from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Merchant, OTPRecord, now_utc

logger = logging.getLogger("voicekhata.otp")

# Phone format: 10 digits, optional +91 or leading 0
PHONE_RE = re.compile(r"^(?:\+?91|0)?([6-9]\d{9})$")
EMAIL_RE = re.compile(r"^[\w\.-]+@[\w\.-]+\.\w{2,}$")


def normalize_target(target: str) -> Tuple[str, str]:
    """
    Normalizes the input email and returns (normalized_email, 'email').
    Phone number authentication has been replaced with 100% free Gmail OTP.
    """
    clean = target.strip().lower()
    if not clean or "@" not in clean or not EMAIL_RE.match(clean):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Please enter a valid Gmail address (e.g. name@gmail.com).",
        )
    return clean, "email"


def generate_otp_code() -> str:
    """Generates a secure 6-digit numeric OTP code."""
    return f"{secrets.randbelow(900_000) + 100_000}"


def compute_otp_hash(target: str, code: str, secret_key: str) -> str:
    """Computes a SHA-256 hash of the target and OTP code with the secret key."""
    payload = f"{target.strip().lower()}:{code.strip()}:{secret_key}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


async def deliver_otp_notification(
    target: str, target_type: str, code: str, purpose: str
) -> Optional[str]:
    """
    Delivers OTP code via SMS or Email depending on target_type and configured gateways.
    If external gateways are not configured, logs to terminal and returns the code as dev_otp.
    """
    settings = get_settings()
    is_live_delivered = False

    if target_type == "email":
        subject_tag = "Account Setup" if purpose == "registration" else "Password Reset"
        purpose_desc = (
            "setting up your VoiceKhata shop account"
            if purpose == "registration"
            else "resetting your VoiceKhata account password"
        )
        sender_email = (settings.smtp_from_email or settings.smtp_user or "anuragsingh90087@gmail.com").strip()

        # 1. First priority: Brevo HTTPS REST API (Port 443 - works everywhere, never blocked on Render)
        if settings.brevo_api_key:
            try:
                brevo_payload = {
                    "sender": {"name": "VoiceKhata", "email": sender_email},
                    "to": [{"email": target}],
                    "subject": f"VoiceKhata OTP for {subject_tag}: {code}",
                    "htmlContent": (
                        f"<div style='font-family:sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px;background:#ffffff;'>"
                        f"<h2 style='color:#14532d;margin-top:0;'>VoiceKhata Verification</h2>"
                        f"<p style='color:#374151;font-size:15px;'>Namaste,</p>"
                        f"<p style='color:#374151;font-size:15px;'>Your verification code for <strong>{purpose_desc}</strong> is:</p>"
                        f"<div style='text-align:center;margin:24px 0;padding:16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:32px;letter-spacing:6px;font-weight:700;color:#166534;'>"
                        f"{code}"
                        f"</div>"
                        f"<p style='color:#6b7280;font-size:13px;'>This code is valid for 10 minutes. If you did not request this, please ignore this email.</p>"
                        f"<hr style='border:none;border-top:1px solid #e5e7eb;margin:20px 0;'>"
                        f"<small style='color:#9ca3af;'>VoiceKhata &bull; Your shop, in your voice</small>"
                        f"</div>"
                    ),
                    "textContent": (
                        f"Namaste,\n\n"
                        f"Your VoiceKhata verification code is: {code}\n\n"
                        f"Valid for 10 minutes for {purpose_desc}.\n\n"
                        f"Team VoiceKhata"
                    ),
                }
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.post(
                        "https://api.brevo.com/v3/smtp/email",
                        headers={
                            "api-key": settings.brevo_api_key.strip(),
                            "Content-Type": "application/json",
                            "accept": "application/json",
                        },
                        json=brevo_payload,
                    )
                    if resp.status_code in (200, 201):
                        is_live_delivered = True
                        logger.info("Sent OTP email to %s via Brevo HTTPS API", target)
                    else:
                        logger.error("Brevo API error (%s): %s", resp.status_code, resp.text)
            except Exception as e:
                logger.error("Failed to send OTP email via Brevo to %s: %s", target, e)

        # 2. Fallback: SMTP (for environments where port 587 is unblocked, e.g. localhost)
        if not is_live_delivered and settings.smtp_host and settings.smtp_user and settings.smtp_password:
            try:
                import asyncio
                msg = email.message.EmailMessage()
                msg["Subject"] = f"VoiceKhata OTP for {subject_tag}: {code}"
                msg["From"] = f"VoiceKhata <{sender_email}>"
                msg["To"] = target
                text_content = (
                    f"Namaste,\n\n"
                    f"Your VoiceKhata verification code is: {code}\n\n"
                    f"This code is valid for 10 minutes for {purpose_desc}.\n"
                    f"If you did not request this code, please ignore this email.\n\n"
                    f"Team VoiceKhata"
                )
                msg.set_content(text_content)

                smtp_pw = settings.smtp_password.replace(" ", "").strip()
                def _send_sync():
                    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as server:
                        server.starttls()
                        server.login(settings.smtp_user.strip(), smtp_pw)
                        server.send_message(msg)

                await asyncio.to_thread(_send_sync)
                is_live_delivered = True
                logger.info("Sent OTP email to %s via SMTP", target)
            except Exception as e:
                logger.error("Failed to send OTP email to %s: %s", target, e)
                # Fall through to console logging

    elif target_type == "phone":
        # 1. Check Fast2SMS
        if settings.fast2sms_api_key:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.post(
                        "https://www.fast2sms.com/dev/bulkV2",
                        headers={
                            "authorization": settings.fast2sms_api_key,
                            "Content-Type": "application/json",
                        },
                        json={
                            "route": "otp",
                            "variables_values": code,
                            "numbers": target,
                        },
                    )
                    if resp.status_code == 200 and resp.json().get("return"):
                        is_live_delivered = True
                        logger.info("Sent OTP SMS to %s via Fast2SMS", target)
                    else:
                        logger.warning("Fast2SMS error: %s", resp.text)
            except Exception as e:
                logger.error("Failed to send SMS via Fast2SMS to %s: %s", target, e)

        # 2. Check Twilio if Fast2SMS was not used or failed
        if not is_live_delivered and settings.twilio_account_sid and settings.twilio_auth_token and settings.twilio_from_number:
            try:
                twilio_url = (
                    f"https://api.twilio.com/2010-04-01/Accounts/{settings.twilio_account_sid}/Messages.json"
                )
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.post(
                        twilio_url,
                        auth=(settings.twilio_account_sid, settings.twilio_auth_token),
                        data={
                            "From": settings.twilio_from_number,
                            "To": f"+91{target}" if len(target) == 10 else target,
                            "Body": f"Your VoiceKhata verification OTP is: {code}. Valid for 10 minutes.",
                        },
                    )
                    if resp.status_code in (200, 201):
                        is_live_delivered = True
                        logger.info("Sent OTP SMS to %s via Twilio", target)
                    else:
                        logger.warning("Twilio SMS error: %s", resp.text)
            except Exception as e:
                logger.error("Failed to send SMS via Twilio to %s: %s", target, e)

    # Always log to server terminal for easy debugging/development
    border = "=" * 62
    print(f"\n{border}")
    print(f" [VOICEKHATA OTP] Purpose: {purpose.upper()}")
    print(f" Target: {target} ({target_type.upper()})")
    print(f" OTP Code: >>> {code} <<< (valid for 10 minutes)")
    print(f" Live delivery: {'SENT' if is_live_delivered else 'MOCK/DEV MODE (logged here)'}")
    print(f"{border}\n", flush=True)

    # Return code as dev_otp if not sent via a live external gateway so UI/dev can proceed easily
    return None if is_live_delivered else code


async def issue_otp(
    db: Session, target: str, purpose: str
) -> Tuple[str, str, Optional[str]]:
    """
    Creates an OTP record for the target & purpose, invalidates previous ones,
    delivers it, and returns (normalized_target, target_type, dev_otp).
    """
    settings = get_settings()
    normalized, target_type = normalize_target(target)

    # Check cooldown: last request must be at least 30 seconds ago
    recent_otp = db.scalar(
        select(OTPRecord)
        .where(
            OTPRecord.target == normalized,
            OTPRecord.purpose == purpose,
            OTPRecord.is_verified.is_(False),
        )
        .order_by(desc(OTPRecord.created_at))
    )
    if recent_otp is not None:
        elapsed = (now_utc() - recent_otp.created_at).total_seconds()
        if elapsed < 30:
            remaining = int(30 - elapsed)
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Please wait {remaining} seconds before requesting a new OTP.",
            )

    code = generate_otp_code()
    otp_hash = compute_otp_hash(normalized, code, settings.secret_key)
    expires_at = now_utc() + timedelta(minutes=settings.otp_expire_minutes)

    record = OTPRecord(
        target=normalized,
        target_type=target_type,
        otp_hash=otp_hash,
        purpose=purpose,
        expires_at=expires_at,
        attempts=0,
        is_verified=False,
    )
    db.add(record)
    db.commit()

    dev_otp = await deliver_otp_notification(normalized, target_type, code, purpose)
    return normalized, target_type, dev_otp


def verify_and_consume_otp(
    db: Session, target: str, purpose: str, entered_code: str
) -> OTPRecord:
    """
    Validates the entered OTP code against the latest unverified record.
    Increments attempt counter on failure. Marks record as verified on success.
    """
    settings = get_settings()
    normalized, _ = normalize_target(target)

    record = db.scalar(
        select(OTPRecord)
        .where(
            OTPRecord.target == normalized,
            OTPRecord.purpose == purpose,
            OTPRecord.is_verified.is_(False),
        )
        .order_by(desc(OTPRecord.created_at))
    )

    if record is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No active OTP found. Please click 'Send OTP' first.",
        )

    if now_utc() > record.expires_at:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="OTP has expired. Please request a new OTP.",
        )

    if record.attempts >= 5:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Too many incorrect attempts. Please request a new OTP.",
        )

    expected_hash = compute_otp_hash(normalized, entered_code.strip(), settings.secret_key)
    if record.otp_hash != expected_hash:
        record.attempts += 1
        db.commit()
        remaining = max(0, 5 - record.attempts)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid OTP code. {remaining} attempt(s) remaining.",
        )

    record.is_verified = True
    db.commit()
    return record

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pwdlib import PasswordHash
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.models import Merchant

password_hash = PasswordHash.recommended()
bearer_scheme = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return password_hash.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    return password_hash.verify(password, hashed)


def create_access_token(merchant_id: UUID) -> str:
    settings = get_settings()
    expires = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_minutes)
    return jwt.encode({"sub": str(merchant_id), "exp": expires}, settings.secret_key, algorithm="HS256")


def get_current_merchant(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> Merchant:
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired access token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        if credentials is None:
            raise unauthorized
        payload = jwt.decode(credentials.credentials, get_settings().secret_key, algorithms=["HS256"])
        merchant_id = UUID(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise unauthorized
    merchant = db.get(Merchant, merchant_id)
    if merchant is None:
        raise unauthorized
    return merchant

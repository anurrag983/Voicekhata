from __future__ import annotations

from functools import lru_cache
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    secret_key: str
    database_url: str = "sqlite:///./voicekhata.db"
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    gnani_api_key: Optional[str] = None
    gnani_stt_url: str = "https://api.vachana.ai/stt/v3"
    gnani_stt_model: str = "prisma-v3.0"
    gnani_tts_url: str = "https://api.vachana.ai/api/v1/tts/sse"
    gnani_tts_model: str = "timbre-v2.5"
    gnani_tts_voice: str = "Nalini"
    gemini_api_key: Optional[str] = None
    gemini_model: str = "gemini-3.5-flash-lite"
    max_audio_bytes: int = 15 * 1024 * 1024
    access_token_minutes: int = 720

    # OTP Delivery Settings (Email / SMTP)
    smtp_host: Optional[str] = None
    smtp_port: int = 587
    smtp_user: Optional[str] = None
    smtp_password: Optional[str] = None
    smtp_from_email: Optional[str] = None

    # OTP Delivery Settings (SMS - Fast2SMS / Twilio)
    fast2sms_api_key: Optional[str] = None
    twilio_account_sid: Optional[str] = None
    twilio_auth_token: Optional[str] = None
    twilio_from_number: Optional[str] = None

    otp_expire_minutes: int = 10

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()

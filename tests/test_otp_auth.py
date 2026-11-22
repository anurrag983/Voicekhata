import uuid
from fastapi.testclient import TestClient

from app.main import app
from app.database import SessionLocal
from app.models import Merchant, OTPRecord

client = TestClient(app)


def test_reject_phone_input():
    # Attempting to use phone number should be rejected
    resp = client.post("/api/v1/auth/otp/send", json={
        "target": "9876543210",
        "purpose": "registration"
    })
    assert resp.status_code == 422
    assert "Gmail" in resp.json()["detail"] or "email" in resp.json()["detail"]


def test_email_otp_full_flow():
    unique_email = f"sharma_{uuid.uuid4().hex[:8]}@gmail.com"

    # 1. Send OTP for registration with Gmail
    resp = client.post("/api/v1/auth/otp/send", json={
        "target": unique_email,
        "purpose": "registration"
    })
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["status"] == "sent"
    assert data["target_type"] == "email"
    dev_otp = data.get("dev_otp")
    if not dev_otp:
        # If live SMTP is configured, fetch code from DB for the test
        from app.otp_service import compute_otp_hash
        from app.config import get_settings
        with SessionLocal() as db:
            rec = db.query(OTPRecord).filter(OTPRecord.target == unique_email, OTPRecord.purpose == "registration").order_by(OTPRecord.created_at.desc()).first()
            # Find which 6-digit matches hash in test
            for cand in range(100000, 1000000):
                if compute_otp_hash(unique_email, str(cand), get_settings().secret_key) == rec.otp_hash:
                    dev_otp = str(cand)
                    break

    # 2. Try registering with invalid OTP
    fail_reg = client.post("/api/v1/auth/otp/register", json={
        "target": unique_email,
        "otp": "000000",
        "password": "Password123!",
        "name": "Sharma Kirana Store"
    })
    assert fail_reg.status_code == 400

    # 3. Register with valid OTP
    reg_resp = client.post("/api/v1/auth/otp/register", json={
        "target": unique_email,
        "otp": dev_otp,
        "password": "Password123!",
        "name": "Sharma Kirana Store",
        "owner_name": "Ramesh Sharma",
        "location": "Jaipur"
    })
    assert reg_resp.status_code == 201, reg_resp.text
    reg_data = reg_resp.json()
    assert "access_token" in reg_data
    assert reg_data["merchant"]["email"] == unique_email
    assert reg_data["merchant"]["name"] == "Sharma Kirana Store"

    # 4. Login with Gmail and password
    login_resp = client.post("/api/v1/auth/login", json={
        "email": unique_email,
        "password": "Password123!"
    })
    assert login_resp.status_code == 200, login_resp.text
    assert "access_token" in login_resp.json()

    # 5. Forgot password / reset password with Gmail OTP
    with SessionLocal() as db:
        db.query(OTPRecord).filter(OTPRecord.target == unique_email).delete()
        db.commit()

    reset_send_resp = client.post("/api/v1/auth/otp/send", json={
        "target": unique_email,
        "purpose": "reset_password"
    })
    assert reset_send_resp.status_code == 200, reset_send_resp.text
    reset_otp = reset_send_resp.json().get("dev_otp")
    if not reset_otp:
        from app.otp_service import compute_otp_hash
        from app.config import get_settings
        with SessionLocal() as db:
            rec = db.query(OTPRecord).filter(OTPRecord.target == unique_email, OTPRecord.purpose == "reset_password").order_by(OTPRecord.created_at.desc()).first()
            for cand in range(100000, 1000000):
                if compute_otp_hash(unique_email, str(cand), get_settings().secret_key) == rec.otp_hash:
                    reset_otp = str(cand)
                    break
    assert reset_otp is not None

    # Reset password
    reset_resp = client.post("/api/v1/auth/otp/reset-password", json={
        "target": unique_email,
        "otp": reset_otp,
        "new_password": "NewSecretPassword999!"
    })
    assert reset_resp.status_code == 200, reset_resp.text
    assert "access_token" in reset_resp.json()

    # Verify login with new password
    new_login_resp = client.post("/api/v1/auth/login", json={
        "email": unique_email,
        "password": "NewSecretPassword999!"
    })
    assert new_login_resp.status_code == 200, new_login_resp.text

    # Cleanup
    with SessionLocal() as db:
        m = db.query(Merchant).filter(Merchant.email == unique_email).first()
        if m:
            db.delete(m)
        db.query(OTPRecord).filter(OTPRecord.target == unique_email).delete()
        db.commit()

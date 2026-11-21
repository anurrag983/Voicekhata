from getpass import getpass

from sqlalchemy import select

from app.database import SessionLocal
from app.models import Merchant
from app.security import hash_password


def main() -> None:
    email = input("Account email: ").strip().lower()
    if not email:
        print("Email cannot be blank.")
        return

    new_password = getpass("Choose a new password (at least 10 characters): ")
    if len(new_password) < 10:
        print("Password must be at least 10 characters. No changes were made.")
        return
    confirmation = getpass("Type the new password again: ")
    if new_password != confirmation:
        print("Passwords did not match. No changes were made.")
        return

    with SessionLocal() as db:
        merchant = db.scalar(select(Merchant).where(Merchant.email == email))
        if merchant is None:
            print("No account found for that email. No changes were made.")
            return
        merchant.password_hash = hash_password(new_password)
        db.commit()

    print("Password updated. Log in with this email and your new password.")


if __name__ == "__main__":
    main()

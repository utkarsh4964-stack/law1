"""
Simple auth for a demo deployment: PBKDF2 password hashing (stdlib only,
no native deps to fight with) + JWT bearer tokens.

This is deliberately NOT production-grade (no refresh tokens, no lockouts,
no password reset flow) - it's "good enough for a demo" per spec.
"""
import base64
import hashlib
import os
import time

import jwt

SECRET = os.environ.get("JWT_SECRET", "sih-demo-secret-change-me")
ALGO = "HS256"
TOKEN_TTL_SECONDS = 12 * 3600

ROLE_RANK = {"viewer": 0, "reviewer": 1, "investigator": 2, "admin": 3}


def hash_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    salt = salt or os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 100_000)
    return base64.b64encode(salt).decode(), base64.b64encode(dk).decode()


def verify_password(password: str, salt_b64: str, hash_b64: str) -> bool:
    salt = base64.b64decode(salt_b64)
    _, dk_b64 = hash_password(password, salt)
    return dk_b64 == hash_b64


def create_token(username: str, role: str, display_name: str) -> str:
    payload = {
        "sub": username,
        "role": role,
        "name": display_name,
        "iat": int(time.time()),
        "exp": int(time.time()) + TOKEN_TTL_SECONDS,
    }
    return jwt.encode(payload, SECRET, algorithm=ALGO)


def decode_token(token: str) -> dict:
    return jwt.decode(token, SECRET, algorithms=[ALGO])


def role_at_least(role: str, minimum: str) -> bool:
    return ROLE_RANK.get(role, -1) >= ROLE_RANK.get(minimum, 99)

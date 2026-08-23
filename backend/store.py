"""
Persistence layer for the multi-case version of the app.

Still a single JSON file on disk (data/db.json) - appropriate for a demo,
NOT for concurrent production use. Swap this module for a real database
(Postgres + an ORM) before deploying this for real investigators; the
function signatures here are the seam to do that behind.
"""
import json
import os
import threading
from datetime import datetime, timezone

import auth

DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "db.json")
_lock = threading.Lock()

DEFAULT_USERS = [
    ("admin", "admin123", "admin", "Admin User"),
    ("investigator", "investigator123", "investigator", "Officer A. Sharma"),
    ("reviewer", "reviewer123", "reviewer", "Reviewer P. Nair"),
    ("viewer", "viewer123", "viewer", "Viewer Access"),
]


def _empty_db():
    users = {}
    for username, password, role, display_name in DEFAULT_USERS:
        salt, pw_hash = auth.hash_password(password)
        users[username] = {
            "username": username, "role": role, "display_name": display_name,
            "salt": salt, "hash": pw_hash,
        }
    return {"users": users, "cases": {}, "case_seq": 0}


def _load():
    if not os.path.exists(DATA_PATH):
        return _empty_db()
    try:
        with open(DATA_PATH, "r", encoding="utf-8") as f:
            db = json.load(f)
        if not isinstance(db, dict) or "users" not in db or not isinstance(db["users"], dict):
            raise ValueError("db.json is missing the expected 'users' structure")
        return db
    except (json.JSONDecodeError, ValueError, OSError) as e:
        # A corrupted or half-written state file used to take the whole app
        # down (every request touches _load(), so login/dashboard/etc all
        # 500'd). Instead: log it loudly and reinitialize with fresh seed
        # data so the app stays usable. This does mean any cases created
        # since the corruption are lost — but a working demo beats a
        # permanently broken one.
        try:
            corrupt_backup = DATA_PATH + ".corrupt"
            if os.path.exists(DATA_PATH):
                os.replace(DATA_PATH, corrupt_backup)
                print(f"[store] WARNING: {DATA_PATH} was corrupted ({e}); "
                      f"moved to {corrupt_backup} and reinitializing with seed data.")
        except OSError:
            print(f"[store] WARNING: {DATA_PATH} was corrupted ({e}); reinitializing with seed data.")
        db = _empty_db()
        _save(db)
        return db


def _save(db):
    os.makedirs(os.path.dirname(DATA_PATH), exist_ok=True)
    tmp_path = DATA_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(db, f, indent=2, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, DATA_PATH)  # atomic on POSIX — never leaves a half-written file


def _now():
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# users
# ---------------------------------------------------------------------------

def get_user(username: str):
    return _load()["users"].get(username)


# ---------------------------------------------------------------------------
# cases
# ---------------------------------------------------------------------------

def create_case(fields: dict, created_by: str) -> dict:
    with _lock:
        db = _load()
        db["case_seq"] += 1
        case_id = f"CASE-{datetime.now().year}-{db['case_seq']:05d}"
        case = {
            "id": case_id,
            "title": fields.get("title", "Untitled Investigation"),
            "case_type": fields.get("case_type", "General"),
            "description": fields.get("description", ""),
            "investigating_officer": fields.get("investigating_officer", created_by),
            "status": fields.get("status", "Active"),
            "priority": fields.get("priority", "Medium"),
            "assigned_team": fields.get("assigned_team", []),
            "created_by": created_by,
            "created_date": _now(),
            "documents": {},
            "audit_log": [],
            "chat_history": [],
            "cache": {},
        }
        db["cases"][case_id] = case
        _append_audit_locked(db, case_id, created_by, "case_created", f"Case '{case['title']}' created")
        _save(db)
        return case


def list_cases() -> list:
    db = _load()
    out = []
    for c in db["cases"].values():
        summary = {k: v for k, v in c.items() if k not in ("documents", "audit_log", "chat_history", "cache")}
        summary["document_count"] = len(c["documents"])
        out.append(summary)
    return sorted(out, key=lambda c: c["created_date"], reverse=True)


def get_case(case_id: str):
    return _load()["cases"].get(case_id)


def delete_case(case_id: str):
    with _lock:
        db = _load()
        db["cases"].pop(case_id, None)
        _save(db)


def _with_case(case_id: str):
    db = _load()
    return db, db["cases"].get(case_id)


# ---------------------------------------------------------------------------
# documents
# ---------------------------------------------------------------------------

def add_document(case_id: str, doc: dict) -> dict:
    with _lock:
        db, case = _with_case(case_id)
        if case is None:
            raise KeyError(case_id)
        case["documents"][doc["id"]] = doc
        _invalidate_cache(case)
        _save(db)
        return doc


def update_document(case_id: str, doc_id: str, patch: dict):
    with _lock:
        db, case = _with_case(case_id)
        if case is None or doc_id not in case["documents"]:
            raise KeyError(doc_id)
        case["documents"][doc_id].update(patch)
        _save(db)
        return case["documents"][doc_id]


def delete_document(case_id: str, doc_id: str):
    with _lock:
        db, case = _with_case(case_id)
        if case is None:
            return
        case["documents"].pop(doc_id, None)
        _invalidate_cache(case)
        _save(db)


def list_documents(case_id: str) -> list:
    case = get_case(case_id)
    return list(case["documents"].values()) if case else []


def get_document(case_id: str, doc_id: str):
    case = get_case(case_id)
    return case["documents"].get(doc_id) if case else None


# ---------------------------------------------------------------------------
# cache (per case - invalidated whenever documents change)
# ---------------------------------------------------------------------------

def _invalidate_cache(case):
    case["cache"] = {}


def set_cache(case_id: str, key: str, value):
    with _lock:
        db, case = _with_case(case_id)
        if case is None:
            return
        case["cache"][key] = value
        _save(db)


def get_cache(case_id: str, key: str):
    case = get_case(case_id)
    return case["cache"].get(key) if case else None


# ---------------------------------------------------------------------------
# chat
# ---------------------------------------------------------------------------

def append_chat(case_id: str, role: str, content: str, mode: str = "case"):
    with _lock:
        db, case = _with_case(case_id)
        if case is None:
            return
        case["chat_history"].append({"role": role, "content": content, "mode": mode, "ts": _now()})
        _save(db)


def get_chat_history(case_id: str) -> list:
    case = get_case(case_id)
    return case["chat_history"] if case else []


# ---------------------------------------------------------------------------
# audit log / chain of custody
# ---------------------------------------------------------------------------

def _append_audit_locked(db, case_id, user, action, detail, doc_id=None):
    case = db["cases"].get(case_id)
    if case is None:
        return
    case["audit_log"].append({
        "ts": _now(), "user": user, "action": action, "detail": detail, "doc_id": doc_id,
    })


def append_audit(case_id: str, user: str, action: str, detail: str, doc_id: str = None):
    with _lock:
        db = _load()
        _append_audit_locked(db, case_id, user, action, detail, doc_id)
        _save(db)


def get_audit_log(case_id: str) -> list:
    case = get_case(case_id)
    return case["audit_log"] if case else []


def get_document_custody(case_id: str, doc_id: str) -> list:
    log = get_audit_log(case_id)
    return [entry for entry in log if entry.get("doc_id") == doc_id]

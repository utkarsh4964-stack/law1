"""
Simple persistence layer.

This is a single-case, single-user prototype: everything lives in one
JSON file on disk (data/case.json) and is mirrored in memory. No DB,
no auth, no multi-tenancy - by design, for a local prototype.
"""
import json
import os
import threading
from datetime import datetime, timezone

DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "case.json")
_lock = threading.Lock()

_EMPTY_CASE = {
    "documents": {},       # id -> document dict
    "chat_history": [],    # list of {role, content}
    "cache": {             # invalidated whenever documents change
        "case_summary": None,
        "graph": None,
        "contradictions": None,
        "timeline": None,
    },
}


def _load():
    if not os.path.exists(DATA_PATH):
        return json.loads(json.dumps(_EMPTY_CASE))
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _save(case):
    os.makedirs(os.path.dirname(DATA_PATH), exist_ok=True)
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(case, f, indent=2, ensure_ascii=False)


def get_case():
    with _lock:
        return _load()


def add_document(doc_id: str, filename: str, text: str, extracted: dict):
    with _lock:
        case = _load()
        case["documents"][doc_id] = {
            "id": doc_id,
            "filename": filename,
            "text": text,
            "uploaded_at": datetime.now(timezone.utc).isoformat(),
            **extracted,  # summary, entities, events, claims
        }
        _invalidate_cache(case)
        _save(case)
        return case["documents"][doc_id]


def delete_document(doc_id: str):
    with _lock:
        case = _load()
        case["documents"].pop(doc_id, None)
        _invalidate_cache(case)
        _save(case)


def list_documents():
    case = _load()
    return list(case["documents"].values())


def get_document(doc_id: str):
    case = _load()
    return case["documents"].get(doc_id)


def _invalidate_cache(case):
    case["cache"] = {
        "case_summary": None,
        "graph": None,
        "contradictions": None,
        "timeline": None,
    }


def set_cache(key: str, value):
    with _lock:
        case = _load()
        case["cache"][key] = value
        _save(case)


def get_cache(key: str):
    case = _load()
    return case["cache"].get(key)


def append_chat(role: str, content: str):
    with _lock:
        case = _load()
        case["chat_history"].append({"role": role, "content": content})
        _save(case)


def get_chat_history():
    case = _load()
    return case["chat_history"]


def reset_case():
    with _lock:
        _save(json.loads(json.dumps(_EMPTY_CASE)))

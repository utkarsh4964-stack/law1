import hashlib
import io
import os
import re
import uuid
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

from fastapi import FastAPI, UploadFile, File, HTTPException, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import PlainTextResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from dateutil import parser as dateparser
from pypdf import PdfReader

import auth
import store
import llm

from groq import APIError as GroqAPIError

app = FastAPI(title="AI Case Report")


def call_llm(fn, *args, **kwargs):
    """Run an llm.* call and turn any failure into a clear HTTPException
    instead of an opaque 500. AI calls are the most likely thing to break in
    this app (model deprecations, rate limits, provider outages) and an
    unhandled exception here used to surface as a bare "Internal Server
    Error" with no indication of what actually went wrong."""
    try:
        return fn(*args, **kwargs)
    except GroqAPIError as e:
        raise HTTPException(502, f"AI provider error: {e}")
    except RuntimeError as e:
        # e.g. llm.client() raising because GROQ_API_KEY isn't set
        raise HTTPException(502, str(e))

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

import logging
import traceback

logger = logging.getLogger("case_ai")


@app.exception_handler(Exception)
async def unhandled_exception_handler(request, exc):
    # Without this, any exception we didn't specifically anticipate falls
    # through to Starlette's default handler, which returns a bare
    # plain-text "Internal Server Error" with zero information — that's
    # what made earlier bugs (corrupted db.json, a deprecated model) take
    # several rounds of guesswork to diagnose from the frontend alone.
    # Every route in this app now returns *some* real detail on failure.
    logger.error("Unhandled exception on %s %s:\n%s", request.method, request.url.path, traceback.format_exc())
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"})

MAX_FILE_BYTES = 15 * 1024 * 1024  # 15 MB
ALLOWED_EXTENSIONS = {".txt", ".md", ".pdf"}

bearer_scheme = HTTPBearer(auto_error=False)


# ---------------------------------------------------------------------------
# auth dependencies
# ---------------------------------------------------------------------------

def get_current_user(creds: HTTPAuthorizationCredentials = Depends(bearer_scheme)) -> dict:
    if creds is None:
        raise HTTPException(401, "Missing authentication token.")
    try:
        payload = auth.decode_token(creds.credentials)
    except Exception:
        raise HTTPException(401, "Invalid or expired token.")
    return {"username": payload["sub"], "role": payload["role"], "name": payload["name"]}


def require_role(minimum: str):
    def dep(user: dict = Depends(get_current_user)) -> dict:
        if not auth.role_at_least(user["role"], minimum):
            raise HTTPException(403, f"This action requires '{minimum}' role or higher.")
        return user
    return dep


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def sanitize_filename(name: str) -> str:
    name = os.path.basename(name or "file")
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)


def read_upload(filename: str, raw: bytes) -> tuple[str, int]:
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported file type '{ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}")
    if ext == ".pdf":
        reader = PdfReader(io.BytesIO(raw))
        text = "\n".join((page.extract_text() or "") for page in reader.pages)
        return text, len(reader.pages)
    try:
        return raw.decode("utf-8"), None
    except UnicodeDecodeError:
        return raw.decode("latin-1", errors="ignore"), None


def parsed_date(d: str):
    try:
        return dateparser.parse(d, fuzzy=True, default=None)
    except Exception:
        return None


def build_timeline(documents: list) -> dict:
    dated, undated = [], []
    for d in documents:
        for ev in d.get("events", []):
            raw_date = ev.get("date", "")
            raw_desc = ev.get("description", "")
            item = {
                "date": raw_date if isinstance(raw_date, str) else str(raw_date or ""),
                "description": raw_desc if isinstance(raw_desc, str) else str(raw_desc or ""),
                "source": d["filename"], "doc_id": d["id"],
            }
            parsed = parsed_date(item["date"]) if item["date"] else None
            if parsed:
                item["_sort"] = parsed.isoformat()
                dated.append(item)
            else:
                undated.append(item)
    dated.sort(key=lambda x: x["_sort"])
    for item in dated:
        item.pop("_sort", None)

    gaps = []
    for i in range(1, len(dated)):
        try:
            d1 = dateparser.parse(dated[i - 1]["date"], fuzzy=True)
            d2 = dateparser.parse(dated[i]["date"], fuzzy=True)
            if (d2 - d1).days > 30:
                gaps.append({"after": dated[i - 1]["date"], "before": dated[i]["date"], "days": (d2 - d1).days})
        except Exception:
            pass

    return {"events": dated, "undated": undated, "gaps": gaps}


def get_case_or_404(case_id: str) -> dict:
    case = store.get_case(case_id)
    if case is None:
        raise HTTPException(404, "Case not found.")
    return case


def require_documents(case_id: str) -> list:
    docs = store.list_documents(case_id)
    if not docs:
        raise HTTPException(400, "Upload at least one document first.")
    return docs


def strip_text(docs: list) -> list:
    return [{k: v for k, v in d.items() if k != "text"} for d in docs]


# ---------------------------------------------------------------------------
# auth endpoints
# ---------------------------------------------------------------------------

class LoginRequest(BaseModel):
    username: str
    password: str


@app.post("/api/auth/login")
def login(req: LoginRequest):
    user = store.get_user(req.username)
    if not user or not auth.verify_password(req.password, user["salt"], user["hash"]):
        raise HTTPException(401, "Invalid username or password.")
    token = auth.create_token(user["username"], user["role"], user["display_name"])
    return {"token": token, "role": user["role"], "display_name": user["display_name"], "username": user["username"]}


@app.get("/api/auth/me")
def me(user: dict = Depends(get_current_user)):
    return user


# ---------------------------------------------------------------------------
# case management
# ---------------------------------------------------------------------------

class CaseCreateRequest(BaseModel):
    title: str
    case_type: str = "General"
    description: str = ""
    investigating_officer: str = ""
    status: str = "Active"
    priority: str = "Medium"
    assigned_team: list[str] = []


@app.post("/api/cases")
def create_case(req: CaseCreateRequest, user: dict = Depends(require_role("investigator"))):
    case = store.create_case(req.model_dump(), user["username"])
    return {k: v for k, v in case.items() if k not in ("documents", "audit_log", "chat_history", "cache")}


@app.get("/api/cases")
def list_cases(user: dict = Depends(get_current_user)):
    return store.list_cases()


@app.get("/api/cases/{case_id}")
def case_detail(case_id: str, user: dict = Depends(get_current_user)):
    case = get_case_or_404(case_id)
    return {k: v for k, v in case.items() if k not in ("documents", "audit_log", "chat_history", "cache")}


@app.delete("/api/cases/{case_id}")
def delete_case(case_id: str, user: dict = Depends(require_role("admin"))):
    get_case_or_404(case_id)
    store.delete_case(case_id)
    return {"ok": True}


@app.get("/api/cases/{case_id}/dashboard")
def case_dashboard(case_id: str, user: dict = Depends(get_current_user)):
    case = get_case_or_404(case_id)
    docs = store.list_documents(case_id)
    entities = {e["name"] for d in docs for e in d.get("entities", []) if e.get("type") == "person"}
    events = sum(len(d.get("events", [])) for d in docs)
    contradictions = store.get_cache(case_id, "contradictions") or []
    graph = store.get_cache(case_id, "graph") or {}
    log = store.get_audit_log(case_id)
    return {
        "case": {k: v for k, v in case.items() if k not in ("documents", "audit_log", "chat_history", "cache")},
        "document_count": len(docs),
        "person_count": len(entities),
        "event_count": events,
        "contradiction_count": len(contradictions),
        "evidence_link_count": len(graph.get("edges", [])),
        "recent_activity": log[-8:][::-1],
    }


# ---------------------------------------------------------------------------
# documents / secure vault
# ---------------------------------------------------------------------------

PROCESSING_STEPS = [
    "file_validated", "integrity_hashed", "text_extracted",
    "document_classified", "entities_extracted", "events_extracted",
    "indexed_for_search", "added_to_evidence_graph",
]


@app.post("/api/cases/{case_id}/documents")
async def upload_document(case_id: str, file: UploadFile = File(...),
                           user: dict = Depends(require_role("investigator"))):
    get_case_or_404(case_id)
    raw = await file.read()
    if len(raw) > MAX_FILE_BYTES:
        raise HTTPException(400, f"File exceeds the {MAX_FILE_BYTES // (1024*1024)}MB limit.")

    safe_name = sanitize_filename(file.filename)
    text, page_count = read_upload(safe_name, raw)
    if not text.strip():
        raise HTTPException(400, f"Could not extract any text from {safe_name}.")

    doc_hash = hashlib.sha256(raw).hexdigest()

    try:
        extracted = llm.extract_document(safe_name, text)
    except RuntimeError as e:
        raise HTTPException(400, str(e))

    doc_id = str(uuid.uuid4())[:8]
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": doc_id,
        "case_id": case_id,
        "filename": safe_name,
        "text": text,
        "size_bytes": len(raw),
        "page_count": page_count,
        "hash": doc_hash,
        "version": "1.0",
        "confidentiality": "Standard",
        "uploaded_by": user["username"],
        "uploaded_at": now,
        "status": "processed",
        "processing_steps": PROCESSING_STEPS,
        **extracted,
    }
    store.add_document(case_id, doc)

    store.append_audit(case_id, user["username"], "document_uploaded", f"Uploaded {safe_name}", doc_id)
    store.append_audit(case_id, user["username"], "integrity_hash_generated", f"SHA-256 generated for {safe_name}", doc_id)
    store.append_audit(case_id, user["username"], "ai_analysis_completed", f"AI extraction completed for {safe_name}", doc_id)

    return {k: v for k, v in doc.items() if k != "text"}


@app.get("/api/cases/{case_id}/documents")
def list_documents(case_id: str, q: str = Query(None), doc_type: str = Query(None),
                    user: dict = Depends(get_current_user)):
    get_case_or_404(case_id)
    docs = strip_text(store.list_documents(case_id))
    if doc_type and doc_type != "All":
        docs = [d for d in docs if d.get("doc_type", "").lower() == doc_type.lower()]
    if q:
        ql = q.lower()
        docs = [d for d in docs if ql in d["filename"].lower() or ql in d.get("summary", "").lower()]
    return docs


@app.get("/api/cases/{case_id}/documents/{doc_id}")
def document_detail(case_id: str, doc_id: str, user: dict = Depends(get_current_user)):
    doc = store.get_document(case_id, doc_id)
    if doc is None:
        raise HTTPException(404, "Document not found.")
    store.append_audit(case_id, user["username"], "document_viewed", f"Viewed {doc['filename']}", doc_id)
    result = {k: v for k, v in doc.items() if k != "text"}
    result["custody"] = store.get_document_custody(case_id, doc_id)
    return result


@app.get("/api/cases/{case_id}/documents/{doc_id}/integrity")
def check_integrity(case_id: str, doc_id: str, user: dict = Depends(get_current_user)):
    doc = store.get_document(case_id, doc_id)
    if doc is None:
        raise HTTPException(404, "Document not found.")
    # Recompute hash of the stored text as a stand-in for re-hashing the stored
    # file (this prototype doesn't persist the original binary separately).
    current = hashlib.sha256(doc["text"].encode("utf-8", errors="ignore")).hexdigest()
    return {"stored_hash": doc["hash"], "note": "Recomputed against extracted text for this prototype; "
                                                  "a production build should hash the stored binary."}


@app.delete("/api/cases/{case_id}/documents/{doc_id}")
def delete_document(case_id: str, doc_id: str, user: dict = Depends(require_role("investigator"))):
    doc = store.get_document(case_id, doc_id)
    if doc is None:
        raise HTTPException(404, "Document not found.")
    if user["role"] == "investigator" and doc["uploaded_by"] != user["username"]:
        raise HTTPException(403, "Investigators can only delete documents they uploaded.")
    store.delete_document(case_id, doc_id)
    store.append_audit(case_id, user["username"], "document_deleted", f"Deleted {doc['filename']}", doc_id)
    return {"ok": True}


@app.get("/api/cases/{case_id}/search")
def global_search(case_id: str, q: str, user: dict = Depends(get_current_user)):
    docs = store.list_documents(case_id)
    ql = q.lower()
    doc_hits, entity_hits, event_hits = [], set(), []
    for d in docs:
        if ql in d["text"].lower() or ql in d.get("summary", "").lower():
            doc_hits.append({"filename": d["filename"], "doc_id": d["id"]})
        for e in d.get("entities", []):
            if ql in e["name"].lower():
                entity_hits.add(e["name"])
        for ev in d.get("events", []):
            if ql in ev.get("description", "").lower():
                event_hits.append({"description": ev["description"], "date": ev.get("date"), "source": d["filename"]})
    return {
        "document_matches": doc_hits, "entity_matches": sorted(entity_hits), "event_matches": event_hits,
    }


# ---------------------------------------------------------------------------
# audit trail
# ---------------------------------------------------------------------------

@app.get("/api/cases/{case_id}/audit-log")
def audit_log(case_id: str, user: dict = Depends(get_current_user)):
    get_case_or_404(case_id)
    return {"log": list(reversed(store.get_audit_log(case_id)))}


# ---------------------------------------------------------------------------
# case-level AI views (cached until documents change)
# ---------------------------------------------------------------------------

@app.get("/api/cases/{case_id}/summary")
def case_summary(case_id: str, user: dict = Depends(get_current_user)):
    docs = require_documents(case_id)
    cached = store.get_cache(case_id, "case_summary")
    if cached:
        return {"summary": cached}
    summary = call_llm(llm.build_case_summary, docs)
    store.set_cache(case_id, "case_summary", summary)
    return {"summary": summary}


@app.get("/api/cases/{case_id}/summary/cached")
def case_summary_cached(case_id: str, user: dict = Depends(get_current_user)):
    # Read-only peek at whatever summary is already cached, for previews
    # like the dashboard's AI Summary bar. Never triggers an LLM call —
    # dashboards get visited far more often than summaries need generating,
    # and this keeps that view fast and free.
    get_case_or_404(case_id)
    return {"summary": store.get_cache(case_id, "case_summary")}


@app.get("/api/cases/{case_id}/timeline")
def case_timeline(case_id: str, user: dict = Depends(get_current_user)):
    docs = require_documents(case_id)
    cached = store.get_cache(case_id, "timeline")
    if cached:
        return cached
    timeline = build_timeline(docs)
    store.set_cache(case_id, "timeline", timeline)
    return timeline


@app.get("/api/cases/{case_id}/graph")
def case_graph(case_id: str, user: dict = Depends(get_current_user)):
    docs = require_documents(case_id)
    cached = store.get_cache(case_id, "graph")
    if cached:
        return cached
    graph = call_llm(llm.build_graph, docs)
    store.set_cache(case_id, "graph", graph)
    return graph


@app.get("/api/cases/{case_id}/contradictions")
def case_contradictions(case_id: str, user: dict = Depends(get_current_user)):
    docs = require_documents(case_id)
    cached = store.get_cache(case_id, "contradictions")
    if cached is not None:
        return {"contradictions": cached}
    contradictions = call_llm(llm.detect_contradictions, docs)
    store.set_cache(case_id, "contradictions", contradictions)
    return {"contradictions": contradictions}


@app.get("/api/cases/{case_id}/similar-cases")
def similar_cases(case_id: str, user: dict = Depends(get_current_user)):
    docs = require_documents(case_id)
    cached = store.get_cache(case_id, "similar_cases")
    if cached is not None:
        return {"matches": cached}
    summary = store.get_cache(case_id, "case_summary") or call_llm(llm.build_case_summary, docs)
    store.set_cache(case_id, "case_summary", summary)
    matches = call_llm(llm.find_similar_cases, summary)
    store.set_cache(case_id, "similar_cases", matches)
    return {"matches": matches}


@app.get("/api/cases/{case_id}/arguments")
def case_arguments(case_id: str, user: dict = Depends(get_current_user)):
    docs = require_documents(case_id)
    cached = store.get_cache(case_id, "arguments")
    if cached is not None:
        return {"arguments": cached}
    summary = store.get_cache(case_id, "case_summary") or call_llm(llm.build_case_summary, docs)
    store.set_cache(case_id, "case_summary", summary)
    arguments = call_llm(llm.generate_arguments, summary, docs)
    store.set_cache(case_id, "arguments", arguments)
    return {"arguments": arguments}


class ChatRequest(BaseModel):
    message: str
    mode: str = "case"   # case | evidence | legal
    lang: str = "en"     # en | hi


@app.post("/api/cases/{case_id}/chat")
def case_chat(case_id: str, req: ChatRequest, user: dict = Depends(get_current_user)):
    docs = require_documents(case_id)
    history = store.get_chat_history(case_id)
    graph = store.get_cache(case_id, "graph") if req.mode == "evidence" else None
    answer = call_llm(llm.chat_answer, req.message, docs, history, mode=req.mode, graph=graph, lang=req.lang)
    store.append_chat(case_id, "user", req.message, req.mode)
    store.append_chat(case_id, "assistant", answer, req.mode)
    store.append_audit(case_id, user["username"], "chat_query", f"Asked ({req.mode}): {req.message[:80]}")
    return {"answer": answer}


@app.get("/api/cases/{case_id}/chat")
def case_chat_history(case_id: str, user: dict = Depends(get_current_user)):
    return {"history": store.get_chat_history(case_id)}


@app.get("/api/cases/{case_id}/report", response_class=PlainTextResponse)
def case_report(case_id: str, user: dict = Depends(get_current_user)):
    case = get_case_or_404(case_id)
    docs = require_documents(case_id)
    summary = store.get_cache(case_id, "case_summary") or call_llm(llm.build_case_summary, docs)
    store.set_cache(case_id, "case_summary", summary)
    case["cache"]["case_summary"] = summary
    timeline = store.get_cache(case_id, "timeline") or build_timeline(docs)
    store.set_cache(case_id, "timeline", timeline)
    graph = store.get_cache(case_id, "graph") or call_llm(llm.build_graph, docs)
    store.set_cache(case_id, "graph", graph)
    contradictions = store.get_cache(case_id, "contradictions")
    if contradictions is None:
        contradictions = call_llm(llm.detect_contradictions, docs)
        store.set_cache(case_id, "contradictions", contradictions)
    similar = store.get_cache(case_id, "similar_cases")
    if similar is None:
        similar = call_llm(llm.find_similar_cases, summary)
        store.set_cache(case_id, "similar_cases", similar)
    audit_log = store.get_audit_log(case_id)
    report = call_llm(llm.generate_report, case, docs, timeline["events"], graph, contradictions, similar, audit_log)
    store.append_audit(case_id, user["username"], "report_generated", "AI case report generated")
    return report


@app.post("/api/cases/{case_id}/reset")
def case_reset(case_id: str, user: dict = Depends(require_role("admin"))):
    store.delete_case(case_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# frontend
# ---------------------------------------------------------------------------

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

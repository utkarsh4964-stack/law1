import os
import uuid
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from dateutil import parser as dateparser
from pypdf import PdfReader
import io

import store
import llm

app = FastAPI(title="AI Case Report")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def read_upload(file: UploadFile, raw: bytes) -> str:
    name = file.filename or ""
    if name.lower().endswith(".pdf"):
        reader = PdfReader(io.BytesIO(raw))
        return "\n".join((page.extract_text() or "") for page in reader.pages)
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin-1", errors="ignore")


def parsed_date(d: str):
    """Best-effort date parse for sorting. Returns None if unparseable."""
    try:
        return dateparser.parse(d, fuzzy=True, default=None)
    except Exception:
        return None


def build_timeline(documents: list) -> dict:
    dated, undated = [], []
    for d in documents:
        for ev in d.get("events", []):
            item = {"date": ev.get("date", ""), "description": ev.get("description", ""), "source": d["filename"]}
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
                gaps.append({
                    "after": dated[i - 1]["date"], "before": dated[i]["date"],
                    "days": (d2 - d1).days,
                })
        except Exception:
            pass

    return {"events": dated, "undated": undated, "gaps": gaps}


def require_documents():
    docs = store.list_documents()
    if not docs:
        raise HTTPException(400, "Upload at least one document first.")
    return docs


# ---------------------------------------------------------------------------
# documents
# ---------------------------------------------------------------------------

@app.post("/api/documents")
async def upload_document(file: UploadFile = File(...)):
    raw = await file.read()
    text = read_upload(file, raw)
    if not text.strip():
        raise HTTPException(400, f"Could not extract any text from {file.filename}.")
    try:
        extracted = llm.extract_document(file.filename, text)
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    doc_id = str(uuid.uuid4())[:8]
    doc = store.add_document(doc_id, file.filename, text, extracted)
    return {k: v for k, v in doc.items() if k != "text"}


@app.get("/api/documents")
def list_documents():
    return [{k: v for k, v in d.items() if k != "text"} for d in store.list_documents()]


@app.delete("/api/documents/{doc_id}")
def delete_document(doc_id: str):
    store.delete_document(doc_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# case-level AI views (cached until documents change)
# ---------------------------------------------------------------------------

@app.get("/api/case/summary")
def case_summary():
    docs = require_documents()
    cached = store.get_cache("case_summary")
    if cached:
        return {"summary": cached}
    summary = llm.build_case_summary(docs)
    store.set_cache("case_summary", summary)
    return {"summary": summary}


@app.get("/api/case/timeline")
def case_timeline():
    docs = require_documents()
    cached = store.get_cache("timeline")
    if cached:
        return cached
    timeline = build_timeline(docs)
    store.set_cache("timeline", timeline)
    return timeline


@app.get("/api/case/graph")
def case_graph():
    docs = require_documents()
    cached = store.get_cache("graph")
    if cached:
        return cached
    graph = llm.build_graph(docs)
    store.set_cache("graph", graph)
    return graph


@app.get("/api/case/contradictions")
def case_contradictions():
    docs = require_documents()
    cached = store.get_cache("contradictions")
    if cached is not None:
        return {"contradictions": cached}
    contradictions = llm.detect_contradictions(docs)
    store.set_cache("contradictions", contradictions)
    return {"contradictions": contradictions}


class ChatRequest(BaseModel):
    message: str


@app.post("/api/case/chat")
def case_chat(req: ChatRequest):
    docs = require_documents()
    history = store.get_chat_history()
    answer = llm.chat_answer(req.message, docs, history)
    store.append_chat("user", req.message)
    store.append_chat("assistant", answer)
    return {"answer": answer}


@app.get("/api/case/chat")
def case_chat_history():
    return {"history": store.get_chat_history()}


@app.get("/api/case/report", response_class=PlainTextResponse)
def case_report():
    docs = require_documents()
    summary = store.get_cache("case_summary") or llm.build_case_summary(docs)
    store.set_cache("case_summary", summary)
    timeline = store.get_cache("timeline") or build_timeline(docs)
    store.set_cache("timeline", timeline)
    graph = store.get_cache("graph") or llm.build_graph(docs)
    store.set_cache("graph", graph)
    contradictions = store.get_cache("contradictions")
    if contradictions is None:
        contradictions = llm.detect_contradictions(docs)
        store.set_cache("contradictions", contradictions)
    report = llm.generate_report(summary, docs, timeline["events"], graph, contradictions)
    return report


@app.post("/api/case/reset")
def case_reset():
    store.reset_case()
    return {"ok": True}


# ---------------------------------------------------------------------------
# frontend
# ---------------------------------------------------------------------------

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

"""
All AI calls go through here, all using Groq's free API (OpenAI-compatible
chat completions with JSON mode). One place to swap models/providers.
"""
import json
import os
from groq import Groq

MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")

_client = None


def client() -> Groq:
    global _client
    if _client is None:
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GROQ_API_KEY is not set. Get a free key at https://console.groq.com/keys "
                "and put it in backend/.env (see .env.example)."
            )
        _client = Groq(api_key=api_key)
    return _client


def _chat_json(system: str, user: str, max_tokens: int = 2000) -> dict:
    """Call the model and force a JSON object back. Retries once on bad JSON."""
    for attempt in range(2):
        resp = client().chat.completions.create(
            model=MODEL,
            temperature=0.1,
            max_tokens=max_tokens,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        raw = resp.choices[0].message.content
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            if attempt == 0:
                user = user + "\n\nYour previous reply was not valid JSON. Reply with ONLY a valid JSON object, nothing else."
                continue
            raise


def _chat_text(system: str, user: str, max_tokens: int = 1500) -> str:
    resp = client().chat.completions.create(
        model=MODEL,
        temperature=0.2,
        max_tokens=max_tokens,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    return resp.choices[0].message.content


# ---------------------------------------------------------------------------
# 1. Per-document extraction
# ---------------------------------------------------------------------------

EXTRACTION_SYSTEM = """You are a meticulous legal case analyst. You read a single \
document from a case file and extract structured information from it ONLY - never \
invent facts that are not in the text. Respond with a single JSON object matching \
exactly this schema:

{
  "summary": "2-4 sentence plain-language summary of this document",
  "doc_type": "short label, e.g. 'witness statement', 'email', 'invoice', 'police report'",
  "entities": [ {"name": "string", "type": "person|organization|location|other"} ],
  "events": [ {"date": "string, as written or normalized to YYYY-MM-DD if clear, else best guess text", "description": "string"} ],
  "claims": [ {"statement": "a single factual claim asserted in this document", "about": "short label of what/who it concerns"} ]
}

Keep entities deduplicated within the document. Keep claims short (one fact each) - \
these will later be compared across documents to find contradictions, so be precise \
about what is actually asserted (who said what, what value/date/fact is claimed)."""


def extract_document(filename: str, text: str) -> dict:
    # Guard against extremely long documents blowing the context window.
    snippet = text[:18000]
    user = f"Filename: {filename}\n\nDocument text:\n---\n{snippet}\n---"
    data = _chat_json(EXTRACTION_SYSTEM, user)
    return {
        "summary": data.get("summary", ""),
        "doc_type": data.get("doc_type", "document"),
        "entities": data.get("entities", []),
        "events": data.get("events", []),
        "claims": data.get("claims", []),
    }


# ---------------------------------------------------------------------------
# 2. Case-level summary
# ---------------------------------------------------------------------------

CASE_SUMMARY_SYSTEM = """You are a legal case analyst producing a complete case \
summary for an investigator, based on per-document summaries already extracted \
from the case file. Synthesize them into one coherent narrative. Do not repeat \
each document one by one - tell the story of the case: who is involved, what \
happened, what is in dispute or unresolved, and what evidence exists. \
Respond with a single JSON object: {"summary": "3-6 paragraph case summary in plain prose"}"""


def build_case_summary(documents: list) -> str:
    listing = "\n\n".join(
        f"[{d['filename']}] ({d.get('doc_type', 'document')}): {d['summary']}"
        for d in documents
    )
    data = _chat_json(CASE_SUMMARY_SYSTEM, listing, max_tokens=1200)
    return data.get("summary", "")


# ---------------------------------------------------------------------------
# 3. Evidence & connection graph
# ---------------------------------------------------------------------------

GRAPH_SYSTEM = """You build a relationship graph for a legal case from a list of \
entities and events found across multiple documents. Merge obvious duplicate \
entities (e.g. "J. Smith" and "John Smith" if context implies the same person) \
into one node, keeping the clearest name. Infer relationships/connections only \
when the source material actually supports them (e.g. two people appear together \
in the same event, an org employs a person, a document mentions two entities \
interacting). Respond with a single JSON object:

{
  "nodes": [ {"id": "string, stable slug", "label": "display name", "type": "person|organization|location|other"} ],
  "edges": [ {"source": "node id", "target": "node id", "relation": "short phrase describing the connection", "evidence": "which document(s) support this, by filename"} ]
}

Keep it focused: only include edges you can justify from the given material."""


def build_graph(documents: list) -> dict:
    payload = []
    for d in documents:
        payload.append({
            "filename": d["filename"],
            "entities": d.get("entities", []),
            "events": d.get("events", []),
            "summary": d.get("summary", ""),
        })
    user = json.dumps(payload, ensure_ascii=False)
    data = _chat_json(GRAPH_SYSTEM, user, max_tokens=2500)
    return {"nodes": data.get("nodes", []), "edges": data.get("edges", [])}


# ---------------------------------------------------------------------------
# 4. Contradiction & evidence analysis
# ---------------------------------------------------------------------------

CONTRADICTION_SYSTEM = """You compare factual claims extracted from different \
documents in a legal case and identify genuine contradictions - places where two \
documents assert incompatible facts (different dates for the same event, \
conflicting accounts of what happened, mismatched figures, etc). Do NOT flag \
things that are merely different topics or complementary (non-conflicting) \
details. Respond with a single JSON object:

{
  "contradictions": [
    {
      "claim_a": "string", "source_a": "filename",
      "claim_b": "string", "source_b": "filename",
      "explanation": "why these conflict"
    }
  ]
}

If there are no real contradictions, return an empty list. Be conservative - \
only flag clear conflicts, not speculation."""


def detect_contradictions(documents: list) -> list:
    payload = []
    for d in documents:
        for c in d.get("claims", []):
            payload.append({"source": d["filename"], **c})
    if len(payload) < 2:
        return []
    user = json.dumps(payload, ensure_ascii=False)
    data = _chat_json(CONTRADICTION_SYSTEM, user, max_tokens=2000)
    return data.get("contradictions", [])


# ---------------------------------------------------------------------------
# 5. Case chat (RAG-lite: full context, fine for prototype-scale case files)
# ---------------------------------------------------------------------------

CHAT_SYSTEM = """You are a case assistant answering questions about a legal case \
strictly from the provided documents. Always cite the filename(s) your answer is \
based on in parentheses, e.g. "(witness_statement.txt)". If the documents don't \
contain the answer, say so plainly rather than guessing."""


def chat_answer(question: str, documents: list, history: list) -> str:
    context = "\n\n".join(
        f"=== {d['filename']} ({d.get('doc_type','document')}) ===\n{d['text'][:6000]}"
        for d in documents
    )
    convo = "\n".join(f"{h['role']}: {h['content']}" for h in history[-6:])
    user = f"CASE DOCUMENTS:\n{context}\n\nRECENT CONVERSATION:\n{convo}\n\nQUESTION: {question}"
    return _chat_text(CHAT_SYSTEM, user, max_tokens=900)


# ---------------------------------------------------------------------------
# 6. AI case report
# ---------------------------------------------------------------------------

REPORT_SYSTEM = """You write a formal, structured case report for an investigator \
or legal team, in Markdown. Use these sections in order: # Case Report, \
## Case Summary, ## People & Entities Involved, ## Timeline of Events, \
## Key Evidence, ## Detected Connections, ## Potential Contradictions, \
## Notes & Gaps. Cite source documents by filename wherever you state a specific \
fact. Be precise and neutral in tone - this is a factual report, not an argument."""


def generate_report(case_summary: str, documents: list, timeline: list, graph: dict, contradictions: list) -> str:
    payload = {
        "case_summary": case_summary,
        "documents": [
            {"filename": d["filename"], "doc_type": d.get("doc_type"), "summary": d["summary"], "entities": d.get("entities", [])}
            for d in documents
        ],
        "timeline": timeline,
        "graph": graph,
        "contradictions": contradictions,
    }
    user = json.dumps(payload, ensure_ascii=False)
    return _chat_text(REPORT_SYSTEM, user, max_tokens=3000)

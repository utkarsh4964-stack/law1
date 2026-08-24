"""
All AI calls go through here, using an OpenAI-compatible chat completions API
with JSON mode. One place to swap models/providers.

Currently pointed at Groq (via its OpenAI-compatible endpoint). Note: Groq's
free tier has a 200k-tokens/day hard cap that's easy to exhaust during a
demo/dev session with no way to raise it without paying — if you hit that
wall again, either upgrade to a paid Groq tier, request a higher on-demand
limit at https://console.groq.com/settings/billing, or point LLM_BASE_URL /
LLM_MODEL / the api key env var back at Gemini or another OpenAI-compatible
provider. Swapping providers only means changing this client() function and
the two env vars below — every call site in this file is written against the
standard OpenAI chat-completions shape, so nothing else needs to change.
"""
import json
import os
from openai import OpenAI

import legal_kb

MODEL = os.environ.get("LLM_MODEL", "llama-3.3-70b-versatile")
BASE_URL = os.environ.get("LLM_BASE_URL", "https://api.groq.com/openai/v1")

_client = None


def client() -> OpenAI:
    global _client
    if _client is None:
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GROQ_API_KEY is not set. Get a free key at https://console.groq.com/keys "
                "and put it in backend/.env (see .env.example)."
            )
        _client = OpenAI(api_key=api_key, base_url=BASE_URL)
    return _client


def _chat_json(system: str, user: str, max_tokens: int = 2000) -> dict:
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

EXTRACTION_SYSTEM = """You are a meticulous investigative document analyst. You read a single \
document from a case file and extract structured information from it ONLY - never \
invent facts that are not in the text. Respond with a single JSON object matching \
exactly this schema:

{
  "summary": "2-4 sentence plain-language summary of this document",
  "doc_type": "short label, e.g. 'witness statement', 'FIR', 'bank statement', 'contract', 'court order'",
  "entities": [ {"name": "string", "type": "person|organization|location|other"} ],
  "events": [ {"date": "string, as written or normalized to YYYY-MM-DD if clear, else best guess text", "description": "string"} ],
  "claims": [ {"statement": "a single factual claim asserted in this document", "about": "short label of what/who it concerns"} ],
  "key_identifiers": [ {"type": "phone|email|money|account|case_number|legal_section|other", "value": "string"} ]
}

Keep entities deduplicated within the document. Keep claims short (one fact each) - \
these will later be compared across documents to find contradictions, so be precise \
about what is actually asserted (who said what, what value/date/fact is claimed)."""


def extract_document(filename: str, text: str) -> dict:
    snippet = text[:18000]
    user = f"Filename: {filename}\n\nDocument text:\n---\n{snippet}\n---"
    data = _chat_json(EXTRACTION_SYSTEM, user)
    return {
        "summary": data.get("summary", ""),
        "doc_type": data.get("doc_type", "document"),
        "entities": data.get("entities", []),
        "events": data.get("events", []),
        "claims": data.get("claims", []),
        "key_identifiers": data.get("key_identifiers", []),
    }


# ---------------------------------------------------------------------------
# 2. Case-level summary
# ---------------------------------------------------------------------------

CASE_SUMMARY_SYSTEM = """You are a case analyst producing a complete case summary for an \
investigator, based on per-document summaries already extracted from the case file. \
Synthesize them into one coherent narrative: who is involved, what happened, what is \
in dispute or unresolved, and what evidence exists. \
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

GRAPH_SYSTEM = """You build a relationship graph for an investigation from a list of \
entities and events found across multiple documents. Merge obvious duplicate entities \
into one node, keeping the clearest name. Infer relationships/connections only when \
the source material actually supports them. Respond with a single JSON object:

{
  "nodes": [ {"id": "string, stable slug", "label": "display name", "type": "person|organization|location|other"} ],
  "edges": [ {"source": "node id", "target": "node id", "relation": "short phrase describing the connection", "evidence": "which document(s) support this, by filename"} ]
}

Keep it focused: only include edges you can justify from the given material."""


def build_graph(documents: list) -> dict:
    payload = [{
        "filename": d["filename"],
        "entities": d.get("entities", []),
        "events": d.get("events", []),
        "summary": d.get("summary", ""),
    } for d in documents]
    data = _chat_json(GRAPH_SYSTEM, json.dumps(payload, ensure_ascii=False), max_tokens=2500)
    return {"nodes": data.get("nodes", []), "edges": data.get("edges", [])}


# ---------------------------------------------------------------------------
# 3b. Alternative investigative angles — different lenses on the same graph
# ---------------------------------------------------------------------------

PERSPECTIVES_SYSTEM = """You are a senior investigator doing a "red team" pass on a case file. \
Given the entities, relationships and evidence already extracted from the case documents, \
generate 3-4 genuinely DIFFERENT investigative angles an investigator should consider - \
not just restatements of the obvious reading of the evidence. Think about: who else could \
be responsible, what innocent explanations could account for the same facts, what the \
evidence does NOT yet establish, and where the investigation has tunnel vision.

Each angle must be grounded in the entities/relationships actually provided - never invent \
people, organizations, or events that are not present in the input. These are hypotheses \
for an investigator to weigh and test, not conclusions or accusations. Respond with a single \
JSON object:

{
  "perspectives": [
    {
      "title": "short name for this angle, e.g. 'Alternative suspect: the vendor side'",
      "stance": "primary|alternative_suspect|innocent_explanation|gap_in_evidence",
      "summary": "2-3 sentence explanation of this angle and why it's worth considering",
      "points": ["short bullet grounded in the provided entities/evidence", "..."],
      "caveat": "one sentence on what would need to be verified before this angle holds up"
    }
  ]
}

Always include at least one "gap_in_evidence" angle (what's missing or unverified) and at \
least one "innocent_explanation" angle (a non-incriminating account of the same facts) if \
the case involves any person who could be a suspect. Be specific to THIS case, not generic."""


def generate_perspectives(graph: dict, case_summary: str) -> list:
    payload = {
        "case_summary": case_summary,
        "entities": graph.get("nodes", []),
        "relationships": graph.get("edges", []),
    }
    data = _chat_json(PERSPECTIVES_SYSTEM, json.dumps(payload, ensure_ascii=False), max_tokens=2200)
    return data.get("perspectives", [])


# ---------------------------------------------------------------------------
# 4. Contradiction & evidence analysis (with type + confidence)
# ---------------------------------------------------------------------------

CONTRADICTION_SYSTEM = """You compare factual claims extracted from different documents in an \
investigation and identify genuine contradictions - places where two documents assert \
incompatible facts. Do NOT flag things that are merely different topics or complementary \
details. Never state a conclusion about who is lying or which claim is true - only flag \
the conflict for human verification. Respond with a single JSON object:

{
  "contradictions": [
    {
      "claim_a": "string", "source_a": "filename",
      "claim_b": "string", "source_b": "filename",
      "conflict_type": "date|amount|identity|location|sequence|other",
      "confidence": 0-100 integer, how clearly these two claims actually conflict,
      "explanation": "neutral description of why these conflict - end with 'Human verification required.'"
    }
  ]
}

If there are no real contradictions, return an empty list. Be conservative."""


def detect_contradictions(documents: list) -> list:
    payload = []
    for d in documents:
        for c in d.get("claims", []):
            payload.append({"source": d["filename"], **c})
    if len(payload) < 2:
        return []
    data = _chat_json(CONTRADICTION_SYSTEM, json.dumps(payload, ensure_ascii=False), max_tokens=2200)
    return data.get("contradictions", [])


# ---------------------------------------------------------------------------
# 5. Case chat - three modes, with citations, optional Hindi output
# ---------------------------------------------------------------------------

def _lang_instruction(lang: str) -> str:
    return " Respond in Hindi (Devanagari script)." if lang == "hi" else " Respond in English."


def chat_answer(question: str, documents: list, history: list, mode: str = "case",
                graph: dict = None, lang: str = "en") -> str:
    convo = "\n".join(f"{h['role']}: {h['content']}" for h in history[-6:])

    if mode == "legal":
        system = (
            "You are a legal-knowledge assistant. Answer using ONLY the provided reference "
            "provisions below - these are illustrative demo entries, not verified legal advice. "
            "Always say plainly that this is not a substitute for a qualified legal professional's "
            "review. Cite provision IDs in parentheses." + _lang_instruction(lang)
        )
        context = json.dumps(legal_kb.LEGAL_PROVISIONS, ensure_ascii=False)
        user = f"REFERENCE PROVISIONS:\n{context}\n\nCONVERSATION:\n{convo}\n\nQUESTION: {question}"
        return _chat_text(system, user, max_tokens=800)

    if mode == "evidence":
        system = (
            "You are a case evidence assistant. Answer strictly from the provided documents AND "
            "the evidence connection graph. Explain connections between entities using the graph "
            "edges, and always cite the filename(s) your answer is based on in parentheses. "
            "If the material doesn't contain the answer, say so plainly." + _lang_instruction(lang)
        )
        doc_context = "\n\n".join(
            f"=== {d['filename']} ({d.get('doc_type','document')}) ===\n{d['text'][:5000]}" for d in documents
        )
        graph_context = json.dumps(graph or {}, ensure_ascii=False)
        user = f"DOCUMENTS:\n{doc_context}\n\nEVIDENCE GRAPH:\n{graph_context}\n\nCONVERSATION:\n{convo}\n\nQUESTION: {question}"
        return _chat_text(system, user, max_tokens=900)

    # default: case mode
    system = (
        "You are a case assistant answering questions about an investigation strictly from the "
        "provided documents. Always cite the filename(s) your answer is based on in parentheses, "
        "e.g. \"(witness_statement.txt)\". If the documents don't contain the answer, say so "
        "plainly rather than guessing." + _lang_instruction(lang)
    )
    context = "\n\n".join(
        f"=== {d['filename']} ({d.get('doc_type','document')}) ===\n{d['text'][:6000]}" for d in documents
    )
    user = f"CASE DOCUMENTS:\n{context}\n\nCONVERSATION:\n{convo}\n\nQUESTION: {question}"
    return _chat_text(system, user, max_tokens=900)


# ---------------------------------------------------------------------------
# 6. AI case report (expanded structure)
# ---------------------------------------------------------------------------

REPORT_SYSTEM = """You write a formal, structured investigation case report in Markdown. \
Use these sections in order, using '##' headings:
1. Case Overview
2. Documents
3. Persons / Organizations
4. Chronological Timeline
5. Evidence Summary
6. Evidence Relationships
7. Potential Contradictions (state clearly these require human verification, never assert guilt/lying)
8. Similar Cases (if provided)
9. Relevant Legal Information (if provided; note these are illustrative reference entries only)
10. AI Findings
11. Source References
12. Audit Information (if provided)

Cite source documents by filename wherever you state a specific fact. Be precise and \
neutral in tone - this is a factual report, not an argument. Start with a single '#' \
title line containing the case ID and title."""


def generate_report(case: dict, documents: list, timeline: list, graph: dict,
                     contradictions: list, similar_cases: list = None, audit_log: list = None) -> str:
    payload = {
        "case_id": case.get("id"), "title": case.get("title"),
        "case_type": case.get("case_type"), "status": case.get("status"), "priority": case.get("priority"),
        "investigating_officer": case.get("investigating_officer"),
        "case_summary": case.get("cache", {}).get("case_summary", ""),
        "documents": [
            {"filename": d["filename"], "doc_type": d.get("doc_type"), "summary": d["summary"],
             "entities": d.get("entities", []), "hash": d.get("hash")}
            for d in documents
        ],
        "timeline": timeline,
        "graph": graph,
        "contradictions": contradictions,
        "similar_cases": similar_cases or [],
        "audit_log": (audit_log or [])[-25:],
    }
    return _chat_text(REPORT_SYSTEM, json.dumps(payload, ensure_ascii=False), max_tokens=3200)


# ---------------------------------------------------------------------------
# 7. Similar cases (demo-scale: compares against a local precedent library)
# ---------------------------------------------------------------------------

SIMILAR_CASES_SYSTEM = """You compare a case summary against a small library of precedent case \
summaries and score factual/legal similarity. This is pattern-matching for investigative \
reference only - NEVER claim a precedent predicts or determines this case's outcome. \
Respond with a single JSON object:

{
  "matches": [
    {
      "precedent_id": "string, from the library",
      "similarity": 0-100 integer,
      "key_similarities": ["short phrase", "short phrase"],
      "note": "one sentence, framed as 'these cases contain similar factual/legal patterns', never as an outcome prediction"
    }
  ]
}

Only include matches with similarity 40 or above. Return at most 4 matches, ranked highest first."""


def find_similar_cases(case_summary: str) -> list:
    payload = {"case_summary": case_summary, "library": legal_kb.SIMILAR_CASE_LIBRARY}
    data = _chat_json(SIMILAR_CASES_SYSTEM, json.dumps(payload, ensure_ascii=False), max_tokens=1200)
    matches = data.get("matches", [])
    by_id = {c["id"]: c for c in legal_kb.SIMILAR_CASE_LIBRARY}
    for m in matches:
        prec = by_id.get(m.get("precedent_id"))
        if prec:
            m["title"] = prec["title"]
            m["summary"] = prec["summary"]
            m["outcome"] = prec["outcome"]
    return matches


# ---------------------------------------------------------------------------
# 8. Argument intelligence
# ---------------------------------------------------------------------------

ARGUMENTS_SYSTEM = """You are an investigative case-analysis assistant. Given a case summary and \
document excerpts, identify potential arguments an investigator or legal team might make, each \
grounded in the evidence, along with a fair potential counterargument. This is for internal \
analysis, not a courtroom simulation - be measured and evidence-bound. Respond with a single JSON object:

{
  "arguments": [
    {
      "argument": "string - a potential argument grounded in the evidence",
      "supporting_evidence": ["filename", "filename"],
      "counterargument": "string - a fair, good-faith potential counterargument",
      "related_precedent_ids": ["PREC-xxxx"]
    }
  ]
}

Only reference precedent IDs from the provided library if genuinely relevant. Produce at most 4 arguments."""


def generate_arguments(case_summary: str, documents: list) -> list:
    payload = {
        "case_summary": case_summary,
        "documents": [{"filename": d["filename"], "summary": d["summary"], "claims": d.get("claims", [])} for d in documents],
        "precedent_library_ids": [c["id"] for c in legal_kb.SIMILAR_CASE_LIBRARY],
    }
    data = _chat_json(ARGUMENTS_SYSTEM, json.dumps(payload, ensure_ascii=False), max_tokens=2000)
    return data.get("arguments", [])

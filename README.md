# AI Case Report

A local prototype that turns a folder of case documents into: a case summary,
an entity/timeline extraction, an evidence connection graph, contradiction
detection, a case chat, and an exportable structured report — powered by
Groq's free LLM API.

```
Upload Documents
  -> AI Reads & Organizes
  -> Extracts Important Information
  -> Case Chat + Timeline + Evidence Graph
  -> Contradiction Detection
  -> AI Case Report
```

## 1. Get a free Groq API key

Sign up at https://console.groq.com/keys and create a key — it's free, no
credit card required.

## 2. Set up the backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# then edit .env and paste your key: GROQ_API_KEY=gsk_...
```

## 3. Run it

```bash
uvicorn main:app --reload
```

Open **http://localhost:8000** — the frontend is served automatically by the
same server, no separate build step.

## 4. Use it

1. **Documents** — drop in `.txt`, `.md`, or `.pdf` files. Each one is read
   and organized (summary, doc type, entities, dated events, factual claims)
   the moment it's uploaded.
2. **Case Summary** — a synthesized narrative across every document on file.
3. **Timeline** — extracted events sorted chronologically, with source
   attribution and a flag for gaps of 30+ days between events.
4. **Connections** — a force-directed graph of people/orgs/locations and the
   relationships between them, each edge backed by the document it came from.
5. **Contradictions** — claims from different documents that conflict with
   each other, side by side with an explanation.
6. **Case Chat** — ask questions in plain English; answers cite the source
   document(s).
7. **Report** — generates a full Markdown case report (summary, entities,
   timeline, evidence, connections, contradictions, gaps) and lets you
   download it as `case-report.md`.

Use **Clear case** in the sidebar to wipe everything and start a new case.

## Notes on this prototype

- **Storage**: single case, single user, stored in `data/case.json`. No
  database, no auth — this is meant to run on your machine. Swap in Postgres
  and real auth before putting this in front of anyone else.
- **Model**: defaults to `llama-3.3-70b-versatile` on Groq. If Groq retires
  that model name, set `GROQ_MODEL` in `.env` to whatever their current
  free-tier flagship model is.
- **Chat/report context**: for a prototype-sized case (a handful to a few
  dozen documents) the full document text is sent to the model directly
  rather than doing vector-search retrieval. For a much larger case file
  you'll want to add a real retrieval layer (e.g. embeddings + a vector
  store) instead of stuffing everything into context.
- **PDF support** uses text extraction only (`pypdf`) — scanned/image-only
  PDFs won't extract text without adding OCR.

const API = "/api";

let TOKEN = localStorage.getItem("case_ai_token") || null;
let ME = null;
let CURRENT_CASE_ID = null;
let chatMode = "case";

// ---------------------------------------------------------------------------
// view switching
// ---------------------------------------------------------------------------

function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById(`view-${name}`).classList.add("active");
}

async function apiFetch(path, options = {}) {
  const headers = options.headers || {};
  if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
  const res = await fetch(`${API}${path}`, { ...options, headers });
  if (res.status === 401) {
    logout();
    throw new Error("Session expired. Please log in again.");
  }
  return res;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

document.getElementById("login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  try {
    const res = await fetch(`${API}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.detail || "Login failed."; return; }
    TOKEN = data.token;
    localStorage.setItem("case_ai_token", TOKEN);
    ME = { username: data.username, role: data.role, name: data.display_name };
    enterApp();
  } catch {
    errEl.textContent = "Could not reach the server.";
  }
});

function logout() {
  TOKEN = null;
  ME = null;
  CURRENT_CASE_ID = null;
  localStorage.removeItem("case_ai_token");
  showView("login");
}

document.getElementById("logout-btn-cases").addEventListener("click", logout);
document.getElementById("logout-btn").addEventListener("click", logout);
document.getElementById("back-to-cases").addEventListener("click", () => { CURRENT_CASE_ID = null; showView("cases"); loadCases(); });

async function enterApp() {
  try {
    const res = await apiFetch("/auth/me");
    if (!res.ok) throw new Error();
    ME = await res.json();
  } catch { logout(); return; }
  document.getElementById("whoami").textContent = `${ME.name} · ${ME.role}`;
  document.getElementById("whoami-workspace").textContent = `${ME.name} · ${ME.role}`;
  showView("cases");
  loadCases();
}

// ---------------------------------------------------------------------------
// my cases
// ---------------------------------------------------------------------------

async function loadCases() {
  const res = await apiFetch("/cases");
  const cases = await res.json();
  const grid = document.getElementById("case-grid");
  grid.innerHTML = "";
  if (cases.length === 0) {
    grid.innerHTML = '<p class="placeholder">No investigations yet. Create one to get started.</p>';
    return;
  }
  cases.forEach(c => grid.appendChild(caseTile(c)));
}

function caseTile(c) {
  const el = document.createElement("div");
  el.className = "case-tile";
  const pClass = `priority-${(c.priority || "medium").toLowerCase()}`;
  el.innerHTML = `
    <div class="case-tile-top">
      <span class="case-tile-id">${escapeHtml(c.id)}</span>
      <span class="priority-pill ${pClass}">${escapeHtml(c.priority)}</span>
    </div>
    <div class="case-tile-title">${escapeHtml(c.title)}</div>
    <div class="case-tile-type">${escapeHtml(c.case_type)} · ${escapeHtml(c.status)}</div>
    <div class="case-tile-foot">
      <span>${c.document_count} documents</span>
      <span>${escapeHtml(c.investigating_officer || c.created_by)}</span>
    </div>
  `;
  el.addEventListener("click", () => openCase(c.id));
  return el;
}

const newCaseModal = document.getElementById("new-case-modal");
document.getElementById("new-case-btn").addEventListener("click", () => newCaseModal.classList.add("active"));
document.getElementById("nc-cancel").addEventListener("click", () => newCaseModal.classList.remove("active"));

document.getElementById("new-case-form").addEventListener("submit", async e => {
  e.preventDefault();
  const payload = {
    title: document.getElementById("nc-title").value.trim(),
    case_type: document.getElementById("nc-type").value,
    description: document.getElementById("nc-description").value,
    investigating_officer: document.getElementById("nc-officer").value,
    status: document.getElementById("nc-status").value,
    priority: document.getElementById("nc-priority").value,
  };
  const res = await apiFetch("/cases", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) { alert(data.detail || "Could not create case."); return; }
  newCaseModal.classList.remove("active");
  e.target.reset();
  openCase(data.id);
});

// ---------------------------------------------------------------------------
// workspace entry
// ---------------------------------------------------------------------------

const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".panel");
const loadedTabs = new Set();

tabs.forEach(tab => {
  tab.addEventListener("click", () => {
    tabs.forEach(t => t.classList.remove("active"));
    panels.forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add("active");
    onTabShown(tab.dataset.tab);
  });
});

function onTabShown(name) {
  if (name === "dashboard") return loadDashboard();
  if (loadedTabs.has(name)) return;
  if (name === "intelligence") {
    loadedTabs.add("intelligence");
    loadSummary();
    loadContradictions();
    loadArguments();
    return;
  }
  if (name === "timeline") loadTimeline();
  if (name === "graph") loadGraph();
  if (name === "similar") loadSimilar();
  if (name === "audit") loadAudit();
}

async function openCase(caseId) {
  CURRENT_CASE_ID = caseId;
  loadedTabs.clear();
  document.getElementById("case-id").textContent = caseId;
  tabs.forEach(t => t.classList.remove("active"));
  panels.forEach(p => p.classList.remove("active"));
  document.querySelector('.tab[data-tab="dashboard"]').classList.add("active");
  document.getElementById("panel-dashboard").classList.add("active");
  showView("workspace");
  await refreshDocuments();
  await loadDashboard();
}

function invalidateCase() { loadedTabs.clear(); }

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------

async function loadDashboard() {
  const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/dashboard`);
  const data = await res.json();
  document.getElementById("dash-title").textContent = data.case.title;
  document.getElementById("dash-sub").textContent =
    `${data.case.id} · ${data.case.case_type} · ${data.case.status} · Priority: ${data.case.priority}`;

  document.getElementById("stat-grid").innerHTML = [
    ["Documents", data.document_count], ["Persons", data.person_count],
    ["Events", data.event_count], ["Contradictions", data.contradiction_count],
    ["Evidence Links", data.evidence_link_count],
  ].map(([label, num]) => `<div class="stat-tile"><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>`).join("");

  const activity = document.getElementById("dash-activity");
  if (!data.recent_activity.length) {
    activity.innerHTML = '<p class="placeholder">No activity yet.</p>';
  } else {
    activity.innerHTML = data.recent_activity.map(a => `
      <div class="activity-row">
        <span class="activity-time">${fmtTime(a.ts)}</span>
        <span><span class="activity-user">${escapeHtml(a.user)}</span> — ${escapeHtml(a.detail)}</span>
      </div>`).join("");
  }
}

// ---------------------------------------------------------------------------
// documents / vault
// ---------------------------------------------------------------------------

const fileInput = document.getElementById("file-input");
const dropzone = document.getElementById("dropzone");
const docList = document.getElementById("doc-list");
const uploadStatus = document.getElementById("upload-status");
const pipelineEl = document.getElementById("processing-pipeline");

const PIPELINE_LABELS = {
  file_validated: "File validated", integrity_hashed: "Integrity hash (SHA-256) generated",
  text_extracted: "Text extracted", document_classified: "Document classified",
  entities_extracted: "Entities extracted", events_extracted: "Events extracted",
  indexed_for_search: "Indexed for search", added_to_evidence_graph: "Added to evidence graph",
};

fileInput.addEventListener("change", () => uploadFiles(fileInput.files));
["dragenter", "dragover"].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add("drag"); }));
["dragleave", "drop"].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove("drag"); }));
dropzone.addEventListener("drop", e => uploadFiles(e.dataTransfer.files));

async function uploadFiles(files) {
  for (const file of files) {
    uploadStatus.textContent = `Uploading ${file.name} …`;
    pipelineEl.innerHTML = "";
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/documents`, { method: "POST", body: form });
      let data;
      try {
        data = await res.json();
      } catch {
        data = { detail: `Server error (${res.status}). Check the server logs for details.` };
      }
      if (!res.ok) throw new Error(data.detail || "Upload failed");
      uploadStatus.textContent = `${file.name} processed.`;
      pipelineEl.innerHTML = data.processing_steps.map(s => `<div class="step-done">${PIPELINE_LABELS[s] || s}</div>`).join("");
      invalidateCase();
      await refreshDocuments();
      await loadDashboard();
    } catch (err) {
      uploadStatus.innerHTML = `<span class="err">${file.name}: ${err.message}</span>`;
    }
  }
  fileInput.value = "";
}

document.getElementById("vault-search").addEventListener("input", debounce(refreshDocuments, 300));
document.getElementById("vault-filter").addEventListener("change", refreshDocuments);

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function refreshDocuments() {
  const q = document.getElementById("vault-search").value.trim();
  const filter = document.getElementById("vault-filter").value;
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (filter && filter !== "All") params.set("doc_type", filter);
  const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/documents?${params}`);
  const docs = await res.json();
  docList.innerHTML = "";
  docs.forEach((doc, i) => docList.appendChild(exhibitCard(doc, i + 1)));

  const filterSel = document.getElementById("vault-filter");
  const current = filterSel.value;
  const types = [...new Set(docs.map(d => d.doc_type).filter(Boolean))];
  filterSel.innerHTML = ['All', ...types].map(t => `<option ${t === current ? "selected" : ""}>${escapeHtml(t)}</option>`).join("");
}

function exhibitCard(doc, index) {
  const el = document.createElement("div");
  el.className = "exhibit-card";
  const entityCount = (doc.entities || []).length;
  const eventCount = (doc.events || []).length;
  el.innerHTML = `
    <div class="exhibit-tag">EXHIBIT ${String(index).padStart(3, "0")}</div>
    <div class="exhibit-name">${escapeHtml(doc.filename)}</div>
    <div class="exhibit-type">${escapeHtml(doc.doc_type || "document")}</div>
    <p class="exhibit-summary">${escapeHtml(doc.summary || "")}</p>
    <div class="exhibit-foot">
      <span class="exhibit-meta">${entityCount} entities · ${eventCount} events · ${doc.hash ? doc.hash.slice(0, 10) : ""}…</span>
      <button class="remove-btn" data-id="${doc.id}">remove</button>
    </div>
  `;
  el.addEventListener("click", (e) => {
    if (e.target.classList.contains("remove-btn")) return;
    openDocModal(doc.id);
  });
  el.querySelector(".remove-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Remove ${doc.filename}?`)) return;
    const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/documents/${doc.id}`, { method: "DELETE" });
    if (!res.ok) { const d = await res.json(); alert(d.detail); return; }
    invalidateCase();
    refreshDocuments();
    loadDashboard();
  });
  return el;
}

const docModal = document.getElementById("doc-modal");
document.getElementById("doc-modal-close").addEventListener("click", () => docModal.classList.remove("active"));

async function openDocModal(docId) {
  const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/documents/${docId}`);
  const doc = await res.json();
  const body = document.getElementById("doc-modal-body");
  body.innerHTML = `
    <h2>${escapeHtml(doc.filename)}</h2>
    <p class="sub">${escapeHtml(doc.doc_type)} · v${escapeHtml(doc.version)} · ${escapeHtml(doc.confidentiality)}</p>
    <p>${escapeHtml(doc.summary)}</p>
    <div class="section-label">Integrity</div>
    <div class="doc-hash">SHA-256: ${escapeHtml(doc.hash)}</div>
    <div class="section-label">Metadata</div>
    <p style="font-size:12.5px;color:var(--text-muted)">
      Uploaded by ${escapeHtml(doc.uploaded_by)} on ${fmtTime(doc.uploaded_at)}
      ${doc.page_count ? ` · ${doc.page_count} pages` : ""} · ${(doc.size_bytes / 1024).toFixed(1)} KB
    </p>
    <div class="section-label">Chain of Custody</div>
    <div class="custody-chain">
      ${(doc.custody || []).map(c => `
        <div class="custody-item">
          <div class="custody-time">${fmtTime(c.ts)}</div>
          <div>${escapeHtml(c.user)} — ${escapeHtml(c.detail)}</div>
        </div>`).join("") || '<p class="placeholder">No custody events yet.</p>'}
    </div>
  `;
  docModal.classList.add("active");
}

// ---------------------------------------------------------------------------
// case summary
// ---------------------------------------------------------------------------

async function loadSummary() {
  const body = document.getElementById("summary-body");
  const docs = await (await apiFetch(`/cases/${CURRENT_CASE_ID}/documents`)).json();
  if (docs.length === 0) return;
  body.innerHTML = '<p class="placeholder">Synthesizing case summary…</p>';
  const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/summary`);
  const data = await res.json();
  if (!res.ok) { body.innerHTML = `<p class="err">${data.detail}</p>`; return; }
  body.innerHTML = data.summary.split("\n\n").map(p => `<p>${escapeHtml(p)}</p>`).join("");
  loadedTabs.add("summary");
}

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

async function loadTimeline() {
  const body = document.getElementById("timeline-body");
  const docs = await (await apiFetch(`/cases/${CURRENT_CASE_ID}/documents`)).json();
  if (docs.length === 0) return;
  body.innerHTML = '<p class="placeholder">Extracting timeline…</p>';
  const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/timeline`);
  const data = await res.json();
  if (!res.ok) { body.innerHTML = `<p class="err">${data.detail}</p>`; return; }

  let html = "";
  if (data.events.length) {
    html += '<div class="timeline-list">';
    data.events.forEach(ev => {
      html += `
        <div class="timeline-item" data-doc="${ev.doc_id}">
          <div class="timeline-date">${escapeHtml(ev.date)}</div>
          <div class="timeline-desc">${escapeHtml(ev.description)}</div>
          <div class="timeline-source">${escapeHtml(ev.source)}</div>
        </div>`;
      const gap = data.gaps.find(g => g.after === ev.date);
      if (gap) html += `<div class="gap-marker">Gap of ~${gap.days} days before the next event</div>`;
    });
    html += "</div>";
  } else {
    html += '<p class="placeholder">No dated events were found.</p>';
  }
  if (data.undated.length) {
    html += '<div class="section-label">Undated events</div><ul>';
    data.undated.forEach(ev => { html += `<li>${escapeHtml(ev.description)} <span class="timeline-source">— ${escapeHtml(ev.source)}</span></li>`; });
    html += "</ul>";
  }
  body.innerHTML = html;
  body.querySelectorAll(".timeline-item").forEach(el => el.addEventListener("click", () => openDocModal(el.dataset.doc)));
  loadedTabs.add("timeline");
}

// ---------------------------------------------------------------------------
// graph
// ---------------------------------------------------------------------------

const typeColors = { person: "#c99a2e", organization: "#6f9270", location: "#7791b5", other: "#9c9583" };

async function loadGraph() {
  const canvas = document.getElementById("graph-canvas");
  const legend = document.getElementById("graph-legend");
  const docs = await (await apiFetch(`/cases/${CURRENT_CASE_ID}/documents`)).json();
  if (docs.length === 0) return;
  canvas.innerHTML = '<p class="placeholder" style="padding:20px">Mapping connections…</p>';
  const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/graph`);
  const data = await res.json();
  if (!res.ok) { canvas.innerHTML = `<p class="err">${data.detail}</p>`; return; }

  canvas.innerHTML = "";
  const nodes = new vis.DataSet(data.nodes.map(n => ({
    id: n.id, label: n.label,
    color: { background: typeColors[n.type] || typeColors.other, border: "#17160f" },
    font: { color: "#17160f", face: "Inter", size: 13 }, shape: "dot", size: 16,
  })));
  const edges = new vis.DataSet(data.edges.map((e, i) => ({
    id: i, from: e.source, to: e.target, label: e.relation, evidence: e.evidence,
    color: { color: "#3c3826", highlight: "#c99a2e" },
    font: { color: "#9c9583", size: 10, strokeWidth: 0, background: "#17160f" }, arrows: "to",
  })));

  const network = new vis.Network(canvas, { nodes, edges }, {
    physics: { solver: "forceAtlas2Based", forceAtlas2Based: { springLength: 140 } },
    interaction: { hover: true },
  });

  const evidencePanel = document.getElementById("edge-evidence");
  network.on("click", params => {
    if (params.edges.length) {
      const edge = edges.get(params.edges[0]);
      evidencePanel.style.display = "block";
      evidencePanel.innerHTML = `<strong>${escapeHtml(edge.label || "")}</strong><p style="margin-top:8px;color:var(--text-muted);font-size:13px">Evidence: ${escapeHtml(edge.evidence || "—")}</p>`;
    } else {
      evidencePanel.style.display = "none";
    }
  });

  legend.innerHTML = Object.entries(typeColors)
    .map(([type, color]) => `<span><span class="legend-dot" style="background:${color}"></span>${type}</span>`).join("");
  loadedTabs.add("graph");
}

// ---------------------------------------------------------------------------
// contradictions
// ---------------------------------------------------------------------------

async function loadContradictions() {
  const body = document.getElementById("contradiction-body");
  const docs = await (await apiFetch(`/cases/${CURRENT_CASE_ID}/documents`)).json();
  if (docs.length === 0) return;
  body.innerHTML = '<p class="placeholder">Comparing evidence across documents…</p>';
  const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/contradictions`);
  const data = await res.json();
  if (!res.ok) { body.innerHTML = `<p class="err">${data.detail}</p>`; return; }

  if (!data.contradictions.length) {
    body.innerHTML = '<p class="no-contradictions">No contradictions detected across the current documents.</p>';
  } else {
    body.innerHTML = data.contradictions.map(c => `
      <div class="contradiction-card">
        <div class="contradiction-top">
          <span class="conflict-type-pill">${escapeHtml(c.conflict_type || "conflict")}</span>
          <span class="confidence-pill">confidence: ${c.confidence ?? "—"}%</span>
        </div>
        <div class="contradiction-pair">
          <div class="contradiction-claim">${escapeHtml(c.claim_a)}<span class="src">${escapeHtml(c.source_a)}</span></div>
          <div class="contradiction-vs">VS</div>
          <div class="contradiction-claim">${escapeHtml(c.claim_b)}<span class="src">${escapeHtml(c.source_b)}</span></div>
        </div>
        <div class="contradiction-explain">${escapeHtml(c.explanation)}</div>
      </div>
    `).join("");
  }
  loadedTabs.add("contradictions");
}

// ---------------------------------------------------------------------------
// similar cases
// ---------------------------------------------------------------------------

async function loadSimilar() {
  const body = document.getElementById("similar-body");
  const docs = await (await apiFetch(`/cases/${CURRENT_CASE_ID}/documents`)).json();
  if (docs.length === 0) return;
  body.innerHTML = '<p class="placeholder">Comparing against the case library…</p>';
  const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/similar-cases`);
  const data = await res.json();
  if (!res.ok) { body.innerHTML = `<p class="err">${data.detail}</p>`; return; }

  if (!data.matches.length) {
    body.innerHTML = '<p class="placeholder">No sufficiently similar precedents found in the reference library.</p>';
  } else {
    body.innerHTML = data.matches.map(m => `
      <div class="similar-card">
        <div class="similar-top">
          <span class="similar-title">${escapeHtml(m.title || m.precedent_id)}</span>
          <span class="similarity-pill">${m.similarity}% match</span>
        </div>
        <p style="font-size:13px;color:var(--text-muted)">${escapeHtml(m.summary || "")}</p>
        <div class="similar-tags">${(m.key_similarities || []).map(t => `<span class="similar-tag">${escapeHtml(t)}</span>`).join("")}</div>
        <div class="similar-note">${escapeHtml(m.note || "")}</div>
      </div>
    `).join("");
  }
  loadedTabs.add("similar");
}

// ---------------------------------------------------------------------------
// argument intelligence
// ---------------------------------------------------------------------------

async function loadArguments() {
  const body = document.getElementById("arguments-body");
  const docs = await (await apiFetch(`/cases/${CURRENT_CASE_ID}/documents`)).json();
  if (docs.length === 0) return;
  body.innerHTML = '<p class="placeholder">Analyzing evidence for potential arguments…</p>';
  const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/arguments`);
  const data = await res.json();
  if (!res.ok) { body.innerHTML = `<p class="err">${data.detail}</p>`; return; }

  if (!data.arguments.length) {
    body.innerHTML = '<p class="placeholder">No arguments generated for the current evidence.</p>';
  } else {
    body.innerHTML = data.arguments.map(a => `
      <div class="argument-card">
        <div class="argument-label">Potential Argument</div>
        <div class="argument-text">${escapeHtml(a.argument)}</div>
        <div class="evidence-chips">${(a.supporting_evidence || []).map(e => `<span class="evidence-chip">${escapeHtml(e)}</span>`).join("")}</div>
        <div class="counter-label">Potential Counterargument</div>
        <div class="argument-text">${escapeHtml(a.counterargument)}</div>
        ${(a.related_precedent_ids || []).length ? `<div class="evidence-chips">${a.related_precedent_ids.map(p => `<span class="evidence-chip">${escapeHtml(p)}</span>`).join("")}</div>` : ""}
      </div>
    `).join("");
  }
  loadedTabs.add("arguments");
}

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

document.getElementById("chat-modes").addEventListener("click", e => {
  const btn = e.target.closest(".mode-btn");
  if (!btn) return;
  document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  chatMode = btn.dataset.mode;
});

const chatWindow = document.getElementById("chat-window");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");

chatForm.addEventListener("submit", async e => {
  e.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;
  appendChat("user", message);
  chatInput.value = "";
  const thinking = appendChat("assistant", "…thinking…");
  const lang = document.getElementById("chat-lang").value;
  try {
    const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, mode: chatMode, lang }),
    });
    const data = await res.json();
    thinking.textContent = res.ok ? data.answer : (data.detail || "Something went wrong.");
  } catch {
    thinking.textContent = "Could not reach the server.";
  }
});

function appendChat(role, text) {
  const el = document.createElement("div");
  el.className = `chat-msg ${role}`;
  el.textContent = text;
  chatWindow.appendChild(el);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return el;
}

// voice input (Web Speech API - Chrome/Edge only, gracefully degrades elsewhere)
const micBtn = document.getElementById("mic-btn");
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  const recognizer = new SpeechRecognition();
  recognizer.continuous = false;
  recognizer.interimResults = false;
  micBtn.addEventListener("mousedown", () => {
    recognizer.lang = document.getElementById("chat-lang").value === "hi" ? "hi-IN" : "en-IN";
    micBtn.classList.add("recording");
    try { recognizer.start(); } catch {}
  });
  const stop = () => { micBtn.classList.remove("recording"); try { recognizer.stop(); } catch {} };
  micBtn.addEventListener("mouseup", stop);
  micBtn.addEventListener("mouseleave", stop);
  recognizer.addEventListener("result", e => {
    chatInput.value = e.results[0][0].transcript;
  });
} else {
  micBtn.title = "Voice input not supported in this browser";
  micBtn.addEventListener("click", () => alert("Voice input isn't supported in this browser — try Chrome or Edge."));
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const reportBody = document.getElementById("report-body");
const generateBtn = document.getElementById("generate-report-btn");
const downloadBtn = document.getElementById("download-report-btn");
let lastReport = "";

generateBtn.addEventListener("click", async () => {
  const docs = await (await apiFetch(`/cases/${CURRENT_CASE_ID}/documents`)).json();
  if (docs.length === 0) { reportBody.innerHTML = '<p class="placeholder">Upload documents first.</p>'; return; }
  reportBody.innerHTML = '<p class="placeholder">Assembling structured case report…</p>';
  generateBtn.disabled = true;
  try {
    const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/report`);
    const text = await res.text();
    if (!res.ok) { reportBody.innerHTML = `<p class="err">${text}</p>`; return; }
    lastReport = text;
    reportBody.innerHTML = markdownToHtml(text);
    downloadBtn.disabled = false;
  } finally {
    generateBtn.disabled = false;
  }
});

downloadBtn.addEventListener("click", () => {
  const blob = new Blob([lastReport], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${CURRENT_CASE_ID}-report.md`;
  a.click();
  URL.revokeObjectURL(url);
});

function markdownToHtml(md) {
  const lines = md.split("\n");
  let html = "", inList = false;
  for (let line of lines) {
    line = line.trim();
    if (!line) { if (inList) { html += "</ul>"; inList = false; } continue; }
    if (line.startsWith("### ")) { html += `<h3>${inline(line.slice(4))}</h3>`; continue; }
    if (line.startsWith("## ")) { html += `<h2>${inline(line.slice(3))}</h2>`; continue; }
    if (line.startsWith("# ")) { html += `<h1>${inline(line.slice(2))}</h1>`; continue; }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inline(line.slice(2))}</li>`;
      continue;
    }
    if (inList) { html += "</ul>"; inList = false; }
    html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += "</ul>";
  return html;
}

function inline(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`(.+?)`/g, "<code>$1</code>");
}

// ---------------------------------------------------------------------------
// audit trail
// ---------------------------------------------------------------------------

async function loadAudit() {
  const body = document.getElementById("audit-body");
  const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/audit-log`);
  const data = await res.json();
  if (!data.log.length) { body.innerHTML = '<p class="placeholder">No activity yet.</p>'; return; }
  body.innerHTML = `
    <table class="audit-table">
      <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Detail</th></tr></thead>
      <tbody>
        ${data.log.map(a => `
          <tr>
            <td class="time">${fmtTime(a.ts)}</td>
            <td class="user">${escapeHtml(a.user)}</td>
            <td class="action">${escapeHtml(a.action)}</td>
            <td>${escapeHtml(a.detail)}</td>
          </tr>`).join("")}
      </tbody>
    </table>
  `;
  loadedTabs.add("audit");
}

// ---------------------------------------------------------------------------
// demo credential quick-fill
// ---------------------------------------------------------------------------

const demoTable = document.getElementById("demo-creds-table");
if (demoTable) {
  demoTable.addEventListener("click", e => {
    const row = e.target.closest("tr[data-user]");
    if (!row) return;
    document.getElementById("login-username").value = row.dataset.user;
    document.getElementById("login-password").value = row.dataset.pass;
  });
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

if (TOKEN) {
  enterApp();
} else {
  showView("login");
}

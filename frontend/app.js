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
  window.scrollTo({ top: 0, behavior: "auto" });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// toasts
// ---------------------------------------------------------------------------

let toastStack = document.querySelector(".toast-stack");
if (!toastStack) {
  toastStack = document.createElement("div");
  toastStack.className = "toast-stack";
  document.body.appendChild(toastStack);
}

function showToast(message, type = "info", timeoutMs = 4000) {
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  toastStack.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast-leaving");
    setTimeout(() => el.remove(), 200);
  }, timeoutMs);
}

// Render's free tier sleeps after 15 min idle; the first request after that
// can take 30-60s to wake up and may bounce with a 502/503/504 (or just
// fail to connect) before the app is actually ready. Previously ANY failure
// here — including that wake-up blip — was treated as "your session is
// invalid" and silently logged the user out, which is what made the app
// feel like it kept kicking back to the login screen. Only a genuine 401
// from the server (bad/expired token) should ever log the user out; a cold
// server gets retried instead.
async function apiFetch(path, options = {}) {
  const headers = options.headers || {};
  if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
  const method = (options.method || "GET").toUpperCase();
  const maxRetries = method === "GET" ? 4 : 1; // idempotent reads retry harder
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetch(`${API}${path}`, { ...options, headers });
    } catch (networkErr) {
      lastErr = networkErr;
      if (attempt < maxRetries) { await sleep(1200 * (attempt + 1)); continue; }
      throw new Error("SERVER_UNREACHABLE");
    }

    if (res.status === 401) {
      logout();
      throw new Error("SESSION_EXPIRED");
    }
    if ([502, 503, 504].includes(res.status) && attempt < maxRetries) {
      lastErr = new Error(`HTTP ${res.status}`);
      await sleep(1200 * (attempt + 1));
      continue;
    }
    return res;
  }
  throw new Error("SERVER_UNREACHABLE");
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
// landing
// ---------------------------------------------------------------------------

document.getElementById("landing-nav-signin").addEventListener("click", () => showView("login"));
document.getElementById("landing-get-started").addEventListener("click", () => showView("login"));
document.getElementById("landing-cta-signin").addEventListener("click", () => showView("login"));
document.getElementById("login-back").addEventListener("click", () => showView("landing"));

document.querySelectorAll(".demo-cred-row").forEach(row => {
  row.addEventListener("click", () => {
    document.getElementById("login-username").value = row.dataset.user;
    document.getElementById("login-password").value = row.dataset.pass;
    document.getElementById("login-error").textContent = "";
  });
});

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

document.getElementById("login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("login-error");
  const submitBtn = document.querySelector("#login-form button[type='submit']");
  errEl.textContent = "";
  submitBtn.disabled = true;

  const maxAttempts = 6; // covers Render's ~30-60s cold-start window
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if ([502, 503, 504].includes(res.status) && attempt < maxAttempts) {
        errEl.textContent = `Server is waking up (Render free tier)… retrying (${attempt}/${maxAttempts})`;
        await sleep(1500 * attempt);
        continue;
      }

      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.detail || "Login failed."; break; }
      TOKEN = data.token;
      localStorage.setItem("case_ai_token", TOKEN);
      ME = { username: data.username, role: data.role, name: data.display_name };
      errEl.textContent = "";
      enterApp();
      break;
    } catch {
      if (attempt < maxAttempts) {
        errEl.textContent = `Server is waking up (Render free tier)… retrying (${attempt}/${maxAttempts})`;
        await sleep(1500 * attempt);
        continue;
      }
      errEl.textContent = "Could not reach the server after several tries. Check your connection, or the Render service may be down — try again shortly.";
    }
  }
  submitBtn.disabled = false;
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
  const errEl = document.getElementById("login-error");
  try {
    const res = await apiFetch("/auth/me");
    if (!res.ok) { logout(); return; }
    ME = await res.json();
  } catch (err) {
    // apiFetch already called logout() itself for a real 401 (SESSION_EXPIRED).
    // For anything else (server still waking up / unreachable), stay put and
    // tell the user what's actually happening instead of silently dumping
    // them back to a blank login form.
    if (err.message !== "SESSION_EXPIRED" && errEl) {
      errEl.textContent = "Server is waking up (Render free tier can take up to a minute after being idle). Please try signing in again.";
    }
    return;
  }
  document.getElementById("whoami").textContent = `${ME.name} · ${ME.role}`;
  document.getElementById("whoami-workspace").textContent = `${ME.name} · ${ME.role}`;
  showView("cases");
  loadCases();
}

// ---------------------------------------------------------------------------
// my cases
// ---------------------------------------------------------------------------

let ALL_CASES = [];

async function loadCases() {
  const grid = document.getElementById("case-grid");
  grid.innerHTML = Array.from({ length: 3 }, () => '<div class="case-tile-skeleton"></div>').join("");
  let cases;
  try {
    const res = await apiFetch("/cases");
    cases = await res.json();
  } catch (err) {
    grid.innerHTML = "";
    renderEmptyState(grid, "icon-alert", "Couldn't load cases",
      err.message === "SERVER_UNREACHABLE" ? "The server may still be waking up — try again in a moment." : "Something went wrong loading your cases.");
    return;
  }
  ALL_CASES = cases;
  renderCaseGrid(cases);
}

function renderCaseGrid(cases) {
  const grid = document.getElementById("case-grid");
  grid.innerHTML = "";
  if (cases.length === 0) {
    const isFiltered = document.getElementById("case-search").value.trim().length > 0;
    renderEmptyState(grid, isFiltered ? "icon-list" : "icon-folder",
      isFiltered ? "No matching cases" : "No investigations yet",
      isFiltered ? "Try a different search term." : "Create your first case to start uploading documents.");
    return;
  }
  cases.forEach(c => grid.appendChild(caseTile(c)));
}

function renderEmptyState(container, icon, title, sub) {
  container.innerHTML = `
    <div class="empty-state" style="grid-column:1/-1">
      <svg viewBox="0 0 24 24"><use href="#${icon}"/></svg>
      <div class="empty-state-title">${escapeHtml(title)}</div>
      <div class="empty-state-sub">${escapeHtml(sub)}</div>
    </div>`;
}

document.getElementById("case-search").addEventListener("input", debounce(e => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) { renderCaseGrid(ALL_CASES); return; }
  const filtered = ALL_CASES.filter(c =>
    (c.title || "").toLowerCase().includes(q) ||
    (c.id || "").toLowerCase().includes(q) ||
    (c.investigating_officer || "").toLowerCase().includes(q) ||
    (c.case_type || "").toLowerCase().includes(q)
  );
  renderCaseGrid(filtered);
}, 200));

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

// Close modals on backdrop click or Escape — applies to every .modal-backdrop in the app.
document.querySelectorAll(".modal-backdrop").forEach(backdrop => {
  backdrop.addEventListener("click", e => { if (e.target === backdrop) backdrop.classList.remove("active"); });
});
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  document.querySelectorAll(".modal-backdrop.active").forEach(m => m.classList.remove("active"));
});

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
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = "Creating…";
  let res, data;
  try {
    res = await apiFetch("/cases", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    data = await res.json();
  } catch (err) {
    showToast(err.message === "SERVER_UNREACHABLE" ? "Could not reach the server — try again in a moment." : "Something went wrong. Please try again.", "error");
    submitBtn.disabled = false; submitBtn.textContent = "Create Case";
    return;
  }
  if (!res.ok) {
    showToast(data.detail || "Could not create case.", "error");
    submitBtn.disabled = false; submitBtn.textContent = "Create Case";
    return;
  }
  submitBtn.disabled = false; submitBtn.textContent = "Create Case";
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
    window.scrollTo({ top: 0, behavior: "auto" });
    onTabShown(tab.dataset.tab);
  });
});

function onTabShown(name) {
  if (name === "dashboard") return loadDashboard();
  if (name === "intelligence") return onIntelSubtabShown(currentIntelSubtab);
  if (loadedTabs.has(name)) return;
  if (name === "timeline") loadTimeline();
  if (name === "graph") loadGraph();
  if (name === "similar") loadSimilar();
  if (name === "audit") loadAudit();
}

document.querySelectorAll(".quick-action").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelector(`.tab[data-tab="${btn.dataset.goto}"]`)?.click();
  });
});

// ---------------------------------------------------------------------------
// case intelligence (merged: summary, contradictions, arguments, chat)
// ---------------------------------------------------------------------------

let currentIntelSubtab = "summary";
const intelSubtabs = document.querySelectorAll(".subtab-btn");
const intelSubpanels = document.querySelectorAll(".intel-subpanel");

intelSubtabs.forEach(btn => {
  btn.addEventListener("click", () => {
    intelSubtabs.forEach(b => b.classList.remove("active"));
    intelSubpanels.forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`intel-${btn.dataset.subtab}`).classList.add("active");
    currentIntelSubtab = btn.dataset.subtab;
    onIntelSubtabShown(currentIntelSubtab);
  });
});

function onIntelSubtabShown(name) {
  if (loadedTabs.has(`intel-${name}`)) return;
  if (name === "summary") loadSummary();
  if (name === "contradictions") loadContradictions();
  if (name === "arguments") loadArguments();
  // "chat" needs no preload — the chat window loads its own history lazily.
}
async function openCase(caseId) {
  CURRENT_CASE_ID = caseId;
  loadedTabs.clear();
  document.getElementById("case-id").textContent = caseId;
  tabs.forEach(t => t.classList.remove("active"));
  panels.forEach(p => p.classList.remove("active"));
  document.querySelector('.tab[data-tab="dashboard"]').classList.add("active");
  document.getElementById("panel-dashboard").classList.add("active");
  intelSubtabs.forEach(b => b.classList.remove("active"));
  intelSubpanels.forEach(p => p.classList.remove("active"));
  document.querySelector('.subtab-btn[data-subtab="summary"]').classList.add("active");
  document.getElementById("intel-summary").classList.add("active");
  currentIntelSubtab = "summary";
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
    ["Documents", data.document_count, "icon-folder", "gold"], ["Persons", data.person_count, "icon-person", "info"],
    ["Events", data.event_count, "icon-calendar", "ok"], ["Contradictions", data.contradiction_count, "icon-alert", "rose"],
    ["Evidence Links", data.evidence_link_count, "icon-link", "gold-dim"],
  ].map(([label, num, icon, tone]) => `<div class="stat-tile tone-${tone}"><svg class="stat-icon"><use href="#${icon}"/></svg><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>`).join("");
  const activity = document.getElementById("dash-activity");
  if (!data.recent_activity.length) {
    renderEmptyState(activity, "icon-list", "No activity yet", "Upload a document or run an analysis to start the audit trail.");
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
    uploadStatus.innerHTML = `<span class="loading-line"><span class="spinner"></span>Uploading ${escapeHtml(file.name)} …</span>`;
    pipelineEl.innerHTML = "";
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/documents`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Upload failed");
      uploadStatus.textContent = `${file.name} processed.`;
      pipelineEl.innerHTML = data.processing_steps.map(s => `<div class="step-done">${PIPELINE_LABELS[s] || s}</div>`).join("");
      showToast(`${file.name} uploaded and processed.`, "success");
      invalidateCase();
      await refreshDocuments();
      await loadDashboard();
    } catch (err) {
      const msg = err.message === "SERVER_UNREACHABLE" ? "Could not reach the server." : err.message;
      uploadStatus.innerHTML = `<span class="err">${escapeHtml(file.name)}: ${escapeHtml(msg)}</span>`;
      showToast(`Failed to upload ${file.name}.`, "error");
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
  if (docs.length === 0) {
    const isFiltered = q || (filter && filter !== "All");
    renderEmptyState(docList, isFiltered ? "icon-folder" : "icon-upload",
      isFiltered ? "No matching documents" : "No documents yet",
      isFiltered ? "Try a different search term or filter." : "Drop a file above or click the upload area to add the first document.");
  } else {
    docs.forEach((doc, i) => docList.appendChild(exhibitCard(doc, i + 1)));
  }

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
  const ext = (doc.filename.split(".").pop() || "").toLowerCase();
  el.innerHTML = `
    <div class="exhibit-tag">EXHIBIT ${String(index).padStart(3, "0")}</div>
    <span class="file-badge file-badge-${ext}">${escapeHtml(ext || "file")}</span>
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
    if (!res.ok) { const d = await res.json(); showToast(d.detail || "Could not remove document.", "error"); return; }
    showToast(`${doc.filename} removed.`, "success");
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
  body.innerHTML = '<p class="loading-line"><span class="spinner"></span>Synthesizing case summary…</p>';
  const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/summary`);
  const data = await res.json();
  if (!res.ok) { body.innerHTML = `<p class="err">${data.detail}</p>`; return; }
  body.innerHTML = data.summary.split("\n\n").map(p => `<p>${escapeHtml(p)}</p>`).join("");
  loadedTabs.add("intel-summary");
}

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

let TIMELINE_DATA = null;
let tlView = "cards";
let tlVisibleCount = 8;
const TL_PAGE_SIZE = 8;

// Lightweight keyword heuristic — no event "type" comes back from the API,
// so we infer one from the description to give each entry a distinct badge.
const TL_TYPES = [
  { key: "communication", label: "Communication", icon: "icon-mail", cls: "tl-badge-info", test: /\bemail(ed)?|mail(ed)?|repl(y|ied)|wrote|message(d)?|call(ed)?\b/i },
  { key: "logistics", label: "Logistics", icon: "icon-truck", cls: "tl-badge-thread", test: /\bdeliver(y|ed)?|shipment|warehouse|goods|dispatch(ed)?\b/i },
  { key: "financial", label: "Financial / vendor", icon: "icon-bank", cls: "tl-badge-ok", test: /\bvendor|approved|invoice|payment|account|bank|audit\b/i },
  { key: "employment", label: "Employment", icon: "icon-briefcase", cls: "tl-badge-teal", test: /\bbegan working|joined|hired|employ(ed|ment)|started at\b/i },
  { key: "meeting", label: "Meeting / statement", icon: "icon-person", cls: "tl-badge-amber", test: /\bmeeting|discussed|statement|interview(ed)?|asked\b/i },
];
function classifyEvent(desc) {
  const hit = TL_TYPES.find(t => t.test.test(desc));
  return hit || { key: "other", label: "Other", icon: "icon-calendar", cls: "tl-badge-teal" };
}

// Parses "2025-10-13" into a stacked date block; falls back to the raw
// string for partial dates like "2022" or "early 2025".
function tlDateParts(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return { year: dateStr, day: null, month: null };
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  return { year: m[1], day: m[2], month: months[parseInt(m[2], 10) - 1] };
}

async function loadTimeline() {
  const body = document.getElementById("timeline-body");
  const docs = await (await apiFetch(`/cases/${CURRENT_CASE_ID}/documents`)).json();
  if (docs.length === 0) return;
  body.innerHTML = '<p class="loading-line"><span class="spinner"></span>Extracting timeline…</p>';
  const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/timeline`);
  const data = await res.json();
  if (!res.ok) { body.innerHTML = `<p class="err">${data.detail}</p>`; return; }

  TIMELINE_DATA = data;
  tlVisibleCount = TL_PAGE_SIZE;
  populateTimelineFilters(data);
  renderTimeline();
  loadedTabs.add("timeline");
}

function populateTimelineFilters(data) {
  const typeSel = document.getElementById("tl-type-filter");
  const timeSel = document.getElementById("tl-time-filter");
  const typesSeen = new Map();
  const yearsSeen = new Set();
  data.events.forEach(ev => {
    const t = classifyEvent(ev.description);
    typesSeen.set(t.key, t.label);
    const y = /^\d{4}/.exec(ev.date);
    if (y) yearsSeen.add(y[0]);
  });
  typeSel.innerHTML = '<option value="all">All events</option>' +
    [...typesSeen.entries()].map(([key, label]) => `<option value="${key}">${escapeHtml(label)}</option>`).join("");
  timeSel.innerHTML = '<option value="all">All time</option>' +
    [...yearsSeen].sort().map(y => `<option value="${y}">${y}</option>`).join("");
}

function renderTimeline() {
  const body = document.getElementById("timeline-body");
  const loadMoreBtn = document.getElementById("tl-load-more");
  const data = TIMELINE_DATA;
  if (!data) return;

  const typeFilter = document.getElementById("tl-type-filter").value;
  const timeFilter = document.getElementById("tl-time-filter").value;

  let events = data.events.filter(ev => {
    const t = classifyEvent(ev.description);
    if (typeFilter !== "all" && t.key !== typeFilter) return false;
    if (timeFilter !== "all" && !ev.date.startsWith(timeFilter)) return false;
    return true;
  });

  let html = "";
  if (events.length) {
    const shown = events.slice(0, tlVisibleCount);
    html += `<div class="tl-list tl-list-${tlView}">`;
    shown.forEach(ev => {
      const t = classifyEvent(ev.description);
      const dp = tlDateParts(ev.date);
      const gap = data.gaps.find(g => g.after === ev.date);

      if (tlView === "list") {
        html += `
          <div class="tl-row" data-doc="${ev.doc_id}">
            <span class="tl-row-badge ${t.cls}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#${t.icon}"/></svg></span>
            <span class="tl-row-date">${escapeHtml(ev.date)}</span>
            <span class="tl-row-desc">${escapeHtml(ev.description)}</span>
            <span class="tl-row-source">${escapeHtml(ev.source)}</span>
          </div>`;
      } else {
        html += `
          <div class="tl-card" data-doc="${ev.doc_id}">
            <div class="tl-badge ${t.cls}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#${t.icon}"/></svg></div>
            <div class="tl-card-body">
              <div class="tl-card-top">
                <div class="tl-dateblock">
                  ${dp.day ? `<span class="tl-year">${dp.year}</span><span class="tl-day">${dp.day}</span><span class="tl-month">${dp.month}</span>` : `<span class="tl-year">${escapeHtml(dp.year)}</span>`}
                </div>
                <div class="tl-card-main">
                  <div class="tl-desc">${escapeHtml(ev.description)}</div>
                  <div class="tl-source"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-folder"/></svg>${escapeHtml(ev.source)}</div>
                </div>
                <span class="evidence-pill"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-check-circle"/></svg>Evidence-backed</span>
              </div>
            </div>
          </div>`;
      }
      if (gap) html += `<div class="gap-marker">Gap of ~${gap.days} days before the next event</div>`;
    });
    html += "</div>";
  } else {
    html += '<p class="placeholder">No dated events match this filter.</p>';
  }
  if (data.undated.length && typeFilter === "all" && timeFilter === "all") {
    html += '<div class="section-label">Undated events</div><ul>';
    data.undated.forEach(ev => { html += `<li>${escapeHtml(ev.description)} <span class="timeline-source">— ${escapeHtml(ev.source)}</span></li>`; });
    html += "</ul>";
  }
  body.innerHTML = html;
  body.querySelectorAll("[data-doc]").forEach(el => el.addEventListener("click", () => openDocModal(el.dataset.doc)));

  loadMoreBtn.style.display = events.length > tlVisibleCount ? "" : "none";
}

function exportTimelineText() {
  if (!TIMELINE_DATA || !TIMELINE_DATA.events.length) { showToast("No timeline to export yet", "info"); return; }
  let out = `Investigation Timeline — Case ${CURRENT_CASE_ID}\n\n`;
  TIMELINE_DATA.events.forEach(ev => { out += `${ev.date}\t${ev.description}\t(${ev.source})\n`; });
  if (TIMELINE_DATA.undated.length) {
    out += `\nUndated events\n`;
    TIMELINE_DATA.undated.forEach(ev => { out += `- ${ev.description} (${ev.source})\n`; });
  }
  const blob = new Blob([out], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${CURRENT_CASE_ID}-timeline.txt`;
  a.click();
}

document.querySelectorAll(".view-toggle-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".view-toggle-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    tlView = btn.dataset.view;
    renderTimeline();
  });
});
document.getElementById("tl-type-filter")?.addEventListener("change", () => { tlVisibleCount = TL_PAGE_SIZE; renderTimeline(); });
document.getElementById("tl-time-filter")?.addEventListener("change", () => { tlVisibleCount = TL_PAGE_SIZE; renderTimeline(); });
document.getElementById("tl-load-more")?.addEventListener("click", () => { tlVisibleCount += TL_PAGE_SIZE; renderTimeline(); });
document.getElementById("export-timeline-btn")?.addEventListener("click", exportTimelineText);

// ---------------------------------------------------------------------------
// graph / connections
// ---------------------------------------------------------------------------

// Muted, desaturated accents so entity types stay distinguishable at a
// glance without fighting the app's otherwise beige/navy/red theme.
const typeColors = { person: "#b8842e", organization: "#3f7a5c", location: "#4a4f8c", other: "#8a7d5e" };
let GRAPH_DATA = null;
let GRAPH_NETWORK = null;
let GRAPH_DOC_MAP = [];       // [{filename, doc_id}]
let graphView = "graph";
let graphSelectedNodeId = null;

// A small white silhouette per entity type, baked onto a colored medallion,
// rendered as a single flat SVG data-URI so vis-network can drop it straight
// in as a node image — a person icon for people, a building for
// organizations, a map pin for locations.
const typeGlyphs = {
  person: '<circle cx="30" cy="23" r="9"/><path d="M12 50c2-11 9-17 18-17s16 6 18 17" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/>',
  organization: '<rect x="16" y="12" width="28" height="34" rx="2"/><rect x="21" y="18" width="5" height="5" fill="TYPECOLOR"/><rect x="30" y="18" width="5" height="5" fill="TYPECOLOR"/><rect x="21" y="27" width="5" height="5" fill="TYPECOLOR"/><rect x="30" y="27" width="5" height="5" fill="TYPECOLOR"/><rect x="26" y="38" width="8" height="8" fill="TYPECOLOR"/>',
  location: '<path d="M30 12c-7.7 0-14 6.1-14 13.6C16 35.5 30 50 30 50s14-14.5 14-24.4C44 18.1 37.7 12 30 12z"/><circle cx="30" cy="25" r="5.5" fill="TYPECOLOR"/>',
  other: '<circle cx="30" cy="30" r="8"/><circle cx="30" cy="14" r="3.2"/><circle cx="30" cy="46" r="3.2"/><circle cx="14" cy="30" r="3.2"/><circle cx="46" cy="30" r="3.2"/>',
};
function nodeIcon(type) {
  const color = typeColors[type] || typeColors.other;
  const glyph = (typeGlyphs[type] || typeGlyphs.other).replaceAll("TYPECOLOR", color);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><circle cx="30" cy="30" r="28" fill="${color}" stroke="#2a2313" stroke-width="2"/><g fill="#fffcf2">${glyph}</g></svg>`;
  return "data:image/svg+xml;base64," + btoa(svg);
}

// Relationship-category heuristic (edges only carry a free-text "relation"
// phrase, no category) — buckets it for coloring, the legend, and the filter.
const REL_CATEGORIES = [
  { key: "employment", label: "Employment", color: "#3f6b4a", test: /work(s|ed)? at|employ(ee|ed|ment)|joined|hired/i },
  { key: "business", label: "Business", color: "#2b4864", test: /vendor|client|supplier|contract|business|partner|associated with/i },
  { key: "communication", label: "Communication", color: "#a1402f", test: /email|call|repl(y|ied)|request(ed)?|communicat(ed|ion)|shared info|ask(ed)?|wrote|message/i },
  { key: "consultation", label: "Consultation", color: "#5c5490", test: /consult/i },
];
function relCategory(relation) {
  const hit = REL_CATEGORIES.find(c => c.test.test(relation || ""));
  return hit || { key: "other", label: "Other", color: "#9c9070" };
}

async function loadGraph() {
  const canvas = document.getElementById("graph-canvas");
  const docs = await (await apiFetch(`/cases/${CURRENT_CASE_ID}/documents`)).json();
  if (docs.length === 0) return;
  GRAPH_DOC_MAP = docs.map(d => ({ filename: d.filename, doc_id: d.id }));
  canvas.innerHTML = '<p class="loading-line" style="padding:20px"><span class="spinner"></span>Mapping connections…</p>';
  const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/graph`);
  const data = await res.json();
  if (!res.ok) { canvas.innerHTML = `<p class="err">${data.detail}</p>`; return; }

  GRAPH_DATA = data;
  populateGraphFilters(data);
  renderRelLegend();
  renderEntityLegend();
  renderGraph();
  loadedTabs.add("graph");
}

function renderEntityLegend() {
  document.getElementById("graph-legend").innerHTML =
    '<span class="legend-title">Entities</span>' +
    Object.entries(typeColors).map(([type, color]) => `<span><img class="legend-icon" src="${nodeIcon(type)}" alt=""/>${type}</span>`).join("") +
    `<span><span class="legend-dot" style="background:transparent;box-shadow:0 0 0 1px var(--text-faint)"></span>unconnected</span>`;
}
function renderRelLegend() {
  document.getElementById("graph-rel-legend").innerHTML =
    '<span class="legend-title">Relationships</span>' +
    REL_CATEGORIES.concat([{ key: "other", label: "Other", color: "#9c9070" }])
      .map(c => `<span><span class="legend-dot" style="background:${c.color}"></span>${c.label}</span>`).join("");
}

function populateGraphFilters(data) {
  const entitySel = document.getElementById("graph-entity-filter");
  const relSel = document.getElementById("graph-rel-filter");
  const types = [...new Set(data.nodes.map(n => n.type || "other"))];
  entitySel.innerHTML = '<option value="all">All entities</option>' +
    types.map(t => `<option value="${t}">${t[0].toUpperCase()}${t.slice(1)}</option>`).join("");
  const catsSeen = new Map();
  data.edges.forEach(e => { const c = relCategory(e.relation); catsSeen.set(c.key, c.label); });
  relSel.innerHTML = '<option value="all">All relationship types</option>' +
    [...catsSeen.entries()].map(([key, label]) => `<option value="${key}">${escapeHtml(label)}</option>`).join("");
}

// Best-effort match of an edge's free-text evidence string against known
// filenames, so it can be made clickable like the timeline's sourced events.
function findEvidenceDoc(evidenceText) {
  if (!evidenceText) return null;
  return GRAPH_DOC_MAP.find(d => evidenceText.includes(d.filename));
}

function evidenceHtml(evidenceText) {
  const doc = findEvidenceDoc(evidenceText);
  const label = escapeHtml(evidenceText || "—");
  return doc ? `<span class="tl-source-link" data-doc="${doc.doc_id}">${label}</span>` : label;
}

function renderGraph() {
  const canvas = document.getElementById("graph-canvas");
  const data = GRAPH_DATA;
  if (!data) return;

  const showIsolated = document.getElementById("graph-show-isolated").checked;
  const entityFilter = document.getElementById("graph-entity-filter").value;
  const relFilter = document.getElementById("graph-rel-filter").value;

  const filteredEdges = data.edges.filter(e => relFilter === "all" || relCategory(e.relation).key === relFilter);
  const connectedIds = new Set();
  filteredEdges.forEach(e => { connectedIds.add(e.source); connectedIds.add(e.target); });

  let visibleNodes = data.nodes.filter(n => entityFilter === "all" || (n.type || "other") === entityFilter);
  visibleNodes = showIsolated ? visibleNodes : visibleNodes.filter(n => connectedIds.has(n.id));
  const visibleIds = new Set(visibleNodes.map(n => n.id));
  const visibleEdges = filteredEdges.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target));

  if (graphView === "table") {
    renderGraphTable(visibleEdges);
    return;
  }

  canvas.innerHTML = "";
  if (visibleNodes.length === 0) {
    canvas.innerHTML = '<p class="placeholder" style="padding:20px">No connections match these filters — try "Show unconnected entities" or a broader filter.</p>';
    return;
  }

  const nodes = new vis.DataSet(visibleNodes.map(n => ({
    id: n.id, label: n.label, entityType: n.type,
    shape: "image", image: nodeIcon(n.type), size: 26,
    font: { color: "#fdf9ee", face: "Inter", size: 13, weight: 700, strokeWidth: 4, strokeColor: "#2a2313", vadjust: -30 },
  })));
  const edges = new vis.DataSet(visibleEdges.map((e, i) => {
    const cat = relCategory(e.relation);
    return {
      id: i, from: e.source, to: e.target, label: e.relation, title: e.relation,
      relation: e.relation, evidence: e.evidence, category: cat.label,
      color: { color: cat.color, highlight: "#2a2313", hover: cat.color },
      opacity: 0.8, width: 2, arrows: "to", smooth: { type: "continuous", roundness: 0.35 },
      font: { size: 10, color: "#2a2313", strokeWidth: 4, strokeColor: "#fffcf2", align: "middle" },
      shadow: { enabled: true, color: "rgba(20,15,5,0.3)", size: 3, x: 1, y: 1 },
    };
  }));

  const network = new vis.Network(canvas, { nodes, edges }, {
    physics: {
      solver: "forceAtlas2Based",
      forceAtlas2Based: { springLength: 190, avoidOverlap: 0.8, gravitationalConstant: -60 },
      stabilization: { iterations: 150 },
    },
    interaction: { hover: true, tooltipDelay: 120 },
  });
  GRAPH_NETWORK = network;
  network.once("stabilizationIterationsDone", () => network.fit({ animation: { duration: 400 } }));

  network.on("click", params => {
    if (params.nodes.length) {
      selectGraphNode(params.nodes[0]);
    } else if (params.edges.length) {
      const edge = edges.get(params.edges[0]);
      showEdgeDetail(edge);
    } else {
      graphSelectedNodeId = null;
      clearGraphSidePanel();
    }
  });

  if (graphSelectedNodeId && visibleIds.has(graphSelectedNodeId)) {
    selectGraphNode(graphSelectedNodeId);
  }
}

function clearGraphSidePanel() {
  document.getElementById("graph-side-panel").innerHTML =
    '<p class="placeholder">Click an entity in the graph to see its details, relationships and related evidence.</p>';
}

function showEdgeDetail(edge) {
  document.getElementById("graph-side-panel").innerHTML = `
    <div class="gsp-header"><span class="gsp-rel-dot" style="background:${escapeHtml(REL_CATEGORIES.find(c => c.label === edge.category)?.color || "#9c9070")}"></span>
      <div><div class="gsp-name">${escapeHtml(edge.relation || "Relationship")}</div><div class="gsp-type">${escapeHtml(edge.category)}</div></div>
    </div>
    <div class="gsp-section"><div class="gsp-label">Evidence</div><p class="gsp-about">${evidenceHtml(edge.evidence)}</p></div>`;
  document.getElementById("graph-side-panel").querySelectorAll("[data-doc]").forEach(el =>
    el.addEventListener("click", () => openDocModal(el.dataset.doc)));
}

function selectGraphNode(nodeId) {
  graphSelectedNodeId = nodeId;
  const data = GRAPH_DATA;
  const node = data.nodes.find(n => n.id === nodeId);
  if (!node) return;
  if (GRAPH_NETWORK) { GRAPH_NETWORK.selectNodes([nodeId]); }

  const touching = data.edges.filter(e => e.source === nodeId || e.target === nodeId);
  const relRows = touching.map(e => {
    const outgoing = e.source === nodeId;
    const otherId = outgoing ? e.target : e.source;
    const other = data.nodes.find(n => n.id === otherId);
    const cat = relCategory(e.relation);
    return `<li data-jump="${otherId}"><span class="gsp-rel-dot" style="background:${cat.color}"></span><span class="gsp-rel-verb">${escapeHtml(e.relation)}</span><span class="gsp-rel-arrow">→</span><span class="gsp-rel-target">${escapeHtml(other ? other.label : otherId)}</span></li>`;
  }).join("");

  const evidenceSet = new Map();
  touching.forEach(e => { if (e.evidence) evidenceSet.set(e.evidence, e.evidence); });
  const evidenceRows = [...evidenceSet.values()].map(ev => `<li>${evidenceHtml(ev)}</li>`).join("");

  const about = touching.length
    ? `${escapeHtml(touching[0].relation)} ${escapeHtml((data.nodes.find(n => n.id === (touching[0].source === nodeId ? touching[0].target : touching[0].source)) || {}).label || "")}`.trim()
    : "No relationships recorded for this entity yet.";

  document.getElementById("graph-side-panel").innerHTML = `
    <div class="gsp-header"><img class="gsp-icon" src="${nodeIcon(node.type)}" alt=""/>
      <div><div class="gsp-name">${escapeHtml(node.label)}</div><div class="gsp-type">${escapeHtml(node.type || "other")}</div></div>
    </div>
    <div class="gsp-section"><div class="gsp-label">About</div><p class="gsp-about">${about}</p></div>
    <div class="gsp-section"><div class="gsp-label">Key relationships (${touching.length})</div><ul class="gsp-rel-list">${relRows || '<li class="placeholder">None yet</li>'}</ul></div>
    <div class="gsp-section"><div class="gsp-label">Related evidence (${evidenceSet.size})</div><ul class="gsp-evidence-list">${evidenceRows || '<li class="placeholder">None yet</li>'}</ul></div>`;

  const panel = document.getElementById("graph-side-panel");
  panel.querySelectorAll("[data-jump]").forEach(el => el.addEventListener("click", () => selectGraphNode(el.dataset.jump)));
  panel.querySelectorAll("[data-doc]").forEach(el => el.addEventListener("click", () => openDocModal(el.dataset.doc)));
}

function renderGraphTable(edges) {
  const wrap = document.getElementById("graph-table-view");
  if (!edges.length) { wrap.innerHTML = '<p class="placeholder" style="padding:20px">No connections match these filters.</p>'; return; }
  const data = GRAPH_DATA;
  const nodeLabel = id => (data.nodes.find(n => n.id === id) || {}).label || id;
  wrap.innerHTML = `
    <table class="audit-table">
      <thead><tr><th>Entity A</th><th>Relationship</th><th>Entity B</th><th>Category</th><th>Evidence</th></tr></thead>
      <tbody>
        ${edges.map(e => {
          const cat = relCategory(e.relation);
          return `<tr>
            <td>${escapeHtml(nodeLabel(e.source))}</td>
            <td class="action">${escapeHtml(e.relation)}</td>
            <td>${escapeHtml(nodeLabel(e.target))}</td>
            <td><span class="legend-dot" style="background:${cat.color}"></span>${escapeHtml(cat.label)}</td>
            <td class="time">${evidenceHtml(e.evidence)}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;
  wrap.querySelectorAll("[data-doc]").forEach(el => el.addEventListener("click", () => openDocModal(el.dataset.doc)));
}

function exportGraphText() {
  if (!GRAPH_DATA || !GRAPH_DATA.nodes.length) { showToast("No connections to export yet", "info"); return; }
  let out = `Connections — Case ${CURRENT_CASE_ID}\n\nEntities\n`;
  GRAPH_DATA.nodes.forEach(n => { out += `- ${n.label} (${n.type || "other"})\n`; });
  out += `\nRelationships\n`;
  const nodeLabel = id => (GRAPH_DATA.nodes.find(n => n.id === id) || {}).label || id;
  GRAPH_DATA.edges.forEach(e => { out += `${nodeLabel(e.source)} — ${e.relation} — ${nodeLabel(e.target)} (${e.evidence || "—"})\n`; });
  const blob = new Blob([out], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${CURRENT_CASE_ID}-connections.txt`;
  a.click();
}

document.getElementById("graph-show-isolated").addEventListener("change", () => { if (GRAPH_DATA) renderGraph(); });
document.getElementById("graph-entity-filter").addEventListener("change", () => { if (GRAPH_DATA) renderGraph(); });
document.getElementById("graph-rel-filter").addEventListener("change", () => { if (GRAPH_DATA) renderGraph(); });
document.getElementById("export-graph-btn").addEventListener("click", exportGraphText);
document.getElementById("graph-zoom-in").addEventListener("click", () => { if (GRAPH_NETWORK) GRAPH_NETWORK.moveTo({ scale: GRAPH_NETWORK.getScale() * 1.25 }); });
document.getElementById("graph-zoom-out").addEventListener("click", () => { if (GRAPH_NETWORK) GRAPH_NETWORK.moveTo({ scale: GRAPH_NETWORK.getScale() / 1.25 }); });
document.getElementById("graph-fit").addEventListener("click", () => { if (GRAPH_NETWORK) GRAPH_NETWORK.fit({ animation: { duration: 300 } }); });
document.getElementById("graph-reset").addEventListener("click", () => renderGraph());
document.querySelectorAll("[data-graphview]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-graphview]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    graphView = btn.dataset.graphview;
    document.getElementById("graph-canvas").style.display = graphView === "graph" ? "" : "none";
    document.getElementById("graph-table-view").style.display = graphView === "table" ? "" : "none";
    document.querySelector(".graph-zoom-controls").style.display = graphView === "graph" ? "" : "none";
    if (GRAPH_DATA) renderGraph();
  });
});

// ---------------------------------------------------------------------------
// contradictions
// ---------------------------------------------------------------------------

async function loadContradictions() {
  const body = document.getElementById("contradiction-body");
  const docs = await (await apiFetch(`/cases/${CURRENT_CASE_ID}/documents`)).json();
  if (docs.length === 0) return;
  body.innerHTML = '<p class="loading-line"><span class="spinner"></span>Comparing evidence across documents…</p>';
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
  loadedTabs.add("intel-contradictions");
}

// ---------------------------------------------------------------------------
// similar cases
// ---------------------------------------------------------------------------

async function loadSimilar() {
  const body = document.getElementById("similar-body");
  const docs = await (await apiFetch(`/cases/${CURRENT_CASE_ID}/documents`)).json();
  if (docs.length === 0) return;
  body.innerHTML = '<p class="loading-line"><span class="spinner"></span>Comparing against the case library…</p>';
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
  body.innerHTML = '<p class="loading-line"><span class="spinner"></span>Analyzing evidence for potential arguments…</p>';
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
  loadedTabs.add("intel-arguments");
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
  const thinking = appendChat("assistant", null, true);
  const lang = document.getElementById("chat-lang").value;
  try {
    const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, mode: chatMode, lang }),
    });
    const data = await res.json();
    setChatBubbleText(thinking, res.ok ? data.answer : (data.detail || "Something went wrong."));
  } catch {
    setChatBubbleText(thinking, "Could not reach the server — it may be waking up, please try again.");
  }
});

function appendChat(role, text, thinking = false) {
  const el = document.createElement("div");
  el.className = `chat-msg ${role}`;
  const label = role === "user" ? "You" : "Case AI";
  el.innerHTML = `
    <div class="chat-msg-head"><span class="chat-msg-role">${label}</span><span class="chat-msg-time">${fmtTime(new Date().toISOString())}</span></div>
    <div class="chat-msg-body">${thinking ? '<span class="typing-dots"><span></span><span></span><span></span></span>' : escapeHtml(text)}</div>
  `;
  chatWindow.appendChild(el);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return el;
}

function setChatBubbleText(el, text) {
  el.querySelector(".chat-msg-body").textContent = text;
  chatWindow.scrollTop = chatWindow.scrollHeight;
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
  micBtn.addEventListener("click", () => showToast("Voice input isn't supported in this browser — try Chrome or Edge.", "error"));
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
  if (docs.length === 0) {
    renderEmptyState(reportBody, "icon-doc-check", "No documents yet", "Upload case documents in the Document Vault before generating a report.");
    return;
  }
  reportBody.innerHTML = '<p class="loading-line"><span class="spinner"></span>Assembling structured case report…</p>';
  generateBtn.disabled = true;
  const originalLabel = generateBtn.textContent;
  generateBtn.textContent = "Generating…";
  try {
    const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/report`);
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try { message = JSON.parse(text).detail || text; } catch { /* not JSON, use raw text */ }
      reportBody.innerHTML = `<p class="err">${escapeHtml(message)}</p>`;
      showToast("Could not generate the report.", "error");
      return;
    }
    lastReport = text;
    reportBody.innerHTML = markdownToHtml(text);
    downloadBtn.disabled = false;
    showToast("Case report generated.", "success");
  } catch (err) {
    reportBody.innerHTML = `<p class="err">${err.message === "SERVER_UNREACHABLE" ? "Could not reach the server." : "Something went wrong."}</p>`;
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = originalLabel;
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
  if (!data.log.length) { renderEmptyState(body, "icon-list", "No activity yet", "Every upload, deletion and analysis on this case will show up here."); return; }
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
// init
// ---------------------------------------------------------------------------

if (TOKEN) {
  enterApp();
} else {
  showView("landing");
}

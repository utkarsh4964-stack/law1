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
  document.getElementById("whoami-workspace").textContent = ME.name;
  const roleEl = document.getElementById("whoami-role-workspace");
  if (roleEl) roleEl.textContent = ME.role;
  const avatarEl = document.getElementById("whoami-avatar");
  if (avatarEl) avatarEl.textContent = (ME.name || "?").trim().charAt(0).toUpperCase();
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

document.getElementById("demo-case-btn").addEventListener("click", async e => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "Loading demo case…";
  try {
    const res = await apiFetch("/cases/demo", { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.detail || "Could not load the demo case.", "error");
      return;
    }
    showToast("Demo case loaded — fully analyzed, nothing to upload.", "success");
    openCase(data.case_id);
  } catch (err) {
    showToast(err.message === "SERVER_UNREACHABLE" ? "Could not reach the server — try again in a moment." : "Something went wrong. Please try again.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ Load Demo Case";
  }
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
  if (name === "contradictions") loadContradictions();
  if (name === "report") renderReportReadiness();
  if (name === "similar") loadSimilar();
  if (name === "audit") loadAudit();
}

document.querySelectorAll("[data-goto]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelector(`.tab[data-tab="${btn.dataset.goto}"]`)?.click();
  });
});

// ---------------------------------------------------------------------------
// case intelligence (summary, arguments, chat — contradictions are separate)
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
  if (name === "arguments") loadArguments();
  // "chat" needs no preload — the chat window loads its own history lazily.
}
async function openCase(caseId) {
  CURRENT_CASE_ID = caseId;
  loadedTabs.clear();
  CONTRA_DATA = null;
  updateContraBadge(0);
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
// persistent case context header (title, status/priority pills, quick stats)
// ---------------------------------------------------------------------------

function renderCaseContextBar(caseObj, counts) {
  const titleEl = document.getElementById("ccb-title");
  const idEl = document.getElementById("ccb-id");
  const statusEl = document.getElementById("ccb-status");
  const priorityEl = document.getElementById("ccb-priority");
  const statsEl = document.getElementById("ccb-stats");
  if (!titleEl) return;
  titleEl.textContent = caseObj.title;
  idEl.textContent = `${caseObj.id} · ${caseObj.case_type}`;
  statusEl.textContent = caseObj.status;
  statusEl.className = "ccb-pill ccb-status status-" + String(caseObj.status || "").toLowerCase().replace(/\s+/g, "-");
  priorityEl.textContent = (caseObj.priority || "") + " priority";
  priorityEl.className = "ccb-pill ccb-priority priority-" + String(caseObj.priority || "").toLowerCase();

  const parts = [];
  if (counts.documents !== undefined) parts.push([counts.documents, "Documents"]);
  if (counts.events !== undefined) parts.push([counts.events, "Events"]);
  if (counts.entities !== undefined) parts.push([counts.entities, "Entities"]);
  if (counts.conflicts !== undefined) parts.push([counts.conflicts, "Conflicts", counts.conflicts > 0]);
  statsEl.innerHTML = parts.map(([num, label, warn]) =>
    `<div class="ccb-stat${warn ? " ccb-stat-warn" : ""}"><span class="ccb-stat-num">${num}</span><span class="ccb-stat-label">${label}</span></div>`
  ).join("");
}

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------

const RELATIONSHIP_CATEGORIES = [
  { label: "Works at", color: "#4a7fb5", match: /\b(works? at|employ|joined|hired)/i },
  { label: "Communicated with", color: "#8f8bc4", match: /\b(email|communicat|repl|wrote|message)/i },
  { label: "Vendor of", color: "#4f9d76", match: /\b(vendor|supplie[rd]|contract)/i },
  { label: "Asked to process", color: "#c9705f", match: /\b(asked|instructed|requested)/i },
  { label: "Payment to", color: "#d9a441", match: /\b(payment|paid|invoice|transfer)/i },
];
function classifyRelation(text) {
  const found = RELATIONSHIP_CATEGORIES.find(c => c.match.test(text || ""));
  return found ? found.label : "Other";
}

async function loadDashboard() {
  const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/dashboard`);
  const data = await res.json();
  document.getElementById("dash-title").textContent = data.case.title;
  document.getElementById("dash-sub").textContent =
    `${data.case.id} · ${data.case.case_type} · ${data.case.status} · Priority: ${data.case.priority}`;
  renderCaseContextBar(data.case, {
    documents: data.document_count, events: data.event_count, conflicts: data.contradiction_count
  });

  // Pull the graph too (cached after first build) so the overview can show
  // real entity/relationship breakdowns and an evidence-backed confidence
  // score, not just the flat counts the old dashboard had.
  let graph = { nodes: [], edges: [] };
  try {
    const gRes = await apiFetch(`/cases/${CURRENT_CASE_ID}/graph`);
    if (gRes.ok) graph = await gRes.json();
  } catch { /* graph is optional enrichment — dashboard still works without it */ }

  const entityTotal = graph.nodes.length;
  const typeCounts = { person: 0, organization: 0, location: 0, other: 0 };
  graph.nodes.forEach(n => { typeCounts[n.type] = (typeCounts[n.type] || 0) + 1; });
  const edgesWithEvidence = graph.edges.filter(e => e.evidence && e.evidence.trim()).length;
  const evidenceScore = graph.edges.length ? Math.round(100 * edgesWithEvidence / graph.edges.length) : (data.document_count ? 100 : 0);

  document.getElementById("stat-grid").innerHTML = [
    ["Documents", data.document_count, "icon-folder", "gold", "Total uploaded"],
    ["Entities", entityTotal, "icon-users", "info", "People, orgs & others"],
    ["Relationships", graph.edges.length, "icon-link", "ok", "Connections found"],
    ["Contradictions", data.contradiction_count, "icon-alert", "rose", data.contradiction_count ? "Needs review" : "No issues detected"],
    ["Events", data.event_count, "icon-calendar", "gold-dim", "Timeline events"],
    ["Evidence Score", evidenceScore + "%", "icon-award", "ok", "Overall confidence"],
  ].map(([label, num, icon, tone, caption]) => `
    <div class="stat-tile tone-${tone}">
      <div class="stat-icon-box"><svg class="stat-icon"><use href="#${icon}"/></svg></div>
      <div class="stat-num">${num}</div>
      <div class="stat-label">${label}</div>
      <div class="stat-caption">${caption}</div>
    </div>`).join("");

  renderDonut(typeCounts, entityTotal);
  renderRelationshipList(graph.edges);
  renderGauge(evidenceScore);
  renderCaseContextBar(data.case, {
    documents: data.document_count, events: data.event_count,
    entities: entityTotal, conflicts: data.contradiction_count
  });

  try {
    const docsRes = await apiFetch(`/cases/${CURRENT_CASE_ID}/documents`);
    renderActivityChart(docsRes.ok ? await docsRes.json() : []);
  } catch { renderActivityChart([]); }

  const cachedSummary = await getCachedSummaryPreview();
  if (cachedSummary) document.getElementById("dash-ai-summary").textContent = cachedSummary;

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

async function getCachedSummaryPreview() {
  try {
    const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/summary/cached`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.summary) return null;
    const firstSentence = data.summary.split(/(?<=[.!?])\s/)[0];
    return firstSentence.length > 200 ? firstSentence.slice(0, 200) + "…" : firstSentence;
  } catch { return null; }
}

function renderDonut(typeCounts, total) {
  const el = document.getElementById("dash-donut-row");
  if (total === 0) {
    el.innerHTML = '<p class="placeholder" style="margin:0">No entities extracted yet.</p>';
    return;
  }
  const entries = [["person", "People"], ["organization", "Organizations"], ["location", "Locations"], ["other", "Other"]];
  let cursor = 0;
  const stops = entries.map(([key]) => {
    const pct = (typeCounts[key] / total) * 100;
    const stop = `${typeColors[key]} ${cursor}% ${cursor + pct}%`;
    cursor += pct;
    return stop;
  }).join(", ");
  el.innerHTML = `
    <div class="donut" style="background: conic-gradient(${stops})"><div class="donut-hole"><strong>${total}</strong><span>Entities</span></div></div>
    <ul class="donut-legend">
      ${entries.map(([key, label]) => `
        <li><span class="legend-key"><span class="legend-swatch" style="background:${typeColors[key]}"></span>${label}</span><span class="legend-count">${typeCounts[key] || 0}</span></li>
      `).join("")}
    </ul>`;
}

function renderRelationshipList(edges) {
  const el = document.getElementById("dash-relationship-list");
  if (!edges.length) {
    el.innerHTML = '<p class="placeholder" style="margin:0">No relationships found yet.</p>';
    return;
  }
  const counts = {};
  edges.forEach(e => { const label = classifyRelation(e.relation); counts[label] = (counts[label] || 0) + 1; });
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const colorFor = label => (RELATIONSHIP_CATEGORIES.find(c => c.label === label) || { color: "#9a8f6e" }).color;
  el.innerHTML = rows.map(([label, count]) => `
    <div class="relationship-row">
      <span class="rel-bar" style="background:${colorFor(label)}"></span>
      <span class="rel-label">${escapeHtml(label)}</span>
      <span class="rel-count">${count}</span>
    </div>`).join("");
}

function renderGauge(score) {
  const el = document.getElementById("dash-gauge");
  const level = score >= 80 ? "High Confidence" : score >= 50 ? "Moderate Confidence" : "Low Confidence";
  const note = score >= 80
    ? "Most information is well-supported by source documents."
    : score >= 50
      ? "Some connections still need supporting evidence."
      : "Many connections lack cited evidence — review before relying on this graph.";
  el.innerHTML = `
    <svg viewBox="0 0 200 118" class="gauge-svg">
      <path d="M20,100 A80,80 0 0 1 180,100" fill="none" stroke="var(--line)" stroke-width="14" stroke-linecap="round"/>
      <path d="M20,100 A80,80 0 0 1 180,100" fill="none" stroke="var(--ok)" stroke-width="14" stroke-linecap="round" pathLength="100" stroke-dasharray="${score} 100"/>
    </svg>
    <div class="gauge-label"><strong>${score}%</strong><span>${level}</span></div>
    <div class="gauge-note"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="#icon-shield"/></svg>${note}</div>`;
}

function renderActivityChart(docs) {
  const el = document.getElementById("dash-activity-chart");
  if (!docs.length) {
    el.innerHTML = '<p class="placeholder" style="margin:0">No documents uploaded yet.</p>';
    return;
  }
  const sorted = [...docs].sort((a, b) => new Date(a.uploaded_at) - new Date(b.uploaded_at));
  const first = new Date(sorted[0].uploaded_at).getTime();
  const last = new Date(sorted[sorted.length - 1].uploaded_at).getTime();
  const span = Math.max(last - first, 1);
  const W = 280, H = 100, PAD = 8;

  const points = sorted.map((d, i) => [
    PAD + ((new Date(d.uploaded_at).getTime() - first) / span) * (W - PAD * 2),
    H - PAD - ((i + 1) / sorted.length) * (H - PAD * 2),
  ]);
  // uploads that all landed in the same instant (typical demo run) would
  // collapse to one x position — spread them evenly instead so the trend
  // is still readable.
  if (points.length > 1 && points.every(([x]) => Math.abs(x - points[0][0]) < 1)) {
    points.forEach((p, i) => { p[0] = PAD + (i / (points.length - 1)) * (W - PAD * 2); });
  }

  const linePath = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${points[points.length - 1][0].toFixed(1)},${H - PAD} L${points[0][0].toFixed(1)},${H - PAD} Z`;
  const dots = points.map(([x, y], i) => `
    <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="var(--teal)">
      <title>${escapeHtml(sorted[i].filename)} — ${fmtTime(sorted[i].uploaded_at)}</title>
    </circle>`).join("");

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="activity-svg">
      <defs>
        <linearGradient id="activityFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--teal)" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="var(--teal)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="var(--line)" stroke-width="1"/>
      <path d="${areaPath}" fill="url(#activityFill)"/>
      <path d="${linePath}" fill="none" stroke="var(--teal)" stroke-width="2"/>
      ${dots}
    </svg>
    <div class="activity-axis">
      <span>${fmtTime(sorted[0].uploaded_at)}</span>
      <span>${sorted.length} document${sorted.length === 1 ? "" : "s"} total</span>
      <span>${fmtTime(sorted[sorted.length - 1].uploaded_at)}</span>
    </div>`;
}

function renderVaultTypeChart(docs) {
  const card = document.getElementById("vault-chart-card");
  const foot = document.getElementById("vault-chart-foot");
  if (!docs.length) { if (card) card.style.display = "none"; return; }
  if (card) card.style.display = "";

  const counts = {};
  docs.forEach(d => { const t = d.doc_type || "Untyped"; counts[t] = (counts[t] || 0) + 1; });
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  renderHBars("vault-type-chart", rows, { colorAt: i => `var(--chart-${(i % 6) + 1})` });

  const typed = docs.filter(d => d.doc_type && d.doc_type !== "Untyped").length;
  if (foot) {
    foot.innerHTML = `
      <span>${docs.length} document${docs.length === 1 ? "" : "s"}</span>
      <span>${rows.length} distinct type${rows.length === 1 ? "" : "s"}</span>
      <span>${Math.round(100 * typed / docs.length)}% auto-classified</span>`;
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

  renderVaultTypeChart(docs);
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

const TIMELINE_CATEGORIES = [
  { key: "employment", label: "Employment", icon: "icon-briefcase", color: "#4a7fb5", match: /\b(began working|joined|hired|appointed|resigned|terminated|employ)/i },
  { key: "vendor", label: "Vendor / Org", icon: "icon-bank", color: "#4f9d76", match: /\b(vendor|approved|contract|agreement|registered|onboard)/i },
  { key: "communication", label: "Communication", icon: "icon-mail", color: "#8f8bc4", match: /\b(emailed|e-mailed|wrote to|message|contacted)/i },
  { key: "reply", label: "Reply / Statement", icon: "icon-person", color: "#d9a441", match: /\b(replied|responded|stated|acknowledg|confirmed)/i },
  { key: "delivery", label: "Delivery", icon: "icon-truck", color: "#7f8cc4", match: /\b(deliver|shipment|warehouse|dispatch|received goods)/i },
  { key: "financial", label: "Financial", icon: "icon-invoice", color: "#c9705f", match: /\b(invoice|payment|paid|transfer|amount|inr|₹|rs\.)/i },
  { key: "task", label: "Task / Instruction", icon: "icon-doc-check", color: "#9a8f6e", match: /\b(asked|requested|instructed|process|task)/i },
];
function classifyEvent(description) {
  const found = TIMELINE_CATEGORIES.find(c => c.match.test(description || ""));
  return found || { key: "other", label: "Other", icon: "icon-clock", color: "#9a8f6e" };
}

let TIMELINE_DATA = null;
let timelineViewMode = "timeline";
let timelineVisibleCount = 6;
const TIMELINE_PAGE_SIZE = 6;

async function loadTimeline() {
  const body = document.getElementById("timeline-body");
  const docs = await (await apiFetch(`/cases/${CURRENT_CASE_ID}/documents`)).json();
  if (docs.length === 0) return;
  body.innerHTML = '<p class="loading-line"><span class="spinner"></span>Extracting timeline…</p>';
  const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/timeline`);
  const data = await res.json();
  if (!res.ok) { body.innerHTML = `<p class="err">${data.detail}</p>`; return; }

  TIMELINE_DATA = data;
  timelineVisibleCount = TIMELINE_PAGE_SIZE;
  populateTimelineFilters(data);
  renderTimelineDensity(data.events || []);
  renderTimeline();
  loadedTabs.add("timeline");
}

function populateTimelineFilters(data) {
  const typeSelect = document.getElementById("timeline-filter-type");
  const timeSelect = document.getElementById("timeline-filter-time");
  const presentKeys = new Set(data.events.map(ev => classifyEvent(ev.description).key));
  typeSelect.innerHTML = '<option value="all">All Events</option>' +
    TIMELINE_CATEGORIES.filter(c => presentKeys.has(c.key))
      .map(c => `<option value="${c.key}">${c.label}</option>`).join("");

  const years = [...new Set(data.events.map(ev => {
    const m = (ev.date || "").match(/\b(19|20)\d{2}\b/);
    return m ? m[0] : null;
  }).filter(Boolean))].sort();
  timeSelect.innerHTML = '<option value="all">All Time</option>' + years.map(y => `<option value="${y}">${y}</option>`).join("");
}

// Bucket events by year (or by month when the whole case sits inside one
// year) so the shape of the case is legible before a single row is read.
function renderTimelineDensity(events) {
  const card = document.getElementById("timeline-density-card");
  const chart = document.getElementById("timeline-density-chart");
  const foot = document.getElementById("timeline-density-foot");
  if (!card || !chart) return;

  const parsed = events.map(ev => {
    const m = (ev.date || "").match(/\b((?:19|20)\d{2})(?:[-/](\d{1,2}))?/);
    return m ? { year: m[1], month: m[2] ? String(m[2]).padStart(2, "0") : null } : null;
  }).filter(Boolean);

  if (parsed.length < 2) { card.style.display = "none"; return; }
  card.style.display = "";

  const years = [...new Set(parsed.map(e => e.year))];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let buckets;
  if (years.length === 1 && parsed.some(e => e.month)) {
    const counts = {};
    parsed.forEach(e => { if (e.month) counts[e.month] = (counts[e.month] || 0) + 1; });
    buckets = Object.keys(counts).sort().map(m => [MONTHS[Number(m) - 1] || m, counts[m]]);
  } else {
    const counts = {};
    parsed.forEach(e => { counts[e.year] = (counts[e.year] || 0) + 1; });
    buckets = Object.keys(counts).sort().map(y => [y, counts[y]]);
  }

  const max = Math.max(...buckets.map(([, v]) => v)) || 1;
  const peak = buckets.reduce((a, b) => (b[1] > a[1] ? b : a));
  chart.innerHTML = buckets.map(([label, value], i) => `
    <div class="col-item" title="${escapeHtml(label)}: ${value} event${value === 1 ? "" : "s"}">
      <span class="col-bar-wrap"><span class="col-bar" style="height:${Math.max(6, (value / max) * 100)}%;background:${value === max ? "var(--teal)" : "var(--chart-6)"};animation-delay:${i * 40}ms"></span></span>
      <span class="col-label">${escapeHtml(label)}</span>
    </div>`).join("");

  if (foot) {
    foot.innerHTML = `
      <span>${parsed.length} dated event${parsed.length === 1 ? "" : "s"}</span>
      <span>Busiest: ${escapeHtml(peak[0])} (${peak[1]})</span>
      <span>${buckets.length} period${buckets.length === 1 ? "" : "s"} covered</span>`;
  }
}

function renderTimeline() {
  const body = document.getElementById("timeline-body");
  const loadMoreBtn = document.getElementById("timeline-load-more");
  const data = TIMELINE_DATA;
  if (!data) return;

  const typeFilter = document.getElementById("timeline-filter-type").value;
  const timeFilter = document.getElementById("timeline-filter-time").value;
  let events = data.events.filter(ev => {
    if (typeFilter !== "all" && classifyEvent(ev.description).key !== typeFilter) return false;
    if (timeFilter !== "all" && !(ev.date || "").includes(timeFilter)) return false;
    return true;
  });

  document.getElementById("timeline-count").textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;

  let html = "";
  if (events.length) {
    const shown = events.slice(0, timelineVisibleCount);
    html += `<div class="timeline-list ${timelineViewMode === "list" ? "is-list-view" : ""}">`;
    shown.forEach(ev => {
      const cat = classifyEvent(ev.description);
      html += `
        <div class="timeline-item" data-doc="${ev.doc_id}">
          <div class="timeline-marker" style="background:${cat.color}">
            <svg width="16" height="16" viewBox="0 0 24 24"><use href="#${cat.icon}"/></svg>
          </div>
          <div class="timeline-date-inline">${escapeHtml(ev.date)}</div>
          <div class="timeline-row">
            <div class="timeline-date-badge">${formatDateBadge(ev.date)}</div>
            <div class="timeline-body-text">
              <div class="timeline-desc">${escapeHtml(ev.description)}</div>
              <div class="timeline-source-row">
                <span class="timeline-source"><svg width="12" height="12" viewBox="0 0 24 24"><use href="#icon-folder"/></svg>${escapeHtml(ev.source)}</span>
                <span class="evidence-pill"><svg width="11" height="11" viewBox="0 0 24 24"><use href="#icon-shield"/></svg>Evidence-backed</span>
              </div>
            </div>
          </div>
        </div>`;
      const gap = data.gaps.find(g => g.after === ev.date);
      if (gap) html += `<div class="gap-marker">Gap of ~${gap.days} days before the next event</div>`;
    });
    html += "</div>";
    loadMoreBtn.style.display = events.length > timelineVisibleCount ? "block" : "none";
  } else {
    html += '<p class="placeholder">No events match this filter.</p>';
    loadMoreBtn.style.display = "none";
  }
  if (data.undated.length) {
    html += '<div class="section-label">Undated events</div><ul>';
    data.undated.forEach(ev => { html += `<li>${escapeHtml(ev.description)} <span class="timeline-source">— ${escapeHtml(ev.source)}</span></li>`; });
    html += "</ul>";
  }
  body.innerHTML = html;
  body.querySelectorAll(".timeline-item").forEach(el => el.addEventListener("click", (e) => {
    if (!e.target.closest(".timeline-source, .evidence-pill")) openDocModal(el.dataset.doc);
  }));
}

function formatDateBadge(dateStr) {
  const trimmed = (dateStr || "").trim();
  if (/^(19|20)\d{2}$/.test(trimmed)) {
    return `<div class="timeline-date-year">YEAR</div><div class="timeline-date-day" style="font-size:18px">${trimmed}</div>`;
  }
  const parsed = new Date(dateStr);
  if (isNaN(parsed)) return `<div class="timeline-date-year">${escapeHtml(dateStr)}</div>`;
  const day = String(parsed.getDate()).padStart(2, "0");
  const month = parsed.toLocaleString("en-US", { month: "short" }).toUpperCase();
  const year = parsed.getFullYear();
  return `<div class="timeline-date-year">${year}</div><div class="timeline-date-day">${day}</div><div class="timeline-date-month">${month}</div>`;
}

document.getElementById("timeline-filter-type").addEventListener("change", () => { timelineVisibleCount = TIMELINE_PAGE_SIZE; renderTimeline(); });
document.getElementById("timeline-filter-time").addEventListener("change", () => { timelineVisibleCount = TIMELINE_PAGE_SIZE; renderTimeline(); });
document.getElementById("timeline-load-more").addEventListener("click", () => { timelineVisibleCount += TIMELINE_PAGE_SIZE; renderTimeline(); });
document.querySelectorAll(".view-toggle-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".view-toggle-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    timelineViewMode = btn.dataset.timelineView;
    renderTimeline();
  });
});
document.getElementById("export-timeline-btn").addEventListener("click", () => {
  if (!TIMELINE_DATA || !TIMELINE_DATA.events.length) { showToast("Nothing to export yet.", "error"); return; }
  let md = `# Investigation Timeline\n\n`;
  TIMELINE_DATA.events.forEach(ev => { md += `- **${ev.date}** — ${ev.description} _(source: ${ev.source})_\n`; });
  if (TIMELINE_DATA.undated.length) {
    md += `\n## Undated events\n\n`;
    TIMELINE_DATA.undated.forEach(ev => { md += `- ${ev.description} _(source: ${ev.source})_\n`; });
  }
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `timeline-${CURRENT_CASE_ID}.md`; a.click();
  URL.revokeObjectURL(url);
});

// ---------------------------------------------------------------------------
// graph
// ---------------------------------------------------------------------------

// Muted, desaturated accents so entity types stay distinguishable at a
// glance without fighting the app's otherwise beige/navy/red theme.
const typeColors = { person: "#d9a441", organization: "#4f9d76", location: "#7f8cc4", other: "#9a8f6e" };
const EDGE_CATEGORIES = [
  { key: "employment", label: "Employment", color: "#4f9d76", match: /\b(works? at|employ|joined|hired)/i },
  { key: "business", label: "Business", color: "#4a7fb5", match: /\b(vendor|supplie[rd]|contract|business|payment|invoice)/i },
  { key: "communication", label: "Communication", color: "#c9705f", match: /\b(email|communicat|repl(y|ied)|wrote|message|requested|asked)/i },
  { key: "consultation", label: "Consultation", color: "#8f8bc4", match: /\b(consult|advis|shared info)/i },
];
function classifyEdge(relation) {
  const found = EDGE_CATEGORIES.find(c => c.match.test(relation || ""));
  return found || { key: "other", label: "Other", color: "#9a8f6e" };
}

let GRAPH_DATA = null;
let GRAPH_DOCS = null;
let GRAPH_NETWORK = null;
let graphViewMode = "graph";

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
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><circle cx="30" cy="30" r="28" fill="${color}" stroke="#12141a" stroke-width="2"/><g fill="#fffcf2">${glyph}</g></svg>`;
  return "data:image/svg+xml;base64," + btoa(svg);
}

async function loadGraph() {
  const canvas = document.getElementById("graph-canvas");
  const legend = document.getElementById("graph-legend");
  const docs = await (await apiFetch(`/cases/${CURRENT_CASE_ID}/documents`)).json();
  if (docs.length === 0) return;
  canvas.innerHTML = '<p class="loading-line" style="padding:20px"><span class="spinner"></span>Mapping connections…</p>';
  const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/graph`);
  const data = await res.json();
  if (!res.ok) { canvas.innerHTML = `<p class="err">${data.detail}</p>`; return; }

  GRAPH_DATA = data;
  GRAPH_DOCS = docs;
  legend.innerHTML = EDGE_CATEGORIES.concat([{ key: "other", label: "Other", color: "#9a8f6e" }])
    .map(c => `<span><span class="legend-line" style="background:${c.color}"></span>${c.label}</span>`).join("");
  populateGraphFilters(data);
  renderGraphInsights(data);
  renderGraphView();
  loadedTabs.add("graph");
}

// Degree ranking + entity mix. The force layout already shows who is central,
// but "central" is a visual impression — this puts a number on it.
function renderGraphInsights(data) {
  const wrap = document.getElementById("graph-insights");
  if (!wrap) return;
  if (!data.nodes.length) { wrap.style.display = "none"; return; }
  wrap.style.display = "";

  const degree = {};
  data.nodes.forEach(n => { degree[n.id ?? n.label] = 0; });
  data.edges.forEach(e => {
    degree[e.from] = (degree[e.from] || 0) + 1;
    degree[e.to] = (degree[e.to] || 0) + 1;
  });
  const labelOf = {};
  data.nodes.forEach(n => { labelOf[n.id ?? n.label] = n.label ?? n.id; });

  const top = Object.entries(degree)
    .map(([id, deg]) => [labelOf[id] || id, deg])
    .filter(([, deg]) => deg > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7);
  renderHBars("graph-top-entities", top, { color: "var(--teal)" });

  const typeCounts = { person: 0, organization: 0, location: 0, other: 0 };
  data.nodes.forEach(n => { typeCounts[n.type] = (typeCounts[n.type] || 0) + 1; });
  const entries = [["person", "People"], ["organization", "Organizations"], ["location", "Locations"], ["other", "Other"]];
  const total = data.nodes.length;
  let cursor = 0;
  const stops = entries.map(([key]) => {
    const pct = (typeCounts[key] / total) * 100;
    const stop = `${typeColors[key]} ${cursor}% ${cursor + pct}%`;
    cursor += pct;
    return stop;
  }).join(", ");
  document.getElementById("graph-entity-donut").innerHTML = `
    <div class="donut" style="background: conic-gradient(${stops})"><div class="donut-hole"><strong>${total}</strong><span>Entities</span></div></div>
    <ul class="donut-legend">
      ${entries.map(([key, label]) => `
        <li><span class="legend-key"><span class="legend-swatch" style="background:${typeColors[key]}"></span>${label}</span><span class="legend-count">${typeCounts[key] || 0}</span></li>
      `).join("")}
    </ul>`;
}

function populateGraphFilters(data) {
  const typeSelect = document.getElementById("graph-filter-type");
  const relSelect = document.getElementById("graph-filter-relation");
  const presentTypes = [...new Set(data.nodes.map(n => n.type))];
  typeSelect.innerHTML = '<option value="all">All Entities</option>' +
    presentTypes.map(t => `<option value="${t}">${t.charAt(0).toUpperCase() + t.slice(1)}s</option>`).join("");
  const presentCats = new Set(data.edges.map(e => classifyEdge(e.relation).key));
  relSelect.innerHTML = '<option value="all">All Relationship Types</option>' +
    EDGE_CATEGORIES.concat([{ key: "other", label: "Other" }]).filter(c => presentCats.has(c.key))
      .map(c => `<option value="${c.key}">${c.label}</option>`).join("");
}

function renderGraphView() {
  document.getElementById("graph-canvas").style.display = graphViewMode === "graph" ? "block" : "none";
  document.getElementById("graph-table-wrap").style.display = graphViewMode === "table" ? "block" : "none";
  if (graphViewMode === "graph") renderGraph(); else renderGraphTable();
}

function getFilteredGraph() {
  const data = GRAPH_DATA;
  const typeFilter = document.getElementById("graph-filter-type").value;
  const relFilter = document.getElementById("graph-filter-relation").value;
  const showIsolated = document.getElementById("graph-show-isolated").checked;

  let nodes = typeFilter === "all" ? data.nodes : data.nodes.filter(n => n.type === typeFilter);
  let edges = relFilter === "all" ? data.edges : data.edges.filter(e => classifyEdge(e.relation).key === relFilter);
  edges = edges.filter(e => nodes.some(n => n.id === e.source) && nodes.some(n => n.id === e.target));

  const connectedIds = new Set();
  edges.forEach(e => { connectedIds.add(e.source); connectedIds.add(e.target); });
  const visibleNodes = showIsolated ? nodes : nodes.filter(n => connectedIds.has(n.id));
  return { nodes: visibleNodes, edges, hiddenCount: nodes.length - visibleNodes.length };
}

function renderGraph() {
  const canvas = document.getElementById("graph-canvas");
  if (!GRAPH_DATA) return;
  const { nodes: visibleNodes, edges: visibleEdges, hiddenCount } = getFilteredGraph();

  canvas.innerHTML = "";
  if (visibleNodes.length === 0) {
    canvas.innerHTML = '<p class="placeholder" style="padding:20px">No connections match this filter — check "Show unconnected entities" or widen your filters.</p>';
    return;
  }

  const nodes = new vis.DataSet(visibleNodes.map(n => ({
    id: n.id, label: n.label,
    shape: "image", image: nodeIcon(n.type), size: 26,
    font: { color: "#f3f0e8", face: "Inter", size: 13, weight: 700, strokeWidth: 4, strokeColor: "#12141a", vadjust: -30 },
  })));
  const edges = new vis.DataSet(visibleEdges.map((e, i) => {
    const cat = classifyEdge(e.relation);
    return {
      id: i, from: e.source, to: e.target, title: e.relation, relation: e.relation, evidence: e.evidence,
      color: { color: cat.color, highlight: "#12141a", hover: cat.color }, opacity: 0.85,
      width: 2, arrows: "to", smooth: { type: "continuous", roundness: 0.35 },
    };
  }));

  const network = new vis.Network(canvas, { nodes, edges }, {
    physics: {
      solver: "forceAtlas2Based",
      forceAtlas2Based: { springLength: 190, avoidOverlap: 0.8, gravitationalConstant: -60 },
      stabilization: { iterations: 150 },
    },
    interaction: { hover: true, tooltipDelay: 120 },
    edges: { font: { size: 0 } }, // relation text lives in the hover tooltip + click detail panel, not always-on canvas text
  });
  GRAPH_NETWORK = network;
  network.once("stabilizationIterationsDone", () => network.fit({ animation: { duration: 400 } }));

  network.on("click", params => {
    if (params.nodes.length) showEntityDetail(params.nodes[0]);
  });

  const hintEl = document.querySelector(".graph-hint");
  if (hintEl && hiddenCount > 0) {
    hintEl.textContent = `Scroll to zoom · drag to pan · ${hiddenCount} unconnected ${hiddenCount === 1 ? "entity" : "entities"} hidden`;
  } else if (hintEl) {
    hintEl.textContent = "Scroll to zoom · drag to pan · drag a dot to reposition it";
  }
}

function showEntityDetail(nodeId) {
  const data = GRAPH_DATA;
  const node = data.nodes.find(n => n.id === nodeId);
  const panel = document.getElementById("graph-detail");
  if (!node) return;

  const related = data.edges.filter(e => e.source === nodeId || e.target === nodeId);
  const aboutEdge = related.find(e => classifyEdge(e.relation).key === "employment") || related[0];
  const about = aboutEdge
    ? `${escapeHtml(aboutEdge.relation)}${aboutEdge.source === nodeId ? " " + escapeHtml(data.nodes.find(n => n.id === aboutEdge.target)?.label || "") : ""}.`
    : `${related.length} relationship${related.length === 1 ? "" : "s"} found across the case documents.`;

  const relLines = related.map(e => {
    const outgoing = e.source === nodeId;
    const otherId = outgoing ? e.target : e.source;
    const other = data.nodes.find(n => n.id === otherId);
    const cat = classifyEdge(e.relation);
    return `<div class="rel-line"><span class="rel-dot" style="background:${cat.color}"></span><span class="rel-verb">${escapeHtml(e.relation)}</span><span class="rel-target" data-node-id="${otherId}">${escapeHtml(other?.label || "Unknown")}</span></div>`;
  }).join("") || '<p class="placeholder" style="font-size:12.5px">No relationships recorded.</p>';

  const matchingDocs = (GRAPH_DOCS || []).filter(d => (d.entities || []).some(e => e.name === node.label));
  const evidenceLines = matchingDocs.length
    ? matchingDocs.map(d => `<div class="evidence-line" data-doc="${d.id}"><svg viewBox="0 0 24 24"><use href="#icon-folder"/></svg>${escapeHtml(d.filename)}</div>`).join("")
    : '<p class="placeholder" style="font-size:12.5px">No directly matching documents found.</p>';

  panel.innerHTML = `
    <div class="detail-header">
      <img class="detail-avatar" src="${nodeIcon(node.type)}" alt=""/>
      <div><div class="detail-name">${escapeHtml(node.label)}</div><div class="detail-type">${escapeHtml(node.type)}</div></div>
    </div>
    <div class="detail-section-label">About</div>
    <div class="detail-about">${about}</div>
    <div class="detail-section-label">Key Relationships (${related.length})</div>
    ${relLines}
    <div class="detail-section-label">Related Evidence (${matchingDocs.length})</div>
    ${evidenceLines}
  `;
  panel.querySelectorAll(".rel-target").forEach(el => el.addEventListener("click", () => {
    if (graphViewMode === "graph" && GRAPH_NETWORK) GRAPH_NETWORK.selectNodes([el.dataset.nodeId]);
    showEntityDetail(el.dataset.nodeId);
  }));
  panel.querySelectorAll(".evidence-line[data-doc]").forEach(el => el.addEventListener("click", () => openDocModal(el.dataset.doc)));
}

function renderGraphTable() {
  const wrap = document.getElementById("graph-table-wrap");
  const { edges } = getFilteredGraph();
  if (!edges.length) { wrap.innerHTML = '<p class="placeholder">No relationships match this filter.</p>'; return; }
  const nodeName = id => GRAPH_DATA.nodes.find(n => n.id === id)?.label || "Unknown";
  wrap.innerHTML = `
    <table class="graph-table">
      <thead><tr><th>From</th><th>Relationship</th><th>To</th><th>Evidence</th></tr></thead>
      <tbody>
        ${edges.map(e => {
          const cat = classifyEdge(e.relation);
          return `<tr>
            <td>${escapeHtml(nodeName(e.source))}</td>
            <td><span class="rel-chip" style="background:${cat.color}22;color:${cat.color}">${escapeHtml(e.relation)}</span></td>
            <td>${escapeHtml(nodeName(e.target))}</td>
            <td>${escapeHtml(e.evidence || "—")}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;
}

document.getElementById("graph-show-isolated").addEventListener("change", () => { if (GRAPH_DATA) renderGraphView(); });
document.getElementById("graph-filter-type").addEventListener("change", () => { if (GRAPH_DATA) renderGraphView(); });
document.getElementById("graph-filter-relation").addEventListener("change", () => { if (GRAPH_DATA) renderGraphView(); });
document.querySelectorAll("[data-graph-view]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-graph-view]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    graphViewMode = btn.dataset.graphView;
    renderGraphView();
  });
});
document.getElementById("export-graph-btn").addEventListener("click", () => {
  if (!GRAPH_DATA || !GRAPH_DATA.edges.length) { showToast("Nothing to export yet.", "error"); return; }
  const nodeName = id => GRAPH_DATA.nodes.find(n => n.id === id)?.label || "Unknown";
  let md = `# Connections\n\n`;
  GRAPH_DATA.edges.forEach(e => { md += `- **${nodeName(e.source)}** — ${e.relation} → **${nodeName(e.target)}** _(${e.evidence || "no evidence text"})_\n`; });
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `connections-${CURRENT_CASE_ID}.md`; a.click();
  URL.revokeObjectURL(url);
});

const PERSPECTIVE_LABELS = {
  primary: "Primary reading", alternative_suspect: "Alternative suspect",
  innocent_explanation: "Innocent explanation", gap_in_evidence: "Gap in evidence",
};

async function generatePerspectives() {
  const body = document.getElementById("perspectives-body");
  body.innerHTML = '<p class="loading-line"><span class="spinner"></span>Weighing alternative angles…</p>';
  try {
    const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/perspectives`);
    const data = await res.json();
    if (!res.ok) {
      // A 429 here is Groq's daily free-tier quota, not a bug — show the
      // server's already-friendly wait-time message as-is rather than a
      // generic failure, and offer a retry button for when it resets.
      body.innerHTML = `<p class="err">${escapeHtml(data.detail)}</p>
        <button class="ghost-btn" id="generate-perspectives-btn" style="margin-top:10px">Try again</button>`;
      document.getElementById("generate-perspectives-btn").addEventListener("click", generatePerspectives);
      return;
    }
    renderPerspectives(data.perspectives);
  } catch {
    body.innerHTML = `<p class="err">Could not reach the server.</p>
      <button class="ghost-btn" id="generate-perspectives-btn" style="margin-top:10px">Try again</button>`;
    document.getElementById("generate-perspectives-btn").addEventListener("click", generatePerspectives);
  }
}

function renderPerspectives(perspectives) {
  const body = document.getElementById("perspectives-body");
  if (!perspectives || !perspectives.length) {
    body.innerHTML = '<p class="placeholder">No alternative angles could be generated from the current evidence.</p>';
    return;
  }
  body.innerHTML = `<div class="perspectives-grid">${perspectives.map(p => `
    <div class="perspective-card stance-${p.stance || "other"}">
      <span class="perspective-stance-tag">${escapeHtml(PERSPECTIVE_LABELS[p.stance] || "Angle")}</span>
      <h4>${escapeHtml(p.title || "")}</h4>
      <p class="perspective-summary">${escapeHtml(p.summary || "")}</p>
      <ul>${(p.points || []).map(pt => `<li>${escapeHtml(pt)}</li>`).join("")}</ul>
      <div class="perspective-caveat"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;margin-top:1px"><use href="#icon-shield"/></svg>${escapeHtml(p.caveat || "Requires further verification.")}</div>
    </div>`).join("")}</div>`;
}

document.getElementById("generate-perspectives-btn").addEventListener("click", generatePerspectives);

// ---------------------------------------------------------------------------
// contradictions
// ---------------------------------------------------------------------------

let CONTRA_DATA = null;

// Confidence is the only severity signal the API gives us, so band it once
// here and let the stats, the donut, the card border and the filter all read
// from the same function — otherwise "high" ends up meaning three things.
function contraSeverity(confidence) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return { key: "low", label: "Unscored", color: "var(--sev-low)" };
  if (c >= 75) return { key: "high", label: "High", color: "var(--sev-high)" };
  if (c >= 50) return { key: "med", label: "Medium", color: "var(--sev-med)" };
  return { key: "low", label: "Low", color: "var(--sev-low)" };
}

async function loadContradictions() {
  const body = document.getElementById("contradiction-body");
  const docs = await (await apiFetch(`/cases/${CURRENT_CASE_ID}/documents`)).json();
  if (docs.length === 0) return;
  body.innerHTML = '<p class="loading-line"><span class="spinner"></span>Comparing every claim against every other claim…</p>';
  const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/contradictions`);
  const data = await res.json();
  if (!res.ok) { body.innerHTML = `<p class="err">${data.detail}</p>`; return; }

  CONTRA_DATA = data.contradictions || [];
  populateContraFilters();
  renderContraStats();
  renderContraCharts();
  renderContradictions();
  updateContraBadge(CONTRA_DATA.length);
  loadedTabs.add("contradictions");
}

function populateContraFilters() {
  const sel = document.getElementById("contra-filter-type");
  const types = [...new Set(CONTRA_DATA.map(c => c.conflict_type || "conflict"))].sort();
  sel.innerHTML = '<option value="all">All Conflict Types</option>' +
    types.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");
}

function updateContraBadge(n) {
  const badge = document.getElementById("tab-contra-badge");
  if (!badge) return;
  badge.hidden = !n;
  badge.textContent = n;
}

function renderContraStats() {
  const el = document.getElementById("contra-stats");
  const total = CONTRA_DATA.length;
  const bands = { high: 0, med: 0, low: 0 };
  CONTRA_DATA.forEach(c => { bands[contraSeverity(c.confidence).key]++; });
  const docsTouched = new Set();
  CONTRA_DATA.forEach(c => { if (c.source_a) docsTouched.add(c.source_a); if (c.source_b) docsTouched.add(c.source_b); });

  el.innerHTML = [
    ["sev-neutral", total, "Conflicts found", total ? "Across the current evidence" : "Nothing contradicts so far"],
    ["sev-high", bands.high, "High confidence", "Review these first"],
    ["sev-med", bands.med, "Medium confidence", "Worth a second look"],
    ["sev-low", bands.low, "Low confidence", "May be phrasing, not conflict"],
    ["sev-neutral", docsTouched.size, "Documents implicated", "Exhibits involved in a conflict"],
  ].map(([tone, num, label, cap]) => `
    <div class="contra-stat ${tone}">
      <div class="contra-stat-num">${num}</div>
      <div class="contra-stat-label">${label}</div>
      <div class="contra-stat-cap">${cap}</div>
    </div>`).join("");
}

function renderContraCharts() {
  const wrap = document.getElementById("contra-charts");
  if (!CONTRA_DATA.length) { wrap.style.display = "none"; document.getElementById("contra-toolbar").style.display = "none"; return; }
  wrap.style.display = "";
  document.getElementById("contra-toolbar").style.display = "";

  // --- severity donut (conic-gradient, same technique as the dashboard) ---
  const bands = [
    ["high", "High (75%+)", "var(--sev-high)"],
    ["med", "Medium (50–74%)", "var(--sev-med)"],
    ["low", "Low (under 50%)", "var(--sev-low)"],
  ];
  const counts = { high: 0, med: 0, low: 0 };
  CONTRA_DATA.forEach(c => { counts[contraSeverity(c.confidence).key]++; });
  const total = CONTRA_DATA.length;
  let cursor = 0;
  const stops = bands.map(([key, , color]) => {
    const pct = (counts[key] / total) * 100;
    const stop = `${color} ${cursor}% ${cursor + pct}%`;
    cursor += pct;
    return stop;
  }).join(", ");
  document.getElementById("contra-donut").innerHTML = `
    <div class="donut" style="background: conic-gradient(${stops})"><div class="donut-hole"><strong>${total}</strong><span>Conflicts</span></div></div>
    <ul class="donut-legend">
      ${bands.map(([key, label, color]) => `
        <li><span class="legend-key"><span class="legend-swatch" style="background:${color}"></span>${label}</span><span class="legend-count">${counts[key]}</span></li>
      `).join("")}
    </ul>`;

  // --- conflict types ---
  const typeCounts = {};
  CONTRA_DATA.forEach(c => { const t = c.conflict_type || "conflict"; typeCounts[t] = (typeCounts[t] || 0) + 1; });
  renderHBars("contra-type-chart", Object.entries(typeCounts).sort((a, b) => b[1] - a[1]),
    { colorAt: i => `var(--chart-${(i % 6) + 1})` });

  // --- documents implicated ---
  const docCounts = {};
  CONTRA_DATA.forEach(c => {
    [c.source_a, c.source_b].filter(Boolean).forEach(s => { docCounts[s] = (docCounts[s] || 0) + 1; });
  });
  renderHBars("contra-doc-chart", Object.entries(docCounts).sort((a, b) => b[1] - a[1]).slice(0, 6),
    { color: "var(--thread)" });
}

function renderContradictions() {
  const body = document.getElementById("contradiction-body");
  const countEl = document.getElementById("contra-count");
  if (!CONTRA_DATA) return;

  if (!CONTRA_DATA.length) {
    body.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-doc-check"/></svg>
        <div class="empty-state-title">No contradictions detected</div>
        <div class="empty-state-sub">Every claim compared across the current documents was consistent. Re-run this check after uploading new evidence — consistency today is not consistency tomorrow.</div>
      </div>`;
    if (countEl) countEl.textContent = "";
    return;
  }

  const typeFilter = document.getElementById("contra-filter-type").value;
  const sevFilter = document.getElementById("contra-filter-sev").value;
  const rows = CONTRA_DATA.filter(c => {
    if (typeFilter !== "all" && (c.conflict_type || "conflict") !== typeFilter) return false;
    if (sevFilter !== "all" && contraSeverity(c.confidence).key !== sevFilter) return false;
    return true;
  });

  if (countEl) countEl.textContent = `${rows.length} of ${CONTRA_DATA.length} shown`;

  if (!rows.length) {
    body.innerHTML = '<p class="placeholder">No conflicts match the current filters.</p>';
    return;
  }

  body.innerHTML = rows.map(c => {
    const sev = contraSeverity(c.confidence);
    const pct = Number.isFinite(Number(c.confidence)) ? Number(c.confidence) : 0;
    return `
      <div class="contradiction-card sev-${sev.key}">
        <div class="contradiction-top">
          <span class="conflict-type-pill">${escapeHtml(c.conflict_type || "conflict")}</span>
          <span class="sev-pill sev-${sev.key}">${sev.label}</span>
          <span class="confidence-pill">confidence: ${c.confidence ?? "—"}%</span>
        </div>
        <div class="contradiction-pair">
          <div class="contradiction-claim">${escapeHtml(c.claim_a)}<span class="src">${escapeHtml(c.source_a)}</span></div>
          <div class="contradiction-vs">VS</div>
          <div class="contradiction-claim">${escapeHtml(c.claim_b)}<span class="src">${escapeHtml(c.source_b)}</span></div>
        </div>
        <div class="contradiction-explain">${escapeHtml(c.explanation)}</div>
        <div class="contra-confidence-bar"><span style="width:${pct}%;background:${sev.color}"></span></div>
      </div>`;
  }).join("");
}

document.getElementById("contra-filter-type").addEventListener("change", renderContradictions);
document.getElementById("contra-filter-sev").addEventListener("change", renderContradictions);

document.getElementById("contra-rerun-btn").addEventListener("click", () => {
  loadedTabs.delete("contradictions");
  loadContradictions();
});

document.getElementById("contra-export-btn").addEventListener("click", () => {
  if (!CONTRA_DATA || !CONTRA_DATA.length) return;
  const lines = [
    `# Contradiction Findings — ${CURRENT_CASE_ID}`,
    "",
    "> Flagged by automated cross-document comparison. Each item requires investigator verification; none is a finding of fact.",
    "",
  ];
  CONTRA_DATA.forEach((c, i) => {
    const sev = contraSeverity(c.confidence);
    lines.push(`## ${i + 1}. ${c.conflict_type || "Conflict"} — ${sev.label} confidence (${c.confidence ?? "—"}%)`);
    lines.push("", `- **Claim A** (${c.source_a}): ${c.claim_a}`);
    lines.push(`- **Claim B** (${c.source_b}): ${c.claim_b}`);
    lines.push("", `${c.explanation}`, "");
  });
  downloadText(`contradictions-${CURRENT_CASE_ID}.md`, lines.join("\n"));
});

// Small shared helper so every page's bar chart looks and animates the same.
function renderHBars(elId, entries, opts = {}) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!entries.length) { el.innerHTML = '<p class="placeholder" style="margin:0">Nothing to show yet.</p>'; return; }
  const max = Math.max(...entries.map(([, v]) => v)) || 1;
  el.innerHTML = entries.map(([name, value], i) => {
    const color = opts.colorAt ? opts.colorAt(i) : (opts.color || "var(--teal)");
    const pct = (value / max) * 100;
    return `
      <div class="hbar-row" title="${escapeHtml(String(name))}: ${value}${opts.suffix || ""}">
        <span class="hbar-name">${escapeHtml(String(name))}</span>
        <span class="hbar-track"><span class="hbar-fill" style="width:${pct}%;background:${color};animation-delay:${i * 45}ms"></span></span>
        <span class="hbar-val">${value}${opts.suffix || ""}</span>
      </div>`;
  }).join("");
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// similar cases
// ---------------------------------------------------------------------------

// Shown above the report so it is obvious *before* generating whether the
// case file is thin. A polished report built on two documents is still a
// report built on two documents.
async function renderReportReadiness() {
  const card = document.getElementById("report-readiness-card");
  const grid = document.getElementById("report-readiness");
  if (!card || !grid) return;
  try {
    const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/dashboard`);
    if (!res.ok) { card.style.display = "none"; return; }
    const d = await res.json();

    const pctOf = (n, target) => Math.min(100, Math.round(100 * (n / target)));
    const items = [
      ["Evidence", pctOf(d.document_count, 5), `${d.document_count} document${d.document_count === 1 ? "" : "s"} on file`],
      ["Timeline", pctOf(d.event_count, 10), `${d.event_count} dated event${d.event_count === 1 ? "" : "s"} extracted`],
      ["Conflicts checked", d.contradiction_count > 0 ? 100 : (d.document_count ? 60 : 0),
        d.contradiction_count ? `${d.contradiction_count} flagged for review` : "None outstanding"],
    ];

    card.style.display = d.document_count ? "" : "none";
    grid.innerHTML = items.map(([label, pct, note]) => {
      const C = 2 * Math.PI * 19;
      return `
        <div class="readiness-item">
          <svg class="readiness-ring" viewBox="0 0 46 46">
            <circle class="rr-track" cx="23" cy="23" r="19"/>
            <circle class="rr-val" cx="23" cy="23" r="19"
              stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct / 100)}"
              stroke="${pct >= 80 ? "var(--ok)" : pct >= 40 ? "var(--teal)" : "var(--thread)"}"/>
          </svg>
          <div class="readiness-copy"><strong>${label}</strong><span>${escapeHtml(note)}</span></div>
        </div>`;
    }).join("");
  } catch { card.style.display = "none"; }
}

async function loadSimilar() {
  const body = document.getElementById("similar-body");
  const docs = await (await apiFetch(`/cases/${CURRENT_CASE_ID}/documents`)).json();
  if (docs.length === 0) return;
  body.innerHTML = '<p class="loading-line"><span class="spinner"></span>Comparing against the case library…</p>';
  const res = await apiFetch(`/cases/${CURRENT_CASE_ID}/similar-cases`);
  const data = await res.json();
  if (!res.ok) { body.innerHTML = `<p class="err">${data.detail}</p>`; return; }

  const simCard = document.getElementById("similar-chart-card");
  if (data.matches.length) {
    simCard.style.display = "";
    renderHBars("similar-chart",
      data.matches.map(m => [m.title || m.precedent_id, Number(m.similarity) || 0]).sort((a, b) => b[1] - a[1]),
      { suffix: "%", colorAt: i => (i === 0 ? "var(--teal)" : "var(--chart-6)") });
  } else {
    simCard.style.display = "none";
  }

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
  const auditCard = document.getElementById("audit-chart-card");
  if (!data.log.length) {
    if (auditCard) auditCard.style.display = "none";
    renderEmptyState(body, "icon-list", "No activity yet", "Every upload, deletion and analysis on this case will show up here.");
    return;
  }
  if (auditCard) {
    auditCard.style.display = "";
    const actionCounts = {};
    data.log.forEach(a => { actionCounts[a.action] = (actionCounts[a.action] || 0) + 1; });
    renderHBars("audit-chart",
      Object.entries(actionCounts).sort((a, b) => b[1] - a[1]).slice(0, 8),
      { colorAt: i => `var(--chart-${(i % 6) + 1})` });
  }
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

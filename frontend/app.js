const API = "/api";

// ---------------- tab switching ----------------

const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".panel");
const loaded = new Set();

tabs.forEach(tab => {
  tab.addEventListener("click", () => {
    tabs.forEach(t => t.classList.remove("active"));
    panels.forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    const name = tab.dataset.tab;
    document.getElementById(`panel-${name}`).classList.add("active");
    onTabShown(name);
  });
});

function onTabShown(name) {
  if (loaded.has(name)) return;
  if (name === "summary") loadSummary();
  if (name === "timeline") loadTimeline();
  if (name === "graph") loadGraph();
  if (name === "contradictions") loadContradictions();
}

document.getElementById("case-id").textContent =
  "NO. " + new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + Math.floor(Math.random() * 900 + 100);

// ---------------- documents ----------------

const fileInput = document.getElementById("file-input");
const dropzone = document.getElementById("dropzone");
const docList = document.getElementById("doc-list");
const uploadStatus = document.getElementById("upload-status");

fileInput.addEventListener("change", () => uploadFiles(fileInput.files));

["dragenter", "dragover"].forEach(evt =>
  dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add("drag"); })
);
["dragleave", "drop"].forEach(evt =>
  dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove("drag"); })
);
dropzone.addEventListener("drop", e => uploadFiles(e.dataTransfer.files));

async function uploadFiles(files) {
  for (const file of files) {
    uploadStatus.textContent = `Reading & organizing ${file.name} …`;
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch(`${API}/documents`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Upload failed");
      uploadStatus.textContent = "";
      invalidateCase();
      await refreshDocuments();
    } catch (err) {
      uploadStatus.innerHTML = `<span class="err">${file.name}: ${err.message}</span>`;
    }
  }
  fileInput.value = "";
}

function invalidateCase() {
  loaded.clear();
}

async function refreshDocuments() {
  const res = await fetch(`${API}/documents`);
  const docs = await res.json();
  docList.innerHTML = "";
  docs.forEach((doc, i) => docList.appendChild(exhibitCard(doc, i + 1)));
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
      <span class="exhibit-meta">${entityCount} entities · ${eventCount} events</span>
      <button class="remove-btn" data-id="${doc.id}">remove</button>
    </div>
  `;
  el.querySelector(".remove-btn").addEventListener("click", async () => {
    await fetch(`${API}/documents/${doc.id}`, { method: "DELETE" });
    invalidateCase();
    refreshDocuments();
  });
  return el;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// ---------------- case summary ----------------

async function loadSummary() {
  const body = document.getElementById("summary-body");
  const docs = await fetch(`${API}/documents`).then(r => r.json());
  if (docs.length === 0) return;
  body.innerHTML = '<p class="placeholder">Synthesizing case summary…</p>';
  const res = await fetch(`${API}/case/summary`);
  const data = await res.json();
  if (!res.ok) { body.innerHTML = `<p class="err">${data.detail}</p>`; return; }
  body.innerHTML = data.summary.split("\n\n").map(p => `<p>${escapeHtml(p)}</p>`).join("");
  loaded.add("summary");
}

// ---------------- timeline ----------------

async function loadTimeline() {
  const body = document.getElementById("timeline-body");
  const docs = await fetch(`${API}/documents`).then(r => r.json());
  if (docs.length === 0) return;
  body.innerHTML = '<p class="placeholder">Extracting timeline…</p>';
  const res = await fetch(`${API}/case/timeline`);
  const data = await res.json();
  if (!res.ok) { body.innerHTML = `<p class="err">${data.detail}</p>`; return; }

  let html = "";
  if (data.events.length) {
    html += '<div class="timeline-list">';
    let gapIdx = 0;
    data.events.forEach((ev, i) => {
      html += `
        <div class="timeline-item">
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
    html += '<div class="timeline-section-label">Undated events</div><ul>';
    data.undated.forEach(ev => {
      html += `<li>${escapeHtml(ev.description)} <span class="timeline-source">— ${escapeHtml(ev.source)}</span></li>`;
    });
    html += "</ul>";
  }

  body.innerHTML = html;
  loaded.add("timeline");
}

// ---------------- graph ----------------

const typeColors = {
  person: "#c99a2e",
  organization: "#6f9270",
  location: "#7791b5",
  other: "#9c9583",
};

async function loadGraph() {
  const canvas = document.getElementById("graph-canvas");
  const legend = document.getElementById("graph-legend");
  const docs = await fetch(`${API}/documents`).then(r => r.json());
  if (docs.length === 0) return;
  canvas.innerHTML = '<p class="placeholder" style="padding:20px">Mapping connections…</p>';
  const res = await fetch(`${API}/case/graph`);
  const data = await res.json();
  if (!res.ok) { canvas.innerHTML = `<p class="err">${data.detail}</p>`; return; }

  canvas.innerHTML = "";
  const nodes = new vis.DataSet(data.nodes.map(n => ({
    id: n.id,
    label: n.label,
    color: { background: typeColors[n.type] || typeColors.other, border: "#17160f" },
    font: { color: "#17160f", face: "Inter", size: 13 },
    shape: "dot",
    size: 16,
  })));
  const edges = new vis.DataSet(data.edges.map(e => ({
    from: e.source,
    to: e.target,
    label: e.relation,
    title: e.evidence,
    color: { color: "#3c3826", highlight: "#c99a2e" },
    font: { color: "#9c9583", size: 10, strokeWidth: 0, background: "#17160f" },
    arrows: "to",
  })));

  new vis.Network(canvas, { nodes, edges }, {
    physics: { solver: "forceAtlas2Based", forceAtlas2Based: { springLength: 140 } },
    interaction: { hover: true },
  });

  legend.innerHTML = Object.entries(typeColors)
    .map(([type, color]) => `<span><span class="legend-dot" style="background:${color}"></span>${type}</span>`)
    .join("");

  loaded.add("graph");
}

// ---------------- contradictions ----------------

async function loadContradictions() {
  const body = document.getElementById("contradiction-body");
  const docs = await fetch(`${API}/documents`).then(r => r.json());
  if (docs.length === 0) return;
  body.innerHTML = '<p class="placeholder">Comparing evidence across documents…</p>';
  const res = await fetch(`${API}/case/contradictions`);
  const data = await res.json();
  if (!res.ok) { body.innerHTML = `<p class="err">${data.detail}</p>`; return; }

  if (!data.contradictions.length) {
    body.innerHTML = '<p class="no-contradictions">No contradictions detected across the current documents.</p>';
  } else {
    body.innerHTML = data.contradictions.map(c => `
      <div class="contradiction-card">
        <div class="contradiction-pair">
          <div class="contradiction-claim">${escapeHtml(c.claim_a)}<span class="src">${escapeHtml(c.source_a)}</span></div>
          <div class="contradiction-vs">VS</div>
          <div class="contradiction-claim">${escapeHtml(c.claim_b)}<span class="src">${escapeHtml(c.source_b)}</span></div>
        </div>
        <div class="contradiction-explain">${escapeHtml(c.explanation)}</div>
      </div>
    `).join("");
  }
  loaded.add("contradictions");
}

// ---------------- chat ----------------

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
  try {
    const res = await fetch(`${API}/case/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
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

// ---------------- report ----------------

const reportBody = document.getElementById("report-body");
const generateBtn = document.getElementById("generate-report-btn");
const downloadBtn = document.getElementById("download-report-btn");
let lastReport = "";

generateBtn.addEventListener("click", async () => {
  const docs = await fetch(`${API}/documents`).then(r => r.json());
  if (docs.length === 0) { reportBody.innerHTML = '<p class="placeholder">Upload documents first.</p>'; return; }
  reportBody.innerHTML = '<p class="placeholder">Assembling structured case report…</p>';
  generateBtn.disabled = true;
  try {
    const res = await fetch(`${API}/case/report`);
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
  a.download = "case-report.md";
  a.click();
  URL.revokeObjectURL(url);
});

function markdownToHtml(md) {
  // Minimal markdown renderer - headings, bold, lists, paragraphs.
  const lines = md.split("\n");
  let html = "";
  let inList = false;
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
  const escaped = escapeHtml(text);
  return escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

// ---------------- reset ----------------

document.getElementById("reset-btn").addEventListener("click", async () => {
  if (!confirm("Clear all documents and analysis for this case?")) return;
  await fetch(`${API}/case/reset`, { method: "POST" });
  invalidateCase();
  docList.innerHTML = "";
  chatWindow.innerHTML = "";
  document.getElementById("summary-body").innerHTML = '<p class="placeholder">Upload documents, then open this tab to generate a summary.</p>';
  document.getElementById("timeline-body").innerHTML = '<p class="placeholder">No timeline yet.</p>';
  document.getElementById("graph-canvas").innerHTML = "";
  document.getElementById("contradiction-body").innerHTML = '<p class="placeholder">No analysis yet.</p>';
  document.getElementById("report-body").innerHTML = '<p class="placeholder">Not generated yet.</p>';
  downloadBtn.disabled = true;
});

// ---------------- init ----------------

refreshDocuments();

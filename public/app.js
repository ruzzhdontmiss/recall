// Recall dashboard.
//
// Pure browser code over the public HTTP API only: every value rendered here is
// already sanitized server-side (`publicDocument`/`publicMemory` strip embedding
// vectors, provider/model bookkeeping and the server-side storage key), and all
// text is HTML-escaped before insertion.

const KEY_STORAGE = "recall_api_key";

const apiKeyInput = document.getElementById("apiKey");
const tagInput = document.getElementById("containerTag");
const tagList = document.getElementById("containerTags");
const banner = document.getElementById("banner");

const contentEl = document.getElementById("content");
const addBtn = document.getElementById("addBtn");
const addStatus = document.getElementById("addStatus");

const searchInput = document.getElementById("searchInput");
const searchMode = document.getElementById("searchMode");
const searchBtn = document.getElementById("searchBtn");
const searchResults = document.getElementById("searchResults");

const staticList = document.getElementById("staticList");
const dynamicList = document.getElementById("dynamicList");
const staticEmpty = document.getElementById("staticEmpty");
const dynamicEmpty = document.getElementById("dynamicEmpty");
const memoryList = document.getElementById("memoryList");
const docFeed = document.getElementById("docFeed");
const docDetail = document.getElementById("docDetail");

function apiKey() {
  return (apiKeyInput.value || localStorage.getItem(KEY_STORAGE) || "").trim();
}

// An empty space means "use the container the API key is bound to".
function tag() {
  return tagInput.value.trim();
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const key = apiKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(path, { ...opts, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return body;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function snippet(s, n = 160) {
  const flat = String(s || "").replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function setBanner(kind, text) {
  if (!text) {
    banner.hidden = true;
    banner.textContent = "";
    return;
  }
  banner.hidden = false;
  banner.className = `banner banner--${kind}`;
  banner.textContent = text;
}

const containerParam = (extra = "") => {
  const params = new URLSearchParams(extra);
  if (tag()) params.set("containerTag", tag());
  const s = params.toString();
  return s ? `?${s}` : "";
};

function statusBadge(status) {
  const cls = status === "ready" ? "ready" : status === "failed" ? "failed" : "other";
  return `<span class="badge badge--${cls}">${escapeHtml(status)}</span>`;
}

async function refreshContainers() {
  const { containerTags } = await api("/v1/containers");
  tagList.innerHTML = containerTags.map((t) => `<option value="${escapeHtml(t)}">`).join("");
}

async function refreshWhoami() {
  const me = await api("/v1/whoami");
  if (!tagInput.value) tagInput.placeholder = `default: ${me.containerTag}`;
}

async function refreshProfile() {
  const { profile } = await api(`/v1/profile${containerParam()}`);

  staticList.innerHTML = profile.static
    .map((f) => `<li>${escapeHtml(f.text)}${f.slot ? `<span class="meta">${escapeHtml(f.slot)}</span>` : ""}</li>`)
    .join("");
  staticEmpty.style.display = profile.static.length ? "none" : "block";

  dynamicList.innerHTML = profile.dynamic
    .map(
      (f) =>
        `<li>${escapeHtml(f.text)}<span class="meta">expires ${new Date(f.expiresAt).toLocaleString()}</span></li>`
    )
    .join("");
  dynamicEmpty.style.display = profile.dynamic.length ? "none" : "block";
}

async function refreshMemories() {
  memoryList.innerHTML = `<li class="empty-hint">loading…</li>`;
  const { memories } = await api(`/v1/memories${containerParam()}`);
  if (!memories.length) {
    memoryList.innerHTML = `<li class="empty-hint">nothing stored yet</li>`;
    return;
  }
  memoryList.innerHTML = memories
    .map((m) => {
      const forget =
        m.effectiveStatus === "active"
          ? `<button class="btn btn--small forget-btn" data-id="${escapeHtml(m.id)}">forget</button>`
          : "";
      return `<li><span class="badge badge--${m.effectiveStatus === "active" ? "ready" : "other"}">${escapeHtml(
        m.effectiveStatus
      )}</span><span class="meta-inline">${escapeHtml(snippet(m.text))}</span>${forget}</li>`;
    })
    .join("");
  memoryList.querySelectorAll(".forget-btn").forEach((btn) => {
    btn.addEventListener("click", () => forgetMemory(btn.dataset.id));
  });
}

async function forgetMemory(id) {
  if (!window.confirm("Forget this memory? This cannot be undone.")) return;
  try {
    await api(`/v1/memories/${encodeURIComponent(id)}${containerParam()}`, { method: "DELETE" });
    await refreshAll();
  } catch (e) {
    setBanner("error", `could not forget memory: ${e.message}`);
  }
}

async function refreshDocs() {
  docFeed.innerHTML = `<li class="empty-hint">loading…</li>`;
  const { documents } = await api(`/v1/documents${containerParam()}`);
  if (!documents.length) {
    docFeed.innerHTML = `<li class="empty-hint">nothing captured yet in this space</li>`;
    return;
  }
  docFeed.innerHTML = documents
    .slice(0, 12)
    .map((d) => {
      const label = d.filename ? escapeHtml(d.filename) : escapeHtml(snippet(d.content, 80));
      const err = d.status === "failed" && d.errorCode ? `<span class="doc-time">${escapeHtml(d.errorCode)}</span>` : "";
      return (
        `<li class="doc-item" data-id="${escapeHtml(d.id)}">` +
        `<div class="doc-head">${statusBadge(d.status)}<span class="doc-label">${label}</span>` +
        `<span class="doc-time">${timeAgo(d.createdAt)}</span></div>` +
        `<span class="doc-meta">chunks ${d.chunkCount}${d.pageCount ? ` · pages ${d.pageCount}` : ""}</span>${err}</li>`
      );
    })
    .join("");
  docFeed.querySelectorAll(".doc-item").forEach((li) => {
    li.addEventListener("click", () => showDocument(li.dataset.id));
  });
}

async function showDocument(id) {
  docDetail.hidden = false;
  docDetail.innerHTML = `<p class="empty-hint">loading…</p>`;
  try {
    const { document: doc, chunks } = await api(`/v1/documents/${encodeURIComponent(id)}${containerParam()}`);
    const head =
      `<div class="doc-head">${statusBadge(doc.status)}<span class="doc-label">${escapeHtml(
        doc.filename || snippet(doc.content, 60)
      )}</span><button class="btn btn--small" id="docClose">close</button></div>` +
      (doc.errorCode ? `<p class="pane-sub">failed: ${escapeHtml(doc.errorCode)}</p>` : "");
    const body = chunks.length
      ? chunks
          .map(
            (c) =>
              `<li><span class="meta">#${c.chunkIndex}${c.page ? ` · page ${c.page}` : ""}</span>${escapeHtml(
                snippet(c.text, 240)
              )}</li>`
          )
          .join("")
      : `<li class="empty-hint">no searchable passages (failed or incomplete ingestion)</li>`;
    docDetail.innerHTML = head + `<ul class="chunk-list">${body}</ul>`;
    document.getElementById("docClose").addEventListener("click", () => {
      docDetail.hidden = true;
      docDetail.innerHTML = "";
    });
  } catch (e) {
    docDetail.innerHTML = `<p class="empty-hint">error: ${escapeHtml(e.message)}</p>`;
  }
}

async function refreshAll() {
  setBanner("", "");
  try {
    await Promise.all([refreshWhoami(), refreshContainers(), refreshProfile(), refreshMemories(), refreshDocs()]);
  } catch (e) {
    if (e.status === 401) {
      setBanner("info", "enter a valid API key to continue");
    } else {
      setBanner("error", `could not load this space: ${e.message}`);
    }
  }
}

addBtn.addEventListener("click", async () => {
  const content = contentEl.value.trim();
  if (!content) return;
  addBtn.disabled = true;
  addStatus.textContent = "extracting…";
  try {
    const payload = { content };
    if (tag()) payload.containerTag = tag();
    const res = await api("/v1/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    addStatus.textContent = `stored · ${res.memoriesExtracted} fact${res.memoriesExtracted === 1 ? "" : "s"} extracted`;
    contentEl.value = "";
    await refreshAll();
  } catch (e) {
    addStatus.textContent = "error: " + e.message;
  } finally {
    addBtn.disabled = false;
    setTimeout(() => (addStatus.textContent = ""), 4000);
  }
});

async function runSearch() {
  const q = searchInput.value.trim();
  if (!q) return;
  searchResults.innerHTML = `<li class="empty-hint">searching…</li>`;
  try {
    const { results } = await api(
      `/v1/search${containerParam({ q, searchMode: searchMode.value })}`
    );
    if (!results.length) {
      searchResults.innerHTML = `<li class="empty-hint">no matches — try different wording, or add more memories first</li>`;
      return;
    }
    searchResults.innerHTML = results
      .map((r) => {
        const where =
          r.source === "chunk"
            ? `<span class="meta-inline">${escapeHtml(r.filename || "document")}${r.page ? ` · page ${r.page}` : ""}</span>`
            : "";
        return `<li><span class="result-tag result-tag--${escapeHtml(r.source)}">${escapeHtml(
          r.source
        )}</span><span class="result-score">${r.score}</span>${escapeHtml(snippet(r.text))}${where}</li>`;
      })
      .join("");
  } catch (e) {
    searchResults.innerHTML = `<li class="empty-hint">error: ${escapeHtml(e.message)}</li>`;
  }
}

searchBtn.addEventListener("click", runSearch);
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch();
});
tagInput.addEventListener("change", refreshAll);

apiKeyInput.addEventListener("change", () => {
  localStorage.setItem(KEY_STORAGE, apiKeyInput.value.trim());
  refreshAll();
});

// Restore a previously entered key (stored locally in this browser only).
apiKeyInput.value = localStorage.getItem(KEY_STORAGE) || "";

refreshAll();

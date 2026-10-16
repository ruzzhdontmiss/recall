const KEY_STORAGE = "recall_api_key";

const apiKeyInput = document.getElementById("apiKey");
const tagInput = document.getElementById("containerTag");
const tagList = document.getElementById("containerTags");

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
const docFeed = document.getElementById("docFeed");

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

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
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
  const query = tag() ? `?containerTag=${encodeURIComponent(tag())}` : "";
  const { profile } = await api(`/v1/profile${query}`);

  staticList.innerHTML = profile.static
    .map((f) => `<li>${escapeHtml(f.text)}${f.slot ? `<span class="meta">${f.slot}</span>` : ""}</li>`)
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

async function refreshDocs() {
  const query = tag() ? `?containerTag=${encodeURIComponent(tag())}` : "";
  const { documents } = await api(`/v1/documents${query}`);
  if (!documents.length) {
    docFeed.innerHTML = `<li class="empty-hint">nothing captured yet in this space</li>`;
    return;
  }
  docFeed.innerHTML = documents
    .slice(0, 8)
    .map(
      (d) =>
        `<li>${escapeHtml(d.content)}<span class="doc-time">${timeAgo(d.createdAt)}</span></li>`
    )
    .join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function refreshAll() {
  try {
    await Promise.all([refreshWhoami(), refreshContainers(), refreshProfile(), refreshDocs()]);
  } catch (e) {
    if (e.status === 401) {
      addStatus.textContent = "enter a valid API key to continue";
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
  const t = tag() ? `&containerTag=${encodeURIComponent(tag())}` : "";
  try {
    const { results } = await api(
      `/v1/search?q=${encodeURIComponent(q)}${t}&searchMode=${searchMode.value}`
    );
    if (!results.length) {
      searchResults.innerHTML = `<li class="empty-hint">no matches — try different wording, or add more memories first</li>`;
      return;
    }
    searchResults.innerHTML = results
      .map(
        (r) =>
          `<li><span class="result-tag result-tag--${r.source}">${r.source}</span><span class="result-score">${r.score}</span>${escapeHtml(r.text)}</li>`
      )
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

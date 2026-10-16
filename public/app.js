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

function tag() {
  return tagInput.value.trim() || "demo_user";
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return res.json();
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
  tagList.innerHTML = containerTags.map((t) => `<option value="${t}">`).join("");
}

async function refreshProfile() {
  const { profile } = await api(`/v1/profile?containerTag=${encodeURIComponent(tag())}`);

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
  const { documents } = await api(`/v1/documents?containerTag=${encodeURIComponent(tag())}`);
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
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function refreshAll() {
  await Promise.all([refreshContainers(), refreshProfile(), refreshDocs()]);
}

addBtn.addEventListener("click", async () => {
  const content = contentEl.value.trim();
  if (!content) return;
  addBtn.disabled = true;
  addStatus.textContent = "extracting…";
  try {
    const res = await api("/v1/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, containerTag: tag() }),
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
  const { results } = await api(
    `/v1/search?q=${encodeURIComponent(q)}&containerTag=${encodeURIComponent(tag())}&searchMode=${searchMode.value}`
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
}

searchBtn.addEventListener("click", runSearch);
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch();
});
tagInput.addEventListener("change", refreshAll);

refreshAll();

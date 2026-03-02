// Popup script: fetches results from background and renders them.

"use strict";

const keysList = document.getElementById("keys-list");
const noKeysMsg = document.getElementById("no-keys");
const btnClear = document.getElementById("btn-clear");

// Track which key cards have their details expanded (survives re-renders)
const expandedKeys = new Set();

async function render() {
  const results = await chrome.runtime.sendMessage({ type: "GET_RESULTS" });
  const keys = Object.keys(results || {});

  if (keys.length === 0) {
    noKeysMsg.style.display = "block";
    keysList.innerHTML = "";
    return;
  }

  noKeysMsg.style.display = "none";

  // Sort: accessible first, then checking, then denied
  keys.sort((a, b) => keyScore(results[b]) - keyScore(results[a]));

  keysList.innerHTML = keys.map((key) => renderKey(key, results[key])).join("");

  // Restore expanded state
  for (const key of expandedKeys) {
    const card = document.querySelector(`.key-card[data-key="${CSS.escape(key)}"]`);
    if (!card) continue;
    const details = card.querySelector(".details");
    const toggle = card.querySelector(".toggle-details");
    if (details && toggle) {
      details.classList.add("open");
      toggle.textContent = "\u25B2 Less";
    }
  }

  // Event delegation would be cleaner but these lists are small
  document.querySelectorAll(".btn-recheck").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      e.target.disabled = true;
      e.target.textContent = "\u23F3";
      await chrome.runtime.sendMessage({ type: "RECHECK_KEY", key: e.target.dataset.key });
      render();
    })
  );

  document.querySelectorAll(".btn-copy").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      navigator.clipboard.writeText(e.target.dataset.key);
      e.target.textContent = "\u2705";
      setTimeout(() => (e.target.textContent = "\uD83D\uDCCB"), 1500);
    })
  );

  document.querySelectorAll(".toggle-details").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      const card = e.target.closest(".key-card");
      const key = card.dataset.key;
      const details = card.querySelector(".details");
      details.classList.toggle("open");
      const isOpen = details.classList.contains("open");
      e.target.textContent = isOpen ? "\u25B2 Less" : "\u25BC More";
      isOpen ? expandedKeys.add(key) : expandedKeys.delete(key);
    })
  );
}

function keyScore(entry) {
  if (!entry.geminiResult) return 1; // checking
  return entry.geminiResult.some((r) => r.status === "ACCESSIBLE") ? 2 : 0;
}

function renderKey(key, entry) {
  const hasAccess = entry.geminiResult?.some((r) => r.status === "ACCESSIBLE");
  const isChecking = entry.status === "checking";

  const badge = isChecking
    ? '<span class="badge checking">\u23F3 Checking\u2026</span>'
    : hasAccess
      ? '<span class="badge accessible">\u2705 Gemini Access</span>'
      : '<span class="badge denied">\u274C No Access</span>';

  const endpointRows = (entry.geminiResult || [])
    .map((r) => {
      const icon = r.status === "ACCESSIBLE" ? "\u2705" : r.status === "DENIED" ? "\u274C" : "\u26A0\uFE0F";
      const detail = r.status === "ACCESSIBLE"
        ? `<span class="preview">${esc(r.preview || "")}</span>`
        : `<span class="error-msg">${esc(r.error || "")}</span>`;
      return `
        <tr>
          <td>${icon}</td>
          <td class="endpoint-name">${esc(r.endpoint)}</td>
          <td class="status-${r.status.toLowerCase()}">${r.status} (${r.httpStatus || "\u2013"})</td>
        </tr>
        <tr class="detail-row"><td colspan="3">${detail}</td></tr>`;
    })
    .join("");

  const sourcesHtml = (entry.sources || [])
    .map((s) =>
      `<li title="${esc(s.url)}"><a href="${esc(s.url)}" target="_blank">${esc(s.title || s.url)}</a></li>`
    )
    .join("");

  return `
    <div class="key-card ${hasAccess ? "has-access" : ""}" data-key="${esc(key)}">
      <div class="key-header">
        <code class="key-text">${esc(key)}</code>
        <div class="key-actions">
          <button class="btn-copy" data-key="${esc(key)}" title="Copy key">\uD83D\uDCCB</button>
          <button class="btn-recheck" data-key="${esc(key)}" title="Re-check">\uD83D\uDD04</button>
        </div>
      </div>
      <div class="key-status">
        ${badge}
        <span class="timestamp">${entry.checkedAt ? new Date(entry.checkedAt).toLocaleString() : ""}</span>
      </div>
      ${entry.geminiResult ? `
        <button class="toggle-details">\u25BC More</button>
        <div class="details">
          <table class="endpoints-table">
            <thead><tr><th></th><th>Endpoint</th><th>Status</th></tr></thead>
            <tbody>${endpointRows}</tbody>
          </table>
          ${sourcesHtml ? `<div class="sources"><strong>Found on:</strong><ul>${sourcesHtml}</ul></div>` : ""}
        </div>` : ""}
    </div>`;
}

function esc(str) {
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

// Clear all
btnClear.addEventListener("click", async () => {
  if (confirm("Clear all stored API keys?")) {
    await chrome.runtime.sendMessage({ type: "CLEAR_RESULTS" });
    render();
  }
});

// Initial render
render();

// Re-render when storage changes (new key found, check completed, etc.)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.gapi_key_results) {
    render();
  }
});

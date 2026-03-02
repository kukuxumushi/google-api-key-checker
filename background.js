// Background service worker: receives API keys from content scripts,
// checks them against the Gemini API, and stores results.

"use strict";

const STORAGE_KEY = "gapi_key_results";

// Keys currently being checked — prevents duplicate concurrent API calls
const keysInFlight = new Set();

// --- Storage helpers ---

async function loadResults() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (data) => {
      resolve(data[STORAGE_KEY] || {});
    });
  });
}

async function saveResults(results) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: results }, resolve);
  });
}

// --- Gemini API check ---

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

const ENDPOINTS = [
  { name: "List Files",  path: "/files",  method: "GET" },
  { name: "List Models", path: "/models", method: "GET" },
];

const FETCH_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

async function fetchWithTimeout(url, opts, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isRetryable(err, resp) {
  if (err) return err.name === "AbortError" || /network|failed to fetch/i.test(err.message);
  return resp && resp.status >= 500;
}

async function checkEndpoint(url, opts, retries = MAX_RETRIES) {
  for (let attempt = 0; ; attempt++) {
    let resp;
    try {
      resp = await fetchWithTimeout(url, opts);
      if (isRetryable(null, resp) && attempt < retries) {
        await delay(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
    } catch (err) {
      if (isRetryable(err) && attempt < retries) {
        await delay(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      return { resp: null, data: null, error: err };
    }

    // Parse JSON safely — some error pages return HTML or empty bodies
    let data = null;
    try {
      data = await resp.json();
    } catch {
      data = { error: { message: "Non-JSON response body" } };
    }
    return { resp, data, error: null };
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pushResult(results, name, resp, data, error) {
  if (error) {
    const msg = error.name === "AbortError" ? "Request timed out" : error.message;
    results.push({ endpoint: name, status: "ERROR", error: msg });
  } else {
    results.push({
      endpoint: name,
      status: resp.ok ? "ACCESSIBLE" : "DENIED",
      httpStatus: resp.status,
      ...(resp.ok
        ? { preview: truncate(JSON.stringify(data), 300) }
        : { error: data.error?.message || JSON.stringify(data).slice(0, 200) }),
    });
  }
}

async function checkGeminiAccess(apiKey) {
  const results = [];

  for (const ep of ENDPOINTS) {
    const url = `${GEMINI_BASE}${ep.path}?key=${apiKey}`;
    const { resp, data, error } = await checkEndpoint(url, { method: ep.method });
    pushResult(results, ep.name, resp, data, error);
  }

  return results;
}

function truncate(str, maxLen) {
  return str.length > maxLen ? str.slice(0, maxLen) + "\u2026" : str;
}

// --- Alert on accessible key ---

async function notifyIfAccessible(key, geminiResult, sourceUrl) {
  const accessible = geminiResult.filter((r) => r.status === "ACCESSIBLE");
  if (accessible.length === 0) return;

  const msg = [
    "Gemini API Key Found!",
    "",
    "Key: " + key,
    "Access: " + accessible.map((r) => r.endpoint).join(", "),
    "Source: " + sourceUrl,
  ].join("\n");

  // Try the tab that matches the source URL, fall back to active tab
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id && tab.url && sourceUrl && tab.url.startsWith(sourceUrl)) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (m) => { alert(m); },
          args: [msg],
        });
        return;
      } catch {}
    }
  }

  // Fallback: active tab
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active?.id) {
      await chrome.scripting.executeScript({
        target: { tabId: active.id },
        func: (m) => { alert(m); },
        args: [msg],
      });
    }
  } catch {
    console.log("[API Key Checker]", msg);
  }
}

// --- Badge ---

async function updateBadge(results) {
  const entries = Object.values(results);
  const working = entries.filter((r) =>
    r.geminiResult?.some((g) => g.status === "ACCESSIBLE")
  ).length;

  if (working > 0) {
    chrome.action.setBadgeText({ text: String(working) });
    chrome.action.setBadgeBackgroundColor({ color: "#e53935" });
  } else if (entries.length > 0) {
    chrome.action.setBadgeText({ text: String(entries.length) });
    chrome.action.setBadgeBackgroundColor({ color: "#757575" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

// --- Message handler ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case "KEYS_FOUND":
      enqueueKeysFound(message.keys, message.url, message.title);
      break;

    case "GET_RESULTS":
      loadResults().then(sendResponse);
      return true;

    case "CLEAR_RESULTS":
      keysInFlight.clear();
      saveResults({}).then(() => {
        updateBadge({});
        sendResponse({ ok: true });
      });
      return true;

    case "RECHECK_KEY":
      recheckKey(message.key).then(sendResponse);
      return true;
  }
});

// --- Serialised processing queue ---
// Multiple sources (content script messages, webRequest listener) can call
// handleKeysFound concurrently.  Without serialisation they each load/save
// the results object and overwrite each other's changes.

let processingQueue = Promise.resolve();

function enqueueKeysFound(keys, pageUrl, pageTitle) {
  processingQueue = processingQueue.then(() =>
    handleKeysFound(keys, pageUrl, pageTitle).catch((err) =>
      console.error("[API Key Checker] handleKeysFound error:", err)
    )
  );
}

// --- Core key processing ---

async function handleKeysFound(keys, pageUrl, pageTitle) {
  // Never record chrome-extension:// URLs as source pages
  if (pageUrl && pageUrl.startsWith("chrome-extension://")) return;

  const results = await loadResults();
  const keysToCheck = [];

  for (const key of keys) {
    // Already checked — just record the new source page
    if (results[key]?.status === "checked") {
      if (!results[key].sources.some((s) => s.url === pageUrl)) {
        results[key].sources.push({ url: pageUrl, title: pageTitle });
        await saveResults(results);
      }
      continue;
    }

    // Already in-flight — skip
    if (keysInFlight.has(key)) continue;

    // Stuck in "checking" from a previous worker restart — treat as new
    // (status is "checking" but not in keysInFlight means the worker died mid-check)

    // New key (or stuck key)
    keysInFlight.add(key);
    results[key] = {
      status: "checking",
      sources: results[key]?.sources || [{ url: pageUrl, title: pageTitle }],
      foundAt: results[key]?.foundAt || new Date().toISOString(),
      geminiResult: null,
    };
    keysToCheck.push(key);
  }

  if (keysToCheck.length > 0) {
    await saveResults(results);
    await updateBadge(results);
  }

  // Check sequentially to be gentle on the API
  for (const key of keysToCheck) {
    try {
      const geminiResult = await checkGeminiAccess(key);
      results[key].status = "checked";
      results[key].checkedAt = new Date().toISOString();
      results[key].geminiResult = geminiResult;
    } catch (err) {
      // Unexpected failure (shouldn't happen, but guarantees we never get stuck)
      console.error("[API Key Checker] checkGeminiAccess failed for", key, err);
      results[key].status = "checked";
      results[key].checkedAt = new Date().toISOString();
      results[key].geminiResult = [
        { endpoint: "All", status: "ERROR", error: err.message || String(err) },
      ];
    } finally {
      keysInFlight.delete(key);
      await saveResults(results);
      await updateBadge(results);
    }
    // Fire-and-forget so alert() doesn't block the loop
    notifyIfAccessible(key, results[key].geminiResult, pageUrl);
  }
}

/**
 * On worker startup, recover any keys stuck in "checking" from a previous crash.
 */
async function recoverStuckKeys() {
  const results = await loadResults();
  const stuck = Object.entries(results).filter(
    ([, v]) => v.status === "checking"
  );
  if (stuck.length === 0) return;

  for (const [key, entry] of stuck) {
    if (keysInFlight.has(key)) continue;
    keysInFlight.add(key);

    try {
      const geminiResult = await checkGeminiAccess(key);
      results[key].status = "checked";
      results[key].checkedAt = new Date().toISOString();
      results[key].geminiResult = geminiResult;
    } catch (err) {
      console.error("[API Key Checker] recovery check failed for", key, err);
      results[key].status = "checked";
      results[key].checkedAt = new Date().toISOString();
      results[key].geminiResult = [
        { endpoint: "All", status: "ERROR", error: err.message || String(err) },
      ];
    } finally {
      keysInFlight.delete(key);
      await saveResults(results);
      await updateBadge(results);
    }
    notifyIfAccessible(key, results[key].geminiResult, entry.sources?.[0]?.url || "");
  }
}

// Recover stuck keys when the service worker starts
recoverStuckKeys();

// --- Network request monitoring ---

const API_KEY_REGEX = /AIzaSy[\w-]{33}/g;

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Ignore requests made by this extension itself (our own Gemini API checks)
    if (details.initiator && details.initiator.startsWith("chrome-extension://")) return;

    const matches = details.url.match(API_KEY_REGEX);
    if (!matches) return;

    const keys = [...new Set(matches)];

    // Resolve the actual tab URL instead of using initiator/documentUrl
    if (details.tabId && details.tabId >= 0) {
      chrome.tabs.get(details.tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          enqueueKeysFound(keys, details.documentUrl || details.url, "");
        } else {
          enqueueKeysFound(keys, tab.url || details.url, tab.title || "");
        }
      });
    } else {
      enqueueKeysFound(keys, details.documentUrl || details.url, "");
    }
  },
  { urls: ["<all_urls>"] }
);

// --- Manual recheck ---

async function recheckKey(key) {
  const results = await loadResults();
  if (!results[key] || keysInFlight.has(key)) return results[key] || null;

  keysInFlight.add(key);
  results[key].status = "checking";
  await saveResults(results);

  try {
    const geminiResult = await checkGeminiAccess(key);
    results[key].status = "checked";
    results[key].checkedAt = new Date().toISOString();
    results[key].geminiResult = geminiResult;
  } catch (err) {
    console.error("[API Key Checker] recheckKey failed for", key, err);
    results[key].status = "checked";
    results[key].checkedAt = new Date().toISOString();
    results[key].geminiResult = [
      { endpoint: "All", status: "ERROR", error: err.message || String(err) },
    ];
  } finally {
    keysInFlight.delete(key);
    await saveResults(results);
    await updateBadge(results);
  }
  notifyIfAccessible(key, results[key].geminiResult, results[key].sources[0]?.url || "");
  return results[key];
}

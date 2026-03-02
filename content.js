// Content script: scans the page for Google API keys and sends them to the background worker.

(function () {
  "use strict";

  const API_KEY_REGEX = /AIzaSy[\w-]{33}/g;

  /**
   * Extract all unique Google API keys from a given text.
   */
  function extractKeys(text) {
    const matches = text.match(API_KEY_REGEX);
    return matches ? [...new Set(matches)] : [];
  }

  /**
   * Scan the full rendered DOM for API keys.
   * outerHTML includes all inline scripts, attributes, etc.
   */
  function scanPage() {
    return extractKeys(document.documentElement.outerHTML);
  }

  /**
   * Fetch and scan external <script src="..."> files for API keys.
   */
  const fetchedScripts = new Set();

  async function scanExternalScripts() {
    const scripts = document.querySelectorAll("script[src]");

    for (const s of scripts) {
      if (!s.src || fetchedScripts.has(s.src)) continue;
      fetchedScripts.add(s.src);

      try {
        const resp = await fetch(s.src, { credentials: "omit" });
        if (!resp.ok) continue;
        const text = await resp.text();
        sendKeysToBackground(extractKeys(text));
      } catch {
        // CORS or network error — skip silently
      }
    }
  }

  // Track keys already sent so we don't message the background twice for the same key
  const sentKeys = new Set();

  function sendKeysToBackground(keys) {
    const newKeys = keys.filter((k) => !sentKeys.has(k));
    if (newKeys.length === 0) return;

    newKeys.forEach((k) => sentKeys.add(k));

    chrome.runtime.sendMessage({
      type: "KEYS_FOUND",
      keys: newKeys,
      url: window.location.href,
      title: document.title,
    });
  }

  // --- Main execution ---

  sendKeysToBackground(scanPage());
  scanExternalScripts();

  // Watch for dynamically inserted content
  const observer = new MutationObserver(() => {
    sendKeysToBackground(scanPage());
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Stop after 30s to avoid performance drain
  setTimeout(() => observer.disconnect(), 30000);
})();

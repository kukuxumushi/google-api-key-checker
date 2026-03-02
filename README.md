# Google API Key Checker

Chrome extension that automatically detects Google API keys on websites you visit and checks whether they have access to the Gemini API.

## What it does

- **Scans pages** for Google API keys (`AIzaSy...`) in HTML source, inline scripts, element attributes, and external JavaScript files
- **Monitors network requests** for API keys passed in URLs
- **Checks each key** against the Gemini API (List Files, List Models) to determine if it has access
- **Alerts you** with a browser dialog when a key with Gemini access is found
- **Deduplicates** — each key is only checked once, results persist across sessions

## Installation

1. Clone this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the cloned folder

## How it works

The extension has three main components:

| Component | File | Role |
|---|---|---|
| Content script | `content.js` | Injected into every page. Scans the DOM and external JS files for API keys, watches for dynamic content via `MutationObserver` |
| Background worker | `background.js` | Receives keys, checks them against the Gemini API with timeout/retry logic, stores results, shows alerts, monitors network requests via `chrome.webRequest` |
| Popup UI | `popup.html/js/css` | Displays all found keys, their check status, endpoint results, and source pages. Supports copy, re-check, and clear actions |

### Key detection

Keys are matched using the pattern `AIzaSy[\w-]{33}` — the standard format for Google API keys. The content script scans:

- Full page HTML (`document.documentElement.outerHTML`)
- External `<script src="...">` files (fetched and scanned)
- Dynamically inserted content (via `MutationObserver`, active for 30s after page load)

The background worker also intercepts all outgoing network requests via `chrome.webRequest` to catch keys passed in URLs.

### Gemini API check

Each key is tested against two read-only Gemini API endpoints:

```
GET https://generativelanguage.googleapis.com/v1beta/files?key=KEY
GET https://generativelanguage.googleapis.com/v1beta/models?key=KEY
```

HTTP requests include a 15-second timeout and up to 2 retries with progressive backoff for transient failures.

### Storage

Results are stored in `chrome.storage.local` and persist across browser restarts. The extension badge shows:

- **Red** with a count — number of keys with Gemini access
- **Grey** with a count — keys found but no Gemini access
- No badge — no keys found

## Permissions

| Permission | Why |
|---|---|
| `storage` | Persist found keys and check results |
| `scripting` | Show `alert()` dialogs on pages when accessible keys are found |
| `webRequest` | Monitor outgoing network requests for API keys in URLs |
| `<all_urls>` | Content script runs on all pages; network request monitoring covers all URLs |
| `generativelanguage.googleapis.com` | Check keys against the Gemini API |

## License

MIT


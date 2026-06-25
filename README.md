# ProtectionHub

Chrome Extension (Manifest V3) that automatically intercepts Excel exports from SAP Fiori Launchpad, applies a Microsoft Information Protection (MIP) Sensitivity Label via the automatics Protection Engine, and delivers the protected file to the user.

---

## Features

- Intercepts blob-based Excel downloads (SAP UI5 `XLSXBuilder`)
- Intercepts HTTP-based Excel downloads
- Automatic extraction of SAP OData metadata (`$batch` request: service name, entity set, filter, client, language)
- Integration with automatics Protection Engine (`GetActionForm` → `ExecuteActionForm`)
- RMS/IRM encryption via Microsoft Azure Rights Management
- Configurable API endpoint URL via extension settings page
- Fallback to unprotected delivery if no endpoint is configured

---

## Prerequisites

- Google Chrome (current version)
- SAP Fiori Launchpad (On-Premise or BTP)
- automatics Protection Engine with a reachable HTTPS endpoint
- TLS certificate of the Protection Engine must be trusted on the client machine

---

## Installation (Developer Mode)

```bash
git clone <repository-url>
cd ExcelValidator_Extension
```

1. Open Chrome → `chrome://extensions`
2. Enable "Developer mode" in the top right
3. Click "Load unpacked" → select the `ExcelValidator_Extension` folder
4. The extension appears in the list as **ProtectionHub**

---

## Configuration

After installation, set the Protection Engine API endpoint:

1. Click the ProtectionHub icon → "Options" (or `chrome://extensions` → Details → Extension options)
2. Enter the API endpoint: `https://hostname:port`
3. Click "Save"

If no endpoint is configured, the download passes through without protection and a browser notification is shown.

---

## Project Structure

```
ExcelValidator_Extension/
├── manifest.json       Extension config (MV3, permissions, content scripts)
├── background.js       Service Worker: API pipeline, download control
├── content.js          Bridge: page context ↔ extension context
├── pageHook.js         Page context hooks: XHR, fetch, Blob, Anchor
├── options.html        Settings page UI
├── options.js          Settings page logic (i18n DE/EN, chrome.storage.sync)
└── style/
    └── style.css       Styles for the settings page
```

---

## How It Works

### Blob Download (SAP UI5 Standard)

```
User → Export button
  → pageHook.js intercepts URL.createObjectURL()
  → anchor.click / dispatchEvent blocked
  → Blob + SAP metadata → content.js → background.js
  → GetActionForm → ExecuteActionForm
  → chrome.downloads.download() → protected .xlsx
```

### HTTP Download

```
Browser initiates .xlsx download
  → background.js: onCreated → immediately cancelled
  → background.js fetches URL itself (credentials: include)
  → GetActionForm → ExecuteActionForm
  → chrome.downloads.download() → protected .xlsx
```

---

## SAP Compatibility

The extension activates on the following URL patterns:

```
*://*/sap/bc/ui2/flp*
*://*/sap/bc/ui5_ui5/ui2/ushell/shells/abap/*
```

For SAP BTP / Cloud Foundry, add the following patterns to `manifest.json` under `host_permissions` and `content_scripts.matches`:

```json
"*://*.launchpad.cfapps.*.hana.ondemand.com/*",
"*://*.hana.ondemand.com/site*"
```

---

## Development

### Viewing Logs

**Background Service Worker** (API calls, download logic):
`chrome://extensions` → ProtectionHub → "Service Worker" link

**Page context / Content Script** (blob hooks, SAP metadata):
DevTools of the Fiori page → Console (filter by `[PH]`, `[CS]`)

### Log Prefixes

| Prefix | Context |
|---|---|
| `[BG]` | Background Service Worker |
| `[CS]` | Content Script |
| `[PH]` | pageHook (page context) |

---

## Known Limitations

Chrome ignores the `filename` parameter in `chrome.downloads.download` when using `data:` URLs — downloads therefore run through an internal Service Worker fetch handler (`https://xl-download.invalid/`) to ensure the correct filename is used.

TLS certificates of the Protection Engine must be accepted per Chrome profile or installed system-wide as a trusted CA — self-signed certificates are blocked by Chrome without a manual exception.

---

## Branches

| Branch | Description |
|---|---|
| `main` | Stable version |
| `Enhanced` | Feature development |

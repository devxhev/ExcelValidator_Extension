console.log("[BG] Background service worker started");

const processedOriginalDownloadIds = new Set();
const recentOwnFinalDownloads = new Map(); // filename -> expiry timestamp

function extractSapMetadata(url) {
  try {
    const u = new URL(url);
    const path = u.pathname;

    const serviceMatch = path.match(/\/odata\/sap\/([^/]+)\//);
    const entityMatch = path.match(/\/odata\/sap\/[^/]+\/([^?/]+)/);

    return {
      serviceName: serviceMatch?.[1] ?? null,
      entitySet: entityMatch?.[1] ?? null,
      sapClient: u.searchParams.get("sap-client"),
      sapLanguage: u.searchParams.get("sap-language"),
      filter: u.searchParams.get("$filter"),
      select: u.searchParams.get("$select"),
      top: u.searchParams.get("$top"),
    };
  } catch {
    return null;
  }
}

function now() {
  return Date.now();
}

function cleanupRecentOwnDownloads() {
  const current = now();
  for (const [filename, expiry] of recentOwnFinalDownloads.entries()) {
    if (expiry <= current) {
      recentOwnFinalDownloads.delete(filename);
    }
  }
}

function registerOwnFinalDownload(filename) {
  cleanupRecentOwnDownloads();
  recentOwnFinalDownloads.set(filename, now() + 15000); // 15s window
  console.log("[BG] Registered own final download:", filename);
}

function isOwnFinalDownload(filename) {
  cleanupRecentOwnDownloads();
  return recentOwnFinalDownloads.has(filename);
}

function basename(path) {
  if (!path) return "";
  return path.split(/[/\\]/).pop() || "";
}

function looksLikeExcelFilename(filename) {
  return /\.(xls|xlsx|xlsm)$/i.test(filename || "");
}

function looksLikeExcelMime(mimeType) {
  if (!mimeType) return false;
  const m = mimeType.toLowerCase();
  return (
    m.includes("spreadsheetml") || m.includes("ms-excel") || m.includes("excel")
  );
}

function ensureExcelFilename(filename) {
  let safeFilename = filename;

  if (!safeFilename || safeFilename.trim() === "") {
    safeFilename = `excel_${Date.now()}.xlsx`;
  }

  const lower = safeFilename.toLowerCase();
  if (
    !lower.endsWith(".xlsx") &&
    !lower.endsWith(".xls") &&
    !lower.endsWith(".xlsm")
  ) {
    safeFilename += ".xlsx";
  }

  return safeFilename;
}

function toFileUrl(path) {
  // Windows path
  if (/^[a-zA-Z]:\\/.test(path)) {
    return "file:///" + path.replace(/\\/g, "/");
  }

  // macOS/Linux path
  if (path.startsWith("/")) {
    return "file://" + path;
  }

  throw new Error("Unsupported local file path: " + path);
}

async function readBlobFromLocalDownloadPath(localPath) {
  const fileUrl = toFileUrl(localPath);
  console.log("[BG] Reading downloaded file from:", fileUrl);

  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to read file via file:// URL: ${response.status}`);
  }

  const blob = await response.blob();
  console.log(
    "[BG] Local file loaded as blob. Size:",
    blob.size,
    "Type:",
    blob.type,
  );
  return blob;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "ping" });
    console.log("[BG] Content script already available in tab:", tabId);
  } catch (e) {
    console.log("[BG] Injecting content script into tab:", tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  }
}

async function sendProcessedFileToTab(tabId, blob, filename) {
  if (tabId == null || tabId < 0) {
    throw new Error("No valid tabId available for final download");
  }

  await ensureContentScript(tabId);

  const safeFilename = ensureExcelFilename(filename);
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = Array.from(new Uint8Array(arrayBuffer));

  registerOwnFinalDownload(safeFilename);

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabId,
      {
        action: "TRIGGER_PROCESSED_DOWNLOAD",
        filename: safeFilename,
        mimeType:
          blob.type ||
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        data: bytes,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!response || !response.success) {
          reject(
            new Error(
              response?.error || "Final content-script download failed",
            ),
          );
          return;
        }

        console.log("[BG] Final processed download triggered in tab:", tabId);
        resolve();
      },
    );
  });
}

async function processExcelBlob(blob, filename, sapMeta) {
  console.log("[BG] processExcelBlob called");
  console.log("[BG] Incoming filename:", filename);
  console.log("[BG] Incoming blob size:", blob.size);
  console.log("[BG] Incoming blob type:", blob.type);
  console.log("[BG] SAP Metadata: ", sapMeta);

  // const formData = new FormData();
  // formData.append("file", blob, filename);
  //
  const response = await fetch("https://excel-validator.free.beeceptor.com", {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(`API failed: ${response.status}`);
  } else console.log("API Aufruf war erfolgreich mit API Response: ", response);
  //
  // const processedBuffer = await response.arrayBuffer();
  // return new Blob([processedBuffer], {
  //   type: blob.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  // });
  // ---------------------------------------------------

  console.log("[BG] Demo mode: returning original blob unchanged");
  return blob;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action !== "PROCESS_BLOB_EXCEL") {
    return false;
  }

  (async () => {
    try {
      console.log("[BG] Received PROCESS_BLOB_EXCEL message");

      const tabId = sender.tab?.id;
      if (tabId == null) {
        throw new Error("No sender tab available for blob processing");
      }

      if (!Array.isArray(message.data) || message.data.length === 0) {
        throw new Error("No blob data received from content script");
      }

      const filename = ensureExcelFilename(message.filename);
      const blob = new Blob([new Uint8Array(message.data)], {
        type:
          message.mimeType ||
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      console.log("[BG] Blob reconstructed from content script");
      console.log("[BG] Filename:", filename);
      console.log("[BG] Size:", blob.size);
      console.log("[BG] Type:", blob.type);

      const processedBlob = await processExcelBlob(
        blob,
        filename,
        message.sapMeta ?? null,
      );
      await sendProcessedFileToTab(tabId, processedBlob, filename);

      sendResponse({ success: true });
    } catch (error) {
      console.error("[BG] PROCESS_BLOB_EXCEL failed:", error);
      sendResponse({ success: false, error: error.message });
    }
  })();

  return true;
});
// manifest.json — zusätzliche Permission nötig:
// "permissions": ["declarativeNetRequest", "downloads", "tabs", ...]

// background.js — eleganteste Lösung:
// Download-URL abfangen BEVOR der Browser-Download startet

chrome.downloads.onCreated.addListener(async (downloadItem) => {
  if (isOwnFinalDownload(basename(downloadItem.filename || ""))) return;

  const base = basename(downloadItem.filename || downloadItem.url);
  if (
    !downloadItem.url.startsWith("http") ||
    (!looksLikeExcelFilename(base) && !looksLikeExcelMime(downloadItem.mime))
  )
    return;

  const sapMeta = extractSapMetadata(downloadItem.url);
  // Sofort canceln — Browser hat noch nichts auf Disk
  // (onCreated feuert VOR dem tatsächlichen Download)
  await chrome.downloads.cancel(downloadItem.id);
  await chrome.downloads.erase({ id: downloadItem.id });

  console.log("[BG] Intercepted before disk write:", base);

  try {
    // Credentials mitschicken falls nötig (Session-Cookies etc.)
    const response = await fetch(downloadItem.url, {
      credentials: "include", // wichtig: Session-Auth vom Tab mitnutzen
    });

    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);

    const blob = await response.blob();
    const processedBlob = await processExcelBlob(blob, base, sapMeta);

    let tabId = downloadItem.tabId;
    if (!tabId || tabId < 0) {
      const [active] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      tabId = active?.id;
    }

    await sendProcessedFileToTab(tabId, processedBlob, base);
  } catch (err) {
    console.error("[BG] Direct fetch after cancel failed:", err);
  }
});

/*
chrome.downloads.onChanged.addListener(async (delta) => {
  try {
    if (!delta.state || delta.state.current !== "complete") {
      return;
    }

    const downloadId = delta.id;

    if (processedOriginalDownloadIds.has(downloadId)) {
      console.log("[BG] Download already processed:", downloadId);
      return;
    }

    const [downloadItem] = await chrome.downloads.search({ id: downloadId });

    if (!downloadItem) {
      console.log("[BG] Download item not found:", downloadId);
      return;
    }

    console.log("[BG] Download completed:", downloadItem);

    const localFilename = downloadItem.filename || "";
    const base = basename(localFilename);

    // Ignore our own final downloads
    if (isOwnFinalDownload(base)) {
      console.log("[BG] Ignoring own final download:", base);
      recentOwnFinalDownloads.delete(base);
      return;
    }

    // Only handle normal HTTP/HTTPS downloads here
    if (
      !downloadItem.url.startsWith("http://") &&
      !downloadItem.url.startsWith("https://")
    ) {
      console.log("[BG] Not an HTTP(S) download, ignoring in onChanged");
      return;
    }

    const looksLikeExcel =
      looksLikeExcelFilename(base) || looksLikeExcelMime(downloadItem.mime);

    if (!looksLikeExcel) {
      console.log("[BG] Not an Excel HTTP download, ignoring");
      return;
    }

    if (!downloadItem.filename) {
      console.log("[BG] No local filename on completed HTTP download");
      return;
    }

    processedOriginalDownloadIds.add(downloadId);

    console.log("[BG] Processing completed HTTP Excel download:", base);

    const blob = await readBlobFromLocalDownloadPath(downloadItem.filename);
    const processedBlob = await processExcelBlob(blob, base);

    let tabId = downloadItem.tabId;
    if (tabId == null || tabId < 0) {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      tabId = activeTab?.id;
      console.log("[BG] Fallback active tab used:", tabId);
    }

    await sendProcessedFileToTab(tabId, processedBlob, base);

    // Optional: remove original file from disk
    try {
      await chrome.downloads.removeFile(downloadId);
      console.log("[BG] Original HTTP download removed from disk:", downloadId);
    } catch (removeError) {
      console.warn("[BG] Could not remove original file:", removeError);
    }
  } catch (error) {
    console.error("[BG] Error in downloads.onChanged:", error);
  }
});
 */

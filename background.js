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
async function triggerDownloadViaAPI(blob, filename) {
  const safeFilename = ensureExcelFilename(filename);

  const arrayBuffer = await blob.arrayBuffer();

  registerOwnFinalDownload(safeFilename);

  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  const mimeType =
    blob.type ||
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const dataUrl = `data:${mimeType};base64,${base64}`;

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: dataUrl,
        filename: safeFilename,
        saveAs: false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (downloadId == null) {
          reject(new Error("Download failed to start"));
          return;
        }

        console.log("[BG] Final processed download triggered, id:", downloadId);
        resolve();
      },
    );
  });
}
const ENGINE_SERVER = "https://10.41.14.34:8746";
async function processExcelBlob(blob, filename, sapMeta, tabId) {
  console.log("[BG] processExcelBlob called for: ", filename);
  try {
    const { endpoint } = await chrome.storage.sync.get("endpoint");

    if (tabId != null) {
      if (endpoint == undefined) {
        chrome.tabs.sendMessage(tabId, {
          action: "showAlert",
          text: "ProtectionHub Extension: No endpoint is configured. Please configure an endpoint in the extension settings. The original file download will proceed without validation.",
        });
        return blob;
      }
    }

    const actionForm = await getActionForm(endpoint, filename, sapMeta);

    const protectedBlob = await executeActionForm(
      endpoint,
      blob,
      filename,
      actionForm,
    );

    return protectedBlob;
  } catch (error) {
    console.log("[BG] Protection Engine called failed: ", error);
    return blob;
  }
}

async function getActionForm(engine_server, filename, sapMeta) {
  const customerIdXml = `<id>
  <customer_id>engine_customer</customer_id>
  <system_id>API</system_id>
  <system_type>ENGINE_API</system_type>
  </id>`;

  const metadataXml = `<metadata>
  <general_metadata>
    <simple_value>
      <entry>
          <key>user_name</key>
          <value>xhevi</value>
        </entry>
      <entry>
          <key>sap_service</key>
          <value>${escapeXml(sapMeta?.serviceName ?? "")}</value>
        </entry>
        <entry>
          <key>sap_entity</key>
          <value>${escapeXml(sapMeta?.entitySet ?? "")}</value>
        </entry>
        <entry>
          <key>filename</key>
          <value>${escapeXml(filename)}</value>
        </entry>
    </simple_value>
  </general_metadata>
</metadata>`;

  const formData = new FormData();
  formData.append("customerIdentification", customerIdXml);
  formData.append("metadata", metadataXml);
  const response = await fetch(
    `${engine_server}/engine-server/serverprocess/GetActionForm`,
    {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "multipart/form-data",
      },
    },
  );

  if (!response.ok) throw new Error(`GetActionForm failed: ${response.status}`);

  const rawText = await response.text();
  console.log("[BG] GetActionForm response received");
  return parseMultipartResponse(rawText);
}
async function executeActionForm(engine_server, blob, filename, actionForm) {
  const customerIdXml = `<id>
  <customer_id>engine_customer</customer_id>
  <system_id>API</system_id>
  <system_type>ENGINE_API</system_type>
  </id>`;

  const formData = new FormData();
  formData.append("customerIdentification", customerIdXml);
  formData.append("action", actionForm.action.replace("AUDIT", "LABEL"));
  formData.append("template", actionForm.template);
  formData.append("classification", actionForm.classification);
  formData.append(
    "extendedTags",
    actionForm.extendedTags ?? "<extended_tags></extended_tags>",
  );

  if (actionForm.userEmailNeeded) {
    formData.append("author", "<author>user@example.com</author>"); // dynamisch setzen
  } else {
    formData.append("author", "<author>?</author>");
  }

  formData.append("file_size", String(blob.size));
  formData.append("file", blob, filename);
  const response = await fetch(
    `${engine_server}/engine-server/serverprocess/ExecuteActionForm`,
    {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "multipart/form-data",
      },
    },
  );
  if (!response.ok)
    throw new Error("ExecuteActionForm failed: ", response.status);

  const contentType = response.headers.get("content-type");
  const rawBuffer = await response.arrayBuffer();

  const boundaryMatch = contentType?.match(/boundary=([^;]+)/);
  const boundary = boundaryMatch?.[1];

  const protectedFileBuffer = extractFileFromMultipart(rawBuffer, boundary);
  console.log("[BG] File protected, new size:", protectedFileBuffer.byteLength);

  return new Blob([protectedFileBuffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
//Helpers
function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extractFileFromMultipart(arrayBuffer, boundary) {
  const bytes = new Uint8Array(arrayBuffer);
  const decoder = new TextDecoder("latin1"); // wichtig: latin1, nicht utf-8 (Binärdaten!)
  const text = decoder.decode(bytes);

  const boundaryStr = `--uuid:${boundary?.replace("uuid:", "")}`;
  const fileMarker = "Content-ID: <file>";

  const fileMarkerIndex = text.indexOf(fileMarker);
  if (fileMarkerIndex === -1) {
    throw new Error("File part not found in multipart response");
  }

  const headerEnd = text.indexOf("\r\n\r\n", fileMarkerIndex);
  const dataStart =
    headerEnd !== -1
      ? headerEnd + 4
      : text.indexOf("\n\n", fileMarkerIndex) + 2;

  const nextBoundaryIndex = text.indexOf(boundaryStr, dataStart);
  const dataEndApprox =
    nextBoundaryIndex !== -1 ? nextBoundaryIndex : text.length;

  let dataEnd = dataEndApprox;
  while (
    dataEnd > dataStart &&
    (bytes[dataEnd - 1] === 0x0a ||
      bytes[dataEnd - 1] === 0x0d ||
      bytes[dataEnd - 1] === 0x2d)
  ) {
    dataEnd--;
  }

  return bytes.slice(dataStart, dataEnd);
}

function parseMultipartResponse(rawText) {
  const boundaryMatch = rawText.match(/--uuid:[^\r\n]+/);
  const boundary = boundaryMatch?.[0];
  if (!boundary) throw new Error("No boundary found in multipart response");

  const parts = rawText
    .split(boundary)
    .filter((p) => p.trim() && p.trim() !== "--");

  const result = {
    action: null,
    template: null,
    classification: null,
    userEmailNeeded: false,
    extendedTags: null,
  };

  for (const part of parts) {
    if (part.includes('name="action"')) {
      result.action = extractXmlBody(part);
    } else if (part.includes('name="template"')) {
      result.template = extractXmlBody(part);
    } else if (part.includes('name="classification"')) {
      result.classification = extractXmlBody(part);
    } else if (part.includes('name="authorMode"')) {
      const authorModeXml = extractXmlBody(part);
      result.userEmailNeeded = authorModeXml.includes(
        "<user_email_needed>true</user_email_needed>",
      );
    }
  }

  return result;
}

function extractXmlBody(part) {
  const xmlStart = part.indexOf("<?xml");
  if (xmlStart === -1) return part.trim();
  return part.slice(xmlStart).trim();
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
        tabId,
      );
      await triggerDownloadViaAPI(processedBlob, filename);

      sendResponse({ success: true });
    } catch (error) {
      console.error("[BG] PROCESS_BLOB_EXCEL failed:", error);
      sendResponse({ success: false, error: error.message });
    }
  })();

  return true;
});

chrome.downloads.onCreated.addListener(async (downloadItem) => {
  // data: URLs sind unsere eigenen finalen Downloads — niemals abfangen
  if (downloadItem.url.startsWith("data:")) {
    console.log("[BG] Ignoring own data: URL download");
    return;
  }

  // Filename aus URL extrahieren (downloadItem.filename ist bei onCreated leer)
  const urlBase = basename(downloadItem.url.split("?")[0]);
  const base = urlBase || `excel_${Date.now()}.xlsx`;

  // Eigenen Download über registrierten Filename erkennen
  if (isOwnFinalDownload(base)) {
    console.log("[BG] Ignoring own registered download:", base);
    recentOwnFinalDownloads.delete(base);
    return;
  }

  // Nur HTTP/HTTPS Excel-Downloads
  if (
    !downloadItem.url.startsWith("http") ||
    (!looksLikeExcelFilename(base) && !looksLikeExcelMime(downloadItem.mime))
  )
    return;

  const sapMeta = extractSapMetadata(downloadItem.url);

  await chrome.downloads.cancel(downloadItem.id);
  await chrome.downloads.erase({ id: downloadItem.id });

  console.log("[BG] HTTP Excel intercepted:", base);

  try {
    const response = await fetch(downloadItem.url, { credentials: "include" });
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);

    const blob = await response.blob();
    const processedBlob = await processExcelBlob(blob, base, sapMeta, null);

    await triggerDownloadViaAPI(processedBlob, base);
  } catch (err) {
    console.error("[BG] HTTP intercept failed:", err);
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

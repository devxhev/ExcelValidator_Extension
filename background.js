console.log("Background Script geladen");

const pendingUrls = new Set();
let originalFileNames = new Map();
let finalFileName = "";

function isExcelDownload(downloadItem) {
  return (
    /\.(xls|xlsx|xlsm)$/i.test(downloadItem.filename) ||
    downloadItem.mime ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    downloadItem.mime === "application/vnd.ms-excel"
  );
}
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  if (
    (downloadItem.state && downloadItem.state !== "in_progress") ||
    !isExcelDownload(downloadItem)
  ) {
    suggest();
    return;
  }

  if (downloadItem.byExtensionId) {
    suggest({ filename: originalFileNames.get(downloadItem.id - 1) });
    return;
  }

  originalFileNames.set(downloadItem.id, downloadItem.filename);
  finalFileName = downloadItem.filename;

  suggest({ filename: finalFileName });
});

// Download erkannt
chrome.downloads.onCreated.addListener(async (downloadItem) => {
  console.log("Download erkannt:", downloadItem.filename);

  // eigenen Download ignorieren
  if (pendingUrls.has(downloadItem.url)) {
    console.log("Ignoriere eigenen Download");
    pendingUrls.delete(downloadItem.url);
    return;
  }

  if (!isExcelDownload(downloadItem)) return;

  try {
    await chrome.downloads.cancel(downloadItem.id);
    console.log("Download abgebrochen");

    if (downloadItem.url.startsWith("http")) {
      await handleNormalDownload(downloadItem);
    } else if (downloadItem.url.startsWith("blob:")) {
      await handleBlobDownload(downloadItem);
    }
  } catch (error) {
    console.error("Fehler:", error);

    pendingUrls.add(downloadItem.url);

    await chrome.downloads.download({
      url: downloadItem.url,
      filename: downloadItem.filename,
    });
  }
});

// HTTP Download
async function handleNormalDownload(downloadItem) {
  console.log("HTTP Download erkannt");

  const response = await fetch(downloadItem.url);
  const blob = await response.blob();

  await processAndDownload(blob);
}

// Blob Download
async function handleBlobDownload(downloadItem) {
  console.log("Blob Download erkannt");

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (!tab) {
    throw new Error("Kein Tab gefunden");
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { action: "ping" });
  } catch {
    console.log("Content Script nicht geladen → injiziere");

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
  }

  chrome.tabs.sendMessage(
    tab.id,
    {
      action: "getBlob",
      url: downloadItem.url,
    },
    async (response) => {
      if (chrome.runtime.lastError) {
        console.error("Message Fehler:", chrome.runtime.lastError);
        return;
      }

      if (!response || !response.success) {
        console.error("Blob konnte nicht geholt werden");
        return;
      }

      const blob = new Blob([new Uint8Array(response.data)], {
        type: response.mimeType,
      });

      await processAndDownload(blob);
    },
  );
}

// API + Download
async function processAndDownload(blob) {
  console.log("Verarbeite Datei, Größe:", blob.size);

  let safeFilename = finalFileName;

  if (!safeFilename) {
    safeFilename = `excel_${Date.now()}.xlsx`;
  }

  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  let binary = "";

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  const base64 = btoa(binary);

  const dataUrl = `data:${blob.type};base64,${base64}`;

  pendingUrls.add(dataUrl);

  await chrome.downloads.download({
    url: dataUrl,
    filename: safeFilename,
    conflictAction: "overwrite",
  });

  console.log("Download gestartet");

  setTimeout(() => {
    pendingUrls.delete(dataUrl);
  }, 5000);
}

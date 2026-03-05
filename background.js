console.log("Background Script geladen");

const pendingUrls = new Set();

chrome.downloads.onCreated.addListener(async (downloadItem) => {
  console.log("Download erkannt:", downloadItem);
  console.log("Filename:", downloadItem.filename);
  console.log("URL:", downloadItem.url);

  if (pendingUrls.has(downloadItem.url)) {
    console.log("Ignoriere eigenen Download - URL bekannt:", downloadItem.url);
    pendingUrls.delete(downloadItem.url);
    return;
  }

  try {
    await chrome.downloads.cancel(downloadItem.id);
    console.log("Download abgebrochen");

    if (
      downloadItem.url.startsWith("http") &&
      !downloadItem.url.startsWith("blob:")
    ) {
      console.log("Normale HTTP URL, direkt verarbeiten");
      await handleNormalDownload(downloadItem);
    } else if (downloadItem.url.startsWith("blob:")) {
      console.log("Blob URL erkannt, suche Tab...");
      await handleBlobDownload(downloadItem);
    }
  } catch (error) {
    console.error("Fehler:", error);
    const fallbackUrl = downloadItem.url;
    pendingUrls.add(fallbackUrl);
    await chrome.downloads.download({
      url: fallbackUrl,
      filename: downloadItem.filename,
    });
  }
});

async function handleNormalDownload(downloadItem) {
  try {
    const response = await fetch(downloadItem.url);
    const blob = await response.blob();
    await processAndDownload(blob, downloadItem.filename);
  } catch (error) {
    console.error("Fehler bei normalem Download:", error);
    throw error;
  }
}

async function handleBlobDownload(downloadItem) {
  const splittedUrl = downloadItem.url.split(":");
  const tabs = await chrome.tabs.query({
    url: splittedUrl[1] + ":" + splittedUrl[2],
  });

  if (tabs.length === 0) {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (activeTab) {
      tabs.push(activeTab);
    }
  }

  if (tabs.length === 0) {
    throw new Error("Kein passender Tab gefunden");
  }

  console.log("Tab gefunden:", tabs[0].id);

  try {
    await chrome.tabs.sendMessage(tabs[0].id, { action: "ping" });
  } catch (e) {
    console.log("Content Script nicht geladen, injiziere...");
    await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      files: ["content.js"],
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  chrome.tabs.sendMessage(
    tabs[0].id,
    {
      action: "getBlob",
      url: downloadItem.url,
      filename: downloadItem.filename,
    },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error("Fehler beim Senden:", chrome.runtime.lastError);
        return;
      }

      console.log("Antwort von Content Script:", response);

      if (response && response.success) {
        const blob = new Blob([new Uint8Array(response.data)], {
          type: response.mimeType,
        });

        processAndDownload(blob, downloadItem.filename).catch((error) => {
          console.error("Fehler bei API:", error);
        });
      } else {
        console.error("Konnte Blob nicht holen:", response?.error);
      }
    },
  );
}

async function processAndDownload(blob, filename) {
  console.log("Sende an API, Größe:", blob.size, "Bytes");

  let safeFilename = filename;

  if (!safeFilename || safeFilename.trim() === "") {
    const now = new Date();
    const timestamp = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}_${now.getHours().toString().padStart(2, "0")}-${now.getMinutes().toString().padStart(2, "0")}-${now.getSeconds().toString().padStart(2, "0")}`;
    safeFilename = `excel_${timestamp}.xlsx`;
    console.log("📛 Dateiname war leer, verwende:", safeFilename);
  }

  if (
    !safeFilename.toLowerCase().endsWith(".xlsx") &&
    !safeFilename.toLowerCase().endsWith(".xls")
  ) {
    safeFilename += ".xlsx";
    console.log("📛 Dateiendung hinzugefügt:", safeFilename);
  }

  try {
    let response = await fetch(
      "https://excel-transformer.free.beeceptor.com/todos",
      {
        method: "GET",
      },
    );

    console.log("Reponse from API: ", response);
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    let binary = "";
    const chunkSize = 65536;

    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      for (let j = 0; j < chunk.length; j++) {
        binary += String.fromCharCode(chunk[j]);
      }
    }

    const base64 = btoa(binary);
    const dataUrl = `data:${blob.type || "application/octet-stream"};base64,${base64}`;

    pendingUrls.add(dataUrl);
    console.log(
      "➕ URL zum Ignorieren hinzugefügt:",
      dataUrl.substring(0, 50) + "...",
    );

    await chrome.downloads.download({
      url: dataUrl,
      filename: safeFilename,
      conflictAction: "overwrite",
    });

    console.log("✅ Download erfolgreich gestartet");

    setTimeout(() => {
      pendingUrls.delete(dataUrl);
      console.log("➖ URL aus Ignorier-Liste entfernt");
    }, 5000);
  } catch (error) {
    console.error("❌ Download fehlgeschlagen:", error);
    pendingUrls.delete(dataUrl);
  }
}

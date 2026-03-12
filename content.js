console.log("[CS] content.js loaded on:", window.location.href);

// =====================================================
// Inject pageHook.js into real page context
// =====================================================
(function injectPageHook() {
  try {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("pageHook.js");
    script.type = "text/javascript";

    script.onload = () => {
      console.log("[CS] pageHook.js successfully injected");
      script.remove();
    };

    script.onerror = (e) => {
      console.error("[CS] pageHook.js failed to load", e);
    };

    (document.head || document.documentElement).appendChild(script);
  } catch (error) {
    console.error("[CS] Failed to inject pageHook.js:", error);
  }
})();

// =====================================================
// Trigger final browser download from tab context
// =====================================================
function triggerFinalDownload(data, mimeType, filename) {
  console.log("[CS] triggerFinalDownload called");
  console.log("[CS] filename:", filename);
  console.log("[CS] mimeType:", mimeType);
  console.log("[CS] byteLength:", data?.length);

  const bytes = new Uint8Array(data);
  const blob = new Blob([bytes], {
    type: mimeType || "application/octet-stream",
  });

  const objectUrl = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename || `excel_${Date.now()}.xlsx`;
  anchor.style.display = "none";

  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  console.log("[CS] Final processed download started");

  setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
    console.log("[CS] Final processed download object URL revoked");
  }, 5000);
}

// =====================================================
// Receive messages from pageHook.js
// =====================================================
window.addEventListener("message", (event) => {
  try {
    if (event.source !== window) return;

    const msg = event.data;
    if (!msg || msg.source !== "excel-transformer-pagehook") return;

    if (msg.type !== "INTERCEPTED_EXCEL_BLOB_DOWNLOAD") return;

    console.log(
      "[CS] Received intercepted blob-based Excel download from pageHook",
    );
    console.log("[CS] filename:", msg.filename);
    console.log("[CS] mimeType:", msg.mimeType);
    console.log("[CS] data length:", msg.data?.length);

    chrome.runtime.sendMessage(
      {
        action: "PROCESS_BLOB_EXCEL",
        filename: msg.filename,
        mimeType: msg.mimeType,
        data: msg.data,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error(
            "[CS] Error sending blob to background:",
            chrome.runtime.lastError,
          );
          return;
        }

        if (!response || !response.success) {
          console.error("[CS] Background processing failed:", response?.error);
          return;
        }

        console.log(
          "[CS] Background finished processing intercepted blob download",
        );
      },
    );
  } catch (error) {
    console.error("[CS] Error handling window message:", error);
  }
});

// =====================================================
// Messages from background
// =====================================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.action === "ping") {
    console.log("[CS] Ping received");
    sendResponse({ pong: true });
    return false;
  }

  if (request?.action === "TRIGGER_PROCESSED_DOWNLOAD") {
    try {
      console.log("[CS] Received TRIGGER_PROCESSED_DOWNLOAD from background");
      triggerFinalDownload(request.data, request.mimeType, request.filename);
      sendResponse({ success: true });
    } catch (error) {
      console.error("[CS] Failed to trigger processed download:", error);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  return false;
});

(function () {
  console.log("[PH] pageHook.js injected into page context");

  const blobRegistry = new Map();
  const batchMetaByService = new Map();

  let lastHash = window.location.hash;

  window.addEventListener("hashchange", () => {
    const newHash = window.location.hash;
    const oldApp = lastHash.split("-")[0];
    const newApp = newHash.split("-")[0];
    if (oldApp !== newApp) {
      console.log(
        "[PH] App changed, clearing batch cache:",
        oldApp,
        "→",
        newApp,
      );
      batchMetaByService.clear();
    }
    lastHash = newHash;
  });

  function storeBatchMeta(meta) {
    if (!meta.serviceName) return;
    if (!batchMetaByService.has(meta.serviceName)) {
      batchMetaByService.set(meta.serviceName, []);
    }
    batchMetaByService.get(meta.serviceName).push(meta);
    console.log("[PH] Stored batch meta:", meta.serviceName, meta.entitySet);
  }

  function findBestBatchMeta() {
    const allMetas = [...batchMetaByService.values()].flat();
    if (allMetas.length === 0) return null;
    allMetas.sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0));
    const withSelect = allMetas.find((m) => m.select !== null);
    if (withSelect) return withSelect;
    const withTop = allMetas.find((m) => m.top !== null);
    if (withTop) return withTop;
    return allMetas[0];
  }

  // XHR Hook
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._url = url;
    this._method = method;
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    this._requestBody = typeof body === "string" ? body : null;

    this.addEventListener("load", function () {
      try {
        if (!this._url?.includes("/sap/opu/odata/")) return;

        const u = new URL(this._url, window.location.origin);
        const path = u.pathname;
        const isBatch = path.endsWith("/$batch");

        const serviceMatch = path.match(/\/odata\/[^/]+\/([^/]+)/);
        const serviceName = serviceMatch?.[1];
        if (!serviceName) return;

        let entitySet = null,
          filter = null,
          select = null,
          top = null,
          skip = null;

        if (isBatch && this._requestBody) {
          const getMatch = this._requestBody.match(
            /GET\s+([^\s?]+)(\?[^\s]*)?\s/,
          );
          if (getMatch) {
            entitySet = getMatch[1];
            if (getMatch[2]) {
              const params = new URLSearchParams(getMatch[2].slice(1));
              filter = params.get("$filter");
              select = params.get("$select");
              top = params.get("$top");
              skip = params.get("$skip");
            }
          }
        } else {
          const entityMatch = path.match(/\/odata\/[^/]+\/[^/]+\/([^?/]+)/);
          entitySet = entityMatch?.[1];
          filter = u.searchParams.get("$filter");
          select = u.searchParams.get("$select");
          top = u.searchParams.get("$top");
          skip = u.searchParams.get("$skip");
        }

        storeBatchMeta({
          serviceName,
          entitySet,
          isBatch,
          sapClient: u.searchParams.get("sap-client"),
          sapLanguage: u.searchParams.get("sap-language"),
          filter,
          select,
          top,
          skip,
          odataVersion: this.getResponseHeader("dataserviceversion"),
          processingInfo: this.getResponseHeader("sap-processing-info"),
          sapServer: this.getResponseHeader("sap-server"),
          capturedAt: Date.now(),
        });
      } catch (e) {
        console.error("[PH] XHR send hook error:", e);
      }
    });

    return originalSend.apply(this, arguments);
  };

  // fetch Hook
  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const response = await originalFetch.apply(this, arguments);

    try {
      const url = typeof input === "string" ? input : input?.url;
      if (!url?.includes("/sap/opu/odata/")) return response;

      const u = new URL(url, window.location.origin);
      const path = u.pathname;
      const serviceMatch = path.match(/\/odata\/[^/]+\/([^/]+)/);
      const entityMatch = path.match(/\/odata\/[^/]+\/[^/]+\/([^?/]+)/);

      storeBatchMeta({
        url,
        serviceName: serviceMatch?.[1],
        entitySet: entityMatch?.[1],
        sapClient: u.searchParams.get("sap-client"),
        sapLanguage: u.searchParams.get("sap-language"),
        filter: u.searchParams.get("$filter"),
        select: u.searchParams.get("$select"),
        top: u.searchParams.get("$top"),
        odataVersion: response.headers.get("dataserviceversion"),
        processingInfo: response.headers.get("sap-processing-info"),
        sapServer: response.headers.get("sap-server"),
        capturedAt: Date.now(),
      });
    } catch (e) {
      console.error("[PH] fetch hook error:", e);
    }

    return response;
  };

  function looksLikeExcelBlob(blob) {
    if (!blob) return false;
    const type = (blob.type || "").toLowerCase();
    return (
      type.includes("spreadsheetml") ||
      type.includes("ms-excel") ||
      type.includes("excel")
    );
  }

  // Filename: nimm was SAP gibt, Fallback nur wenn wirklich leer
  function resolveFilename(downloadAttr) {
    const trimmed = downloadAttr?.trim();
    if (trimmed && trimmed !== "") return trimmed;
    return `excel_${Date.now()}.xlsx`;
  }

  // URL.createObjectURL Hook
  const originalCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    const objectUrl = originalCreateObjectURL(blob);
    if (looksLikeExcelBlob(blob)) {
      const sapMeta = findBestBatchMeta();
      console.log(
        "[PH] Excel blob registered, best batch:",
        sapMeta?.entitySet,
      );
      blobRegistry.set(objectUrl, {
        blob,
        mimeType: blob.type,
        size: blob.size,
        sapMeta,
      });
    }
    return objectUrl;
  };

  // anchor.click Hook
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...args) {
    try {
      const href = this.href;
      const downloadAttr = this.download;

      if (href && href.startsWith("blob:") && blobRegistry.has(href)) {
        const entry = blobRegistry.get(href);
        console.log(
          "[PH] anchor.click intercepted, downloadAttr:",
          downloadAttr,
        );

        const reader = new FileReader();
        reader.onload = function () {
          try {
            const bytes = Array.from(new Uint8Array(reader.result));
            window.postMessage(
              {
                source: "excel-transformer-pagehook",
                type: "INTERCEPTED_EXCEL_BLOB_DOWNLOAD",
                filename: resolveFilename(downloadAttr),
                mimeType:
                  entry.mimeType ||
                  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                data: bytes,
                sapMeta: entry.sapMeta ?? null,
              },
              "*",
            );
          } catch (error) {
            console.error("[PH] Failed to post intercepted blob:", error);
          }
        };
        reader.onerror = () => console.error("[PH] FileReader failed");
        reader.readAsArrayBuffer(entry.blob);
        return;
      }
    } catch (error) {
      console.error("[PH] Error in anchor click hook:", error);
    }
    return originalAnchorClick.apply(this, args);
  };

  // dispatchEvent Hook
  const originalDispatchEvent = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (event) {
    try {
      if (
        this instanceof HTMLAnchorElement &&
        event.type === "click" &&
        this.href?.startsWith("blob:") &&
        blobRegistry.has(this.href)
      ) {
        const entry = blobRegistry.get(this.href);
        const downloadAttr = this.download;
        console.log(
          "[PH] dispatchEvent click intercepted, downloadAttr:",
          downloadAttr,
        );

        const reader = new FileReader();
        reader.onload = function () {
          try {
            const bytes = Array.from(new Uint8Array(reader.result));
            window.postMessage(
              {
                source: "excel-transformer-pagehook",
                type: "INTERCEPTED_EXCEL_BLOB_DOWNLOAD",
                filename: resolveFilename(downloadAttr),
                mimeType:
                  entry.mimeType ||
                  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                data: bytes,
                sapMeta: entry.sapMeta ?? null,
              },
              "*",
            );
          } catch (e) {
            console.error("[PH] dispatchEvent intercept post failed:", e);
          }
        };
        reader.readAsArrayBuffer(entry.blob);
        return true;
      }
    } catch (e) {
      console.error("[PH] Error in dispatchEvent hook:", e);
    }
    return originalDispatchEvent.call(this, event);
  };

  // MutationObserver Hook
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (
          node instanceof HTMLAnchorElement &&
          node.href?.startsWith("blob:") &&
          blobRegistry.has(node.href)
        ) {
          console.log(
            "[PH] MutationObserver: blob anchor added, downloadAttr:",
            node.download,
          );
          const entry = blobRegistry.get(node.href);
          const downloadAttr = node.download;

          node.addEventListener(
            "click",
            (e) => {
              e.preventDefault();
              e.stopImmediatePropagation();
              const reader = new FileReader();
              reader.onload = function () {
                const bytes = Array.from(new Uint8Array(reader.result));
                window.postMessage(
                  {
                    source: "excel-transformer-pagehook",
                    type: "INTERCEPTED_EXCEL_BLOB_DOWNLOAD",
                    filename: resolveFilename(downloadAttr),
                    mimeType:
                      entry.mimeType ||
                      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    data: bytes,
                    sapMeta: entry.sapMeta ?? null,
                  },
                  "*",
                );
              };
              reader.readAsArrayBuffer(entry.blob);
            },
            { capture: true },
          );
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  console.log("[PH] pageHook hooks installed");
})();

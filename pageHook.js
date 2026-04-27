(function () {
  console.log("[PH] pageHook.js injected into page context");

  const blobRegistry = new Map();

  const batchMetaByService = new Map();

  // =====================================================
  // XHR hooken — SAP nutzt XMLHttpRequest für OData
  // =====================================================
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  let lastHash = window.location.hash;

  window.addEventListener("hashchange", () => {
    const newHash = window.location.hash;

    // Nur leeren wenn sich die App wirklich geändert hat
    // Fiori Hash: #ZAUTHOR_CV_CDS-manage&... → #ZBOOK_CV_CDS-manage&...
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

    // Nach Timestamp sortieren — neuester zuerst
    allMetas.sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0));

    // Priorität 1: hat $select (konkrete Tabellenspalten)
    const withSelect = allMetas.find((m) => m.select !== null);
    if (withSelect) return withSelect;

    // Priorität 2: hat $top
    const withTop = allMetas.find((m) => m.top !== null);
    if (withTop) return withTop;

    return allMetas[0]; // neuester
  }

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

        const serviceMatch = path.match(/\/odata\/sap\/([^/]+)/);
        const serviceName = serviceMatch?.[1];
        if (!serviceName) return;

        let entitySet = null;
        let filter = null;
        let select = null;
        let top = null;
        let skip = null;

        if (isBatch && this._requestBody) {
          // Ersten GET aus dem Batch-Body parsen
          const getMatch = this._requestBody.match(
            /GET\s+([^\s?]+)(\?[^\s]*)?\s/,
          );
          if (getMatch) {
            entitySet = getMatch[1]; // z.B. "ZAUTHOR_CV_CDS_Items"

            if (getMatch[2]) {
              const params = new URLSearchParams(getMatch[2].slice(1));
              filter = params.get("$filter");
              select = params.get("$select");
              top = params.get("$top");
              skip = params.get("$skip");
            }
          }
        } else {
          // Normaler GET — Entity direkt aus URL
          const entityMatch = path.match(/\/odata\/sap\/[^/]+\/([^?/]+)/);
          entitySet = entityMatch?.[1];
          filter = u.searchParams.get("$filter");
          select = u.searchParams.get("$select");
          top = u.searchParams.get("$top");
          skip = u.searchParams.get("$skip");
        }

        const meta = {
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
        };

        // Pro Service speichern — kein Timeout
        storeBatchMeta(meta);
        console.log("[PH] Batch meta cached:", serviceName, meta);
      } catch (e) {
        console.error("[PH] XHR send hook error:", e);
      }
    });

    return originalSend.apply(this, arguments);
  };

  // =====================================================
  // fetch() hooken — neuere SAP Versionen nutzen fetch
  // =====================================================
  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const response = await originalFetch.apply(this, arguments);

    try {
      const url = typeof input === "string" ? input : input?.url;
      if (!url?.includes("/sap/opu/odata/")) return response;

      const u = new URL(url, window.location.origin);
      const path = u.pathname;

      const serviceMatch = path.match(/\/odata\/sap\/([^/]+)\//);
      const entityMatch = path.match(/\/odata\/sap\/[^/]+\/([^?/]+)/);

      const meta = {
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
        metadataLastMod: response.headers.get("sap-metadata-last-modified"),
        capturedAt: Date.now(),
      };

      storeODataMeta(meta);
      console.log("[PH] fetch OData captured:", meta);
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

  // Hook URL.createObjectURL
  const originalCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    const objectUrl = originalCreateObjectURL(blob);

    if (looksLikeExcelBlob(blob)) {
      const sapMeta = findBestBatchMeta();
      console.log("[PH] Best batch match:", sapMeta?.entitySet);

      blobRegistry.set(objectUrl, {
        blob,
        mimeType: blob.type,
        size: blob.size,
        sapMeta,
      });
    }

    return objectUrl;
  };

  // Hook anchor.click to intercept blob-based downloads
  const originalAnchorClick = HTMLAnchorElement.prototype.click;

  HTMLAnchorElement.prototype.click = function (...args) {
    try {
      const href = this.href;
      const downloadAttr = this.download;

      if (href && href.startsWith("blob:") && blobRegistry.has(href)) {
        const entry = blobRegistry.get(href);

        console.log("[PH] Intercepted anchor click for Excel blob download");
        console.log("[PH] href:", href);
        console.log("[PH] downloadAttr:", downloadAttr);

        const reader = new FileReader();

        reader.onload = function () {
          try {
            const arrayBuffer = reader.result;
            const bytes = Array.from(new Uint8Array(arrayBuffer));

            window.postMessage(
              {
                source: "excel-transformer-pagehook",
                type: "INTERCEPTED_EXCEL_BLOB_DOWNLOAD",
                filename:
                  downloadAttr && downloadAttr.trim() !== ""
                    ? downloadAttr
                    : `excel_${Date.now()}.xlsx`,
                mimeType:
                  entry.mimeType ||
                  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                data: bytes,
                sapMeta: entry.sapMeta ?? null,
              },
              "*",
            );

            console.log(
              "[PH] Posted intercepted Excel blob to content script bridge",
            );
          } catch (error) {
            console.error("[PH] Failed to post intercepted blob:", error);
          }
        };

        reader.onerror = function () {
          console.error(
            "[PH] FileReader failed while reading intercepted Excel blob",
          );
        };

        reader.readAsArrayBuffer(entry.blob);

        // Prevent the original browser download
        return;
      }
    } catch (error) {
      console.error("[PH] Error in anchor click hook:", error);
    }

    return originalAnchorClick.apply(this, args);
  };
  // Hook dispatchEvent (für Frameworks die nicht .click() nutzen)
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
        console.log("[PH] dispatchEvent click intercepted on blob anchor");

        const reader = new FileReader();
        reader.onload = function () {
          try {
            const bytes = Array.from(new Uint8Array(reader.result));
            window.postMessage(
              {
                source: "excel-transformer-pagehook",
                type: "INTERCEPTED_EXCEL_BLOB_DOWNLOAD",
                filename: downloadAttr?.trim() || `excel_${Date.now()}.xlsx`,
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
        return true; // Originalen Download blockieren
      }
    } catch (e) {
      console.error("[PH] Error in dispatchEvent hook:", e);
    }
    return originalDispatchEvent.call(this, event);
  };

  // MutationObserver: fängt <a blob:> ab die ins DOM eingefügt werden
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (
          node instanceof HTMLAnchorElement &&
          node.href?.startsWith("blob:") &&
          blobRegistry.has(node.href)
        ) {
          console.log("[PH] MutationObserver: blob anchor added to DOM");
          const entry = blobRegistry.get(node.href);
          const downloadAttr = node.download;

          // Originalen Click blockieren bevor er feuert
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
                    filename:
                      downloadAttr?.trim() || `excel_${Date.now()}.xlsx`,
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
  console.log("[PH] MutationObserver + dispatchEvent hooks installed");

  console.log("[PH] pageHook hooks installed");
})();

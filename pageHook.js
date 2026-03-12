(function () {
  console.log("[PH] pageHook.js injected into page context");

  const blobRegistry = new Map();

  function looksLikeExcelBlob(blob) {
    if (!blob) return false;

    const type = (blob.type || "").toLowerCase();

    return (
      type.includes("spreadsheetml") ||
      type.includes("ms-excel") ||
      type.includes("excel")
    );
  }

  // =====================================================
  // Hook URL.createObjectURL
  // =====================================================
  const originalCreateObjectURL = URL.createObjectURL.bind(URL);

  URL.createObjectURL = function (blob) {
    const objectUrl = originalCreateObjectURL(blob);

    try {
      if (looksLikeExcelBlob(blob)) {
        blobRegistry.set(objectUrl, {
          blob,
          mimeType: blob.type,
          size: blob.size,
        });

        console.log("[PH] Excel blob registered");
        console.log("[PH] blobUrl:", objectUrl);
        console.log("[PH] mimeType:", blob.type);
        console.log("[PH] size:", blob.size);
      }
    } catch (error) {
      console.error("[PH] Error in createObjectURL hook:", error);
    }

    return objectUrl;
  };

  // =====================================================
  // Hook anchor.click to intercept blob-based downloads
  // =====================================================
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

  console.log("[PH] pageHook hooks installed");
})();

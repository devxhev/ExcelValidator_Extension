// content.js
console.log("✅ Content Script geladen in:", window.location.href);

// Auf Nachrichten vom Background warten
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("📨 Nachricht erhalten:", request);

  if (request.action === "ping") {
    console.log("🏓 Pong");
    sendResponse({ pong: true });
    return false;
  }

  if (request.action === "getBlob") {
    console.log("🔍 Hole Blob von URL:", request.url);

    // Asynchronen Handler aufrufen
    handleGetBlob(request.url)
      .then((result) => {
        console.log(
          "✅ Blob erfolgreich geholt, Größe:",
          result.data.length,
          "Bytes",
        );
        sendResponse(result);
      })
      .catch((error) => {
        console.error("❌ Fehler beim Holen:", error);
        sendResponse({
          success: false,
          error: error.message,
        });
      });

    return true; // Wichtig für asynchrone Antwort!
  }
});

// Hauptfunktion zum Holen des Blobs
async function handleGetBlob(blobUrl) {
  try {
    console.log("🌐 Fetche blob URL...");

    // WICHTIG: blob: URLs können direkt gefetcht werden!
    const response = await fetch(blobUrl);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    console.log(
      "📦 Response erhalten, Content-Type:",
      response.headers.get("content-type"),
    );

    const blob = await response.blob();
    console.log("💾 Blob erstellt, Typ:", blob.type, "Größe:", blob.size);

    // In ArrayBuffer konvertieren für Übertragung
    const buffer = await blob.arrayBuffer();
    console.log("📊 ArrayBuffer Größe:", buffer.byteLength);

    return {
      success: true,
      data: Array.from(new Uint8Array(buffer)),
      mimeType:
        blob.type ||
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
  } catch (error) {
    console.error("❌ Fetch fehlgeschlagen:", error);

    // Fallback: Versuche Blob über DOM zu finden
    console.log("🔍 Versuche Fallback-Methode...");
    const fallbackBlob = await findBlobInDOM(blobUrl);
    if (fallbackBlob) {
      console.log("✅ Fallback erfolgreich");
      return fallbackBlob;
    }

    throw error;
  }
}

// Fallback: Suche im DOM nach dem Blob
async function findBlobInDOM(blobUrl) {
  // Suche nach Elementen mit blob: URLs
  const elements = document.querySelectorAll('[src*="blob:"], [href*="blob:"]');
  console.log(`🔍 Gefundene blob-Elemente: ${elements.length}`);

  for (const el of elements) {
    const elementUrl = el.src || el.href;
    if (elementUrl === blobUrl) {
      console.log("✅ Passendes Element gefunden:", el.tagName);
      try {
        const response = await fetch(blobUrl);
        const blob = await response.blob();
        const buffer = await blob.arrayBuffer();
        return {
          success: true,
          data: Array.from(new Uint8Array(buffer)),
          mimeType: blob.type,
        };
      } catch (e) {
        console.error("❌ Fallback-Fetch fehlgeschlagen:", e);
      }
    }
  }

  return null;
}

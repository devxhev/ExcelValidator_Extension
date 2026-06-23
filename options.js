const translations = {
  de: {
    title: "ProtectionHub Einstellungen",
    subtitle: "Konfiguriere die Verbindung zu deiner API.",
    endpoint: "API-Endpunkt",
    apiconnection: "API Verbindung",
    hint: "Basis-URL deiner API, ohne trailing slash.",
    save: "Speichern",
    reset: "Zurücksetzen",
    saved: "✓ Gespeichert",
    invalidendpoint: "Kein gültiger Endpunkt!",
  },
  en: {
    title: "ProtectionHub Settings",
    subtitle: "Configure the connection to your API.",
    endpoint: "API Endpoint",
    apiconnection: "API Connection",
    hint: "Base URL of your API, without trailing slash.",
    save: "Save",
    reset: "Reset",
    saved: "✓ Saved",
    invalidendpoint: "Not a valid endpoint!",
  },
};

const lang = chrome.i18n.getUILanguage().startsWith("de") ? "de" : "en";
let t = translations[lang];
document.querySelectorAll("[data-i18n]").forEach((el) => {
  el.textContent = t[el.dataset.i18n];
});

const endpointInput = document.getElementById("endpoint");
const saveBtn = document.getElementById("saveBtn");
const resetBtn = document.getElementById("resetBtn");
const saveMsg = document.getElementById("saveMsg");
const invalidEndpointMsg = document.getElementById("invalid-endpoint");

function load() {
  if (typeof chrome !== "undefined" && chrome.storage) {
    chrome.storage.sync.get("endpoint", ({ endpoint }) => {
      if (endpoint) endpointInput.value = endpoint;
    });
  } else {
    const stored = localStorage.getItem("ext_endpoint");
    if (stored) endpointInput.value = stored;
  }
}

function save() {
  const endpoint = endpointInput.value.trim().replace(/\/$/, "");
  if (!endpoint.includes("https://")) {
    invalidEndpointMsg.classList.add("showMsg");
    setTimeout(() => invalidEndpointMsg.classList.remove("showMsg"), 2000);
    return;
  }
  if (typeof chrome !== "undefined" && chrome.storage) {
    chrome.storage.sync.set({ endpoint }, showSaved);
  } else {
    localStorage.setItem("ext_endpoint", endpoint);
    showSaved();
  }
}

function reset() {
  endpointInput.value = "";
  if (typeof chrome !== "undefined" && chrome.storage) {
    chrome.storage.sync.remove("endpoint");
  } else {
    localStorage.removeItem("ext_endpoint");
  }
}

function showSaved() {
  saveMsg.classList.add("show");
  setTimeout(() => saveMsg.classList.remove("show"), 2000);
}

saveBtn.addEventListener("click", save);
resetBtn.addEventListener("click", reset);
load();

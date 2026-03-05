# Excel Validator Browser Extension
Eine Chrome-Erweiterung, die Excel-Downloads abfängt, an eine API sendet und die transformierte Version automatisch herunterlädt.

## 🚀 Features
- 🔍 Automatische Erkennung: Fängt Excel-Downloads (.xlsx, .xls) automatisch ab

- 🌐 Unterstützt alle Download-Typen: Verarbeitet normale HTTP-Downloads und komplexe blob: URLs

- 🔄 API-Integration: Sendet abgefangene Dateien an deine Transformations-API

- 💾 Intelligentes Download-Handling: Verhindert Endlosschleifen durch Tracking eigener Downloads

- 📁 Fallback-Namensgebung: Generiert automatisch Dateinamen falls keine vorhanden

- 🎯 Robustes Error-Handling: Mehrere Fallback-Mechanismen für Zuverlässigkeit


```bash
git clone https://github.com/deinusername/excel-transformer-extension.git
cd excel-transformer-extension
```

## In Chrome laden
- Öffne Chrome und gehe zu ```chrome://extensions/```

- Aktiviere "Developer mode" (Toggle oben rechts)

- Klicke auf "Load unpacked"

- Wähle den Extension-Ordner aus

## Installation überprüfen
- Das Extension-Icon sollte in der Toolbar erscheinen

- Öffne die Background-Console: Rechtsklick auf Extension → "Inspect popup" → Console Tab

- Suche nach "Background Script geladen"

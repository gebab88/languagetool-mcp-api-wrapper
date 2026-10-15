# languagetool-mcp-api-wrapper

Ein lokaler [MCP](https://modelcontextprotocol.io)-Server (stdio, JSON-RPC 2.0), der eine selbst gehostete [LanguageTool](https://languagetool.org)-HTTP-Instanz an MCP-Clients anbindet (z. B. OpenCode, Claude Code). Reines Node.js, **keine externen Abhängigkeiten** – alle Daten bleiben lokal.

## Voraussetzungen

- **Node.js ≥ 18** (braucht natives `fetch` und `AbortSignal.timeout`)
- **Eine erreichbare LanguageTool-HTTP-Instanz**, z. B. als MacPorts-Daemon (macOS):

  ```sh
  sudo port install LanguageTool   # einmalig
  sudo port load LanguageTool      # startet den Daemon auf http://localhost:8081
  ```

  Geht auch jede andere LT-Instanz mit HTTP-Interface (Docker, eigener Build) – die Adresse wird über `LT_BASE_URL` eingegeben (s. [Konfiguration](#konfiguration)).

- **Verifizieren**, dass LT erreichbar ist:

  ```sh
  curl -s http://localhost:8081/v2/languages | head -c 100
  ```

  Eine leere Antwort oder `Connection refused` bedeutet: LT läuft nicht.

## Installation

```sh
git clone https://github.com/gebab88/languagetool-mcp-api-wrapper.git
cd languagetool-mcp-api-wrapper
```

1. **Kein `npm install` nötig** – das Projekt hat keine externen Abhängigkeiten. Die `package.json` dient nur `npm test`.
2. **(Optional) Testlauf:** `node --test` – Details im Abschnitt [Tests](#tests).
3. **Smoke-Test ohne Client** – der Server spricht MCP über stdio, das lässt sich direkt mit einer Pipe prüfen (läuft auch ohne LT, `check_text` setzt eine erreichbare Instanz voraus):

   ```sh
   printf '%s\n' \
     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
     '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
     '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"check_text","arguments":{"text":"This is a spellig error.","language":"en-US"}}}' \
     | node server.mjs
   ```

   Erwartet: drei JSON-Zeilen auf `stdout` – die `initialize`-Antwort mit `serverInfo`, die Tool-Liste (`check_text`, `list_languages`) und der Markdown-Report. Danach beendet sich der Prozess sauber.
4. **Im MCP-Client registrieren** – siehe [Registrierung](#registrierung-im-mcp-client). Fertig.

## Registrierung im MCP-Client

### OpenCode

Am einfachsten per CLI (mergt in die Config ein, ohne andere Einstellungen anzufassen):

```sh
# global – in allen Projekten verfügbar:
opencode mcp add languagetool --global -- node /vollständiger/Pfad/zu/server.mjs

# oder nur im aktuellen Projekt (--global weglassen):
opencode mcp add languagetool -- node /vollständiger/Pfad/zu/server.mjs
```

- **Prüfen:** `opencode mcp list` → `✓ languagetool connected`; in der TUI mit `/mcps`.
- Läuft LT nicht auf `http://localhost:8081`, ergänze in der Config ein `environment`-Feld (siehe unten).
- Taucht der Server nicht auf: `opencode service restart` setzt den OpenCode-Dienst zurück.

Manuell per Config-Datei – global in `~/.config/opencode/opencode.json`, projektlokal in `opencode.json` (OpenCode V2 legt Server unter `mcp.servers` an; das ältere V1-Format mit dem Namen direkt unter `mcp` und `enabled` wird weiterhin gelesen, ist aber nicht die aktuelle Form):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "languagetool": {
        "type": "local",
        "command": ["node", "/vollständiger/Pfad/zu/server.mjs"],
        "environment": { "LT_BASE_URL": "http://localhost:8081" }
      }
    }
  }
}
```

Die Tools erscheinen im Modell als `languagetool_check_text` und `languagetool_list_languages` (in Code Mode gruppiert: `tools.languagetool.check_text(...)`).

### Claude Code (Beispiel)

```sh
claude mcp add languagetool -- node /vollständiger/Pfad/zu/server.mjs
```

oder als Projektdatei `.mcp.json`:

```json
{
  "mcpServers": {
    "languagetool": {
      "command": "node",
      "args": ["/vollständiger/Pfad/zu/server.mjs"],
      "env": { "LT_BASE_URL": "http://localhost:8081" }
    }
  }
}
```

Andere MCP-Clients mit stdio-Transport funktionieren analog: Prozess `node /Pfad/zu/server.mjs` starten, JSON-RPC über `stdin`/`stdout` sprechen.

## Konfiguration

| Variable | Standard | Bedeutung |
|---|---|---|
| `LT_BASE_URL` | `http://localhost:8081` | Basis-URL der LanguageTool-Instanz |
| `LT_CHECK_TIMEOUT_MS` | `60000` | Timeout für `/v2/check` in ms |

Übergeben kann man sie pro Client (OpenCode: `environment` im Server-Eintrag, Claude Code: `env` in `.mcp.json`) oder im Shell, aus dem der Client startet.

## Tools

- **`check_text`** – prüft einen Text auf Rechtschreib-, Grammatik- und Zeichensetzungsfehler sowie Stilprobleme und gibt einen Markdown-Report nach Kategorie mit Korrekturvorschlägen zurück.
  - `text` (erforderlich): der zu prüfende Text
  - `language`: Sprachcode, z. B. `de-DE`, `en-US`, oder `auto` (Standard)
  - `picky`: strengere Prüfung mit mehr Stil-Hinweisen (Standard: `false`)
  - `disabledRules` / `enabledRules`: Regel-IDs, die ignoriert bzw. zusätzlich aktiviert werden sollen
- **`list_languages`** – listet die von der Instanz unterstützten Sprachen mit Code und Name.

## Hinweise

- In LT 6.x sind die Rechtschreib-Wörterbücher für Deutsch und Englisch nur an regionale Varianten gebunden; die nackten Codes `de` bzw. `en` werden deshalb automatisch auf `de-DE` bzw. `en-US` abgebildet. Gemischte Schreibweise in Sprachcodes (z. B. `De`) wird normalisiert – andernfalls würde LT mit dem nackten Basiscode laufen und die Rechtschreibprüfung stillschweigend aussetzen.
- Der Server schreibt JSON ausschließlich nach `stdout`, Logs nach `stderr` – so, wie es der MCP-stdio-Transport verlangt.
- Laufende Prüfungen können Clients mit MCP `notifications/cancelled` abbrechen; der Server antwortet dann mit einem Fehler-Ergebnis („… wurde abgebrochen“).
- Läuft LT nicht, startet der MCP-Server trotzdem sauber; Tool-Aufrufe melden dann „… nicht erreichbar …“ statt einen Absturz auszulösen.
- Unterstützte Protokollversionen: `2024-11-05`, `2025-03-26`, `2025-06-18`.

## Tests

Die Tests starten den Server als Prozess und sprechen das MCP-Protokoll mit ihm (E2E, `node:test` – ohne externe Abhängigkeiten). Sie prüfen u. a., dass eingelegte Fehler in deutschen und englischen Texten (Rechtschreibung, Grammatik, Großschreibung) erkannt werden, dass fehlerfreie Texte sauber durchgehen und dass Cancellation, Sprachcode-Normalisierung und Fehlerbehandlung korrekt arbeiten.

Voraussetzung: Node.js ≥ 18 und eine erreichbare LanguageTool-Instanz (`LT_BASE_URL`, Standard `http://localhost:8081`). Ohne erreichbare Instanz werden die Tests übersprungen (skip), statt zu scheitern – der Cancellation- und der Protokoll-Test laufen auch ohne LT. Der Client-Timeout der Tests (`MCP_TEST_TIMEOUT_MS`, Standard 90 s) sollte größer bleiben als `LT_CHECK_TIMEOUT_MS`.

```bash
node --test   # oder: npm test
```

## Lizenz

[MIT](LICENSE)
# languagetool-mcp-api-wrapper

Ein lokaler [MCP](https://modelcontextprotocol.io)-Server (stdio, JSON-RPC 2.0), der eine selbst gehostete [LanguageTool](https://languagetool.org)-HTTP-Instanz an MCP-Clients anbindet (z. B. OpenCode, Claude Code). Reines Node.js, **keine externen Abhängigkeiten** – alle Daten bleiben lokal.

## Voraussetzungen

- Node.js ≥ 18 (braucht natives `fetch` und `AbortSignal.timeout`)
- Eine erreichbare LanguageTool-HTTP-Instanz, z. B. als MacPorts-Daemon:

  ```
  sudo port load LanguageTool   # lauscht auf http://localhost:8081
  ```

## Registrierung im MCP-Client

Beispiel OpenCode (`opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "languagetool": {
      "type": "local",
      "command": ["node", "/vollständiger/Pfad/zu/server.mjs"],
      "enabled": true
    }
  }
}
```

## Konfiguration

| Variable | Standard | Bedeutung |
|---|---|---|
| `LT_BASE_URL` | `http://localhost:8081` | Basis-URL der LanguageTool-Instanz |

## Tools

- **`check_text`** – prüft einen Text auf Rechtschreib-, Grammatik- und Zeichensetzungsfehler sowie Stilprobleme und gibt einen Markdown-Report nach Kategorie mit Korrekturvorschlägen zurück.
  - `text` (erforderlich): der zu prüfende Text
  - `language`: Sprachcode, z. B. `de-DE`, `en-US`, oder `auto` (Standard)
  - `picky`: strengere Prüfung mit mehr Stil-Hinweisen (Standard: `false`)
  - `disabledRules` / `enabledRules`: Regel-IDs, die ignoriert bzw. zusätzlich aktiviert werden sollen
- **`list_languages`** – listet die von der Instanz unterstützten Sprachen mit Code und Name.

## Hinweise

- In LT 6.x sind die Rechtschreib-Wörterbücher für Deutsch und Englisch nur an regionale Varianten gebunden; die nackten Codes `de` bzw. `en` werden deshalb automatisch auf `de-DE` bzw. `en-US` abgebildet.
- Der Server schreibt JSON ausschließlich nach `stdout`, Logs nach `stderr` – so, wie es der MCP-stdio-Transport verlangt.
- Unterstützte Protokollversionen: `2024-11-05`, `2025-03-26`, `2025-06-18`.

## Lizenz

[MIT](LICENSE)

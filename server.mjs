#!/usr/bin/env node
/**
 * lokales LanguageTool MCP-Server (stdio, ohne externe Abhängigkeiten)
 *
 * Brückt den Model Context Protocol (JSON-RPC 2.0 über stdio) an eine
 * selbst gehostete LanguageTool-HTTP-Instanz. Auf diesem System läuft sie
 * als MacPorts-Daemon:  languagetool-server --http --port 8081
 *
 * Umgebung:
 *   LT_BASE_URL  Basis-URL der LT-Instanz (Standard: http://localhost:8081)
 *
 * Der Server schreibt ausschließlich JSON-Zeilen nach stdout, Logs gehen
 * nach stderr – so, wie es der MCP-stdio-Transport verlangt.
 */

const BASE = (process.env.LT_BASE_URL ?? 'http://localhost:8081').replace(/\/+$/, '');
const CHECK_URL = `${BASE}/v2/check`;
const LANGUAGES_URL = `${BASE}/v2/languages`;

const SERVER_INFO = { name: 'languagetool', version: '1.0.0' };
const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

// ---------------------------------------------------------------------------
// Sprache/Protokoll-Kleinkram
// ---------------------------------------------------------------------------

function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// ---------------------------------------------------------------------------
// LanguageTool-Client
// ---------------------------------------------------------------------------

async function ltCheck({ text, language, picky, disabledRules, enabledRules }) {
  const params = new URLSearchParams();
  params.set('text', text);
  params.set('language', language || 'auto');
  if (picky) params.set('level', 'picky');
  if (disabledRules?.length) params.set('disabledRules', disabledRules.join(','));
  if (enabledRules?.length) params.set('enabledRules', enabledRules.join(','));

  let res;
  try {
    res = await fetch(CHECK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new Error(
      `LanguageTool lokal nicht erreichbar unter ${CHECK_URL} (${err.message}). ` +
        `Ist der LT-Server gestartet? (MacPorts: "sudo port load LanguageTool")`
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LanguageTool HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function ltLanguages() {
  let res;
  try {
    res = await fetch(LANGUAGES_URL, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new Error(`LanguageTool lokal nicht erreichbar unter ${LANGUAGES_URL} (${err.message}).`);
  }
  if (!res.ok) throw new Error(`LanguageTool HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Ausgabeformatierung
// ---------------------------------------------------------------------------

// LanguageTool liefert die Kategorie-Zuschrift je nach geprüfter Sprache
// lokalisiert ("Mögliche Tippfehler" vs. "Possible Typo") – die Kategorie-IDs
// sind dagegen stabil, deshalb danach mappen.
const CATEGORY_LABELS = {
  TYPOS: 'Rechtschreibung',
  GRAMMAR: 'Grammatik',
  PUNCTUATION: 'Zeichensetzung',
  TYPOGRAPHY: 'Typografie',
  STYLE: 'Stil',
  CASING: 'Groß-/Kleinschreibung',
};

function categoryOf(match) {
  const category = match.rule?.category ?? {};
  const label = CATEGORY_LABELS[String(category.id ?? '').toUpperCase()];
  if (label) return label;
  return category.name ?? (match.rule?.issueType ? String(match.rule.issueType) : 'Sonstiges');
}

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function buildCheckReport(data) {
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const lang = data.language ?? {};
  const detected = lang.detectedLanguage ?? lang;

  const lines = [];
  lines.push(
    `## ${matches.length === 0 ? '✅ Keine Probleme gefunden' : `⚠️ ${matches.length} Hinweise`}`
  );
  lines.push(`Sprache: ${detected.name ?? lang.name ?? '?'} (${detected.code ?? lang.code ?? '?'})`);
  if (data.warnings?.incompleteResults) {
    lines.push('(Hinweis: LanguageTool hat die Ergebnisse gekürzt – der Text ist sehr lang)');
  }
  if (matches.length === 0) return lines.join('\n');

  // Zusammenfassung nach Kategorie
  const groups = new Map();
  for (const m of matches) {
    const cat = categoryOf(m);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(m);
  }
  lines.push('');
  lines.push(
    'Übersicht: ' + [...groups.entries()].map(([cat, items]) => `${items.length}× ${cat}`).join(', ')
  );

  for (const [cat, items] of groups) {
    lines.push('');
    lines.push(`### ${cat}`);
    for (const m of items) {
      const ctx = m.context ?? {};
      const offset = Number(ctx.offset ?? 0);
      const len = Number(ctx.length ?? 0);
      const fragment = String(ctx.text ?? '').slice(offset, offset + len);
      const suggestions = (Array.isArray(m.replacements) ? m.replacements : [])
        .slice(0, 5)
        .map((r) => String(r.value ?? '').trim())
        .filter((v) => v.length > 0);

      const label = m.shortMessage || m.message || '(ohne Meldung)';
      lines.push(`- \`${fragment}\` — ${label}`);
      if (suggestions.length > 0) {
        lines.push(`  Vorschläge: ${suggestions.map((s) => `\`${s}\``).join(', ')}`);
      }
      if (m.rule?.id) lines.push(`  Regel: \`${m.rule.id}\``);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// MCP-Tools
// ---------------------------------------------------------------------------

const TOOL_DEFS = [
  {
    name: 'check_text',
    title: 'Text mit LanguageTool prüfen',
    description:
      `Prüft einen Text mit der lokal laufenden LanguageTool-Instanz (${BASE}) auf Rechtschreib-, ` +
      'Grammatik- und Zeichensetzungsfehler sowie Stilprobleme. Gibt eine Markdown-Zusammenfassung ' +
      'nach Kategorie mit Einzelhinweisen und Korrekturvorschlägen zurück. Alle Daten bleiben lokal.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Der zu prüfende Text.' },
        language: {
          type: 'string',
          description:
            'Sprachcode, z. B. "de-DE", "en-US", oder "auto" für automatische Erkennung (Standard: auto). ' +
            'Achtung: In dieser LT-Version arbeitet die Rechtschreibprüfung für Deutsch/Englisch nur mit ' +
            'regionalen Varianten – nackte Codes "de" bzw. "en" werden automatisch zu "de-DE" bzw. "en-US" umgebildet.',
        },
        picky: {
          type: 'boolean',
          description: 'Strengere Prüfung mit mehr Stil-Hinweisen (Standard: false).',
        },
        disabledRules: {
          type: 'array',
          items: { type: 'string' },
          description: 'Regel-IDs, die ignoriert werden sollen, z. B. ["WHITESPACE_RULE"].',
        },
        enabledRules: {
          type: 'array',
          items: { type: 'string' },
          description: 'Zusätzliche Regel-IDs, die aktiviert werden sollen.',
        },
      },
      required: ['text'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_languages',
    title: 'Verfügbare Sprachen auflisten',
    description:
      'Listet die von der lokalen LanguageTool-Instanz unterstützten Sprachen mit Code und Name auf.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

// In LT 6.x sind die Rechtschreib-Wörterbücher für Deutsch und Englisch nur an
// regionale Varianten gebunden. Die nackten Basis-Codes laufen dort leer,
// deshalb automatisch auf die gebräuchlichste Variante abbilden.
const VARIANT_FALLBACK = { de: 'de-DE', en: 'en-US' };

async function handleCheckText(args) {
  const { text, language = 'auto', picky = false, disabledRules = [], enabledRules = [] } = args ?? {};
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Argument "text" fehlt oder ist leer.');
  }
  const effectiveLanguage = VARIANT_FALLBACK[language] ?? language;
  const data = await ltCheck({ text, language: effectiveLanguage, picky, disabledRules, enabledRules });
  return ok(buildCheckReport(data));
}

async function handleListLanguages() {
  const rows = await ltLanguages();
  const lines = rows.map((l) => `${l.longCode ?? l.code} — ${l.name}`);
  return ok(`${rows.length} Sprachen:\n${lines.join('\n')}`);
}

async function callTool(params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  try {
    switch (name) {
      case 'check_text':
        return await handleCheckText(args);
      case 'list_languages':
        return await handleListLanguages();
      default:
        return errorResult(`Unbekanntes Tool: ${name}`);
    }
  } catch (err) {
    return errorResult(`Aufruf fehlgeschlagen: ${err?.message ?? String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC-Loop (MCP over stdio)
// ---------------------------------------------------------------------------

function makeResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function makeError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleMessage(msg) {
  const { id, method, params } = msg ?? {};
  const isNotification = id === undefined;

  switch (method) {
    case 'initialize':
      return makeResult(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(params?.protocolVersion)
          ? params.protocolVersion
          : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          'Lokale LanguageTool-Anbindung: prüfe Texte über check_text (z. B. vor dem Absenden von Dokumenten).',
      });
    case 'ping':
      return makeResult(id, {});
    case 'tools/list':
      return makeResult(id, { tools: TOOL_DEFS });
    case 'tools/call':
      return makeResult(id, await callTool(params));
    default:
      // Benachrichtigungen (z. B. notifications/initialized) brauchen keine Antwort.
      if (isNotification) return undefined;
      return makeError(id, -32601, `Methode nicht gefunden: ${method}`);
  }
}

const pending = new Set();

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length === 0) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send(makeError(null, -32700, 'Parse error'));
      continue;
    }
    if (msg.id !== undefined) log(`← ${msg.method}`);

    const job = handleMessage(msg)
      .then((reply) => {
        if (reply !== undefined) send(reply);
      })
      .catch((err) => {
        if (msg.id !== undefined) {
          send(makeError(msg.id, -32603, `Interner Fehler: ${err?.message ?? String(err)}`));
        }
      });
    pending.add(job);
    job.finally(() => pending.delete(job));
  }
});
process.stdin.on('end', () => {
  // Ggf. bereits empfangene, aber noch laufende Anfragen (z. B. Langtext-Checks)
  // zuerst fertiglaufen lassen, bevor der Prozess beendet wird.
  if (pending.size === 0) {
    process.exit(0);
  }
  Promise.allSettled([...pending]).then(() => process.exit(0));
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

log(`LanguageTool-MCP-Server startet (Ziel: ${BASE}, LT-Version unbekannt bis erster Aufruf)`);

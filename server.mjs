#!/usr/bin/env node
/**
 * lokales LanguageTool MCP-Server (stdio, ohne externe Abhängigkeiten)
 *
 * Brückt den Model Context Protocol (JSON-RPC 2.0 über stdio) an eine
 * selbst gehostete LanguageTool-HTTP-Instanz. Auf diesem System läuft sie
 * als MacPorts-Daemon:  languagetool-server --http --port 8081
 *
 * Umgebung:
 *   LT_BASE_URL          Basis-URL der LT-Instanz (Standard: http://localhost:8081)
 *   LT_CHECK_TIMEOUT_MS  Timeout für /v2/check in ms (Standard: 60000)
 *
 * Der Server schreibt ausschließlich JSON-Zeilen nach stdout, Logs gehen
 * nach stderr – so, wie es der MCP-stdio-Transport verlangt.
 */

const BASE = (process.env.LT_BASE_URL ?? 'http://localhost:8081').replace(/\/+$/, '');
const CHECK_URL = `${BASE}/v2/check`;
const LANGUAGES_URL = `${BASE}/v2/languages`;
const CHECK_TIMEOUT_MS = Number(process.env.LT_CHECK_TIMEOUT_MS) || 60_000;
const LANGUAGES_TIMEOUT_MS = 15_000;

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

// Kombiniert ein optionales externes Cancel-Signal mit einem Timeout.
// (AbortSignal.any() wäre eleganter, braucht aber Node ≥ 20.3;
// so geht es ab Node ≥ 18.)
function withTimeout(external, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onExternal = () => controller.abort();
  external?.addEventListener('abort', onExternal, { once: true });
  controller.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternal);
    },
    { once: true }
  );
  return controller.signal;
}

// ---------------------------------------------------------------------------
// LanguageTool-Client
// ---------------------------------------------------------------------------

async function ltCheck({ text, language, picky, disabledRules, enabledRules }, signal) {
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
      signal: withTimeout(signal, CHECK_TIMEOUT_MS),
    });
  } catch (err) {
    if (signal?.aborted) {
      const cancelled = new Error('Textprüfung wurde abgebrochen.');
      cancelled.name = 'CancelledError';
      throw cancelled;
    }
    if (err?.name === 'AbortError') {
      throw new Error(`Zeitüberschreitung: LanguageTool antwortet nicht innerhalb von ${CHECK_TIMEOUT_MS / 1000} s.`);
    }
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

async function ltLanguages(signal) {
  let res;
  try {
    res = await fetch(LANGUAGES_URL, { signal: withTimeout(signal, LANGUAGES_TIMEOUT_MS) });
  } catch (err) {
    if (signal?.aborted) {
      const cancelled = new Error('Sprachliste-Aufruf wurde abgebrochen.');
      cancelled.name = 'CancelledError';
      throw cancelled;
    }
    if (err?.name === 'AbortError') {
      throw new Error(`Zeitüberschreitung: LanguageTool antwortet nicht innerhalb von ${LANGUAGES_TIMEOUT_MS / 1000} s.`);
    }
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

// Feste Kategorienreihenfolge im Report (statt Reihenfolge des ersten Fundes)
const CATEGORY_ORDER = ['Rechtschreibung', 'Grammatik', 'Zeichensetzung', 'Typografie', 'Groß-/Kleinschreibung', 'Stil'];

const categoryOrderOf = (cat) => {
  const i = CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
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
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => categoryOrderOf(a) - categoryOrderOf(b));
  lines.push('');
  lines.push('Übersicht: ' + orderedGroups.map(([cat, items]) => `${items.length}× ${cat}`).join(', '));

  for (const [cat, items] of orderedGroups) {
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
            'regionalen Varianten – nackte Codes "de" bzw. "en" werden automatisch zu "de-DE" bzw. "en-US" umgebildet. ' +
            'Gemischte Schreibweise (z. B. "De") wird normalisiert.',
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

// LT erwartet kleingeschriebenen Sprach- und großgeschriebenen Regional-Subtag
// (z. B. "de-DE"). Ohne Normalisierung würde eine gemischte Schreibweise wie
// "De" stillschweigend mit dem nackten Basiscode laufen, wo in LT 6.x die
// Rechtschreibwörterbücher nicht greifen.
function normalizeLanguage(code) {
  if (typeof code !== 'string') return code;
  const parts = code.trim().toLowerCase().split('-').filter((p) => p.length > 0);
  if (parts.length === 0) return 'auto';
  const [lang, ...rest] = parts;
  const subtags = rest.map((p) =>
    p.length === 2 ? p.toUpperCase() : p.length === 4 ? p.charAt(0).toUpperCase() + p.slice(1) : p
  );
  return [lang, ...subtags].join('-');
}

async function handleCheckText(args, signal) {
  const { text, language = 'auto', picky = false, disabledRules = [], enabledRules = [] } = args ?? {};
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Argument "text" fehlt oder ist leer.');
  }
  const normalized = normalizeLanguage(language);
  const effectiveLanguage = VARIANT_FALLBACK[normalized] ?? normalized;
  const data = await ltCheck({ text, language: effectiveLanguage, picky, disabledRules, enabledRules }, signal);
  return ok(buildCheckReport(data));
}

async function handleListLanguages(signal) {
  const rows = await ltLanguages(signal);
  const lines = rows.map((l) => `${l.longCode ?? l.code} — ${l.name}`);
  return ok(`${rows.length} Sprachen:\n${lines.join('\n')}`);
}

async function callTool(params, signal) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  try {
    switch (name) {
      case 'check_text':
        return await handleCheckText(args, signal);
      case 'list_languages':
        return await handleListLanguages(signal);
      default:
        return errorResult(`Unbekanntes Tool: ${name}`);
    }
  } catch (err) {
    if (err?.name === 'CancelledError') return errorResult(err.message);
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

async function handleMessage(msg, signal) {
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
      return makeResult(id, await callTool(params, signal));
    case 'notifications/cancelled': {
      const targetId = params?.requestId;
      const target = inFlight.get(targetId);
      if (target) {
        inFlight.delete(targetId);
        target.abort();
        log(`↯ Request ${targetId} vom Client abgebrochen`);
      }
      return undefined;
    }
    default:
      // Benachrichtigungen (z. B. notifications/initialized) brauchen keine Antwort.
      if (isNotification) return undefined;
      return makeError(id, -32601, `Methode nicht gefunden: ${method}`);
  }
}

const pending = new Set();
const inFlight = new Map(); // Request-ID -> AbortController (für notifications/cancelled)

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
    if (msg.id !== undefined) log(`← ${msg.id} ${msg.method}`);

    // Jede Request bekommt einen eigenen AbortController – so können Clients
    // laufende Requests abbrechen (MCP: notifications/cancelled).
    const controller = msg.id !== undefined ? new AbortController() : undefined;
    if (controller) inFlight.set(msg.id, controller);

    const job = handleMessage(msg, controller?.signal)
      .then((reply) => {
        if (reply !== undefined) send(reply);
      })
      .catch((err) => {
        if (msg.id !== undefined) {
          send(makeError(msg.id, -32603, `Interner Fehler: ${err?.message ?? String(err)}`));
        }
      })
      .finally(() => {
        if (controller) inFlight.delete(msg.id);
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

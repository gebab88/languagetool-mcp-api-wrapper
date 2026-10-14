/**
 * E2E-Tests für den LanguageTool-MCP-Server (server.mjs).
 *
 * Jeder Test startet den Server als echten Prozess und spricht das MCP-Protokoll
 * (JSON-RPC 2.0 über stdio) mit ihm – so, wie es ein Client tun würde.
 * Die Kern-Assertions prüfen, dass eingelegte Fehler in deutschen und englischen
 * Texten (Rechtschreibung, Grammatik, Großschreibung) erkannt werden, und dass
 * fehlerfreie Texte sauber durchgehen.
 *
 * Voraussetzung: eine erreichbare LanguageTool-HTTP-Instanz
 * (LT_BASE_URL, Standard: http://localhost:8081). Ist sie nicht erreichbar,
 * werden die Tests übersprungen (skip) und schlagen nicht fehl.
 *
 * Ausführen:  node --test test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const BASE = (process.env.LT_BASE_URL ?? 'http://localhost:8081').replace(/\/+$/, '');

// Einmalig prüfen, ob die LanguageTool-Instanz erreichbar ist. Ist sie nicht da,
// werden die Tests übersprungen (der skip-Grund ist eine Zeichenkette).
const ltUp = await fetch(`${BASE}/v2/languages`, { signal: AbortSignal.timeout(5000) })
  .then((r) => r.ok)
  .catch(() => false);

const SKIP = ltUp ? false : `LanguageTool-Instanz nicht erreichbar unter ${BASE}`;

// ---------------------------------------------------------------------------
// Minimaler MCP-Client: startet den Server und spricht JSON-RPC über stdio.
// Antworten können in beliebiger Reihenfolge eintreffen (der Server arbeitet
// Anfragen parallel ab), deshalb werden sie über die Request-ID gematcht.
// ---------------------------------------------------------------------------

class McpClient {
  constructor() {
    this.child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = '';
    this.nextId = 0;
    this.waiters = new Map(); // id -> { resolve, reject }
    this.child.stdout.on('data', (d) => this.onData(d.toString()));
    this.child.stderr.on('data', () => {}); // Server-Logs bewusst ignorieren
    this.child.on('error', (err) => {
      for (const { reject } of this.waiters.values()) reject(err);
      this.waiters.clear();
    });
  }

  onData(chunk) {
    this.buf += chunk;
    let newline;
    while ((newline = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, newline).trim();
      this.buf = this.buf.slice(newline + 1);
      if (line.length === 0) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const waiter = this.waiters.get(msg.id);
      if (waiter) {
        this.waiters.delete(msg.id);
        waiter.resolve(msg);
      }
    }
  }

  request(method, params) {
    const id = ++this.nextId;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`Timeout: keine Antwort auf "${method}"`));
      }, 15000);
      this.waiters.set(id, {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });
  }

  kill() { this.child.kill(); }
}

async function withClient(fn) {
  const client = new McpClient();
  try {
    await fn(client);
  } finally {
    client.kill();
  }
}

// tools/call check_text aufrufen und das Report-Text-Ergebnis liefern
async function check(client, args) {
  const res = await client.request('tools/call', { name: 'check_text', arguments: args });
  assert.equal(res.error, undefined, `JSON-RPC-Fehler: ${JSON.stringify(res.error)}`);
  const text = res.result?.content?.[0]?.text ?? '';
  return { result: res.result, text };
}

// ---------------------------------------------------------------------------
// MCP-Protokoll
// ---------------------------------------------------------------------------

test('initialize: Protokollversion und Server-Info', SKIP, async () => {
  await withClient(async (c) => {
    const res = await c.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
    });
    assert.equal(res.error, undefined);
    assert.equal(res.result.protocolVersion, '2025-06-18');
    assert.equal(res.result.serverInfo.name, 'languagetool');
    assert.ok(res.result.capabilities.tools, 'Tool-Capability fehlt');
  });
});

test('tools/list: check_text und list_languages vorhanden', SKIP, async () => {
  await withClient(async (c) => {
    const res = await c.request('tools/list', {});
    assert.equal(res.error, undefined);
    assert.deepEqual(
      res.result.tools.map((t) => t.name).sort(),
      ['check_text', 'list_languages']
    );
    const checkText = res.result.tools.find((t) => t.name === 'check_text');
    assert.deepEqual(checkText.inputSchema.required, ['text']);
  });
});

test('unbekanntes Tool liefert Tool-Fehler', SKIP, async () => {
  await withClient(async (c) => {
    const res = await c.request('tools/call', { name: 'kein_tool', arguments: {} });
    assert.equal(res.error, undefined, 'Tool-Fehler gehört ins result, nicht in einen JSON-RPC-Fehler');
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Unbekanntes Tool/);
  });
});

test('leerer Text wird abgelehnt', SKIP, async () => {
  await withClient(async (c) => {
    const res = await c.request('tools/call', { name: 'check_text', arguments: { text: '   ' } });
    assert.equal(res.error, undefined);
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /ist leer/);
  });
});

// ---------------------------------------------------------------------------
// Fehlererkennung – Deutsch
// ---------------------------------------------------------------------------

test('Deutsch: Rechtschreibfehler wird erkannt', SKIP, async () => {
  await withClient(async (c) => {
    const { result, text } = await check(c, {
      text: 'Ich habe ein Problem mit der Rechtschreibprufung.',
      language: 'de-DE',
    });
    assert.equal(result.isError, undefined);
    assert.match(text, /Rechtschreibprufung/);           // das Fehlwort selbst
    assert.match(text, /Mögliche Tippfehler/);           // Kategorie
    assert.match(text, /GERMAN_SPELLER_RULE/);          // die Regel
    assert.match(text, /German \(Germany\) \(de-DE\)/); // erkannte Sprache
  });
});

test('Deutsch: Grammatikfehler wird erkannt', SKIP, async () => {
  await withClient(async (c) => {
    const { result, text } = await check(c, {
      text: 'Er haben gestern sehr viel gearbeitet.',
      language: 'de-DE',
    });
    assert.equal(result.isError, undefined);
    assert.match(text, /Er haben/);
    assert.match(text, /Grammatik/);
    assert.match(text, /DE_VERBAGREEMENT/);
  });
});

test('Deutsch: Satzanfang ohne Großbuchstabe wird erkannt', SKIP, async () => {
  await withClient(async (c) => {
    const { result, text } = await check(c, {
      text: 'das ist ein Fehler.',
      language: 'de-DE',
    });
    assert.equal(result.isError, undefined);
    assert.match(text, /`das`/);
  });
});

test('Deutsch: nackter Code "de" funktioniert (VARIANT_FALLBACK)', SKIP, async () => {
  await withClient(async (c) => {
    const { result, text } = await check(c, {
      text: 'Ich habe ein Problem mit der Rechtschreibprufung.',
      language: 'de',
    });
    assert.equal(result.isError, undefined);
    assert.match(text, /Rechtschreibprufung/);
  });
});

test('Deutsch: fehlerfreier Text liefert keine Hinweise', SKIP, async () => {
  await withClient(async (c) => {
    const { result, text } = await check(c, {
      text: 'Das ist ein Test.',
      language: 'de-DE',
    });
    assert.equal(result.isError, undefined);
    assert.match(text, /Keine Probleme gefunden/);
  });
});

// ---------------------------------------------------------------------------
// Fehlererkennung – Englisch
// ---------------------------------------------------------------------------

test('Englisch: Rechtschreibfehler wird erkannt', SKIP, async () => {
  await withClient(async (c) => {
    const { result, text } = await check(c, {
      text: 'This is a spellig error.',
      language: 'en-US',
    });
    assert.equal(result.isError, undefined);
    assert.match(text, /spellig/);
    assert.match(text, /Possible Typo/);
    assert.match(text, /English \(US\) \(en-US\)/);
  });
});

test('Englisch: "Its" statt "It\'s" wird erkannt', SKIP, async () => {
  await withClient(async (c) => {
    const { result, text } = await check(c, {
      text: 'Its a simple test.',
      language: 'en-US',
    });
    assert.equal(result.isError, undefined);
    assert.match(text, /`Its`/);
    assert.match(text, /IT_IS/);
  });
});

test('Englisch: Satzanfang ohne Großbuchstabe wird erkannt', SKIP, async () => {
  await withClient(async (c) => {
    const { result, text } = await check(c, {
      text: 'this is a test.',
      language: 'en-US',
    });
    assert.equal(result.isError, undefined);
    assert.match(text, /`this`/);
  });
});

test('Englisch: nackter Code "en" funktioniert (VARIANT_FALLBACK)', SKIP, async () => {
  await withClient(async (c) => {
    const { result, text } = await check(c, {
      text: 'This is a spellig error.',
      language: 'en',
    });
    assert.equal(result.isError, undefined);
    assert.match(text, /spellig/);
  });
});

test('Englisch: fehlerfreier Text liefert keine Hinweise', SKIP, async () => {
  await withClient(async (c) => {
    const { result, text } = await check(c, {
      text: 'This is a test.',
      language: 'en-US',
    });
    assert.equal(result.isError, undefined);
    assert.match(text, /Keine Probleme gefunden/);
  });
});

// ---------------------------------------------------------------------------
// list_languages
// ---------------------------------------------------------------------------

test('list_languages: deutsche und englische Einträge', SKIP, async () => {
  await withClient(async (c) => {
    const res = await c.request('tools/call', { name: 'list_languages', arguments: {} });
    assert.equal(res.error, undefined);
    assert.equal(res.result.isError, undefined);
    const text = res.result.content[0].text;
    assert.match(text, /German/);
    assert.match(text, /English/);
    assert.match(text, /de-DE/);
    assert.match(text, /en-US/);
  });
});

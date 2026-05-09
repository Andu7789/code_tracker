/**
 * Code Tracer — Standalone Phase 1
 * Run: node tracer.js
 * Then open canvas.html in your browser
 */

const http = require('http');
const WebSocket = require('ws');

const CHROME_PORT = 9222;
const TRACER_PORT = 7923;

let canvasClients = new Set();
let recording = false;
let nodeCounter = 0;
let startTime = 0;
let callStack = [];

// ── WebSocket server for canvas.html ───────────────────────────────────────
const wss = new WebSocket.Server({ port: TRACER_PORT });

wss.on('connection', (client) => {
  canvasClients.add(client);
  console.log(`[Tracer] Canvas connected (${canvasClients.size} clients)`);

  client.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'startRecording') startRecording();
      if (msg.type === 'stopRecording')  stopRecording();
      if (msg.type === 'clearGraph')     broadcast({ type: 'clearGraph' });
    } catch {}
  });

  client.on('close', () => {
    canvasClients.delete(client);
  });
});

console.log(`[Tracer] Waiting for canvas on ws://localhost:${TRACER_PORT}`);
console.log(`[Tracer] Open canvas.html in your browser`);

function broadcast(msg) {
  const str = JSON.stringify(msg);
  canvasClients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(str);
  });
}

// ── Chrome tab list ─────────────────────────────────────────────────────────
function getChromeTabs() {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${CHROME_PORT}/json`, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Could not parse Chrome tabs')); }
      });
    }).on('error', () => reject(new Error(
      `Could not connect to Chrome on port ${CHROME_PORT}. ` +
      `Start Chrome with --remote-debugging-port=${CHROME_PORT}`
    )));
  });
}

// ── CDP connection ──────────────────────────────────────────────────────────
let cdpWs = null;
let cmdId = 1;

function cdpSend(method, params = {}) {
  if (cdpWs && cdpWs.readyState === WebSocket.OPEN) {
    cdpWs.send(JSON.stringify({ id: cmdId++, method, params }));
  }
}

async function startRecording() {
  if (recording) return;

  try {
    const tabs = await getChromeTabs();
    const target = tabs.find(t =>
      t.url?.includes('localhost') ||
      (t.type === 'page' && !t.url?.includes('9222'))
    );

    if (!target?.webSocketDebuggerUrl) {
      broadcast({ type: 'error', message: 'No app tab found. Open your app in Chrome first.' });
      return;
    }

    console.log(`[Tracer] Connecting to: ${target.url}`);
    cdpWs = new WebSocket(target.webSocketDebuggerUrl);

    cdpWs.on('open', () => {
      console.log('[Tracer] CDP connected');
      recording = true;
      nodeCounter = 0;
      startTime = Date.now();
      callStack = [];

      cdpSend('Runtime.enable');
      cdpSend('Network.enable');
      cdpSend('Page.enable');

      // Inject smart click tracker — reads meaningful labels from your app
      cdpSend('Runtime.evaluate', {
        expression: `(function() {
          if (window.__ct) return;
          window.__ct = true;

          function getBestLabel(el) {
            var cur = el;
            for (var i = 0; i < 10; i++) {
              if (!cur || cur === document.body) break;
              // data-view = nav item (best label)
              var view = cur.getAttribute('data-view');
              if (view) return 'nav: ' + view;
              // button or link
              if (cur.tagName === 'BUTTON' || cur.tagName === 'A') {
                // aria-label or title
                var aria = cur.getAttribute('aria-label') || cur.getAttribute('title');
                if (aria) return 'btn: ' + aria.slice(0, 30);
                // text nodes only (skip SVG text)
                var txt = Array.from(cur.childNodes)
                  .filter(function(n) { return n.nodeType === 3; })
                  .map(function(n) { return n.textContent.trim(); })
                  .join('').trim();
                if (txt) return (cur.tagName === 'BUTTON' ? 'btn' : 'link') + ': ' + txt.slice(0, 30);
                // fall back to id
                if (cur.id) return (cur.tagName === 'BUTTON' ? 'btn' : 'link') + ': #' + cur.id;
              }
              // meaningful id
              if (cur.id && cur.id.length < 40) return '#' + cur.id;
              cur = cur.parentElement;
            }
            return el.tagName.toLowerCase();
          }

          window.addEventListener('click', function(e) {
            var label = getBestLabel(e.target);
            console.log('[CT]click:' + label);
          }, true);

          console.log('[CT]ready:injected');
        })();`,
        awaitPromise: false,
      });

      broadcast({ type: 'recording', value: true });
      broadcast({ type: 'status', message: 'Recording — click a button in your app!' });
      console.log('[Tracer] Recording started');
    });

    cdpWs.on('message', (raw) => {
      if (!recording) return;
      try { handleCDPMessage(JSON.parse(raw.toString())); } catch {}
    });

    cdpWs.on('close', () => {
      console.log('[Tracer] CDP disconnected');
      recording = false;
      broadcast({ type: 'recording', value: false });
    });

    cdpWs.on('error', (err) => {
      console.error('[Tracer] CDP error:', err.message);
      broadcast({ type: 'error', message: 'CDP error: ' + err.message });
    });

  } catch (err) {
    console.error('[Tracer]', err.message);
    broadcast({ type: 'error', message: err.message });
  }
}

function stopRecording() {
  recording = false;
  if (cdpWs) {
    try { cdpWs.close(); } catch {}
    cdpWs = null;
  }
  broadcast({ type: 'recording', value: false });
  broadcast({ type: 'status', message: 'Recording stopped — drag nodes to arrange' });
  console.log('[Tracer] Recording stopped');
}

// ── Clean URL into a readable label ────────────────────────────────────────
function cleanUrl(url) {
  try {
    const u = new URL(url);
    // Extract table name from Supabase REST path: /rest/v1/trades -> trades
    const parts = u.pathname.split('/').filter(Boolean);
    const table = parts[parts.length - 1] || u.pathname;

    // Show key filters
    const select = u.searchParams.get('select');
    const order  = u.searchParams.get('order');
    const bits   = [];
    if (order)  bits.push(order.split('.')[0]);

    return table + (bits.length ? ' · ' + bits.join(', ') : '');
  } catch {
    return url.split('/').pop() || url;
  }
}

// ── Handle CDP messages ─────────────────────────────────────────────────────
function handleCDPMessage(msg) {
  const { method, params } = msg;

  // ── Network requests ──────────────────────────────────────────────────────
  if (method === 'Network.requestWillBeSent') {
    const url     = params?.request?.url ?? '';
    const reqMethod = params?.request?.method ?? 'GET';

    // Only capture Supabase API calls — skip everything else
    if (!url.includes('supabase')) return;

    // Skip images and screenshots
    if (url.match(/\.(png|jpg|jpeg|gif|webp|svg|ico)(\?|$)/i)) return;

    // Skip OPTIONS preflight requests
    if (reqMethod === 'OPTIONS') return;

    const label  = reqMethod + ' ' + cleanUrl(url);
    const nodeId = 'n' + (++nodeCounter);
    const parentId = callStack[callStack.length - 1];

    emitNode({
      id: nodeId,
      kind: 'ajax',
      label,
      file: 'supabase',
      line: 0,
      depth: callStack.length,
      timestamp: Date.now() - startTime,
      parentId,
    });

    if (parentId) {
      emitEdge({ id: 'e' + nodeId, source: parentId, target: nodeId, kind: 'ajax' });
    }

    // Keep on stack briefly so sequential calls chain together
    callStack.push(nodeId);
    setTimeout(() => {
      callStack = callStack.filter(id => id !== nodeId);
    }, 3000);
  }

  // ── Console messages from injected script ─────────────────────────────────
  if (method === 'Runtime.consoleAPICalled') {
    const text = params?.args?.[0]?.value ?? '';
    if (!text.startsWith('[CT]')) return;

    console.log('[Tracer]', text);

    if (text === '[CT]ready:injected') {
      broadcast({ type: 'status', message: 'Injected! Now click a button in your app.' });
      return;
    }

    // Parse [CT]click:label
    const withoutPrefix = text.slice(4);
    const colonIdx = withoutPrefix.indexOf(':');
    const eventType = withoutPrefix.slice(0, colonIdx);
    const label     = withoutPrefix.slice(colonIdx + 1) || 'unknown';

    const nodeId   = 'n' + (++nodeCounter);
    const parentId = callStack[callStack.length - 1];

    emitNode({
      id: nodeId,
      kind: 'js',
      label: label,
      file: 'browser',
      line: 0,
      depth: callStack.length,
      timestamp: Date.now() - startTime,
      parentId,
    });

    if (parentId) {
      emitEdge({ id: 'e' + nodeId, source: parentId, target: nodeId, kind: 'call' });
    }

    // Push click onto stack so API calls connect to it
    callStack.push(nodeId);
    setTimeout(() => {
      callStack = callStack.filter(id => id !== nodeId);
    }, 3000);
  }
}

function emitNode(node) { broadcast({ type: 'addNode', node }); }
function emitEdge(edge) { broadcast({ type: 'addEdge', edge }); }

console.log('[Tracer] Ready. Open canvas.html then click Start Recording.');

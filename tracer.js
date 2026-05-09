const http = require('http');
const WebSocket = require('ws');

const CHROME_PORT = 9222;
const TRACER_PORT = 7923;

// URLs containing any of these patterns will be captured as API nodes.
// Change to match your backend — e.g. ['.ashx', '/api/'] for a C# backend,
// or ['post_data'] if your app posts to PHP/ASHX files with that param.
const CAPTURE_URL_PATTERNS = ['supabase'];

let canvasClients = new Set();
let recording = false;
let nodeCounter = 0;
let sessionId = 'init';
let startTime = 0;
let callStack = [];
let cdpWs = null;
let cmdId = 1;
let pendingCallbacks = {};

// ── WebSocket server for canvas.html ──────────────────────────────────────────
const wss = new WebSocket.Server({ port: TRACER_PORT });

wss.on('connection', (client) => {
  canvasClients.add(client);
  console.log(`[Tracer] Canvas connected (${canvasClients.size} clients)`);
  client.send(JSON.stringify({ type: 'recording', value: recording }));

  client.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'startRecording') startRecording();
      if (msg.type === 'stopRecording')  stopRecording();
      if (msg.type === 'clearGraph')     broadcast({ type: 'clearGraph' });
    } catch (e) { console.error('[Tracer] bad message', e.message); }
  });

  client.on('close', () => canvasClients.delete(client));
});

console.log(`[Tracer] Listening on ws://localhost:${TRACER_PORT}`);
console.log(`[Tracer] Open canvas.html in your browser, then click Record.`);

function broadcast(msg) {
  const str = JSON.stringify(msg);
  canvasClients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(str); });
}

// ── Chrome tab list ───────────────────────────────────────────────────────────
function getChromeTabs() {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${CHROME_PORT}/json`, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Could not parse Chrome tab list')); }
      });
    }).on('error', () => reject(new Error(
      `Cannot reach Chrome on port ${CHROME_PORT}. ` +
      `Start Chrome with --remote-debugging-port=${CHROME_PORT}`
    )));
  });
}

function cdpSend(method, params = {}, cb = null) {
  if (cdpWs && cdpWs.readyState === WebSocket.OPEN) {
    const id = cmdId++;
    if (cb) pendingCallbacks[id] = cb;
    cdpWs.send(JSON.stringify({ id, method, params }));
  }
}

// ── Start recording ───────────────────────────────────────────────────────────
async function startRecording() {
  if (recording) return;

  try {
    const tabs = await getChromeTabs();

    const candidates = tabs.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
    console.log('[Tracer] Available page tabs:');
    candidates.forEach(t => console.log('  ', t.url));

    const target =
      candidates.find(t => t.url?.includes('127.0.0.1')) ||
      candidates.find(t => t.url?.includes('localhost') && !t.url?.includes('localhost:' + TRACER_PORT));

    if (!target) {
      broadcast({ type: 'error', message: 'No app tab found. Open your app in Chrome first.' });
      console.log('[Tracer] No suitable tab found.');
      return;
    }

    console.log(`[Tracer] Connecting to: ${target.url}`);
    cdpWs = new WebSocket(target.webSocketDebuggerUrl);

    cdpWs.on('open', () => {
      console.log('[Tracer] CDP connected');
      recording = true;
      nodeCounter = 0;
      sessionId = Date.now().toString(36) + '_';
      startTime = Date.now();
      callStack = [];
      pendingCallbacks = {};

      cdpSend('Runtime.enable');
      cdpSend('Network.enable');
      cdpSend('Page.enable');
      cdpSend('Profiler.enable');
      cdpSend('Profiler.setSamplingInterval', { interval: 100 });
      injectClickTracker();

      broadcast({ type: 'recording', value: true, sessionId });
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

// ── Stop recording ────────────────────────────────────────────────────────────
function stopRecording() {
  recording = false;
  if (cdpWs) { try { cdpWs.close(); } catch {} cdpWs = null; }
  broadcast({ type: 'recording', value: false });
  broadcast({ type: 'status', message: 'Stopped — drag nodes to arrange' });
  console.log('[Tracer] Recording stopped');
}

// ── Inject click tracker into the page ───────────────────────────────────────
function injectClickTracker() {
  cdpSend('Runtime.evaluate', {
    expression: `(function() {
      if (window.__ct) return;
      window.__ct = true;
      function label(el) {
        var cur = el;
        for (var i = 0; i < 10; i++) {
          if (!cur || cur === document.body) break;
          var v = cur.getAttribute && cur.getAttribute('data-view');
          if (v) return 'nav: ' + v;
          if (cur.tagName === 'BUTTON' || cur.tagName === 'A') {
            var a = cur.getAttribute('aria-label') || cur.getAttribute('title');
            if (a) return 'btn: ' + a.slice(0,30);
            var t = Array.from(cur.childNodes).filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join('').trim();
            if (t) return (cur.tagName==='BUTTON'?'btn':'link')+': '+t.slice(0,30);
            if (cur.id) return (cur.tagName==='BUTTON'?'btn':'link')+': #'+cur.id;
          }
          if (cur.id && cur.id.length < 40) return '#' + cur.id;
          cur = cur.parentElement;
        }
        return String(el.tagName).toLowerCase();
      }
      window.addEventListener('click', function(e) {
        console.log('[CT]click:' + label(e.target));
      }, true);
      console.log('[CT]ready:injected');
    })();`,
    awaitPromise: false,
  });
}

// ── Clean URL for display ─────────────────────────────────────────────────────
function cleanUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const table = parts[parts.length - 1] || u.pathname;
    const order = u.searchParams.get('order');
    return table + (order ? ' · ' + order.split('.')[0] : '');
  } catch { return url.split('/').pop() || url; }
}

// ── Handle CDP events & command responses ─────────────────────────────────────
function handleCDPMessage(msg) {
  // Dispatch command responses to registered callbacks
  if (msg.id !== undefined && pendingCallbacks[msg.id]) {
    const cb = pendingCallbacks[msg.id];
    delete pendingCallbacks[msg.id];
    cb(msg.result);
    return;
  }

  const { method, params } = msg;

  if (method === 'Page.loadEventFired') {
    console.log('[Tracer] Page reloaded — re-injecting');
    callStack = [];
    injectClickTracker();
    return;
  }

  if (method === 'Network.requestWillBeSent') {
    const url = params?.request?.url ?? '';
    const reqMethod = params?.request?.method ?? 'GET';
    const matchesPattern = CAPTURE_URL_PATTERNS.some(p => url.includes(p));
    if (!matchesPattern) return;
    if (url.match(/\.(png|jpg|jpeg|gif|webp|svg|ico)(\?|$)/i)) return;
    if (reqMethod === 'OPTIONS') return;

    const nodeId = sessionId + (++nodeCounter);
    const parentId = callStack[callStack.length - 1];
    emitNode({ id: nodeId, kind: 'ajax', label: reqMethod + ' ' + cleanUrl(url),
               file: 'api', timestamp: Date.now() - startTime, parentId });
    if (parentId) emitEdge({ id: 'e' + nodeId, source: parentId, target: nodeId, kind: 'ajax' });
    callStack.push(nodeId);
    setTimeout(() => { callStack = callStack.filter(x => x !== nodeId); }, 3000);
    return;
  }

  if (method === 'Runtime.consoleAPICalled') {
    const text = params?.args?.[0]?.value ?? '';
    if (!text.startsWith('[CT]')) return;
    console.log('[Tracer]', text);

    if (text === '[CT]ready:injected') {
      broadcast({ type: 'status', message: 'Injected! Click a button in your app.' });
      return;
    }

    const colonIdx = text.indexOf(':', 4);
    const label = text.slice(colonIdx + 1) || 'unknown';

    callStack = []; // clicks are always root nodes
    const clickId = sessionId + (++nodeCounter);
    emitNode({ id: clickId, kind: 'click', label, file: 'browser',
               timestamp: Date.now() - startTime });
    callStack.push(clickId);

    // Phase 4: sample JS call stack for ~400ms after the click
    cdpSend('Profiler.start');
    setTimeout(() => {
      cdpSend('Profiler.stop', {}, (result) => {
        if (result?.profile) parseProfile(result.profile, clickId);
      });
      callStack = callStack.filter(x => x !== clickId);
    }, 400);
  }
}

// ── Parse CPU profile → emit JS function nodes ────────────────────────────────
function parseProfile(profile, parentClickId) {
  const nodes = profile.nodes || [];
  const seen = new Set();
  let emitted = 0;

  const SKIP_FN = new Set(['(anonymous)', '(program)', '(idle)', '(garbage collector)', '']);
  const SKIP_URL = ['chrome', 'extension', 'node_modules', 'webpack', 'tracer.js', 'canvas.html'];

  nodes.forEach(node => {
    if (emitted >= 15) return;
    const { functionName, url, lineNumber } = node.callFrame;
    if (!url || SKIP_URL.some(s => url.includes(s))) return;
    if (SKIP_FN.has(functionName)) return;

    const key = functionName + '|' + url + '|' + lineNumber;
    if (seen.has(key)) return;
    seen.add(key);
    emitted++;

    const fileName = url.split('/').pop().split('?')[0] || url;
    const line = lineNumber + 1;
    console.log(`[Tracer] JS fn: ${functionName} @ ${fileName}:${line}`);

    const nodeId = sessionId + (++nodeCounter);
    emitNode({
      id: nodeId,
      kind: 'js',
      label: functionName,
      file: fileName + ':' + line,
      timestamp: Date.now() - startTime,
      parentId: parentClickId,
    });
    emitEdge({ id: 'e' + nodeId, source: parentClickId, target: nodeId, kind: 'js' });
  });

  if (emitted > 0) console.log(`[Tracer] Emitted ${emitted} JS function node(s) for click`);
  else console.log('[Tracer] No user JS functions captured (try clicking a button that does more work)');
}

function emitNode(n) { broadcast({ type: 'addNode', node: n }); }
function emitEdge(e) { broadcast({ type: 'addEdge', edge: e }); }

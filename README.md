# Code Tracer — Standalone

A non-invasive code tracer that connects to any web app via Chrome DevTools Protocol
and visualises the call path as a draggable spider graph. No code changes to your app needed.

## Setup (one time)

```bash
npm install
```

## Usage (every time)

**Step 1** — Start Chrome with remote debugging:
```bash
# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Temp\chrome-debug"

# Mac
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

**Step 2** — Open your app in that Chrome window and log in

**Step 3** — Start the tracer:
```bash
node tracer.js
```

**Step 4** — Open `canvas.html` in any browser (double-click it or DRAG TO BROWSER)

**Step 5** — Click **⏺ Record**, click a button in your app, watch the graph build

## What it captures

- **Click events** — every button/link click in your app
- **Network requests** — every API call (Supabase, fetch, XHR)
- **Edges** — connections between clicks and the API calls they trigger

## Files

- `tracer.js` — Node.js server that connects to Chrome via CDP
- `canvas.html` — Spider canvas UI (open in any browser)
- `package.json` — Just needs the `ws` package

## Tip — Create a Chrome shortcut

Right-click desktop → New → Shortcut
Location: `"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Temp\chrome-debug"`
Name: `Chrome Debug`

Use this shortcut whenever you want to trace code.

#!/usr/bin/env node
/**
 * Single-origin demo host: Vista Canvas + packaged Nordhavn Bank.
 *
 *   /mock-bank/*  → demo/mock-bank (static SPA)
 *   /api/*        → canvas agent API (:4174)
 *   /*            → Vite UI (:4173) or DESIGN_CANVAS_UI_ORIGIN
 *
 * Usage (with canvas `npm run dev` already running):
 *   DESIGN_CANVAS_TARGET=… node scripts/demo-host.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const canvasRoot = path.resolve(__dirname, '..');
const bankRoot = path.join(canvasRoot, 'demo', 'mock-bank');
const BANK_PREFIX = '/mock-bank';

const LISTEN_HOST = process.env.DEMO_HOST ?? '127.0.0.1';
const LISTEN_PORT = Number(process.env.DEMO_PORT ?? 4180);
const UI_ORIGIN = process.env.DESIGN_CANVAS_UI_ORIGIN ?? 'http://127.0.0.1:4173';
const API_ORIGIN = process.env.DESIGN_CANVAS_API_ORIGIN ?? 'http://127.0.0.1:4174';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

if (!fs.existsSync(path.join(bankRoot, 'index.html'))) {
  console.error(
    `[demo-host] Missing packaged bank at ${bankRoot}. Run: npm run package:mock-bank`,
  );
  process.exit(1);
}

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function safeBankFile(urlPathname) {
  const relative = decodeURIComponent(urlPathname.slice(BANK_PREFIX.length) || '/');
  const cleaned = path.posix.normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '');
  const abs = path.resolve(bankRoot, `.${cleaned === '/' ? '' : cleaned}`);
  if (!abs.startsWith(bankRoot)) return null;
  return abs;
}

function sendFile(res, filePath) {
  const data = fs.readFileSync(filePath);
  res.writeHead(200, {
    'content-type': contentType(filePath),
    'cache-control': 'no-cache',
    'access-control-allow-origin': '*',
  });
  res.end(data);
}

function serveBank(req, res, url) {
  let filePath = safeBankFile(url.pathname);
  if (!filePath) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    // SPA fallback for Angular routes under /mock-bank/*
    const indexPath = path.join(bankRoot, 'index.html');
    sendFile(res, indexPath);
    return;
  }

  sendFile(res, filePath);
}

function proxyTo(origin, req, res, url) {
  const target = new URL(url.pathname + url.search, origin);
  const headers = { ...req.headers, host: target.host };
  delete headers['accept-encoding'];

  const upstream = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Bad gateway (${origin}): ${err.message}`);
  });

  req.pipe(upstream);
}

function proxyUpgrade(origin, req, socket, head) {
  const target = new URL(req.url ?? '/', origin);
  const headers = { ...req.headers, host: target.host };
  const upstream = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    path: target.pathname + target.search,
    method: req.method,
    headers,
  });

  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(upRes.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\r\n')}\r\n\r\n`,
    );
    if (upHead.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
  if (head.length) upstream.write(head);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${LISTEN_HOST}:${LISTEN_PORT}`);

  if (url.pathname === BANK_PREFIX || url.pathname.startsWith(`${BANK_PREFIX}/`)) {
    serveBank(req, res, url);
    return;
  }

  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    proxyTo(API_ORIGIN, req, res, url);
    return;
  }

  proxyTo(UI_ORIGIN, req, res, url);
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${LISTEN_HOST}:${LISTEN_PORT}`);
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    proxyUpgrade(API_ORIGIN, req, socket, head);
    return;
  }
  if (url.pathname.startsWith(BANK_PREFIX)) {
    socket.destroy();
    return;
  }
  proxyUpgrade(UI_ORIGIN, req, socket, head);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  const origin = `http://${LISTEN_HOST}:${LISTEN_PORT}`;
  console.log(`[demo-host] ${origin}`);
  console.log(`[demo-host] canvas  ← ${UI_ORIGIN}`);
  console.log(`[demo-host] api     ← ${API_ORIGIN}`);
  console.log(`[demo-host] bank    ← ${pathToFileURL(bankRoot).href}`);
  console.log(`[demo-host] set DESIGN_CANVAS_APP_ORIGIN=${origin}${BANK_PREFIX}`);
});

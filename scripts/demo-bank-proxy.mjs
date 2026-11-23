#!/usr/bin/env node
/**
 * Demo reverse proxy: one origin for Nordhavn Bank shell + Native Federation remotes.
 * Rewrites /federation.manifest.json so remotes load under /mfe/<name>/…
 *
 * Usage: node scripts/demo-bank-proxy.mjs
 * Default listen: 127.0.0.1:8787
 */
import http from 'node:http';
import { URL } from 'node:url';

const LISTEN_HOST = process.env.DEMO_PROXY_HOST ?? '127.0.0.1';
const LISTEN_PORT = Number(process.env.DEMO_PROXY_PORT ?? 8787);

const REMOTES = [
  { name: 'accounts-mfe', prefix: '/mfe/accounts', port: 4201 },
  { name: 'account-detail-mfe', prefix: '/mfe/account-detail', port: 4202 },
  { name: 'nav-mfe', prefix: '/mfe/nav', port: 4203 },
  { name: 'transfer-mfe', prefix: '/mfe/transfer', port: 4204 },
  { name: 'profile-mfe', prefix: '/mfe/profile', port: 4205 },
];

const SHELL_PORT = 4200;

const MANIFEST = Object.fromEntries(
  REMOTES.map((r) => [r.name, `${r.prefix}/remoteEntry.json`]),
);

function resolveTarget(pathname) {
  for (const remote of REMOTES) {
    if (pathname === remote.prefix || pathname.startsWith(`${remote.prefix}/`)) {
      const rest = pathname.slice(remote.prefix.length) || '/';
      return { port: remote.port, path: rest };
    }
  }
  return { port: SHELL_PORT, path: pathname };
}

function proxy(req, res) {
  const url = new URL(req.url ?? '/', `http://${LISTEN_HOST}:${LISTEN_PORT}`);

  if (url.pathname === '/federation.manifest.json') {
    const body = JSON.stringify(MANIFEST, null, 2);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(body);
    return;
  }

  const target = resolveTarget(url.pathname);
  const headers = { ...req.headers, host: `localhost:${target.port}` };
  delete headers['accept-encoding'];

  const upstream = http.request(
    {
      // Angular `ng serve` binds IPv6 localhost on this machine — not 127.0.0.1.
      hostname: 'localhost',
      port: target.port,
      path: `${target.path}${url.search}`,
      method: req.method,
      headers,
      family: 0,
    },
    (up) => {
      const outHeaders = { ...up.headers };
      outHeaders['access-control-allow-origin'] = '*';
      res.writeHead(up.statusCode ?? 502, outHeaders);
      up.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Bad gateway (${target.port}): ${err.message}`);
  });

  req.pipe(upstream);
}

const server = http.createServer(proxy);

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${LISTEN_HOST}:${LISTEN_PORT}`);
  const target = resolveTarget(url.pathname);
  const headers = { ...req.headers, host: `localhost:${target.port}` };

  const upstream = http.request({
    hostname: 'localhost',
    port: target.port,
    path: `${target.path}${url.search}`,
    method: req.method,
    headers,
    family: 0,
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
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(
    `[demo-bank-proxy] http://${LISTEN_HOST}:${LISTEN_PORT} → shell :${SHELL_PORT} + remotes`,
  );
});

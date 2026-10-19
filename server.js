/**
 * Zero-framework web server.
 *
 * Node's built-in http module is enough for a proof of concept: no express,
 * no bundler, no build step.
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { compare } from './src/diff.js';
import { classifyChanges, llmConfig } from './src/agent.js';
import { buildMemo } from './src/report.js';
import { extractText, isSupported, SUPPORTED_EXTENSIONS } from './src/extract.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Load .env when present, so `npm start` picks up the optional model config.
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env file: rules-based classification only. This is the default path.
}

const PORT = Number(process.env.PORT) || 4310;
const HOST = process.env.HOST?.trim() || '0.0.0.0';

const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(new Error(`That file is too large. The limit is ${Math.round(limit / (1024 * 1024))} MB.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

async function handleCompare(req, res) {
  let payload;
  try {
    const raw = await readBody(req, MAX_JSON_BYTES);
    payload = JSON.parse(raw.toString('utf8') || '{}');
  } catch (error) {
    return sendJson(res, 400, { error: `Could not read the request: ${error.message}` });
  }

  const before = typeof payload.before === 'string' ? payload.before : '';
  const after = typeof payload.after === 'string' ? payload.after : '';

  if (before.trim() === '' || after.trim() === '') {
    return sendJson(res, 400, { error: 'Provide text for both versions before comparing.' });
  }

  const beforeName = typeof payload.beforeName === 'string' && payload.beforeName ? payload.beforeName : 'before';
  const afterName = typeof payload.afterName === 'string' && payload.afterName ? payload.afterName : 'after';

  try {
    // Step 1 and 2: deterministic. Never guessed, never model-generated.
    const { changes, stats } = compare(before, after);

    // Step 3: judgement, with a rules-based fallback.
    const { findings, engine } = await classifyChanges(changes, { useLLM: payload.useLLM !== false });

    // Step 4: compose the memo from verified findings only.
    const memo = buildMemo({ beforeName, afterName, findings, stats, engine });

    return sendJson(res, 200, { stats, findings, memo, engine, beforeName, afterName });
  } catch (error) {
    return sendJson(res, 422, { error: error.message });
  }
}

async function handleExtract(req, res) {
  let filename = 'document';
  const header = req.headers['x-filename'];
  if (typeof header === 'string' && header.trim() !== '') {
    try {
      filename = decodeURIComponent(header);
    } catch {
      filename = header;
    }
  }

  if (!isSupported(filename)) {
    return sendJson(res, 415, {
      error: `Unsupported file type. Upload one of: ${SUPPORTED_EXTENSIONS.join(', ')}.`,
    });
  }

  let buffer;
  try {
    buffer = await readBody(req, MAX_UPLOAD_BYTES);
  } catch (error) {
    return sendJson(res, 413, { error: error.message });
  }

  if (buffer.length === 0) {
    return sendJson(res, 400, { error: 'The uploaded file was empty.' });
  }

  try {
    const { text, info } = await extractText(buffer, filename);
    return sendJson(res, 200, { text, info });
  } catch (error) {
    return sendJson(res, 422, { error: `Could not read ${filename}: ${error.message}` });
  }
}

async function handleStatic(req, res, pathname) {
  let relative;
  if (pathname === '/') relative = 'public/index.html';
  else if (pathname === '/README.md') relative = 'README.md';
  else if (pathname.startsWith('/samples/')) relative = pathname.slice(1);
  else relative = `public${pathname}`;

  const target = path.resolve(ROOT, relative);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/health') {
    const config = llmConfig();
    return sendJson(res, 200, { status: 'ok', engine: config.enabled ? `model:${config.model}` : 'rules' });
  }

  if (pathname === '/api/compare' && req.method === 'POST') {
    return handleCompare(req, res);
  }

  if (pathname === '/api/extract' && req.method === 'POST') {
    return handleExtract(req, res);
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return handleStatic(req, res, pathname);
  }

  return sendJson(res, 405, { error: 'Method not allowed' });
});

/**
 * IPv4 addresses a colleague could actually reach. Virtual adapters (WSL,
 * Hyper-V, Docker, VMware) and link-local addresses are skipped, because
 * printing five URLs where one works is worse than printing none.
 */
function networkUrls(port) {
  const virtualAdapter = /vEthernet|VirtualBox|VMware|Hyper-V|Loopback|WSL|Docker|Bluetooth|Tailscale|ZeroTier/i;
  const found = [];

  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (virtualAdapter.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (address.address.startsWith('169.254.')) continue;
      found.push({ name, url: `http://${address.address}:${port}` });
    }
  }

  return found;
}

server.listen(PORT, HOST, () => {
  const config = llmConfig();
  const shared = networkUrls(PORT);

  console.log('');
  console.log('  DocDiff Reviewer is running');
  console.log('');
  console.log(`  Local:     http://localhost:${PORT}`);
  if (shared.length === 0) {
    console.log('  Share:     no network address found (this machine is offline)');
  } else {
    for (const entry of shared) {
      console.log(`  Share:     ${entry.url}   (${entry.name})`);
    }
  }
  console.log(`  Engine:    ${config.enabled ? `model:${config.model}` : 'rules (no API key needed)'}`);
  console.log(`  Uploads:   ${SUPPORTED_EXTENSIONS.join(', ')} up to 10 MB`);
  console.log('');
  console.log('  Colleagues on the same network use the Share address.');
  console.log('  If it does not load, allow Node.js through Windows Firewall.');
  console.log('');
});

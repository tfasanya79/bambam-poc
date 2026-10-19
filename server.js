/**
 * Zero-dependency web server.
 *
 * Node's built-in http module is enough for a proof of concept: no express,
 * no bundler, no build step. `node server.js` is the whole install.
 */

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { compare } from './src/diff.js';
import { classifyChanges, llmConfig } from './src/agent.js';
import { buildMemo } from './src/report.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Load .env when present, so `npm start` picks up the optional model config.
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env file: rules-based classification only. This is the default path.
}

const PORT = Number(process.env.PORT) || 4310;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large. Keep each document under 5 MB.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleCompare(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req) || '{}');
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

  if (req.method === 'GET' || req.method === 'HEAD') {
    return handleStatic(req, res, pathname);
  }

  return sendJson(res, 405, { error: 'Method not allowed' });
});

server.listen(PORT, () => {
  const config = llmConfig();
  console.log(`DocDiff Reviewer running at http://localhost:${PORT}`);
  console.log(`Classification engine: ${config.enabled ? `model:${config.model}` : 'rules (no API key needed)'}`);
});

#!/usr/bin/env node
// Receives research logs from the glasses over the local network.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFile, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_OUTPUT = fileURLToPath(new URL('../output/device-logs/', import.meta.url));
const BODY_LIMIT = 4 * 1024 * 1024;
const RUN_BYTE_LIMIT = 16 * 1024 * 1024;
const ROW_LIMIT = 12_000;
const CHUNK_LIMIT = 1024;
const EXPORT_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const PART_FILE = /^\d{5}\.json$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const partName = chunk => `${String(chunk).padStart(5, '0')}.json`;

class RequestError extends Error {
  constructor(status, code, fields = {}) {
    super(code);
    this.status = status;
    this.fields = fields;
  }
}

function respond(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function requestPath(target = '') {
  // A proxy can forward an absolute request target with the origin attached.
  const [path] = target.replace(/^https?:\/\/[^/?#]+/i, '').split(/[?#]/, 1);
  return path.startsWith('/') || path === '*' ? path : '';
}

async function readBody(req) {
  if (Number(req.headers['content-length']) > BODY_LIMIT) {
    throw new RequestError(413, 'body_too_large');
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > BODY_LIMIT) throw new RequestError(413, 'body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseBody(body) {
  try { return JSON.parse(body); }
  catch { throw new RequestError(400, 'invalid_json'); }
}

function validateChunk(parsed) {
  const { exportId, chunk, rows, final = false, droppedRows = 0 } = parsed;
  if (typeof exportId !== 'string' || !EXPORT_ID.test(exportId) || !isCount(chunk) || chunk >= CHUNK_LIMIT ||
      !Array.isArray(rows) || rows.length > ROW_LIMIT || !rows.every(isObject) ||
      typeof final !== 'boolean' || !isCount(droppedRows)) {
    throw new RequestError(400, 'invalid_chunk');
  }
  return { exportId, chunk, rows, final, droppedRows };
}

async function writeAtomic(path, text) {
  const temp = join(dirname(path), `.write-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, text, { flag: 'wx', mode: 0o600, flush: true });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

async function readParts(directory) {
  let names;
  try { names = await readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const parts = [];
  for (const name of names.filter(name => PART_FILE.test(name)).sort()) {
    if (name !== partName(parts.length) || parts.length >= CHUNK_LIMIT) throw new Error('Invalid chunk journal order');
    const text = await readFile(join(directory, name), 'utf8');
    parts.push({ text, entry: JSON.parse(text) });
  }
  return parts;
}

async function saveChunk(directory, output, entry) {
  const parts = await readParts(directory);
  const expectedChunk = parts.length;
  const text = JSON.stringify(entry);
  const duplicate = entry.chunk < expectedChunk;
  if (duplicate) {
    if (parts[entry.chunk].text !== text) {
      throw new RequestError(409, 'chunk_conflict', { expectedChunk });
    }
  } else {
    if (entry.chunk !== expectedChunk) {
      throw new RequestError(409, 'chunk_out_of_order', { expectedChunk });
    }
    if (parts.at(-1)?.entry.final) {
      throw new RequestError(409, 'run_finished', { expectedChunk });
    }
    const rowCount = parts.reduce((sum, part) => sum + part.entry.rows.length, entry.rows.length);
    const byteCount = parts.reduce((sum, part) => sum + Buffer.byteLength(part.text), Buffer.byteLength(text));
    if (rowCount > ROW_LIMIT || byteCount > RUN_BYTE_LIMIT) throw new RequestError(413, 'run_too_large');
    if (!expectedChunk) {
      // An archive produced without a journal belongs to an earlier receiver.
      try { await lstat(output); throw new RequestError(409, 'run_archive_exists'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await mkdir(directory, { recursive: true });
    }
    await writeAtomic(join(directory, partName(entry.chunk)), text);
    parts.push({ entry });
  }

  // The journal is authoritative. Retrying after a crash between these writes
  // rebuilds the visible JSONL without duplicating any rows.
  const jsonl = parts.map(({ entry: part }) => part.rows.map(row => `${JSON.stringify(row)}\n`).join('')).join('');
  await writeAtomic(output, jsonl);
  return { ok: true, exportId: entry.exportId, chunk: entry.chunk, duplicate, final: entry.final, droppedRows: entry.droppedRows };
}

export async function createLogServer({ outputDirectory = DEFAULT_OUTPUT, logger = console } = {}) {
  const output = resolve(outputDirectory);
  const journal = join(output, '.chunks');
  await mkdir(journal, { recursive: true });
  const requests = new Map();
  const serialize = (id, task) => {
    const next = (requests.get(id) ?? Promise.resolve()).catch(() => {}).then(task);
    requests.set(id, next);
    return next.finally(() => { if (requests.get(id) === next) requests.delete(id); });
  };

  return createServer({ requestTimeout: 15_000 }, async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    const path = requestPath(req.url);
    const endpoint = path === '/log/' || path === '/health/' ? path.slice(0, -1) : path;
    if (endpoint !== '/log' && endpoint !== '/health') {
      logger.log(`[log] unmatched ${req.method} ${JSON.stringify(path)}`);
      return respond(res, 404, { ok: false, error: 'not_found' });
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': endpoint === '/log' ? 'POST, OPTIONS' : 'GET, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      return res.end();
    }
    const allowed = endpoint === '/log' ? 'POST' : 'GET';
    if (req.method !== allowed) {
      res.setHeader('allow', `${allowed}, OPTIONS`);
      return respond(res, 405, { ok: false, error: 'method_not_allowed' });
    }
    if (endpoint === '/health') return respond(res, 200, { ok: true });

    try {
      const body = await readBody(req);
      const parsed = parseBody(body);
      if (isObject(parsed) && ['exportId', 'chunk', 'rows', 'final', 'droppedRows'].some(key => Object.hasOwn(parsed, key))) {
        const entry = validateChunk(parsed);
        const result = await serialize(entry.exportId, () => saveChunk(
          join(journal, entry.exportId), join(output, `run-${entry.exportId}.jsonl`), entry,
        ));
        if (!result.duplicate) logger.log(`[log] chunk ${entry.chunk} (${entry.rows.length} rows) -> run-${entry.exportId}.jsonl`);
        return respond(res, 200, result);
      }

      // Keep the original endpoint usable for existing one-shot JSON and probes.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = join(output, `run-${stamp}-${randomUUID().slice(0, 8)}.json`);
      await writeFile(file, body, { flag: 'wx', mode: 0o600 });
      await appendFile(join(output, 'index.txt'), `${new Date().toISOString()} ${req.socket.remoteAddress} ${Buffer.byteLength(body)}B ${file}\n`);
      logger.log(`[log] ${Buffer.byteLength(body)} bytes -> ${file}`);
      return respond(res, 200, { ok: true });
    } catch (error) {
      if (error instanceof RequestError) {
        if (error.status === 413) req.resume();
        return respond(res, error.status, { ok: false, error: error.message, ...error.fields });
      }
      logger.error('[log] write failed', error);
      return respond(res, 500, { ok: false, error: 'write_failed' });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  const server = await createLogServer();
  server.listen(port, '0.0.0.0', () => console.log(`[log] listening on http://0.0.0.0:${server.address().port}`));
}

// Integration tests for /api/operations.
//
// Spins up the real Express app against a throwaway libSQL file, goes through
// auth + CSRF, and exercises the full CRUD surface. Uses the built-in fetch
// (Node 18+) with a minimal cookie jar so we don't add a supertest dep.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Must be set BEFORE requiring the app so db/database.js picks up the override.
const tmpDbPath = path.join(os.tmpdir(), `surebet-test-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
process.env.TURSO_DATABASE_URL = 'file:' + tmpDbPath;
process.env.JWT_SECRET = 'test-secret-' + crypto.randomBytes(8).toString('hex');
process.env.NODE_ENV = 'test';

const app = require('../app');

let server;
let baseUrl;

// Minimal cookie jar — fetch in Node doesn't thread cookies automatically.
const jar = {
  cookies: new Map(),
  accept(setCookieLine) {
    const [pair] = setCookieLine.split(';');
    const eq = pair.indexOf('=');
    if (eq === -1) return;
    const name = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (val === '') this.cookies.delete(name);
    else this.cookies.set(name, val);
  },
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  },
  reset() { this.cookies.clear(); },
};

async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (jar.cookies.size) headers.cookie = jar.header();
  const csrf = jar.cookies.get('csrf_token');
  if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.raw?.()?.['set-cookie'] || []);
  for (const c of setCookies) jar.accept(c);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;

  // Seed CSRF cookie (any safe-method request triggers the middleware).
  await req('GET', '/api/auth/me');

  // Register a throwaway user; issueSession sets the token cookie.
  const uname = 'test' + crypto.randomBytes(3).toString('hex');
  const r = await req('POST', '/api/auth/register', {
    username: uname,
    password: 'TestPass1234!',
    display_name: 'Test User',
  });
  if (r.status !== 200) throw new Error('register failed: ' + JSON.stringify(r.data));
}, 30000);

afterAll(async () => {
  await new Promise(r => server.close(r));
  // libSQL may hold the file handle for a tick; best-effort cleanup.
  try { fs.unlinkSync(tmpDbPath); } catch {}
  try { fs.unlinkSync(tmpDbPath + '-wal'); } catch {}
  try { fs.unlinkSync(tmpDbPath + '-shm'); } catch {}
});

describe('GET /api/operations', () => {
  it('returns an empty list for a fresh user with pagination metadata', async () => {
    const r = await req('GET', '/api/operations');
    expect(r.status).toBe(200);
    expect(r.data.operations).toEqual([]);
    expect(r.data.total).toBe(0);
    expect(r.data.pagination).toMatchObject({ hasMore: false });
    expect(r.data.pagination.limit).toBeGreaterThan(0);
  });

  it('caps oversized limit at 100', async () => {
    const r = await req('GET', '/api/operations?limit=9999');
    expect(r.status).toBe(200);
    expect(r.data.pagination.limit).toBe(100);
  });

  it('ignores negative or non-numeric offset', async () => {
    const r = await req('GET', '/api/operations?offset=-5');
    expect(r.status).toBe(200);
    expect(r.data.pagination.offset).toBe(0);
  });
});

describe('POST /api/operations', () => {
  it('creates an operation and returns its id', async () => {
    const r = await req('POST', '/api/operations', {
      type: 'aquecimento',
      game: 'Team A vs Team B',
      stake_bet365: 100,
      odd_bet365: 2.5,
      stake_poly_usd: 20,
      odd_poly: 1.8,
      exchange_rate: 5.0,
      result: 'pending',
      profit: 0,
      tags: ['liga-A'],
    });
    expect(r.status).toBe(200);
    expect(r.data.id).toBeGreaterThan(0);
  });

  it('rejects missing required fields', async () => {
    const r = await req('POST', '/api/operations', { type: 'aquecimento' });
    expect(r.status).toBe(400);
  });

  it('includes the created operation in list with tags', async () => {
    const r = await req('GET', '/api/operations');
    expect(r.status).toBe(200);
    expect(r.data.operations.length).toBeGreaterThan(0);
    const op = r.data.operations[0];
    expect(op.game).toBe('Team A vs Team B');
    expect(Array.isArray(op.tags)).toBe(true);
    expect(op.tags).toContain('liga-a'); // tags lowercased server-side
  });
});

describe('PUT /api/operations/:id', () => {
  let opId;
  beforeAll(async () => {
    const r = await req('POST', '/api/operations', {
      type: 'arbitragem',
      game: 'Update Target',
      stake_bet365: 50,
      odd_bet365: 3.0,
      result: 'pending',
      profit: 10,
    });
    opId = r.data.id;
  });

  it('updates profit and result', async () => {
    const r = await req('PUT', '/api/operations/' + opId, {
      result: 'bet365_won', profit: 25.5,
    });
    expect(r.status).toBe(200);
    const list = await req('GET', '/api/operations');
    const updated = list.data.operations.find(o => o.id === opId);
    expect(updated.result).toBe('bet365_won');
    expect(updated.profit).toBeCloseTo(25.5);
  });

  it('returns 404 for an operation that does not exist', async () => {
    const r = await req('PUT', '/api/operations/999999', { profit: 0 });
    expect(r.status).toBe(404);
  });
});

describe('DELETE /api/operations/:id', () => {
  it('deletes and returns a snapshot for undo', async () => {
    const created = await req('POST', '/api/operations', {
      type: 'aquecimento',
      game: 'To Delete',
      stake_bet365: 10,
      odd_bet365: 2.0,
      result: 'pending',
      profit: 0,
    });
    const id = created.data.id;

    const del = await req('DELETE', '/api/operations/' + id);
    expect(del.status).toBe(200);
    expect(del.data.ok).toBe(true);
    expect(del.data.snapshot).toMatchObject({ game: 'To Delete', type: 'aquecimento' });

    const list = await req('GET', '/api/operations');
    expect(list.data.operations.find(o => o.id === id)).toBeUndefined();
  });

  it('can re-create from the snapshot (undo semantics)', async () => {
    const created = await req('POST', '/api/operations', {
      type: 'aquecimento',
      game: 'Undo Me',
      stake_bet365: 30,
      odd_bet365: 2.1,
      result: 'pending',
      profit: 5,
      tags: ['restored'],
    });
    const del = await req('DELETE', '/api/operations/' + created.data.id);
    const recreated = await req('POST', '/api/operations', del.data.snapshot);
    expect(recreated.status).toBe(200);
    expect(recreated.data.id).not.toBe(created.data.id);

    const list = await req('GET', '/api/operations');
    const op = list.data.operations.find(o => o.id === recreated.data.id);
    expect(op.game).toBe('Undo Me');
    expect(op.tags).toContain('restored');
  });
});

describe('auth boundary', () => {
  it('rejects requests without a session cookie', async () => {
    // Bypass the shared jar to simulate an unauthenticated client.
    const res = await fetch(baseUrl + '/api/operations');
    expect(res.status).toBe(401);
  });
});

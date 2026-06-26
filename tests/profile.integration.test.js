// Integration tests for the profile (avatar/bio) endpoints and the single-active-
// session enforcement (anti shared-account). Spins up the real app against a
// throwaway libSQL file with a minimal cookie jar (no supertest dep).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const tmpDbPath = path.join(os.tmpdir(), `surebet-profile-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
process.env.TURSO_DATABASE_URL = 'file:' + tmpDbPath;
process.env.JWT_SECRET = 'test-secret-' + crypto.randomBytes(8).toString('hex');
process.env.NODE_ENV = 'test';

const app = require('../app');

let server, baseUrl;

// 1x1 transparent PNG.
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAUH7C3PtAAAAAElFTkSuQmCC';

function makeJar() {
  return {
    cookies: new Map(),
    accept(line) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq === -1) return;
      const name = pair.slice(0, eq).trim();
      const val = pair.slice(eq + 1).trim();
      if (val === '') this.cookies.delete(name); else this.cookies.set(name, val);
    },
    header() { return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
  };
}

async function req(jar, method, p, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (jar.cookies.size) headers.cookie = jar.header();
  const csrf = jar.cookies.get('csrf_token');
  if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const res = await fetch(baseUrl + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : (res.headers.raw?.()?.['set-cookie'] || []);
  for (const c of setCookies) jar.accept(c);
  const ct = res.headers.get('content-type') || '';
  let data = null;
  if (ct.includes('application/json')) { try { data = await res.json(); } catch { data = null; } }
  else { data = await res.arrayBuffer(); }
  return { status: res.status, data, contentType: ct };
}

const creds = { username: 'prof' + crypto.randomBytes(3).toString('hex'), password: 'TestPass1234!', display_name: 'Prof User' };
let userId;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, 30000);

afterAll(async () => {
  await new Promise(r => server.close(r));
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDbPath + s); } catch {} }
});

describe('single active session (anti shared-account)', () => {
  const devA = makeJar();
  const devB = makeJar();

  it('logging in on a second device revokes the first', async () => {
    await req(devA, 'GET', '/api/auth/me');            // seed csrf for device A
    const reg = await req(devA, 'POST', '/api/auth/register', creds);
    expect(reg.status).toBe(200);
    userId = reg.data.id;

    // Device B logs in as the same user → device A's session must be revoked.
    await req(devB, 'GET', '/api/auth/me');            // seed csrf for device B
    const login = await req(devB, 'POST', '/api/auth/login', { username: creds.username, password: creds.password });
    expect(login.status).toBe(200);

    const aAfter = await req(devA, 'GET', '/api/profile');
    expect(aAfter.status).toBe(401);

    const bAfter = await req(devB, 'GET', '/api/profile');
    expect(bAfter.status).toBe(200);
  });
});

describe('profile (bio + avatar)', () => {
  const dev = makeJar();

  it('runs the full profile lifecycle', async () => {
    await req(dev, 'GET', '/api/auth/me');
    const login = await req(dev, 'POST', '/api/auth/login', { username: creds.username, password: creds.password });
    expect(login.status).toBe(200);

    // bio
    const putBio = await req(dev, 'PUT', '/api/profile', { bio: 'olá mundo' });
    expect(putBio.status).toBe(200);
    expect(putBio.data.bio).toBe('olá mundo');

    // can't switch to custom before uploading an image
    const noImg = await req(dev, 'PUT', '/api/profile', { avatar_source: 'custom' });
    expect(noImg.status).toBe(400);

    // upload avatar → source becomes custom
    const up = await req(dev, 'POST', '/api/profile/avatar', { data: PNG_DATA_URL });
    expect(up.status).toBe(200);
    expect(up.data).toMatchObject({ avatar_source: 'custom', has_avatar: true });

    // /me reflects it
    const me = await req(dev, 'GET', '/api/auth/me');
    expect(me.data).toMatchObject({ bio: 'olá mundo', avatar_source: 'custom', has_avatar: true });

    // image is served
    const img = await req(dev, 'GET', `/api/profile/avatar/${userId}`);
    expect(img.status).toBe(200);
    expect(img.contentType).toContain('image/png');

    // rejects a non-image
    const bad = await req(dev, 'POST', '/api/profile/avatar', { data: 'data:text/plain;base64,aGVsbG8=' });
    expect(bad.status).toBe(400);

    // delete → falls back to discord, no image
    const del = await req(dev, 'DELETE', '/api/profile/avatar');
    expect(del.status).toBe(200);
    expect(del.data).toMatchObject({ avatar_source: 'discord', has_avatar: false });

    const gone = await req(dev, 'GET', `/api/profile/avatar/${userId}`);
    expect(gone.status).toBe(404);
  });
});

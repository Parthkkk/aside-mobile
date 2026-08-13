/**
 * Running with no Telegram at all.
 *
 * The repo's headline case is the installed phone app, but the server used
 * to refuse to boot without a Telegram bot token and chat id: `loadConfig`
 * threw and told the reader to run a setup script that lives in a different
 * project. A fresh clone could not start, so every instruction after step 4
 * of the README was unreachable.
 *
 * The security half matters more than the convenience half. `validateInitData`
 * HMACs with the bot token as its key, so an empty token is a key anyone
 * can reproduce. Standalone mode must therefore refuse `/api/auth` outright
 * rather than validate against nothing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import {
  STANDALONE_OWNER_ID,
  loadConfig,
  loadOrCreateJwtSecret,
} from '../src/config.js';
import { derivePairingKey } from '../src/pair.js';

let tmp: string;
let app: FastifyInstance;
let secret: string;
const saved = { ...process.env };

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-'));
  // A config path that does not exist: exactly what a fresh clone has.
  process.env.MINIAPP_CONFIG = path.join(tmp, 'missing-config.json');
  process.env.MINIAPP_STATE_DIR = path.join(tmp, 'state');
  process.env.MINIAPP_SECRET_PATH = path.join(tmp, 'secret.json');
  process.env.MINIAPP_SESSIONS_DIR = path.join(tmp, 'sessions');
  fs.mkdirSync(path.join(tmp, 'sessions'), { recursive: true });
});

afterEach(async () => {
  await app?.close();
  process.env = { ...saved };
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function boot(): Promise<void> {
  const config = loadConfig();
  secret = loadOrCreateJwtSecret(config.secretPath);
  ({ app } = await buildServer(config, { jwtSecret: secret }));
  await app.ready();
}

describe('a clone with no config file', () => {
  it('loads a config instead of throwing', () => {
    const config = loadConfig();
    expect(config.standalone).toBe(true);
    expect(config.botToken).toBe('');
    expect(config.allowedUserId).toBe(STANDALONE_OWNER_ID);
  });

  it('does not greet a stranger by the original author name', () => {
    expect(loadConfig().miniapp.ownerName).toBe('');
  });

  it('boots and answers /api/health', async () => {
    await boot();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('refuses /api/auth rather than HMAC against an empty key', async () => {
    await boot();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth',
      payload: { initDataRaw: 'user=%7B%22id%22%3A1%7D&hash=whatever' },
    });
    // 404, not 401: the route does not exist in this mode at all.
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'telegram_not_configured' });
  });

  it('still pairs, and the token works on a real route', async () => {
    await boot();
    const paired = await app.inject({
      method: 'POST',
      url: '/api/pair',
      payload: { key: derivePairingKey(secret) },
    });
    expect(paired.statusCode).toBe(200);
    const token = paired.json().token as string;
    expect(token).toBeTruthy();

    const authed = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authed.statusCode).toBe(200);
  });

  it('refuses framing outright, since no Telegram means no iframe host', async () => {
    await boot();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(String(res.headers['content-security-policy'])).toContain(
      "frame-ancestors 'none'",
    );
  });

  it('rejects a wrong pairing key', async () => {
    await boot();
    const res = await app.inject({
      method: 'POST',
      url: '/api/pair',
      payload: { key: '0'.repeat(32) },
    });
    expect(res.statusCode).toBe(401);
  });

  it('keeps its secret out of the repo and mode 600', async () => {
    await boot();
    const file = process.env.MINIAPP_SECRET_PATH as string;
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('a config with a token but no chat id', () => {
  it('still fails loudly, because that one is a real mistake', () => {
    const file = path.join(tmp, 'half-config.json');
    fs.writeFileSync(file, JSON.stringify({ token: '123:abc' }));
    process.env.MINIAPP_CONFIG = file;
    expect(() => loadConfig()).toThrow(/chat_id/);
  });
});

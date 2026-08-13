/**
 * The pairing page must not be reachable through the proxied port.
 *
 * The bug these guard: `/pair` lived on the main app behind a
 * `request.ip === '127.0.0.1'` check. `tailscale serve` terminates TLS and
 * proxies to loopback, and `trustProxy` is off, so every tailnet request
 * presented as loopback and the check passed for everyone. Fetching
 * `https://<tailnet-host>/pair` returned the QR byte-for-byte identical to
 * the loopback response.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { loadConfig, loadOrCreateJwtSecret } from '../src/config.js';
import { buildPairServer, derivePairingKey } from '../src/pair.js';
import { makeTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let app: FastifyInstance;
let webDist: string;
let secret: string;

beforeEach(async () => {
  env = makeTestEnv();
  const config = loadConfig();
  secret = loadOrCreateJwtSecret(config.secretPath);
  // `/pair` is only registered when a built SPA is present, so the pointer
  // page needs one to exist at all.
  webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-dist-'));
  fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html>ok');
  ({ app } = await buildServer(config, { jwtSecret: secret, webDist }));
  await app.ready();
});

afterEach(async () => {
  await app.close();
  fs.rmSync(webDist, { recursive: true, force: true });
  env.cleanup();
});

describe('the proxied port never serves the pairing page', () => {
  it('refuses /pair even when the request presents as loopback', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pair',
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(403);
    // The QR is the credential. It must not be in the body at any IP.
    expect(res.body).not.toContain('data:image/png;base64');
    expect(res.body).not.toContain(derivePairingKey(secret));
  });

  it('refuses /pair for a request that arrived over the tailnet', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pair',
      remoteAddress: '100.96.251.107',
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(derivePairingKey(secret));
  });

  it('points at the separate loopback port', async () => {
    const res = await app.inject({ method: 'GET', url: '/pair' });
    expect(res.body).toContain('127.0.0.1:8791/pair');
  });
});

describe('the pairing listener', () => {
  it('serves the QR to loopback', async () => {
    const pairApp = buildPairServer({ jwtSecret: secret, appPort: 8790 });
    await pairApp.ready();
    const res = await pairApp.inject({
      method: 'GET',
      url: '/pair',
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data:image/png;base64');
    await pairApp.close();
  });

  it('still refuses a non-loopback peer, in case someone proxies this port too', async () => {
    const pairApp = buildPairServer({ jwtSecret: secret, appPort: 8790 });
    await pairApp.ready();
    const res = await pairApp.inject({
      method: 'GET',
      url: '/pair',
      remoteAddress: '100.96.251.107',
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('data:image/png;base64');
    await pairApp.close();
  });

  it('derives the same key the app checks submissions against', () => {
    // build-android.sh derives this a third time, in python. If this
    // constant changes, that copy has to change with it.
    expect(derivePairingKey('abc')).toHaveLength(32);
    expect(derivePairingKey('abc')).toBe(derivePairingKey('abc'));
    expect(derivePairingKey('abc')).not.toBe(derivePairingKey('abd'));
  });
});

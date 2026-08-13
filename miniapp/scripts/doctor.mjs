#!/usr/bin/env node
/**
 * Does this install actually work?
 *
 * Every check answers a question someone hits during setup, in the order
 * they hit it, and each one prints what to do rather than just what failed.
 * Exit code is the number of hard failures, so an agent can branch on it.
 *
 * Run: npm run doctor   (from miniapp/)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const miniapp = path.resolve(here, '..');
const repo = path.resolve(miniapp, '..');

let failures = 0;
let warnings = 0;

const ok = (m, detail) => console.log(`  ok    ${m}${detail ? `  (${detail})` : ''}`);
const bad = (m, fix) => {
  failures += 1;
  console.log(`  FAIL  ${m}`);
  if (fix) console.log(`        fix: ${fix}`);
};
const warn = (m, detail) => {
  warnings += 1;
  console.log(`  warn  ${m}${detail ? `  (${detail})` : ''}`);
};

const section = (title) => console.log(`\n${title}`);

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim();
}

async function httpStatus(url, timeoutMs = 4000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

// --- 1. toolchain ---------------------------------------------------------
section('Toolchain');

const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) ok('node', process.version);
else bad(`node ${process.version} is too old`, 'brew install node  (need v20+)');

if (fs.existsSync(path.join(miniapp, 'node_modules'))) ok('dependencies installed');
else bad('dependencies are not installed', 'cd miniapp && npm install');

// --- 2. build outputs -----------------------------------------------------
section('Build');

const serverEntry = path.join(miniapp, 'server/dist/index.js');
if (fs.existsSync(serverEntry)) ok('server built');
else bad('server is not built', 'cd miniapp/server && npm run build');

const webIndex = path.join(miniapp, 'web/dist/index.html');
if (fs.existsSync(webIndex)) ok('web app built');
else bad('web app is not built', 'cd miniapp/web && npm run build');

// --- 3. what the server will read -----------------------------------------
section('Configuration');

let config = null;
try {
  const mod = await import(path.join(miniapp, 'server/dist/config.js'));
  config = mod.loadConfig();
  ok(config.standalone ? 'standalone mode (no Telegram)' : 'Telegram mode', `port ${config.port}`);
} catch (err) {
  bad(`config could not be loaded: ${err.message}`, 'this should not happen; open an issue with this output');
}

if (config) {
  if (fs.existsSync(config.asideCli)) ok('Aside CLI found', config.asideCli);
  else bad(`no Aside CLI at ${config.asideCli}`, 'install Aside from https://aside.so and sign in, or set MINIAPP_ASIDE_CLI');

  if (fs.existsSync(config.sessionsDir)) ok('Aside sessions directory found');
  else warn('no sessions directory yet', 'normal on a fresh Aside install; it appears after your first task');

  if (fs.existsSync(config.secretPath)) {
    const mode = fs.statSync(config.secretPath).mode & 0o777;
    if (mode === 0o600) ok('signing secret present and private');
    else bad(`signing secret is mode ${mode.toString(8)}`, `chmod 600 ${config.secretPath}`);
  } else {
    warn('no signing secret yet', 'the server writes one on first start');
  }
}

// --- 4. is it running -----------------------------------------------------
section('Runtime');

const port = config?.port ?? 8790;
const pairPort = Number(process.env.MINIAPP_PAIR_PORT) || port + 1;

const health = await httpStatus(`http://127.0.0.1:${port}/api/health`);
if (health === 200) {
  ok(`server responding on ${port}`);

  const pair = await httpStatus(`http://127.0.0.1:${pairPort}/pair`);
  if (pair === 200) ok(`pairing page on ${pairPort}`);
  else bad(`pairing page not answering on ${pairPort}`, 'restart the server; check nothing else holds that port');

  const leak = await httpStatus(`http://127.0.0.1:${port}/pair`);
  if (leak === 403) ok('pairing page refused on the proxied port, as it must be');
  else if (leak === 404) warn('no /pair route on the app port', 'expected when the web app is not built');
  else bad(`/pair on the app port returned ${leak}, expected 403`, 'this is the tailnet pairing leak; do not expose this server');
} else {
  warn(`server is not running on ${port}`, 'start it: cd miniapp/server && npm start');
}

// --- 5. the network the phone needs ---------------------------------------
section('Tailscale');

let tailnetHost = '';
const tsCandidates = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
];
const ts = tsCandidates.find((p) => fs.existsSync(p));
if (!ts) {
  warn('Tailscale not found', 'brew install --cask tailscale, then sign in on the Mac and the phone');
} else {
  try {
    const status = JSON.parse(sh(ts, ['status', '--json']));
    tailnetHost = String(status?.Self?.DNSName || '').replace(/\.$/, '');
    if (tailnetHost) ok('tailnet hostname', tailnetHost);
    else warn('Tailscale is installed but this Mac has no hostname yet', 'sign in: open -a Tailscale');

    const serve = sh(ts, ['serve', 'status']);
    if (serve.includes(String(port))) ok(`tailscale serve points at ${port}`);
    else bad('tailscale serve is not pointing at this server', `${ts} serve --bg ${port}`);
    if (serve.includes(String(pairPort))) {
      bad(
        `tailscale serve exposes the pairing port ${pairPort}`,
        `remove that rule now: ${ts} serve --https=443 off`,
      );
    }
  } catch {
    warn('could not read Tailscale status', 'is the daemon running? open -a Tailscale');
  }
}

// --- 6. Android build, only if someone wants it ---------------------------
section('Android build (optional)');

const tarballJdk = path.join(os.homedir(), 'java/jdk-21.0.12+8/Contents/Home');
const javaHome = process.env.JAVA_HOME
  || (() => { try { return sh('/usr/libexec/java_home', ['-v', '21']); } catch { return ''; } })()
  // build-android.sh falls back to an unpacked tarball; look where it looks.
  || (fs.existsSync(tarballJdk) ? tarballJdk : '');
if (javaHome) ok('JDK 21', javaHome);
else warn('no JDK 21', 'only needed to build the APK: brew install --cask temurin@21');

const sdk = process.env.ANDROID_HOME || path.join(os.homedir(), 'Library/Android/sdk');
if (fs.existsSync(sdk)) {
  ok('Android SDK', sdk);
  const platform36 = fs.existsSync(path.join(sdk, 'platforms/android-36'));
  if (platform36) ok('platform android-36');
  else warn('android-36 not installed', 'sdkmanager "platforms;android-36" "build-tools;36.0.0"');
} else {
  warn('no Android SDK', 'only needed to build the APK; the installable web app needs none of this');
}

// --- verdict --------------------------------------------------------------
console.log('');
if (failures === 0 && warnings === 0) console.log('All checks passed.');
else console.log(`${failures} failure(s), ${warnings} warning(s).`);
if (failures === 0 && tailnetHost) {
  console.log(`\nNext: open http://127.0.0.1:${pairPort}/pair on this Mac and scan it with your phone.`);
}
process.exit(Math.min(failures, 125));

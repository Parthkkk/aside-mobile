/**
 * The stable hostname the installed app is pinned to.
 *
 * A quick tunnel rotates its hostname on every restart, which the Telegram
 * mini app survives only because the server re-registers the new URL against
 * the bot's menu button every couple of minutes. An installed app has no such
 * escape hatch: a home-screen icon records its URL at install time and cannot
 * be told a new one. So the standalone build needs a name that never moves,
 * and that is what the tailnet provides.
 *
 * Read from the local daemon rather than written into config, because a
 * hostname copied by hand into a file is a hostname that silently disagrees
 * with reality the first time anything is renamed.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where the Tailscale CLI can live. This must stay in step with the same
 * list in `scripts/doctor.mjs` and `build-android.sh`: a machine's Tailscale
 * can be the App Store bundle, a Homebrew binary on either architecture, or
 * a userspace `tailscaled` reachable only through a named socket, and the
 * wrong pairing simply reports "could not read Tailscale status".
 *
 * Hardcoding one binary + one socket here used to mean the pairing page fell
 * back to an `http://127.0.0.1:...` link on every machine that did not match
 * the original author's layout -- i.e. a pairing link no phone can reach.
 * Probing all the combinations the other two places already probed is the
 * fix, and it has to stay in lockstep with them.
 */
const BINARY_CANDIDATES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
];

const SOCKET_CANDIDATES = [
  path.join(os.homedir(), '.aside-mobile/tailscale/ts.sock'),
  path.join(os.homedir(), '.aside-telegram-bridge/tailscale/ts.sock'),
];

/** Re-read occasionally: the daemon may not be up yet when we first ask. */
const TTL_MS = 60_000;

let cached: string | null = null;
let checkedAt = 0;
let inFlight = false;

/**
 * Parse a `tailscale status --json` blob down to the Mac's tailnet hostname,
 * or null when it is not usable. Extracted so it can be tested directly.
 */
export function dnsNameFromStatus(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as {
      BackendState?: string;
      Self?: { DNSName?: string };
    };
    if (parsed.BackendState !== 'Running') return null;
    // MagicDNS returns a fully-qualified name with the trailing dot.
    const dns = String(parsed.Self?.DNSName || '').replace(/\.$/, '');
    return dns || null;
  } catch {
    return null;
  }
}

function execStatus(bin: string, sock: string | null): Promise<string | null> {
  return new Promise((resolve) => {
    const args = sock
      ? [`--socket=${sock}`, 'status', '--json']
      : ['status', '--json'];
    execFile(
      bin,
      args,
      { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout)),
    );
  });
}

function refresh(): void {
  if (inFlight) return;

  /*
   * An explicit hostname wins over probing the daemon, same as the build
   * script. This is also the only thing a machine where Tailscale cannot be
   * detected (a very unusual install, or a renamed binary) needs to set.
   */
  const fromEnv = String(process.env.ASIDE_TAILNET_HOST || '').trim();
  if (fromEnv) {
    cached = fromEnv;
    checkedAt = Date.now();
    return;
  }

  inFlight = true;
  void (async () => {
    try {
      cached = null;
      // A machine can have more than one daemon; a socket that does not
      // exist is skipped, and `null` means "the system daemon".
      const socks = [
        ...SOCKET_CANDIDATES.filter((s) => fs.existsSync(s)),
        null,
      ];
      for (const bin of BINARY_CANDIDATES.filter((b) => fs.existsSync(b))) {
        for (const sock of socks) {
          const stdout = await execStatus(bin, sock);
          if (stdout == null) continue;
          const dns = dnsNameFromStatus(stdout);
          if (dns) {
            cached = dns;
            return;
          }
        }
      }
    } finally {
      inFlight = false;
      checkedAt = Date.now();
    }
  })();
}

/**
 * Current tailnet hostname, or null when Tailscale is not usable.
 *
 * Synchronous by design so it can sit behind a plain getter in the route
 * layer: it hands back the last known value and kicks off a refresh in the
 * background rather than making every caller await a subprocess.
 */
export function tailnetHost(): string | null {
  if (Date.now() - checkedAt > TTL_MS) refresh();
  return cached;
}

/** Prime the cache at boot so the first request already has an answer. */
export function primeTailnetHost(): void {
  refresh();
}

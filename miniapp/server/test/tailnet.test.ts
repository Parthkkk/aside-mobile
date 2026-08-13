/**
 * The hostname the pairing page pins itself to.
 *
 * `dnsNameFromStatus` is the pure heart of `tailnet.ts`: everything else in
 * that module is subprocess and filesystem probing. It has to turn a
 * `tailscale status --json` blob into the Mac's bare tailnet hostname, and
 * return null rather than a wrong answer on every way that blob can be
 * unhelpful -- a stopped backend, a missing name, or output that is not JSON
 * at all. A null here is what degrades the pairing page to a loopback link,
 * so a wrong "success" would hand a phone a link that cannot reach the Mac.
 */
import { describe, expect, it } from 'vitest';
import { dnsNameFromStatus } from '../src/tailnet.js';

describe('dnsNameFromStatus', () => {
  it('returns the bare hostname when the backend is running', () => {
    const out = JSON.stringify({
      BackendState: 'Running',
      Self: { DNSName: 'their-mac.tailXXXX.ts.net.' },
    });
    expect(dnsNameFromStatus(out)).toBe('their-mac.tailXXXX.ts.net');
  });

  it('strips the trailing dot MagicDNS appends', () => {
    const out = JSON.stringify({
      BackendState: 'Running',
      Self: { DNSName: 'their-mac.tailXXXX.ts.net.' },
    });
    expect(dnsNameFromStatus(out)).not.toMatch(/\.$/);
  });

  it('returns null when the backend is not running', () => {
    const out = JSON.stringify({
      BackendState: 'Stopped',
      Self: { DNSName: 'their-mac.tailXXXX.ts.net.' },
    });
    expect(dnsNameFromStatus(out)).toBeNull();
  });

  it('returns null when there is no DNS name', () => {
    const out = JSON.stringify({ BackendState: 'Running', Self: {} });
    expect(dnsNameFromStatus(out)).toBeNull();
  });

  it('returns null for output that is not JSON', () => {
    expect(dnsNameFromStatus('tailscaled is not running')).toBeNull();
    expect(dnsNameFromStatus('')).toBeNull();
  });
});

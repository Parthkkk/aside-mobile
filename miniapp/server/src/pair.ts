/**
 * The pairing page, on its own loopback-only listener.
 *
 * This used to be a route on the main app guarded by `request.ip`. That
 * guard did not work in the deployment this project actually ships:
 * `tailscale serve` terminates TLS and proxies to `127.0.0.1:8790`, and
 * `trustProxy` is deliberately off (see the comment in `app.ts`), so
 * `request.ip` is the proxy's socket peer -- loopback -- for every request
 * that arrives over the tailnet. The check passed for everyone. Any tailnet
 * peer could open `https://<host>/pair`, read the QR, and pair itself.
 *
 * The fix is structural rather than another IP test. `tailscale serve`
 * proxies exactly one port, so the pairing page lives on a different one,
 * bound to loopback, never proxied. A tailnet peer cannot reach this
 * listener at all: there is nothing to spoof, and no header to get wrong.
 *
 * The IP check is kept as a second gate anyway. It costs one comparison
 * and it is the thing that still holds if someone later points a tunnel at
 * this port too.
 */
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import QRCode from 'qrcode';

/** Default port for the pairing listener: one above the app's own. */
export const DEFAULT_PAIR_PORT_OFFSET = 1;

/**
 * The pairing key, derived from the HS256 signing secret.
 *
 * Lives here rather than in `app.ts` because two processes now need the
 * same value from the same input: the app (to check `/api/pair` submissions)
 * and this listener (to put it in the QR). `build-android.sh` derives it a
 * third time in python; that copy must stay in step with this one.
 */
export function derivePairingKey(jwtSecret: string): string {
  return crypto
    .createHash('sha256')
    .update(`${jwtSecret}:standalone-pairing:v1`)
    .digest('hex')
    .slice(0, 32);
}

function isLoopbackIp(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export interface PairServerOptions {
  jwtSecret: string;
  /** The MAIN app's port -- what the pairing link points the phone at. */
  appPort: number;
  /** Stable tailnet hostname for this Mac, read lazily. */
  tailnetHost?: () => string | null;
  logger?: boolean;
}

/**
 * A Fastify instance serving exactly one page. Caller binds it to loopback.
 */
export function buildPairServer(opts: PairServerOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: false });
  const pairingKey = derivePairingKey(opts.jwtSecret);

  app.get('/pair', async (request, reply) => {
    if (!isLoopbackIp(String(request.ip || ''))) {
      return reply.code(403).type('text/html').send(
        '<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:2rem">' +
          '<h1>Not here</h1><p>Open this page on the Mac itself.</p></body>',
      );
    }

    const host = opts.tailnetHost?.() || '';
    const base = host ? `https://${host}` : `http://127.0.0.1:${opts.appPort}`;
    const link = `${base}/app#pair=${pairingKey}`;
    const qr = await QRCode.toDataURL(link, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: { dark: '#3d3a34', light: '#f6f3ee' },
    });

    return reply.type('text/html; charset=utf-8').send(`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair your phone</title>
<style>
  body{font:16px/1.55 -apple-system,system-ui,sans-serif;background:#f6f3ee;color:#3d3a34;
       margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}
  .card{max-width:26rem;text-align:center}
  h1{font-family:ui-serif,'New York',Georgia,serif;font-weight:500;font-size:1.6rem;margin:0 0 .35rem}
  p{margin:.4rem 0;color:#6f6961}
  img{display:block;margin:1.5rem auto;border-radius:14px;box-shadow:0 2px 20px rgba(0,0,0,.09)}
  ol{text-align:left;color:#6f6961;padding-left:1.15rem;margin:1.25rem 0 0}
  li{margin:.4rem 0}
  code{background:#e9e4db;padding:.12em .4em;border-radius:5px;font-size:.9em}
  .warn{margin-top:1.5rem;font-size:.85rem;color:#8a8378;border-top:1px solid #e2ddd4;padding-top:1rem}
</style>
<div class="card">
  <h1>Pair your phone</h1>
  <p>Scan with the phone you want to use Aside on.</p>
  <img src="${qr}" width="320" height="320" alt="Pairing QR code">
  <ol>
    <li>Make sure Tailscale is installed and signed in on the phone.</li>
    <li>Scan the code. It opens Aside and pairs in one step.</li>
    <li>In Chrome, tap the menu and choose <b>Add to Home screen</b>.</li>
    <li>Launch it from the icon from now on.</li>
  </ol>
  <p class="warn">This link is a key to your Mac. Anyone who has it and is on
  your tailnet can use your agent. It is the same key every time and it does
  not expire on its own: to revoke it, delete the signing secret and restart
  the server.</p>
</div>`);
  });

  return app;
}

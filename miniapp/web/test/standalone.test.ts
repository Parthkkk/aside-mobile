/**
 * Boot-time auth resolution.
 *
 * The regression this guards against is the one that shipped: an
 * unreachable Mac left the boot fetch hanging for minutes and the app sat
 * frozen on its spinner. The fix is a hard deadline on `/api/pair` and
 * `/api/session`, after which the app fails fast to the "Can't reach your
 * Mac" state instead of waiting forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveStandaloneAuth } from '../src/standalone';

/** A fetch that never answers on its own, but honours an abort signal. */
function stubbingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }
      }),
  );
}

describe('resolveStandaloneAuth', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', stubbingFetch());
    // A fresh boot: no pairing key in the URL, no stored token.
    vi.stubGlobal('location', { ...window.location, hash: '', search: '' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('gives up on an unreachable Mac instead of hanging forever', async () => {
    vi.useFakeTimers();

    const resolution = resolveStandaloneAuth();
    // Let the 12s boot deadline elapse (plus margin) and flush microtasks.
    await vi.advanceTimersByTimeAsync(12_500);

    await expect(resolution).resolves.toEqual({
      ok: false,
      reason: 'unreachable',
    });
  });

  it('passes an abort signal to the boot request', async () => {
    vi.useFakeTimers();

    const resolution = resolveStandaloneAuth();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(12_500);
    await resolution;

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalled();
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

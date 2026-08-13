// vitest/config re-exports vite's defineConfig with the `test` block typed.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Stamp the service worker's cache version with the identity of this build.
 *
 * `sw.js` used to carry a hand-written version string and a comment asking
 * the next person to remember to bump it. Forgetting costs more than it
 * sounds: the shell cache outlives the assets it points at, because a build
 * empties `dist` and emits new content hashes, so the cached shell asks for
 * an `/assets/index-<hash>.css` that is no longer on the server. The asset
 * handler misses, the fetch 404s, and the app paints with no stylesheet.
 * Both caches are behaving as designed, so nothing recovers on its own and
 * the phone stays broken until someone reinstalls it. Reproduced, then
 * fixed here.
 *
 * The id is a hash of the emitted asset filenames, which are themselves
 * content hashes. So it changes when and only when the bundle changes, and
 * a rebuild that produces identical output leaves everyone's cache alone.
 */
function swBuildId(): Plugin {
  const names: string[] = [];
  return {
    name: 'sw-build-id',
    apply: 'build',
    generateBundle(_options, bundle) {
      names.push(...Object.keys(bundle).sort());
    },
    closeBundle() {
      const swPath = path.resolve(__dirname, 'dist/sw.js');
      if (!fs.existsSync(swPath)) return;
      const id = createHash('sha256')
        .update(names.join('\n'))
        .digest('hex')
        .slice(0, 12);
      const src = fs.readFileSync(swPath, 'utf8');
      if (!src.includes('__BUILD_ID__')) {
        // Loud, because a silent miss here reintroduces the exact bug this
        // exists to prevent, and it would only show up on someone's phone.
        this.error('sw.js has no __BUILD_ID__ placeholder to stamp');
      }
      fs.writeFileSync(swPath, src.replaceAll('__BUILD_ID__', id));
    },
  };
}

const API_TARGET = process.env.MINIAPP_DEV_API || 'http://127.0.0.1:8790';

export default defineConfig({
  plugins: [react(), swBuildId()],
  test: {
    // Component tests drive real DOM events through React; the pure-logic
    // suites do not care either way.
    environment: 'jsdom',
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // The mini app is served from one origin; assets are relative so the
    // same bundle works behind a tunnel subpath.
    assetsDir: 'assets',
  },
  server: {
    // bind v4 explicitly: the default resolves to ::1 on this Mac, which
    // makes http://127.0.0.1:5273 refuse connections
    host: '127.0.0.1',
    port: 5273,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET, ws: true, changeOrigin: true },
    },
  },
});

import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    strictPort: true,
    // Models are rebuilt in place by `tools/fbx-to-creep.mjs` and keep the same
    // filename, so the browser happily serves whichever version it cached
    // first. That is not a theoretical risk: an orc and an archer were both
    // reported broken in the game while the files on disk were correct, and the
    // difference was a stale cache. Development reloads them every time;
    // production serves a fresh deploy anyway.
    headers: { 'Cache-Control': 'no-store' },
    // The client always connects to its own origin at /ws. In development that
    // is Vite, which forwards it to the match server (`npm run server`); in
    // production the match server serves the client itself, so the same URL
    // works with no configuration.
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2048,
    // Two pages, two bundles. The landing at `/` carries no three.js: it has to
    // paint on a phone over mobile data long before the game would have
    // finished downloading, and the game at `/play/` is what the player asks
    // for when they press Jugar.
    rollupOptions: {
      input: {
        landing: fileURLToPath(new URL('./index.html', import.meta.url)),
        game: fileURLToPath(new URL('./play/index.html', import.meta.url)),
      },
    },
  },
});

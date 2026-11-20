import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  // Keep the previous build's files: an open window still on the old version must keep loading
  // its scripts while a new build lands (deleting them left a blank window). Hashed names never clash.
  // Hidden sourcemaps: UI crash reports (Settings → Health) carry minified stacks; the .map next to
  // each bundle lets an agent map `Hr at index-X.js:92:5230` back to the real component.
  // ponytail: old assets pile up slowly in web/dist/assets; clear them when it matters.
  build: { outDir: 'dist', emptyOutDir: false, sourcemap: 'hidden' },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4777', '/ws': { target: 'ws://127.0.0.1:4777', ws: true } } },
})

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const DAEMON = process.env.CONDUCTOR_ORIGIN ?? 'http://127.0.0.1:7777';

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    // Everything daemon-owned is proxied so the browser sees one origin.
    // Track D's /preview/* must go through here too, or iframes break.
    proxy: {
      '/api': { target: DAEMON, changeOrigin: true },
      '/ws': { target: DAEMON, ws: true, changeOrigin: true },
      '/preview': { target: DAEMON, changeOrigin: true },
    },
  },
});

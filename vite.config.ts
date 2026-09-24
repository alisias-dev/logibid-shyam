import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        output: {
          /**
           * Split the framework and icon set into their own long-lived chunks.
           *
           * Every route imported React, the router and a fistful of lucide icons,
           * so Rollup had to either duplicate them per route chunk or hoist them
           * into the single ~1MB entry chunk. Both hurt: the entry chunk had to be
           * re-downloaded on every deploy, and each route chunk pulled in its own
           * copy. These two rarely change, so the browser now keeps them across
           * releases. Everything else is split per route by the React.lazy()
           * boundaries in src/App.tsx.
           */
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return;
            if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
              return 'vendor-react';
            }
            if (/[\\/]node_modules[\\/](lucide-react)[\\/]/.test(id)) {
              return 'vendor-icons';
            }
            return undefined;
          },
        },
      },
    },
    server: {
      // Proxy /api calls to local Express backend server if Vite is run directly
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});

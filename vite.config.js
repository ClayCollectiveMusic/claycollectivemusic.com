import { defineConfig } from 'vite';
import { ViteEjsPlugin } from 'vite-plugin-ejs';
import { resolve } from 'path';
import glob from 'glob-all';
import fs from 'fs';
import { scanMedia, generatePlayerData } from './src/lib/scan-media.js';

// Scan media folders for albums, tracks, stems
const mediaDir = resolve(__dirname, 'src/media');

// Single data object passed to EJS — mutate in place to pick up changes in watch mode.
// Also includes itself as `data` so templates can pass it through to EJS includes.
const data = {
  site: JSON.parse(fs.readFileSync('src/site.json', 'utf8')),
  albums: scanMedia(mediaDir),
  generatePlayerData,
};
data.data = data;

export default defineConfig({
  root: 'src',
  plugins: [
    ViteEjsPlugin(data, {
      ejs: { }
    }),
    {
      name: 'media-watcher',
      configureServer(server) {
        // Watch site.json for changes
        const siteJsonPath = resolve(__dirname, 'src/site.json');
        server.watcher.add(siteJsonPath);
        server.watcher.on('change', (file) => {
          if (file === siteJsonPath) {
            data.site = JSON.parse(fs.readFileSync(siteJsonPath, 'utf8'));
            server.ws.send({ type: 'full-reload' });
          }
        });

        // Watch the media directory for new/changed/deleted files
        server.watcher.add(mediaDir);
        const rescan = () => {
          data.albums = scanMedia(mediaDir);
          server.ws.send({ type: 'full-reload' });
        };
        server.watcher.on('add', rescan);
        server.watcher.on('change', rescan);
        server.watcher.on('unlink', rescan);
        server.watcher.on('unlinkDir', rescan);
        server.watcher.on('addDir', rescan);
      },
    },
  ],
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: Object.fromEntries(
        glob.sync('src/*.html').map(f => [f.replace('src/', '').replace('.html', ''), resolve(__dirname, f)])
      ),
    },
  },
  server: {
    open: true,
    port: 5173,
  },
});

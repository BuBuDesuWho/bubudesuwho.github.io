import { defineConfig, Plugin } from 'vite';
import { resolve } from 'path';
import { cpSync } from 'fs';

function copyAssetsPlugin(): Plugin {
  return {
    name: 'copy-assets',
    closeBundle() {
      const root = resolve(__dirname);
      const dist = resolve(root, 'dist');
      for (const dir of ['css', 'fonts', 'songs']) {
        cpSync(resolve(root, dir), resolve(dist, dir), { recursive: true });
      }
      for (const file of ['changelog.json']) {
        cpSync(resolve(root, file), resolve(dist, file));
      }
      cpSync(resolve(root, 'css', 'images'), resolve(dist, 'assets', 'images'), { recursive: true });
      cpSync(resolve(root, 'sound'), resolve(dist, 'sound'), { recursive: true });
    },
  };
}

export default defineConfig(({ command }) => ({
  root: '.',
  base: '/',
  publicDir: false,
  plugins: [copyAssetsPlugin()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        play: resolve(__dirname, 'play.html'),
        changelog: resolve(__dirname, 'changelog.html'),
        stats: resolve(__dirname, 'stats.html'),
        bubudle: resolve(__dirname, 'bubudle.html'),
      },
    },
  },
}));

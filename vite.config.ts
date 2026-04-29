import { defineConfig, Plugin } from 'vite';
import { resolve } from 'path';
import { cpSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';

function copyAssetsPlugin(): Plugin {
  return {
    name: 'copy-assets',
    closeBundle() {
      const root = resolve(__dirname);
      const dist = resolve(root, 'dist');
      for (const dir of ['css', 'fonts', 'songs']) {
        cpSync(resolve(root, dir), resolve(dist, dir), { recursive: true });
      }
      // Each PAGE_REPO ships only its own mode's changelog; copy whichever is present.
      for (const file of ['changelog.anime.json', 'changelog.kpop.json']) {
        const src = resolve(root, file);
        if (existsSync(src)) cpSync(src, resolve(dist, file));
      }
      cpSync(resolve(root, 'css', 'images'), resolve(dist, 'assets', 'images'), { recursive: true });
      cpSync(resolve(root, 'sound'), resolve(dist, 'sound'), { recursive: true });
    },
  };
}

function resolveBuildVersion(): string {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return String(Date.now());
  }
}

export default defineConfig(({ command }) => ({
  root: '.',
  base: '/',
  publicDir: false,
  plugins: [copyAssetsPlugin()],
  define: {
    __BUILD_VERSION__: JSON.stringify(resolveBuildVersion()),
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        play: resolve(__dirname, 'play.html'),
        changelog: resolve(__dirname, 'changelog.html'),
        stats: resolve(__dirname, 'stats.html'),
        bubudle: resolve(__dirname, 'bubudle.html'),
        submission: resolve(__dirname, 'submission.html'),
      },
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/howler')) return 'howler';
          return undefined;
        },
      },
    },
  },
}));

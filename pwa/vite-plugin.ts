// Build-time PWA wiring, shared by vite.config.ts and the PAGE_REPO config that
// scripts/deploy-page.sh generates (it copies this folder over), so there's one
// copy of the logic instead of a heredoc twin.
//
// - emits manifest.webmanifest + icons + sw.js (template in pwa/sw.js)
// - injects the manifest / apple-touch-icon links into every page head
// - adds modulepreload hints for each page's lazily imported chunk, which
//   main.ts would otherwise only discover after it has downloaded and run
import type { Plugin, ResolvedConfig } from 'vite';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Mirrors the page routing in src/main.ts. A stale entry here only costs a
// missing preload hint, never a broken page.
const PAGE_ENTRIES: Record<string, string> = {
  'play.html': 'src/ui.ts',
  'bubudle.html': 'src/bubudle.ts',
  'stats.html': 'src/stats.ts',
  'guide.html': 'src/guide.ts',
  'submission.html': 'src/submission.ts',
};

const ICONS = ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

type Chunk = { type: 'chunk'; fileName: string; facadeModuleId: string | null; imports: string[] };
type Bundle = Record<string, { type: string; fileName: string } | Chunk>;

export function pwaPlugin(buildVersion: string): Plugin {
  let config: ResolvedConfig;
  const dir = resolve(__dirname);

  return {
    name: 'pwa',
    apply: 'build',
    enforce: 'post',
    configResolved(c) { config = c; },

    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const base = config.base;
        const tags = [
          { tag: 'link', attrs: { rel: 'manifest', href: base + 'manifest.webmanifest' }, injectTo: 'head' as const },
          { tag: 'link', attrs: { rel: 'apple-touch-icon', href: base + 'apple-touch-icon.png' }, injectTo: 'head' as const },
        ];
        const page = (ctx.filename || '').split(/[\\/]/).pop() || '';
        const entry = PAGE_ENTRIES[page];
        const bundle = ctx.bundle as Bundle | undefined;
        if (entry && bundle) {
          for (const file of lazyChunkClosure(bundle, entry)) {
            if (html.includes(base + file)) continue;
            tags.push({ tag: 'link', attrs: { rel: 'modulepreload', href: base + file }, injectTo: 'head' as const });
          }
        }
        return tags;
      },
    },

    generateBundle(_opts, bundle) {
      const kpop = config.mode === 'kpop' || config.env.VITE_APP_MODE === 'kpop';
      const name = kpop ? 'Whoranghae' : 'BubuDesuWho';
      const manifest = {
        name,
        short_name: name,
        description: kpop
          ? 'Guess which member sings each line of your favorite K-pop songs.'
          : 'Guess which member sings each line of Love Live! songs.',
        start_url: config.base,
        scope: config.base,
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#fb96be',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      };
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: JSON.stringify(manifest, null, 2) + '\n' });
      for (const icon of ICONS) {
        this.emitFile({ type: 'asset', fileName: icon, source: readFileSync(resolve(dir, icon)) });
      }

      // App shell: every page plus the hashed JS/CSS/font assets. Images are
      // left to the runtime cache so a first visit doesn't download every
      // group banner.
      const files = Object.keys(bundle).filter(f => /\.(html|js|css|woff2)$/.test(f));
      const precache = [config.base, ...files.map(f => config.base + f), config.base + 'manifest.webmanifest'];
      const sw = readFileSync(resolve(dir, 'sw.js'), 'utf-8')
        .replace("'__SW_VERSION__'", JSON.stringify(buildVersion))
        .replace('__SW_PRECACHE__', JSON.stringify(precache));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: sw });
    },
  };
}

function lazyChunkClosure(bundle: Bundle, entry: string): string[] {
  const chunks = Object.values(bundle).filter((c): c is Chunk => c.type === 'chunk');
  const root = chunks.find(c => c.facadeModuleId?.replace(/\\/g, '/').endsWith(entry));
  if (!root) return [];
  const byName = new Map(chunks.map(c => [c.fileName, c]));
  const seen = new Set<string>();
  const walk = (c: Chunk) => {
    if (seen.has(c.fileName)) return;
    seen.add(c.fileName);
    for (const dep of c.imports) {
      const d = byName.get(dep);
      if (d) walk(d);
    }
  };
  walk(root);
  return [...seen];
}

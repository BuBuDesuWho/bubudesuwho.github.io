import { inject } from '@vercel/analytics';
import { injectSpeedInsights } from '@vercel/speed-insights';
import { initAboutPage, initChangelogPage } from './ui-about';
import { initBuddy } from './buddy';

// Vercel Analytics + Speed Insights — only on the Vercel production host.
// Skips localhost, GH Pages, and preview deploys (which would inflate counts).
const VERCEL_HOSTS = new Set(['bubudesuwho.vercel.app', 'whoranghae.vercel.app']);
if (VERCEL_HOSTS.has(location.hostname)) {
  inject();
  injectSpeedInsights();
}

// Cloudflare Web Analytics — only on the GH Pages deploys it's registered for.
// Off Vercel/local because the beacon endpoint is commonly blocked, producing
// connection-refused stalls; @vercel/analytics covers Vercel separately.
const CF_BEACON_TOKENS: Record<string, string> = {
  'bubudesuwho.github.io': '3971b4c780524ef4a0e30c8c1347d44d',
  'whoranghae.github.io': '24916978afb649059f68f3628b744568',
};
const cfToken = CF_BEACON_TOKENS[location.hostname];
if (cfToken) {
  const s = document.createElement('script');
  s.defer = true;
  s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  s.setAttribute('data-cf-beacon', JSON.stringify({ token: cfToken }));
  document.head.appendChild(s);
}

// Favorite-member buddy portrait (every page, no-op when no favorite set).
initBuddy();

// The Voice Guide only has Love-Live dossiers, so hide its nav link on the
// kpop build (the sidebar partial is shared by both modes).
if (import.meta.env.VITE_APP_MODE === 'kpop') {
  document.querySelectorAll('.guide-nav-link').forEach(el => {
    (el.closest('li') ?? el).remove();
  });
}

// detect which page we're on and initialize accordingly
const path = location.pathname;

// `./ui` pulls in player → howler (~36 KB). About / Changelog / Stats don't
// need it, so play.html is the only page that statically loads it.
if (path.endsWith('play.html')) {
  import('./ui').then(m => m.initPlayPage());
} else if (path.endsWith('bubudle.html')) {
  import('./bubudle').then(m => m.initBubudlePage());
} else if (path.endsWith('submission.html')) {
  import('./submission').then(m => m.initSubmissionPage());
} else if (path.endsWith('changelog.html')) {
  initChangelogPage();
} else if (path.endsWith('stats.html')) {
  import('./stats').then(m => m.initStatsPage());
} else if (path.endsWith('guide.html')) {
  import('./guide').then(m => m.initGuidePage());
} else {
  // index.html or /
  initAboutPage();
}

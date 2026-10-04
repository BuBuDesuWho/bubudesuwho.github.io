// Offline shell + cached songs/covers/audio (see pwa/sw.js). Production web only:
// in dev the worker would cache Vite's HMR modules, and inside the Capacitor APK
// the shell is already local while songs come cross-origin from VITE_CONTENT_BASE.
const isCapacitor = 'Capacitor' in window || (location.protocol === 'https:' && location.hostname === 'localhost');

if (import.meta.env.PROD && 'serviceWorker' in navigator && !isCapacitor) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(err => {
      console.warn('Service worker registration failed', err);
    });
  });
}

// Covers render at ~250 CSS px, so pages load the 512 px WebP thumbnails that
// scripts/build-thumbs.py generates and deploy-page.sh ships same-origin. The
// full-size cover (covers-v1 Release in prod, css/images/covers in dev) is only
// the fallback for a thumbnail that's missing, e.g. a cover not on disk at
// deploy time or a dev checkout that never ran the script.

// Release asset names drop this prefix, and build-thumbs.py names thumbs the same way.
const COVER_PREFIX = /^css\/images\/covers\/(?:kpop\/)?/;

export function coverThumbUrl(cover: string): string {
  // The Capacitor APK fetches content from the deployed site, thumbs included.
  const base = (import.meta.env.VITE_CONTENT_BASE || import.meta.env.BASE_URL) as string;
  return `${base}css/images/thumbs/covers/${cover.replace(COVER_PREFIX, '')}.webp`;
}

export function coverFullUrl(cover: string): string {
  const coverBase = import.meta.env.VITE_COVER_BASE;
  return coverBase
    ? coverBase + cover.replace(COVER_PREFIX, '')
    : import.meta.env.BASE_URL + cover;
}

/** Load `primary`, switching to `fallback` once if it fails. Safe to call again on a reused <img>. */
export function setImgSrc(img: HTMLImageElement, primary: string, fallback: string): void {
  img.onerror = () => {
    img.onerror = null;
    img.src = fallback;
  };
  img.src = primary;
}

export function setCoverSrc(img: HTMLImageElement, cover: string): void {
  setImgSrc(img, coverThumbUrl(cover), coverFullUrl(cover));
}

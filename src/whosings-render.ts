// Canvas drawing for "Who's singing". Everything is in logical stage units;
// the view sets the transform that maps the stage onto the screen.
import type { WsLine } from './whosings';

// SIF's geometry: faces on a lower semicircle around a point near the top.
// The stage is a little taller than SIF's 640 so the bottom face's name fits.
export const STAGE_W = 1386;
export const STAGE_H = 680;
export const CX = STAGE_W / 2;
export const CY = 160;
const R = 400;
const MAX_BUTTON_R = 64;
/** Seconds the cue spends growing out from the centre before a line. */
export const CUE_LEAD = 1;

export interface Seat {
  id: number;
  name: string;
  color: string;
  img: HTMLImageElement | null;
  x: number;
  y: number;
}

export interface ArcLayout {
  points: { x: number; y: number }[];
  radius: number;
}

/** n buttons spread evenly from 180° (left) to 0° (right) along the lower
 *  arc; one button sits at the bottom. Buttons shrink so neighbours don't touch. */
export function arcLayout(n: number): ArcLayout {
  if (n <= 0) return { points: [], radius: MAX_BUTTON_R };
  // SIF spacing (22.5°) centred on the bottom, so a trio sits together low on
  // the arc; only past nine faces does the spacing tighten to fit 180°.
  const step = n > 1 ? Math.min(Math.PI / 8, Math.PI / (n - 1)) : 0;
  const points = Array.from({ length: n }, (_, i) => {
    const a = Math.PI / 2 + ((n - 1) / 2 - i) * step;
    return { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) };
  });
  const chord = n > 1 ? 2 * R * Math.sin(step / 2) : Infinity;
  // leave room between faces for the pick ring's glow
  const radius = Math.min(MAX_BUTTON_R, (chord - 24) / 2);
  return { points, radius };
}

export const CUE_R = R - MAX_BUTTON_R - 34; // inside the arc, so it never covers a face

function text(ctx: CanvasRenderingContext2D, str: string, x: number, y: number, size: number, font = 'bold', family = 'sans-serif'): void {
  ctx.save();
  ctx.font = `${font} ${size}px ${family}`;
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.fillStyle = '#fff';
  ctx.strokeText(str, x, y);
  ctx.fillText(str, x, y);
  ctx.restore();
}

/** `scaleOf` lets a face bounce when pressed; names stay put so they don't jitter. */
export function drawSeats(ctx: CanvasRenderingContext2D, seats: Seat[], baseR: number, held: ReadonlySet<number>, scaleOf?: (id: number) => number): void {
  for (const s of seats) {
    const r = baseR * (scaleOf?.(s.id) ?? 1);
    ctx.save();
    if (held.has(s.id)) {
      ctx.fillStyle = s.color;
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 40;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r + 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.save();
    ctx.clip();
    if (s.img) {
      ctx.drawImage(s.img, s.x - r, s.y - r, r * 2, r * 2);
    } else {
      ctx.fillStyle = s.color;
      ctx.fillRect(s.x - r, s.y - r, r * 2, r * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = `${Math.round(r)}px 'Paytone One', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.name.charAt(0), s.x, s.y + r * 0.06);
    }
    ctx.restore();
    ctx.lineWidth = 3;
    ctx.strokeStyle = s.color;
    ctx.stroke();
    ctx.restore();
    text(ctx, s.name, s.x, s.y + baseR + 20, Math.max(12, Math.round(baseR / 4)), 'normal', "'Paytone One', sans-serif");
  }
}

/** A thin neutral arc that grows out from the centre as a line approaches,
 *  then drains toward the middle while it's sung, so it never favours anyone. */
export function drawCue(ctx: CanvasRenderingContext2D, t: number, line: WsLine, lead = CUE_LEAD): void {
  const grow = Math.min(1, Math.max(0, (t - (line.start - lead)) / lead));
  const remaining = t < line.start ? 1 : Math.max(0, (line.end - t) / (line.end - line.start));
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = `rgba(255,255,255,${0.12 + 0.18 * grow})`;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(CX, CY, CUE_R * grow, 0, Math.PI);
  ctx.stroke();
  if (t >= line.start) {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.shadowColor = 'rgba(255,255,255,0.8)';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(CX, CY, CUE_R, Math.PI / 2 - (remaining * Math.PI) / 2, Math.PI / 2 + (remaining * Math.PI) / 2);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawPicks(ctx: CanvasRenderingContext2D, seats: Seat[], baseR: number, picks: ReadonlySet<number>, scaleOf?: (id: number) => number): void {
  for (const s of seats) {
    if (!picks.has(s.id)) continue;
    const r = baseR * (scaleOf?.(s.id) ?? 1);
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.shadowColor = s.color;
    ctx.shadowBlur = 18;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r + 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/** Up to two centred lines inside the arc; shrinks the font if they still won't fit. */
const LYRIC_MAX_LINES = 3;

function wrap(ctx: CanvasRenderingContext2D, str: string, maxW: number): string[] {
  const lines = [''];
  for (const w of str.split(' ')) {
    const cur = lines[lines.length - 1];
    const next = cur ? `${cur} ${w}` : w;
    if (cur && ctx.measureText(next).width > maxW) lines.push(w);
    else lines[lines.length - 1] = next;
  }
  return lines;
}

// The same lyric stays up for seconds at a time; wrapping it means a
// measureText per word per font size, so keep the last layout.
let lyricFor = '';
let lyricLayout: { lines: string[]; size: number } = { lines: [], size: 0 };

function layoutLyric(ctx: CanvasRenderingContext2D, str: string, maxW: number): { lines: string[]; size: number } {
  // shrink until it fits the arc; combined slots can run several lines long
  let size = 24;
  let lines: string[] = [];
  ctx.save();
  for (; size >= 14; size -= 2) {
    ctx.font = `bold ${size}px sans-serif`;
    lines = wrap(ctx, str, maxW);
    if (lines.length <= LYRIC_MAX_LINES) break;
  }
  size = Math.max(size, 14);
  if (lines.length > LYRIC_MAX_LINES) {
    lines = lines.slice(0, LYRIC_MAX_LINES);
    lines[LYRIC_MAX_LINES - 1] += ' …';
  }
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
  ctx.restore();
  // a single unbreakable word can still be too wide
  if (widest > maxW) size = Math.max(10, Math.floor((size * maxW) / widest));
  return { lines, size };
}

export function drawLyric(ctx: CanvasRenderingContext2D, str: string): void {
  const maxW = 480;
  const x = CX;
  const y = CY + 150;
  if (str !== lyricFor) {
    lyricFor = str;
    lyricLayout = layoutLyric(ctx, str, maxW);
  }
  const { lines, size } = lyricLayout;
  for (let k = 0; k < lines.length; k++) text(ctx, lines[k], x, y + k * size * 1.25, size);
}

// Reveal-mode notes, drawn SIF-style: glossy bubble heads fly out from the
// centre to each singer's face, trailing a glowing hold ribbon that ends in a
// hollow ring. Notes that land together are linked by a thin bar, a timing
// ring closes in on the face just before each lands, and the landing itself
// is handed to StageFx for its ring burst, stars and squish.
//
// Reveal mode shows the answers by design, so this is the only place that
// draws anything on the true singers. Guess mode never uses it.
import { sameTimeGroups, landingsBetween, type RevealHold } from './whosings';
import { CX, CY, type Seat } from './whosings-render';
import type { StageFx } from './whosings-fx';

/** Seconds a note takes to fly from the centre to its face. The tail leaves
 *  the centre this long before the hold ends, so the ribbon shrinks into the
 *  face just as the singer stops. */
const TRAVEL = 1;
/** Seconds the timing ring spends closing in before a note lands. */
const APPROACH = 0.45;
/** A landing only bursts if we saw it happen, not if a seek jumped past it. */
const LAND_WINDOW = 0.3;

// Bubbles are baked once per colour at this radius and scaled down to draw,
// which keeps the gradients, gloss and glow off the per-frame path.
const SPRITE_R = 128;
const SPRITE_PAD = 36;

function rgb(color: string): [number, number, number] {
  let h = color.startsWith('#') ? color.slice(1) : '';
  if (h.length === 3) h = h.replace(/./g, '$&$&');
  const n = parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(n)) return [220, 220, 220];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ribbons and rings ask for the same few tints every frame
const tints = new Map<string, string>();

/** `color` mixed toward white by `k` (0 = as is, 1 = white). */
function tint(color: string, k: number, alpha = 1): string {
  const key = `${color}|${k}|${alpha}`;
  let out = tints.get(key);
  if (!out) {
    const [r, g, b] = rgb(color).map((c) => Math.round(c + (255 - c) * k));
    out = `rgba(${r},${g},${b},${alpha})`;
    tints.set(key, out);
  }
  return out;
}

const BAR_STROKES = [[8, 'rgba(255,255,255,0.3)'], [3, '#fff']] as const;

function bakeBubble(color: string): HTMLCanvasElement {
  const side = 2 * (SPRITE_R + SPRITE_PAD);
  const cv = document.createElement('canvas');
  cv.width = cv.height = side;
  const g = cv.getContext('2d')!;
  const c = side / 2;
  const R = SPRITE_R;

  const glow = g.createRadialGradient(c, c, R * 0.8, c, c, R + SPRITE_PAD);
  glow.addColorStop(0, tint(color, 0.3, 0.6));
  glow.addColorStop(1, tint(color, 0.3, 0));
  g.fillStyle = glow;
  g.fillRect(0, 0, side, side);

  // the thick bright rim
  g.beginPath();
  g.arc(c, c, R, 0, Math.PI * 2);
  g.fillStyle = tint(color, 0.1);
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.stroke();

  // pale sparkly middle, brightest up and to the left where the light hits
  const inner = R * 0.72;
  const fill = g.createRadialGradient(c - inner * 0.3, c - inner * 0.35, inner * 0.05, c, c, inner);
  fill.addColorStop(0, '#ffffff');
  fill.addColorStop(0.45, tint(color, 0.72));
  fill.addColorStop(1, tint(color, 0.35));
  g.beginPath();
  g.arc(c, c, inner, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = tint(color, 0.85, 0.95);
  g.stroke();

  // specks at fixed spots so every bubble of a colour matches
  g.fillStyle = 'rgba(255,255,255,0.85)';
  const specks: [number, number, number][] = [
    [0.35, 0.3, 0.05], [-0.25, 0.45, 0.04], [0.5, -0.1, 0.035], [-0.05, 0.15, 0.03],
    [0.15, 0.55, 0.03], [-0.5, 0.05, 0.03], [0.3, -0.45, 0.025],
  ];
  for (const [x, y, s] of specks) {
    g.beginPath();
    g.arc(c + x * inner, c + y * inner, s * R, 0, Math.PI * 2);
    g.fill();
  }

  // the gloss: a soft white lozenge across the top left
  g.save();
  g.translate(c - R * 0.34, c - R * 0.4);
  g.rotate(-Math.PI / 5);
  const gloss = g.createLinearGradient(0, -R * 0.2, 0, R * 0.2);
  gloss.addColorStop(0, 'rgba(255,255,255,0.95)');
  gloss.addColorStop(1, 'rgba(255,255,255,0.15)');
  g.fillStyle = gloss;
  g.beginPath();
  g.ellipse(0, 0, R * 0.42, R * 0.19, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
  return cv;
}

export class RevealNotes {
  private groups: number[][];
  private groupStart: number[];
  private sprites = new Map<string, HTMLCanvasElement>();
  private lastT = -Infinity;
  private landed: number[] = [];
  /** Seconds of flight; the player's note-speed setting. */
  travel = TRAVEL;

  constructor(
    private holds: readonly RevealHold[],
    private seats: Map<number, Seat>,
    private r: number,
    private fx: StageFx,
    private reduced: () => boolean,
  ) {
    this.groups = sameTimeGroups(holds);
    this.groupStart = this.groups.map((g) => holds[g[0]].start);
  }

  /** A fresh run or a seek: landings before t are old news. */
  reset(t: number): void {
    this.lastT = t;
  }

  /** Fire landing effects for notes that reached their face since the last frame. */
  update(t: number, now: number): void {
    if (t < this.lastT) this.lastT = t;
    for (const i of landingsBetween(this.holds, this.lastT, t, this.landed)) {
      const h = this.holds[i];
      const s = this.seats.get(h.member);
      if (s && t - h.start < LAND_WINDOW) this.fx.land(s, now);
    }
    this.lastT = t;
  }

  private sprite(color: string): HTMLCanvasElement {
    let sp = this.sprites.get(color);
    if (!sp) {
      sp = bakeBubble(color);
      this.sprites.set(color, sp);
    }
    return sp;
  }

  private progress(arrive: number, t: number): number {
    return Math.min(1, Math.max(0, (t - (arrive - this.travel)) / this.travel));
  }

  // notes grow as they approach, like SIF's
  private size(p: number): number {
    return this.r * (0.2 + 0.6 * p);
  }

  private at(s: Seat, p: number): { x: number; y: number } {
    return { x: CX + (s.x - CX) * p, y: CY + (s.y - CY) * p };
  }

  /** Ribbons, linking bars and the flying bubbles; call before the faces. */
  drawBack(ctx: CanvasRenderingContext2D, t: number, now: number): void {
    ctx.save();
    for (const h of this.holds) {
      if (h.start - this.travel > t) break;
      if (t >= h.end) continue;
      const s = this.seats.get(h.member);
      if (s) this.drawRibbon(ctx, s, this.progress(h.start, t), this.progress(h.end, t), now);
    }
    this.drawBars(ctx, t);
    for (const h of this.holds) {
      if (h.start - this.travel > t) break;
      if (t >= h.start) continue;
      const s = this.seats.get(h.member);
      if (!s) continue;
      const p = this.progress(h.start, t);
      const { x, y } = this.at(s, p);
      const rad = this.size(p);
      const sc = rad / SPRITE_R;
      const sp = this.sprite(s.color);
      ctx.globalAlpha = Math.min(1, 0.4 + p * 3);
      ctx.drawImage(sp, x - sp.width * sc / 2, y - sp.height * sc / 2, sp.width * sc, sp.height * sc);
    }
    ctx.restore();
  }

  /** The hold ribbon: a glow, a colour body with bright edges and a white
   *  core, drawn in the note's own frame so it's just stacked trapezoids. */
  private drawRibbon(ctx: CanvasRenderingContext2D, s: Seat, hp: number, tp: number, now: number): void {
    const dist = Math.hypot(s.x - CX, s.y - CY);
    const hd = dist * hp;
    const td = dist * tp;
    if (hd - td < 1) return;
    const hw = this.size(hp) * 0.72;
    const tw = this.size(tp) * 0.72;
    const shimmer = this.reduced() ? 0 : 0.12 * Math.sin(now / 110);
    ctx.save();
    ctx.translate(CX, CY);
    ctx.rotate(Math.atan2(s.y - CY, s.x - CX));
    const band = (k: number, fill: string, alpha: number) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(td, -tw * k);
      ctx.lineTo(hd, -hw * k);
      ctx.lineTo(hd, hw * k);
      ctx.lineTo(td, tw * k);
      ctx.closePath();
      ctx.fill();
    };
    band(1.45, s.color, 0.22);
    band(1, s.color, 0.8);
    // bright edges down both sides
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = tint(s.color, 0.7);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(td, -tw);
    ctx.lineTo(hd, -hw);
    ctx.moveTo(td, tw);
    ctx.lineTo(hd, hw);
    ctx.stroke();
    band(0.55, tint(s.color, 0.6), 0.7 + shimmer);
    band(0.2, '#ffffff', 0.85);

    // the tail end is a hollow ring once it has left the centre
    if (tp > 0) {
      ctx.globalAlpha = 1;
      ctx.lineWidth = Math.max(3, tw * 0.3);
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      ctx.arc(td, 0, tw, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = Math.max(1.5, tw * 0.1);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
    ctx.restore();
  }

  /** SIF's "same timing" bar: a thin white line between notes that land together. */
  private drawBars(ctx: CanvasRenderingContext2D, t: number): void {
    for (let g = 0; g < this.groups.length; g++) {
      const start = this.groupStart[g];
      if (start - this.travel > t) break;
      if (t >= start) continue;
      const p = this.progress(start, t);
      const idx = this.groups[g];
      ctx.globalAlpha = Math.min(1, p * 3);
      ctx.lineCap = 'round';
      for (let k = 1; k < idx.length; k++) {
        const a = this.seats.get(this.holds[idx[k - 1]].member);
        const b = this.seats.get(this.holds[idx[k]].member);
        if (!a || !b) continue;
        const pa = this.at(a, p);
        const pb = this.at(b, p);
        for (const [w, c] of BAR_STROKES) {
          ctx.lineWidth = w;
          ctx.strokeStyle = c;
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.stroke();
        }
      }
    }
  }

  /** Over the faces: the timing ring closing in, and a glow ring while held. */
  drawFront(ctx: CanvasRenderingContext2D, t: number, now: number, scaleOf: (id: number) => number): void {
    const reduced = this.reduced();
    ctx.save();
    for (const h of this.holds) {
      if (h.start - APPROACH > t) break;
      if (t >= h.end) continue;
      const s = this.seats.get(h.member);
      if (!s) continue;
      const r = this.r * scaleOf(s.id);
      if (t < h.start) {
        // four dashes shrinking onto the face, SIF's timing ring
        const p = 1 - (h.start - t) / APPROACH;
        // starts only a little wider than the face so it doesn't sprawl over neighbours
        const rad = r * (1.4 - 0.35 * p);
        const spinA = reduced ? 0 : p * 1.2;
        ctx.globalAlpha = Math.min(1, p * 2.5) * 0.9;
        ctx.lineCap = 'round';
        ctx.lineWidth = 4;
        ctx.strokeStyle = tint(s.color, 0.55);
        for (let k = 0; k < 4; k++) {
          const a = spinA + (k * Math.PI) / 2;
          ctx.beginPath();
          ctx.arc(s.x, s.y, rad, a + 0.2, a + Math.PI / 2 - 0.2);
          ctx.stroke();
        }
      } else {
        const beat = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(now / 130);
        ctx.globalAlpha = 0.45 + 0.35 * beat;
        ctx.lineWidth = 7;
        ctx.strokeStyle = s.color;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 6 + 4 * beat, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

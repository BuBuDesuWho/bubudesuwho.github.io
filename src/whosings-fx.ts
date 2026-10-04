// Stage effects for "Who's singing": light beams, star bursts, tap ripples, the
// judgement pop, combo and the score gauge. Same stage units as
// whosings-render.ts. Everything animates on the frame clock (performance.now
// / the rAF timestamp), never the song clock, so pausing audio doesn't freeze
// a half-played burst on screen.
//
// Nothing here knows who sang a line: in guess mode a burst only ever lands on
// the seats the player picked, and only once the model has said they were
// right. Reveal mode's landings come from whosings-notes.ts.
import { rankThresholds, type Rank } from './whosings';
import { STAGE_W, STAGE_H, CX, CY, CUE_R, type Seat } from './whosings-render';

const POOL = 280;
const AMBIENT = 1;
const BURST = 2;

const TAP_MS = 450;
const TAP_BOUNCE_MS = 280;
const LAND_BOUNCE_MS = 420;
const RING_MS = 520;
const FLASH_MS = 600;
const JUDGE_MS = 900;
const PULSE_MS = 500;
const BEAM_FLASH_MS = 160;
const SHIMMER_MS = 480;
const COMBO_BOUNCE_MS = 340;

const JUDGE_Y = CY + 62;
const COMBO_Y = CY + 108;

const GAUGE_W = 600;
const GAUGE_X = CX - GAUGE_W / 2;
const GAUGE_Y = 58;
const GAUGE_H = 12;
export const RANK_COLOR: Record<Rank, string> = { C: '#8fd3ff', B: '#9dff9d', A: '#ffb3da', S: '#ffd54a' };

/** The soft pulsing ring around each face. Off: it read as clutter. */
const BREATHING_RINGS = false;

const SPARKLE_COLORS = ['#ffffff', '#fff3b0', '#ffd1ec', '#c9ecff'];
const PASTELS = ['#ffb3da', '#ffe38a', '#b8f0ff', '#d4c2ff', '#b9ffc9', '#ffffff'];

/** Combo number colour by tier: plain, then sky, pink and gold at 10 / 25 / 50. */
const COMBO_COLORS = ['#ffffff', '#8fe3ff', '#ffa6e4', '#ffd54a'];
const COMBO_TIERS = [10, 25, 50];

export function comboTier(combo: number): number {
  let tier = 0;
  for (const at of COMBO_TIERS) if (combo >= at) tier++;
  return tier;
}

// Beams hang from above the stage and sway slowly; a line start brightens them.
const BEAMS = [
  { x: CX - 420, angle: -0.35, color: '255,190,230', phase: 0 },
  { x: CX - 150, angle: -0.12, color: '200,230,255', phase: 1.7 },
  { x: CX + 150, angle: 0.12, color: '255,240,200', phase: 3.1 },
  { x: CX + 420, angle: 0.35, color: '255,190,230', phase: 4.4 },
];
const BEAM_LEN = STAGE_H * 1.1;
const BEAM_SPREAD = 150;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Unit star points, worked out once; a fat inner radius keeps it chunky like SIF's.
const STAR_PTS = new Float32Array(20);
for (let k = 0; k < 10; k++) {
  const a = -Math.PI / 2 + (k * Math.PI) / 5;
  const r = k % 2 ? 0.5 : 1;
  STAR_PTS[k * 2] = Math.cos(a) * r;
  STAR_PTS[k * 2 + 1] = Math.sin(a) * r;
}

/** Traces a five-point star of outer radius s turned by rot; fill or stroke it after. */
export function starPath(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, rot: number): void {
  const c = Math.cos(rot);
  const sn = Math.sin(rot);
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const px = STAR_PTS[k * 2];
    const py = STAR_PTS[k * 2 + 1];
    const X = x + (px * c - py * sn) * s;
    const Y = y + (px * sn + py * c) * s;
    if (k) ctx.lineTo(X, Y);
    else ctx.moveTo(X, Y);
  }
  ctx.closePath();
}

const easeOut = (p: number) => 1 - (1 - p) * (1 - p);
/** Overshoots past 1 and settles, for pops that feel springy. */
const backOut = (p: number) => {
  const c = 2.2;
  const q = p - 1;
  return 1 + (c + 1) * q * q * q + c * q * q;
};

interface Bounce { at: number; land: boolean }

/** What the stage needs from the frame loop: `busy` while something with an
 *  end is playing out (full frame rate), `ambient` when only the endless drift
 *  is left (beams, sparkles), `still` when a redraw would change nothing. */
export type StageActivity = 'busy' | 'ambient' | 'still';

/** How long the beam glow from a pulse stays visible: exp(-5) of its 0.3 alpha is under one 8-bit step. */
const PULSE_VISIBLE_MS = PULSE_MS * 5;

export class StageFx {
  // Particles live in flat arrays and get recycled round-robin, so a busy
  // chorus never allocates per frame.
  private kind = new Uint8Array(POOL);
  private px = new Float32Array(POOL);
  private py = new Float32Array(POOL);
  private vx = new Float32Array(POOL);
  private vy = new Float32Array(POOL);
  private size = new Float32Array(POOL);
  private rot = new Float32Array(POOL);
  private spin = new Float32Array(POOL);
  private born = new Float64Array(POOL);
  private life = new Float32Array(POOL);
  private color: string[] = new Array(POOL).fill('#fff');
  private cursor = 0;

  private lastTick = -1;
  private ambientDue = 0;
  private pulseAt = -Infinity;
  private tapAt = new Map<number, number>();
  private ringAt = new Map<number, number>();
  private bounceAt = new Map<number, Bounce>();
  private flashAt = new Map<number, number>();

  private judgeKind: 'right' | 'wrong' | null = null;
  private judgeAt = -Infinity;
  private comboShown = 0;
  private comboAt = -Infinity;
  private scoreShown = 0;
  private scoreText = '0';
  private scoreTextFor = 0;
  private gaugeAt = -1;
  /** The gauge's number was still counting toward the score when last drawn. */
  private gaugeMoving = false;

  private beamGrads: CanvasGradient[] | null = null;
  private perfectGrad: CanvasGradient | null = null;
  private gaugeGrad: CanvasGradient | null = null;

  constructor(private reduced: () => boolean) {}

  /** A fresh run or a seek: drop anything that belongs to the old position. */
  reset(score = 0): void {
    this.judgeKind = null;
    this.judgeAt = -Infinity;
    this.comboShown = 0;
    this.scoreShown = score;
    for (let i = 0; i < POOL; i++) if (this.kind[i] === BURST) this.kind[i] = 0;
    this.flashAt.clear();
    this.ringAt.clear();
  }

  /** A face pressed in guess mode: ripple, pop and a few stars in its own colour. */
  tap(s: Seat, now: number): void {
    this.tapAt.set(s.id, now);
    this.bounceAt.set(s.id, { at: now, land: false });
    this.starBurst(s.x, s.y, s.color, this.reduced() ? 0 : 6, 140, now);
  }

  /** A reveal note reaching its face: a double ring, stars and a squish. */
  land(s: Seat, now: number): void {
    this.ringAt.set(s.id, now);
    this.bounceAt.set(s.id, { at: now, land: true });
    this.starBurst(s.x, s.y, s.color, this.reduced() ? 0 : 5, 170, now);
  }

  pulse(now: number): void {
    this.pulseAt = now;
    const n = this.reduced() ? 0 : 10;
    for (let k = 0; k < n; k++) this.spawnAmbient(now, 2.2);
  }

  judge(kind: 'right' | 'wrong', picked: Seat[], now: number): void {
    this.judgeKind = kind;
    this.judgeAt = now;
    if (kind !== 'right') return;
    const reduced = this.reduced();
    const n = reduced ? 5 : 14;
    for (const s of picked) {
      this.flashAt.set(s.id, now);
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2;
        const speed = 180 + Math.random() * 220;
        this.spawn(BURST, s.x, s.y, Math.cos(a) * speed, Math.sin(a) * speed,
          7 + Math.random() * 6, 0.6 + Math.random() * 0.35, k % 3 === 0 ? s.color : SPARKLE_COLORS[k % 4], now);
      }
    }
    if (reduced) return;
    // confetti thrown up off the word itself
    for (let k = 0; k < 12; k++) {
      const x = CX + (Math.random() - 0.5) * 300;
      this.spawn(BURST, x, JUDGE_Y - 30, (x - CX) * 1.2, -(160 + Math.random() * 200),
        6 + Math.random() * 5, 0.8 + Math.random() * 0.3, PASTELS[k % PASTELS.length], now);
    }
  }

  /** Full combo: stars rain down over the whole stage. */
  celebrate(now: number): void {
    const n = this.reduced() ? 12 : 60;
    for (let k = 0; k < n; k++) {
      this.spawn(BURST, CX + (Math.random() - 0.5) * 1100, -20 - Math.random() * 160,
        (Math.random() - 0.5) * 80, 60 + Math.random() * 120,
        7 + Math.random() * 7, 2.2 + Math.random() * 1.2, PASTELS[k % PASTELS.length], now);
    }
  }

  /** Whether anything on the stage still moves at `now`; call after drawing the frame. */
  activity(now: number): StageActivity {
    if (this.busy(now)) return 'busy';
    if (!this.reduced()) return 'ambient';
    for (let i = 0; i < POOL; i++) if (this.kind[i] === AMBIENT && now - this.born[i] <= this.life[i]) return 'ambient';
    return 'still';
  }

  private busy(now: number): boolean {
    const reduced = this.reduced();
    for (let i = 0; i < POOL; i++) if (this.kind[i] === BURST && now - this.born[i] <= this.life[i]) return true;
    if (this.judgeKind && now - this.judgeAt < JUDGE_MS) return true;
    // drawGauge stamps gaugeAt with the frame it drew, so an undrawn gauge never counts
    if (this.gaugeMoving && this.gaugeAt === now) return true;
    if (!reduced) {
      if (now - this.pulseAt < PULSE_VISIBLE_MS) return true;
      if (now - this.comboAt < COMBO_BOUNCE_MS) return true;
      for (const b of this.bounceAt.values()) if (now - b.at < (b.land ? LAND_BOUNCE_MS : TAP_BOUNCE_MS)) return true;
    }
    // the second ripple of each pair starts a beat late, so it ends later too
    const tapLag = reduced ? 1 : 1.22;
    const ringLag = reduced ? 1 : 1.18;
    for (const at of this.tapAt.values()) if (now - at < TAP_MS * tapLag) return true;
    for (const at of this.ringAt.values()) if (now - at < RING_MS * ringLag) return true;
    for (const at of this.flashAt.values()) if (now - at < FLASH_MS) return true;
    return false;
  }

  /** Face size multiplier: a pop when pressed, a squish-and-bounce when a note lands. */
  seatScale(id: number, now: number): number {
    const b = this.bounceAt.get(id);
    if (b === undefined || this.reduced()) return 1;
    const ms = b.land ? LAND_BOUNCE_MS : TAP_BOUNCE_MS;
    const p = (now - b.at) / ms;
    if (p < 0 || p >= 1) return 1;
    // a landing squashes in first and springs back past full size
    if (b.land) return 1 - 0.13 * Math.sin(p * Math.PI * 2.5) * (1 - p) * (1 - p);
    return 1 + 0.1 * Math.sin(p * Math.PI) * (1 - p);
  }

  private starBurst(x: number, y: number, color: string, n: number, speed: number, now: number): void {
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + Math.random() * 0.6;
      const v = speed * (0.7 + Math.random() * 0.6);
      this.spawn(BURST, x + Math.cos(a) * 40, y + Math.sin(a) * 40, Math.cos(a) * v, Math.sin(a) * v - 60,
        6 + Math.random() * 4, 0.5 + Math.random() * 0.25, k % 2 ? color : '#fff6b0', now);
    }
  }

  private spawn(kind: number, x: number, y: number, vx: number, vy: number, size: number, life: number, color: string, now: number): void {
    const i = this.cursor;
    this.cursor = (i + 1) % POOL;
    this.kind[i] = kind;
    this.px[i] = x;
    this.py[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.size[i] = size;
    this.rot[i] = Math.random() * Math.PI * 2;
    this.spin[i] = this.reduced() ? 0 : (Math.random() - 0.5) * 7;
    this.life[i] = life * 1000;
    this.born[i] = now;
    this.color[i] = color;
  }

  private spawnAmbient(now: number, speedUp = 1): void {
    this.spawn(AMBIENT,
      Math.random() * STAGE_W, STAGE_H * (0.55 + Math.random() * 0.5),
      (Math.random() - 0.5) * 16, -(14 + Math.random() * 22) * speedUp,
      2 + Math.random() * 3, 3 + Math.random() * 2,
      SPARKLE_COLORS[(Math.random() * SPARKLE_COLORS.length) | 0], now);
  }

  /** Move particles along; call once per frame before drawing. */
  tick(now: number): void {
    // clamp so a backgrounded tab doesn't fling everything off on return
    const dt = this.lastTick < 0 ? 0 : Math.min(0.05, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;
    if (!this.reduced()) {
      this.ambientDue += dt * 5;
      while (this.ambientDue >= 1) {
        this.ambientDue--;
        this.spawnAmbient(now);
      }
    }
    const drag = Math.exp(-3.2 * dt);
    for (let i = 0; i < POOL; i++) {
      const k = this.kind[i];
      if (!k) continue;
      if (now - this.born[i] > this.life[i]) {
        this.kind[i] = 0;
        continue;
      }
      if (k === BURST) {
        this.vx[i] *= drag;
        this.vy[i] = this.vy[i] * drag + 260 * dt;
      }
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.rot[i] += this.spin[i] * dt * (k === AMBIENT ? 0.3 : 1);
    }
  }

  private pulseLevel(now: number): number {
    return this.reduced() ? 0 : Math.exp(-Math.max(0, now - this.pulseAt) / PULSE_MS);
  }

  /** Behind everything: the light beams and drifting sparkles. */
  drawBack(ctx: CanvasRenderingContext2D, now: number): void {
    const reduced = this.reduced();
    if (!this.beamGrads) {
      this.beamGrads = BEAMS.map((b) => {
        const g = ctx.createLinearGradient(0, 0, 0, BEAM_LEN);
        g.addColorStop(0, `rgba(${b.color},0.55)`);
        g.addColorStop(1, `rgba(${b.color},0)`);
        return g;
      });
    }
    const pulse = this.pulseLevel(now);
    // a short sharp flash on top of the slower pulse, so the downbeat reads
    const flash = reduced ? 0 : Math.exp(-Math.max(0, now - this.pulseAt) / BEAM_FLASH_MS);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    BEAMS.forEach((b, k) => {
      const sway = reduced ? 0 : 0.1 * Math.sin(now / 2600 + b.phase);
      ctx.save();
      ctx.translate(b.x, -40);
      ctx.rotate(b.angle + sway);
      ctx.globalAlpha = Math.min(1, (reduced ? 0.12 : 0.16) + 0.3 * pulse + 0.45 * flash);
      ctx.fillStyle = this.beamGrads![k];
      ctx.beginPath();
      ctx.moveTo(-8, 0);
      ctx.lineTo(8, 0);
      ctx.lineTo(BEAM_SPREAD, BEAM_LEN);
      ctx.lineTo(-BEAM_SPREAD, BEAM_LEN);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
    for (let i = 0; i < POOL; i++) {
      if (this.kind[i] !== AMBIENT) continue;
      const p = (now - this.born[i]) / this.life[i];
      const fade = Math.min(1, p * 5, (1 - p) * 3);
      const twinkle = 0.55 + 0.45 * Math.sin(now / 180 + i);
      ctx.globalAlpha = Math.max(0, fade * twinkle * (0.7 + 0.3 * pulse));
      ctx.fillStyle = this.color[i];
      starPath(ctx, this.px[i], this.py[i], this.size[i], this.rot[i]);
      ctx.fill();
    }
    ctx.restore();
  }

  /** A soft ring around each face that breathes, so the stage never sits still. */
  drawBreath(ctx: CanvasRenderingContext2D, seats: Seat[], r: number, now: number): void {
    if (!BREATHING_RINGS) return;
    const reduced = this.reduced();
    ctx.save();
    ctx.lineWidth = 2;
    seats.forEach((s, k) => {
      const b = reduced ? 0 : Math.sin(now / 900 + k * 0.7);
      ctx.globalAlpha = 0.28 + 0.14 * b;
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r + 11 + 2.5 * b, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.restore();
  }

  /** Two glints run out from the bottom of the cue arc to its ends as a line
   *  starts. Symmetric on purpose: it marks the beat, not a singer. */
  drawShimmer(ctx: CanvasRenderingContext2D, now: number): void {
    if (this.reduced()) return;
    const p = (now - this.pulseAt) / SHIMMER_MS;
    if (p < 0 || p >= 1) return;
    const spread = (Math.PI / 2) * easeOut(p);
    const len = 0.32 * (1 - 0.5 * p);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#fff';
    for (const dir of [-1, 1]) {
      const a = Math.PI / 2 + dir * spread;
      ctx.globalAlpha = 0.9 * (1 - p);
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(CX, CY, CUE_R, Math.min(a, a - dir * len), Math.max(a, a - dir * len));
      ctx.stroke();
      ctx.fillStyle = '#fff6c8';
      starPath(ctx, CX + CUE_R * Math.cos(a), CY + CUE_R * Math.sin(a), 11 * (1 - 0.4 * p), now / 150);
      ctx.fill();
    }
    ctx.restore();
  }

  private ring(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, width: number, color: string, alpha: number): void {
    if (alpha <= 0 || width <= 0) return;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  /** Over the faces: tap ripples, landing rings, the flash on right picks, and burst stars. */
  drawFront(ctx: CanvasRenderingContext2D, seats: Seat[], r: number, now: number): void {
    const reduced = this.reduced();
    ctx.save();
    for (const s of seats) {
      const tap = this.tapAt.get(s.id);
      if (tap !== undefined) {
        // two ripples, the second a beat behind, like SIF's double tap ring
        for (const lag of reduced ? [0] : [0, 0.22]) {
          const p = (now - tap) / TAP_MS - lag;
          if (p < 0 || p >= 1) continue;
          this.ring(ctx, s.x, s.y, r * (1 + 0.6 * easeOut(p)), 4 * (1 - p) + 1, lag ? '#fff' : s.color, 0.8 * (1 - p));
        }
      }
      const land = this.ringAt.get(s.id);
      if (land !== undefined) {
        for (const lag of reduced ? [0] : [0, 0.18]) {
          const p = (now - land) / RING_MS - lag;
          if (p < 0 || p >= 1) continue;
          const rad = r * (1.02 + 0.75 * easeOut(p));
          this.ring(ctx, s.x, s.y, rad, 9 * (1 - p), s.color, 0.85 * (1 - p));
          this.ring(ctx, s.x, s.y, rad, 3 * (1 - p), '#fff', 0.9 * (1 - p));
        }
      }
      const flash = this.flashAt.get(s.id);
      if (flash !== undefined) {
        const p = (now - flash) / FLASH_MS;
        if (p >= 0 && p < 1) this.ring(ctx, s.x, s.y, r * (1.05 + 0.9 * easeOut(p)), 6 * (1 - p), '#fff', 1 - p);
      }
    }
    // chunky stars: a white outline round a coloured body, and a pale heart
    ctx.lineJoin = 'round';
    for (let i = 0; i < POOL; i++) {
      if (this.kind[i] !== BURST) continue;
      const p = (now - this.born[i]) / this.life[i];
      const sz = this.size[i] * (p < 0.12 ? 0.5 + 4 * p : 1 - 0.45 * p);
      ctx.globalAlpha = Math.max(0, 1 - p * p);
      starPath(ctx, this.px[i], this.py[i], sz, this.rot[i]);
      ctx.lineWidth = Math.max(1.5, sz * 0.32);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.fillStyle = this.color[i];
      ctx.fill();
      ctx.globalAlpha *= 0.55;
      ctx.fillStyle = '#fff';
      starPath(ctx, this.px[i], this.py[i], sz * 0.42, this.rot[i]);
      ctx.fill();
    }
    ctx.restore();
  }

  /** PERFECT! / MISS, then the combo under it. */
  drawJudgement(ctx: CanvasRenderingContext2D, combo: number, now: number): void {
    const reduced = this.reduced();
    const age = now - this.judgeAt;
    if (this.judgeKind && age >= 0 && age < JUDGE_MS) {
      const right = this.judgeKind === 'right';
      const alpha = age < 550 ? 1 : 1 - (age - 550) / (JUDGE_MS - 550);
      let pop = 1;
      let tilt = 0;
      let y = JUDGE_Y;
      if (!reduced) {
        if (right) {
          pop = 0.35 + 0.65 * backOut(Math.min(1, age / 260));
          // lands with a wobble and keeps a little jaunty lean
          tilt = -0.05 - 0.12 * Math.exp(-age / 160) * Math.cos(age / 55);
          y -= 10 * (age / JUDGE_MS);
        } else {
          tilt = 0.12 * Math.exp(-age / 220) * Math.sin(age / 40);
          y += 8 * (age / JUDGE_MS);
        }
      }
      if (!this.perfectGrad) {
        this.perfectGrad = ctx.createLinearGradient(0, -56, 0, 4);
        this.perfectGrad.addColorStop(0, '#ffffff');
        this.perfectGrad.addColorStop(0.35, '#ffe0f3');
        this.perfectGrad.addColorStop(0.65, '#ffa9dc');
        this.perfectGrad.addColorStop(1, '#b9a6ff');
      }
      ctx.save();
      ctx.translate(CX, y);
      ctx.rotate(tilt);
      ctx.scale(pop, pop);
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.font = `${right ? 64 : 50}px 'Paytone One', sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineJoin = 'round';
      const label = right ? 'PERFECT!' : 'MISS';
      if (right) {
        // double outline, white outside a candy pink, like SIF's judgement art
        ctx.lineWidth = 14;
        ctx.strokeStyle = '#fff';
        ctx.strokeText(label, 0, 0);
        ctx.lineWidth = 7;
        ctx.strokeStyle = '#e0509c';
        ctx.strokeText(label, 0, 0);
        ctx.fillStyle = this.perfectGrad;
      } else {
        ctx.lineWidth = 8;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.strokeText(label, 0, 0);
        ctx.fillStyle = '#a9bddd';
      }
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }

    if (combo !== this.comboShown) {
      if (combo > this.comboShown) this.comboAt = now;
      this.comboShown = combo;
    }
    if (combo < 2) return;
    const a = (now - this.comboAt) / COMBO_BOUNCE_MS;
    let pop = 1;
    let hop = 0;
    if (!reduced && a >= 0 && a < 1) {
      pop = 1 + 0.45 * (1 - a) * (1 - a) * Math.cos(a * Math.PI * 2.2);
      hop = -14 * Math.sin(a * Math.PI) * (1 - a);
    }
    ctx.save();
    ctx.translate(CX, COMBO_Y + hop);
    ctx.scale(pop, pop);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.fillStyle = COMBO_COLORS[comboTier(combo)];
    ctx.font = "40px 'Paytone One', sans-serif";
    ctx.textAlign = 'right';
    const n = String(combo);
    ctx.strokeText(n, 2, 0);
    ctx.fillText(n, 2, 0);
    ctx.font = "20px 'Paytone One', sans-serif";
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.strokeText('COMBO', 10, 0);
    ctx.fillText('COMBO', 10, 0);
    ctx.restore();
  }

  /** The score counting up toward `score`, beside a gauge that fills to S. */
  drawGauge(ctx: CanvasRenderingContext2D, score: number, max: number, now: number): void {
    if (max <= 0) return;
    const dt = Math.min(0.1, Math.max(0, (now - (this.gaugeAt < 0 ? now : this.gaugeAt)) / 1000));
    this.gaugeAt = now;
    // a seek back can lower the score; drop straight to it rather than count down
    if (score < this.scoreShown) this.scoreShown = score;
    else this.scoreShown += (score - this.scoreShown) * (1 - Math.exp(-dt * 7));
    if (score - this.scoreShown < 0.5) this.scoreShown = score;
    this.gaugeMoving = this.scoreShown !== score;
    const shown = Math.round(this.scoreShown);

    const marks = rankThresholds(max);
    const top = marks[marks.length - 1].score;
    const frac = Math.min(1, shown / top);

    if (!this.gaugeGrad) {
      this.gaugeGrad = ctx.createLinearGradient(GAUGE_X, 0, GAUGE_X + GAUGE_W, 0);
      marks.forEach((m, k) => this.gaugeGrad!.addColorStop(k / (marks.length - 1), RANK_COLOR[m.rank]));
    }
    ctx.save();
    roundRect(ctx, GAUGE_X, GAUGE_Y, GAUGE_W, GAUGE_H, GAUGE_H / 2);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.stroke();
    if (frac > 0) {
      ctx.save();
      ctx.clip();
      ctx.fillStyle = this.gaugeGrad;
      ctx.fillRect(GAUGE_X, GAUGE_Y, GAUGE_W * frac, GAUGE_H);
      if (frac >= 1 && !this.reduced()) {
        // S reached: a highlight keeps running along the full bar
        const x = GAUGE_X + ((now / 4) % (GAUGE_W + 80)) - 40;
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = '#fff';
        ctx.fillRect(x, GAUGE_Y, 24, GAUGE_H);
      }
      ctx.restore();
    }

    ctx.font = "15px 'Paytone One', sans-serif";
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    for (const m of marks) {
      const x = GAUGE_X + GAUGE_W * (m.score / top);
      const got = shown >= m.score;
      if (m.score < top) {
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillRect(x - 1, GAUGE_Y - 3, 2, GAUGE_H + 6);
      }
      ctx.fillStyle = got ? RANK_COLOR[m.rank] : 'rgba(255,255,255,0.55)';
      ctx.strokeText(m.rank, x, GAUGE_Y + GAUGE_H + 18);
      ctx.fillText(m.rank, x, GAUGE_Y + GAUGE_H + 18);
    }

    if (shown !== this.scoreTextFor) {
      this.scoreTextFor = shown;
      this.scoreText = shown.toLocaleString();
    }
    ctx.font = "26px 'Paytone One', sans-serif";
    ctx.textAlign = 'right';
    ctx.lineWidth = 5;
    ctx.fillStyle = '#fff';
    ctx.strokeText(this.scoreText, GAUGE_X - 16, GAUGE_Y + GAUGE_H);
    ctx.fillText(this.scoreText, GAUGE_X - 16, GAUGE_Y + GAUGE_H);
    ctx.restore();
  }
}

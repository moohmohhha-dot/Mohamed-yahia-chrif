// هل تعلم؟ — six facts in 60 s. Pure function of time: window.seek(t) paints frame t.
// 3-D sets are raymarched fragment shaders (shaders.js via lib/glsl.js); all Arabic type is 2-D on top.
// Timing is in seconds on a 90 bpm grid (one beat = 0.667 s); scenes start on beats.
import * as M from './lib/motion.js';
import * as G from './lib/glsl.js';
import * as SH from './shaders.js';

const { W, H, E, prog, lerp, clamp, spring, SPRING, wobble } = M;

const C = { gold: '#F2B544', goldHi: '#FFE3A1', goldLo: '#B9771A', white: '#FFFFFF', ink: '#05060A' };
const DISPLAY = 'Display', UI = 'UI';
const BEAT = 60 / 90;

// [start s, end s, set] — every start sits on a beat
const SCENES = [
  [0, 6, 'intro'],
  [9 * BEAT, 20 * BEAT, 'sun'],
  [20 * BEAT, 30 * BEAT, 'heart'],
  [30 * BEAT, 40 * BEAT, 'octopus'],
  [40 * BEAT, 52 * BEAT, 'honey'],
  [52 * BEAT, 64 * BEAT, 'everest'],
  [64 * BEAT, 74 * BEAT, 'storm'],
  [74 * BEAT, 60, 'earth'],
];
const WHIP = 0.42;   // seconds both shots share the frame at a cut

// ---------------------------------------------------------------- helpers
const AR = '٠١٢٣٤٥٦٧٨٩';
const ar = (s) => String(s).replace(/\d/g, (d) => AR[d]);
const groupAr = (n) => ar(Math.round(n).toLocaleString('en-US').replace(/,/g, '٬'));
const sp = (t, cfg = SPRING.gentle) => spring(t, cfg);
// scene-local time of the scene being drawn: every line exits on the scene clock, not its own delayed clock
let LT = 0;

function goldFill(ctx, y0, y1) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, C.goldHi); g.addColorStop(0.45, C.gold); g.addColorStop(1, C.goldLo);
  return g;
}

// A line of Arabic whose words rise out of a mask one after another (right to left).
// anchor 'right' | 'center' | 'left' places the whole line; t is seconds since the line starts.
function wordsLine(ctx, str, x, y, size, t, { color = C.white, weight = 700, family = DISPLAY, stagger = 0.09, anchor = 'right', out = 1e9, gold = false } = {}) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${family}`;
  ctx.direction = 'rtl';
  const words = str.split(' ');
  const space = ctx.measureText(' ').width;
  const ws = words.map((w) => ctx.measureText(w).width);
  const total = ws.reduce((a, b) => a + b, 0) + space * (words.length - 1);
  let cx = anchor === 'right' ? x : anchor === 'center' ? x + total / 2 : x + total;
  const exit = E.inCubic(prog(LT, out, out + 0.35));
  words.forEach((w, i) => {
    const k = sp(t - i * stagger, SPRING.snappy);
    if (k <= 0.001) { cx -= ws[i] + space; return; }
    ctx.save();
    ctx.beginPath(); ctx.rect(cx - ws[i] - 20, y - size * 1.25, ws[i] + 40, size * 1.75); ctx.clip();
    const dy = (1 - k) * size * 1.1 + exit * -size * 1.3;
    ctx.textAlign = 'right';
    ctx.shadowColor = 'rgba(0,0,0,0.75)'; ctx.shadowBlur = size * 0.35; ctx.shadowOffsetY = size * 0.06;
    ctx.fillStyle = gold ? goldFill(ctx, y - size, y + size * 0.2) : color;
    ctx.globalAlpha = clamp(k * 1.4) * (1 - exit);
    ctx.fillText(w, cx, y + dy);
    ctx.restore();
    cx -= ws[i] + space;
  });
  ctx.restore();
  return total;
}

// A hero figure that slams in (scale from big, gold, glow) with an optional counter.
function hero(ctx, str, x, y, size, t, { anchor = 'right', out = 1e9, color = null, glow = C.gold } = {}) {
  if (t <= 0) return;
  ctx.save();
  ctx.font = `700 ${size}px ${DISPLAY}`;
  ctx.direction = 'rtl';
  ctx.textAlign = anchor;
  const k = sp(t, SPRING.bouncy);
  const exit = E.inCubic(prog(LT, out, out + 0.35));
  const s = lerp(1.9, 1, k) * (1 - exit * 0.3);
  ctx.translate(x, y - size * 0.35); ctx.scale(s, s); ctx.translate(-x, -(y - size * 0.35));
  ctx.globalAlpha = clamp(t / 0.12) * (1 - exit);
  ctx.shadowColor = glow; ctx.shadowBlur = size * (0.25 + 0.5 * Math.exp(-t * 3));
  ctx.fillStyle = color || goldFill(ctx, y - size, y + size * 0.15);
  ctx.fillText(str, x, y);
  // a light sweep across the figure once it lands
  const sw = prog(t, 0.35, 1.0);
  if (sw > 0 && sw < 1) {
    ctx.globalCompositeOperation = 'source-atop';
    ctx.shadowBlur = 0;
    const w = ctx.measureText(str).width;
    const x0 = anchor === 'right' ? x - w : anchor === 'center' ? x - w / 2 : x;
    const gx = x0 + (w + 200) * (1 - sw) - 100;
    const g = ctx.createLinearGradient(gx - 80, 0, gx + 80, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,0.85)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillText(str, x, y);
  }
  ctx.restore();
}

// Readability scrim: a soft dark falloff from one side.
function scrim(ctx, side, a = 0.55) {
  let g;
  if (side === 'left') { g = ctx.createLinearGradient(0, 0, W * 0.62, 0); }
  else if (side === 'bottom') { g = ctx.createLinearGradient(0, H, 0, H * 0.45); }
  else if (side === 'top') { g = ctx.createLinearGradient(0, 0, 0, H * 0.5); }
  else { g = ctx.createLinearGradient(W, 0, W * 0.38, 0); }
  g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}

// Ghost numeral of the fact (١..٦), huge and faint behind the copy.
function ghostNum(ctx, n, x, y, t, out) {
  const k = sp(t - 0.1, SPRING.gentle);
  const exit = prog(t, out, out + 0.35);
  ctx.save();
  ctx.font = `700 520px ${DISPLAY}`;
  ctx.textAlign = 'center';
  ctx.globalAlpha = 0.13 * k * (1 - exit);
  ctx.strokeStyle = C.gold; ctx.lineWidth = 4;
  ctx.strokeText(ar(n), x + (1 - k) * 120, y);
  ctx.restore();
}

// ---------------------------------------------------------------- scenes: 3-D params per local time
const sceneParams = {
  intro: (t) => [E.outCubic(prog(t, 0, 6)), 0.5 + 0.5 * Math.sin(t * 2)],
  sun: (t) => [prog(t, 1.4, 5.6), E.inOutSine(prog(t, 0, 7.3))],
  heart: (t) => { const ph = (t * 72 / 60) % 1; return [Math.exp(-ph * 9) + 0.6 * Math.exp(-Math.max(ph - 0.22, 0) * 12) * (ph > 0.22 ? 1 : 0), 0.5 + t * 0.07]; },
  octopus: (t) => [E.outCubic(prog(t, 2.0, 3.2)), E.inOutSine(prog(t, 0, 6.7))],
  honey: (t) => [t / 8, Math.exp(-Math.max(t - 2.0, 0) * 2)],
  everest: (t) => [E.inOutCubic(prog(t, 2.6, 6.2)), 0.35 + t * 0.03],
  storm: (t) => {
    const strikes = [0.9, 2.6, 4.2];
    let fl = 0, seed = 0, rev = 0;
    strikes.forEach((s, i) => { if (t >= s) { seed = i + 1; rev = clamp((t - s) / 0.08); fl = Math.exp(-(t - s) * 5) * (0.7 + 0.3 * Math.sin((t - s) * 70)); } });
    return [Math.max(fl, 0), seed * 1.37, rev];
  },
  earth: (t) => [E.outCubic(prog(t, 0, 10)), E.inOutSine(prog(t, 0, 9))],
};

function render3D(ctx, name, lt) {
  G.draw(ctx, name, lt, sceneParams[name](lt));
}

// ---------------------------------------------------------------- copy per scene (lt = local time, d = scene length)
const COPY = {
  intro(ctx, lt) {
    const out = 5.3;
    scrim(ctx, 'bottom', 0.6);
    hero(ctx, 'هل تعلم؟', W / 2, H * 0.78, 190, lt - 0.35, { anchor: 'center', out });
    wordsLine(ctx, 'ست حقائق ستغيّر نظرتك للعالم', W / 2, H * 0.885, 54, lt - 1.4, { anchor: 'center', family: UI, out });
  },
  sun(ctx, lt, d) {
    const out = d - 0.55;
    scrim(ctx, 'bottom', 0.7);
    ghostNum(ctx, 1, W * 0.12, H * 0.95, lt, out);
    wordsLine(ctx, 'ضوء الشمس الذي تراه الآن', W - 120, H * 0.70, 72, lt - 0.35, { out });
    wordsLine(ctx, 'غادرها قبل', W - 120, H * 0.85, 72, lt - 2.0, { out });
    const n = Math.min(8, Math.floor(8 * E.outCubic(prog(lt, 2.2, 5.6))));
    hero(ctx, `${ar(n)} دقائق`, W - 600, H * 0.86, 140, lt - 2.2, { out });
  },
  heart(ctx, lt, d) {
    const out = d - 0.55;
    scrim(ctx, 'right', 0.0);
    scrim(ctx, 'left', 0.55);
    ghostNum(ctx, 2, W * 0.22, H * 0.9, lt, out);
    const x = W * 0.47;
    wordsLine(ctx, 'قلبك ينبض أكثر من', x, H * 0.33, 70, lt - 0.35, { out });
    const n = 100000 * E.outExpo(prog(lt, 1.4, 4.4));
    hero(ctx, groupAr(n), x, H * 0.56, 170, lt - 1.4, { out });
    wordsLine(ctx, 'مرة كل يوم', x, H * 0.72, 70, lt - 2.4, { out });
  },
  octopus(ctx, lt, d) {
    const out = d - 0.55;
    scrim(ctx, 'left', 0.55);
    ghostNum(ctx, 3, W * 0.22, H * 0.9, lt, out);
    const x = W * 0.47;
    wordsLine(ctx, 'الأخطبوط يملك', x, H * 0.32, 74, lt - 0.35, { out });
    hero(ctx, `${ar(3)} قلوب`, x, H * 0.55, 170, lt - 1.4, { out });
    wordsLine(ctx, 'ودمه أزرق!', x, H * 0.73, 84, lt - 3.0, { out, color: '#6FC3FF' });
  },
  honey(ctx, lt, d) {
    const out = d - 0.55;
    scrim(ctx, 'bottom', 0.75);
    ghostNum(ctx, 4, W * 0.12, H * 0.95, lt, out);
    wordsLine(ctx, 'العسل لا يفسد أبداً', W - 120, H * 0.58, 84, lt - 0.35, { out });
    wordsLine(ctx, 'وُجد عسل صالح في مقابر فرعونية عمرها', W - 120, H * 0.71, 52, lt - 2.4, { out, family: UI });
    hero(ctx, `+${ar(3000)} سنة`, W - 120, H * 0.885, 112, lt - 4.4, { out });
  },
  everest(ctx, lt, d) {
    const out = d - 0.55;
    scrim(ctx, 'top', 0.7);
    ghostNum(ctx, 5, W * 0.12, H * 0.62, lt, out);
    wordsLine(ctx, 'ضع جبل إيفرست في خندق ماريانا...', W - 110, H * 0.15, 66, lt - 0.35, { out });
    // height / depth labels
    const lbl = (str, x, y, t0, col) => wordsLine(ctx, str, x, y, 46, lt - t0, { out, family: UI, color: col });
    lbl(`إيفرست: ${groupAr(8849)} م`, W - 110, H * 0.27, 1.2, C.white);
    lbl(`عمق الخندق: ${groupAr(10935)} م`, W - 110, H * 0.35, 2.4, '#8FD3FF');
    hero(ctx, `قمته تبقى تحت الماء بـ ${ar(2)} كم!`, W / 2, H * 0.875, 80, lt - 6.0, { out, anchor: 'center' });
  },
  storm(ctx, lt, d) {
    const out = d - 0.55;
    scrim(ctx, 'bottom', 0.65);
    ghostNum(ctx, 6, W * 0.12, H * 0.95, lt, out);
    wordsLine(ctx, 'البرق أسخن من سطح الشمس', W - 120, H * 0.68, 76, lt - 0.35, { out });
    hero(ctx, `${ar(5)}×`, W - 120, H * 0.885, 150, lt - 2.0, { out, color: '#DDE8FF', glow: '#7FA8FF' });
    const n = 30000 * E.outExpo(prog(lt, 2.6, 4.6));
    wordsLine(ctx, `≈ ${groupAr(n)} درجة مئوية`, W - 420, H * 0.875, 54, lt - 2.6, { out, family: UI, color: '#CFE0FF' });
  },
  earth(ctx, lt) {
    scrim(ctx, 'bottom', 0.4);
    wordsLine(ctx, 'اشترك في قناة', W / 2, H * 0.30, 64, lt - 0.6, { anchor: 'center' });
    // channel name: latin, letter by letter
    const name = 'MOHAMED';
    ctx.save();
    ctx.font = `700 190px ${DISPLAY}`;
    ctx.textAlign = 'center';
    const lay = M.layout(ctx, name, `700 190px ${DISPLAY}`, 18);
    const x0 = W / 2 - lay.width / 2;
    lay.glyphs.forEach((g, i) => {
      const k = sp(lt - 1.3 - i * 0.06, SPRING.bouncy);
      if (k <= 0) return;
      ctx.save();
      ctx.translate(x0 + g.cx, H * 0.53);
      ctx.scale(k, k);
      ctx.rotate((1 - k) * 0.6);
      ctx.shadowColor = C.gold; ctx.shadowBlur = 40;
      ctx.fillStyle = goldFill(ctx, -150, 10);
      ctx.font = `700 190px ${DISPLAY}`;
      ctx.fillText(g.ch, 0, 0);
      ctx.restore();
    });
    // sweep
    const sw = prog(lt, 2.3, 3.2);
    if (sw > 0 && sw < 1) {
      ctx.globalCompositeOperation = 'lighter';
      const gx = x0 + (lay.width + 300) * sw - 150;
      const g = ctx.createLinearGradient(gx - 90, 0, gx + 90, 0);
      g.addColorStop(0, 'rgba(255,240,200,0)'); g.addColorStop(0.5, 'rgba(255,240,200,0.6)'); g.addColorStop(1, 'rgba(255,240,200,0)');
      ctx.fillStyle = g;
      lay.glyphs.forEach((gl) => ctx.fillText(gl.ch, x0 + gl.cx, H * 0.53));
    }
    ctx.restore();
    // subscribe button
    const bk = sp(lt - 3.0, SPRING.bouncy);
    if (bk > 0) {
      const press = lt > 5.2 ? 1 - 0.08 * Math.exp(-(lt - 5.2) * 8) * Math.sin((lt - 5.2) * 30) : 1;
      const subbed = lt > 5.2;
      ctx.save();
      ctx.translate(W / 2, H * 0.70); ctx.scale(bk * press, bk * press);
      M.rrect(ctx, -230, -55, 460, 110, 55);
      ctx.fillStyle = subbed ? '#3A3A3A' : '#E62117'; ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 30; ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#fff'; ctx.font = `700 54px ${DISPLAY}`; ctx.textAlign = 'center'; ctx.direction = 'rtl';
      ctx.fillText(subbed ? 'تم الاشتراك ✓' : 'اشترك', 0, 18);
      ctx.restore();
      // cursor
      const ck = E.inOutCubic(prog(lt, 4.3, 5.1));
      if (lt > 4.1) {
        const cx = lerp(W * 0.68, W / 2 + 120, ck), cy = lerp(H * 0.95, H * 0.72, ck);
        const s = lt > 5.15 && lt < 5.4 ? 0.85 : 1;
        ctx.save(); ctx.translate(cx, cy); ctx.scale(s, s);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 46); ctx.lineTo(12, 35); ctx.lineTo(22, 56); ctx.lineTo(30, 52); ctx.lineTo(20, 32); ctx.lineTo(36, 32); ctx.closePath();
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.fill(); ctx.stroke();
        ctx.restore();
      }
    }
    wordsLine(ctx, 'وزد علمك كل يوم', W / 2, H * 0.86, 58, lt - 3.6, { anchor: 'center', family: UI, color: C.goldHi });
  },
};

// ---------------------------------------------------------------- hits (beats) -> sfx.mjs
const b = (s) => s / BEAT;
const HITS = [
  [0, 'open', 'sub', { len: 2.0 }],
  [b(0.35), 'title', 'impact'],
  [b(1.4), 'subtitle', 'whoosh', { len: 0.5 }],
  ...SCENES.slice(1).map(([s], i) => [b(s), `cut ${i + 2}`, i === 6 ? 'impact' : 'whoosh+sub', i === 6 ? {} : { len: 0.5 }]),
  [b(SCENES[1][0] + 2.2), 'eight minutes', 'thud'],
  [b(SCENES[2][0] + 1.4), '100k', 'thud'],
  [b(SCENES[3][0] + 1.4), 'three hearts', 'thud'],
  [b(SCENES[3][0] + 3.0), 'blue blood', 'bell', { pitch: 'E6' }],
  [b(SCENES[4][0] + 4.4), '3000 years', 'thud'],
  [b(SCENES[5][0] + 2.6), 'mountain sinks', 'riser', { len: 0.1, anchor: 'start' }],
  [b(SCENES[5][0] + 6.0), 'under water', 'impact'],
  [b(SCENES[6][0] + 0.9), 'strike 1', 'crash', { len: 1.6, gain: 0.12 }],
  [b(SCENES[6][0] + 2.0), 'x5', 'thud'],
  [b(SCENES[6][0] + 2.6), 'strike 2', 'crash', { len: 1.6, gain: 0.12 }],
  [b(SCENES[6][0] + 4.2), 'strike 3', 'crash', { len: 1.6, gain: 0.12 }],
  [b(SCENES[7][0] + 1.3), 'MOHAMED', 'impact'],
  [b(SCENES[7][0] + 5.2), 'subscribe click', 'click'],
  [b(SCENES[7][0] + 5.25), 'subscribed', 'bell', { pitch: 'A6' }],
];

// ---------------------------------------------------------------- draw
function drawScene(ctx, i, t) {
  const [s0, s1, name] = SCENES[i];
  const lt = t - s0;
  LT = lt;
  render3D(ctx, name, lt);
  COPY[name](ctx, lt, s1 - s0);
}

M.film({
  fonts: [`700 100px ${DISPLAY}`, `700 40px ${UI}`],
  hits: HITS,
  samples: (t) => (SCENES.some(([s], i) => i > 0 && t > s - 0.05 && t < s + WHIP + 0.05) ? 8 : 2),
  async init() { G.init(1600, 900); Object.keys(sceneParams).forEach((k) => G.scene(k, SH[k])); },
  draw(ctx, u, t) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const i = SCENES.findIndex(([a, z]) => t >= a && t < z);
    const idx = i < 0 ? SCENES.length - 1 : i;
    const [s0] = SCENES[idx];
    const into = t - s0;
    if (idx > 0 && into < WHIP) {
      // whip pan: previous shot slides out to the right while the new one pushes in from the left (RTL reading)
      const p = E.inOutCubic(into / WHIP);
      const zPrev = 1 + 0.04 * E.outCubic(clamp((t - SCENES[idx - 1][0]) / 6));
      ctx.save(); ctx.translate(p * W, 0); M.zoomAbout(ctx, zPrev, W / 2, H / 2); drawScene(ctx, idx - 1, t); ctx.restore();
      ctx.save(); ctx.translate((p - 1) * W, 0); drawScene(ctx, idx, t); ctx.restore();
      // speed streaks across the seam
      const g = ctx.createLinearGradient(p * W - 160, 0, p * W + 160, 0);
      g.addColorStop(0, 'rgba(255,220,150,0)'); g.addColorStop(0.5, `rgba(255,220,150,${0.35 * Math.sin(p * Math.PI)})`); g.addColorStop(1, 'rgba(255,220,150,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    } else {
      // a slow push on every shot so nothing sits still
      const z = 1 + 0.04 * E.outCubic(clamp(into / 6));
      ctx.save(); M.zoomAbout(ctx, z, W / 2, H / 2); drawScene(ctx, idx, t); ctx.restore();
    }
    // the storm's last strike whites out into the outro (one of two structural flashes)
    const sOut = SCENES[7][0];
    const fl = Math.max(M.bump(t, sOut, 0.25), 0);
    if (fl > 0) { ctx.fillStyle = `rgba(230,238,255,${fl * 0.85})`; ctx.fillRect(0, 0, W, H); }
    // fade in from the first frame's black and out at the very end
    const fin = clamp(t / 0.25), fout = clamp((60 - t) / 0.8);
    if (fin < 1 || fout < 1) { ctx.fillStyle = `rgba(0,0,0,${1 - Math.min(fin, fout)})`; ctx.fillRect(0, 0, W, H); }
  },
  post(ctx, u, t) {
    // film grain (seeded per frame) + letterbox bars for the cinema feel
    const fr = Math.floor(t * 30);
    ctx.save();
    ctx.globalAlpha = 0.05;
    for (let k = 0; k < 140; k++) {
      const x = M.hash01(k, fr) * W, y = M.hash01(k + 999, fr) * H;
      ctx.fillStyle = M.hash01(k + 7, fr) > 0.5 ? '#fff' : '#000';
      ctx.fillRect(x, y, 2, 2);
    }
    ctx.restore();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, 54); ctx.fillRect(0, H - 54, W, 54);
  },
});

// Epic score for "هل تعلم؟", synthesized in code on the film's 90 bpm grid.
// D minor, i–VI–III–VII per bar; taiko drums, saw-string pads, sub bass, a brass "braam" on every cut.
// Seeded noise only, so the file is the same on every run.
//   node 02-facts/audio/score.mjs   -> 02-facts/audio/music.wav
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SR = 48000, DUR = 60, N = SR * DUR, BEAT = 60 / 90, BAR = BEAT * 4;
const L = new Float32Array(N), R = new Float32Array(N);
const PAD_L = new Float32Array(N), PAD_R = new Float32Array(N);
const TAU = Math.PI * 2;
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

// scene starts (s) — kept in step with film.js
const CUTS = [9, 20, 30, 40, 52, 64, 74].map((b) => b * BEAT);
// intensity 0..1 over time: sparse intro, full facts, biggest in the outro
const energy = (t) => (t < 6 ? 0.35 : t < 49.3 ? 0.75 + 0.15 * ((t - 6) / 43) : t < 57 ? 1.0 : 1.0 - (t - 57) / 3);

function add(buf, i, v) { if (i >= 0 && i < N) buf[i] += v; }

// ---- pads: detuned saws through a two-pole lowpass, chord per bar
const PROG = [[50, 53, 57], [46, 50, 53], [53, 57, 60], [48, 52, 55]]; // Dm Bb F C
function pads() {
  const voices = [];
  for (let bar = 0; bar * BAR < DUR; bar++) {
    const ch = PROG[bar % 4];
    ch.forEach((m) => [-0.08, 0.0, 0.07].forEach((det, k) => voices.push({ t0: bar * BAR, f: mtof(m + det), pan: (k - 1) * 0.6, oct: 0 })));
    ch.slice(0, 1).forEach((m) => voices.push({ t0: bar * BAR, f: mtof(m + 12), pan: 0.3, oct: 1 }));
  }
  for (const v of voices) {
    const i0 = Math.floor(v.t0 * SR), len = Math.floor(BAR * SR * 1.15);
    let ph = rnd(), y1 = 0, y2 = 0;
    for (let n = 0; n < len; n++) {
      const t = v.t0 + n / SR;
      if (t >= DUR) break;
      ph += v.f / SR; ph -= Math.floor(ph);
      const saw = 2 * ph - 1;
      const cut = 0.025 + 0.05 * energy(t) + 0.015 * Math.sin(TAU * t * 0.11);
      y1 += cut * (saw - y1); y2 += cut * (y1 - y2);
      const env = Math.min(1, n / (0.5 * SR)) * Math.min(1, (len - n) / (0.4 * SR));
      const g = 0.035 * env * (0.4 + 0.6 * energy(t)) * (v.oct ? 0.5 : 1);
      add(PAD_L, i0 + n, y2 * g * (1 - v.pan) ); add(PAD_R, i0 + n, y2 * g * (1 + v.pan));
    }
  }
}

// ---- sub bass on the root, pulsing in eighths once the facts start
function bass() {
  let ph = 0;
  for (let n = 0; n < N; n++) {
    const t = n / SR;
    const bar = Math.floor(t / BAR);
    const root = PROG[bar % 4][0] - 24;
    ph += mtof(root) / SR;
    const pos = (t % (BEAT / 2)) / (BEAT / 2);
    const pulse = t < 6 ? 1 : 0.55 + 0.45 * Math.exp(-pos * 4);
    const s = Math.tanh(1.6 * Math.sin(TAU * ph)) * 0.16 * pulse * (0.5 + 0.5 * energy(t));
    L[n] += s; R[n] += s;
  }
}

// ---- taiko: pitched body + skin noise
function taiko(t0, gain, pitch = 70) {
  const i0 = Math.floor(t0 * SR), len = Math.floor(0.9 * SR);
  let ph = 0, lp = 0;
  for (let n = 0; n < len; n++) {
    const t = n / SR;
    const f = pitch * (0.62 + 0.38 * Math.exp(-t * 18));
    ph += f / SR;
    lp += 0.25 * ((rnd() * 2 - 1) - lp);
    const v = (Math.sin(TAU * ph) * Math.exp(-t * 5.5) + lp * Math.exp(-t * 28) * 0.6) * gain;
    add(L, i0 + n, v); add(R, i0 + n, v);
  }
}
function drums() {
  const totalBeats = Math.floor(DUR / BEAT);
  for (let b = 0; b < totalBeats; b++) {
    const t = b * BEAT, e = energy(t);
    if (t < 5.3) { if (b % 4 === 0) taiko(t, 0.5, 55); continue; }
    if (t > 58.5) continue;
    const inBar = b % 4;
    taiko(t, (inBar === 0 ? 0.75 : inBar === 2 ? 0.55 : 0.32) * e, inBar === 0 ? 62 : 82);
    if (inBar === 3) taiko(t + BEAT / 2, 0.35 * e, 95);
    // a 16th roll into every cut
    if (CUTS.some((c) => Math.abs(c - (t + BEAT)) < 0.01)) for (let k = 0; k < 4; k++) taiko(t + (k * BEAT) / 4, (0.25 + 0.12 * k) * e, 100 + k * 6);
  }
  // shaker eighths through the facts
  for (let t = 6; t < 57; t += BEAT / 2) {
    const i0 = Math.floor(t * SR), len = Math.floor(0.08 * SR);
    let hp = 0, prev = 0;
    for (let n = 0; n < len; n++) {
      const x = rnd() * 2 - 1; hp = 0.85 * (hp + x - prev); prev = x;
      const v = hp * Math.exp(-n / SR * 45) * 0.05 * energy(t);
      add(L, i0 + n, v * 0.7); add(R, i0 + n, v * 1.1);
    }
  }
}

// ---- braam: low brass stab with an opening filter, on every cut and the title
function braam(t0, gain, root = 38) {
  const i0 = Math.floor(t0 * SR), len = Math.floor(2.4 * SR);
  const fs = [root, root + 12, root + 7 + 12].map(mtof);
  const ph = fs.map(() => rnd());
  let y1 = 0, y2 = 0;
  for (let n = 0; n < len; n++) {
    const t = n / SR;
    let s = 0;
    fs.forEach((f, k) => { ph[k] += f * (1 + 0.003 * Math.sin(TAU * 5 * t)) / SR; ph[k] -= Math.floor(ph[k]); s += 2 * ph[k] - 1; });
    const cut = 0.02 + 0.18 * Math.exp(-t * 2.2);
    y1 += cut * (s - y1); y2 += cut * (y1 - y2);
    const env = Math.min(1, t / 0.03) * Math.exp(-t * 1.1);
    const v = Math.tanh(y2 * 1.8) * env * gain;
    add(L, i0 + n, v); add(R, i0 + n, v);
  }
}

// ---- a simple Schroeder reverb on the pad bus
function reverb(inL, inR, wet) {
  const combs = [1557, 1617, 1491, 1422, 1277, 1356].map((d) => ({ d: Math.floor(d * SR / 44100), buf: new Float32Array(Math.floor(d * SR / 44100)), i: 0 }));
  const outL = new Float32Array(N), outR = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const x = (inL[n] + inR[n]) * 0.5;
    let s = 0;
    combs.forEach((c) => { const y = c.buf[c.i]; c.buf[c.i] = x + y * 0.84; c.i = (c.i + 1) % c.d; s += y; });
    outL[n] = inL[n] + s * wet * 0.18; outR[n] = inR[n] + s * wet * 0.18 * 0.97;
  }
  return [outL, outR];
}

pads(); bass(); drums();
braam(0.35, 0.33, 38);
CUTS.forEach((c, i) => braam(c, i === 6 ? 0.42 : 0.26, i === 6 ? 38 : [38, 34, 41, 36, 38, 43][i]));
const [pl, pr] = reverb(PAD_L, PAD_R, 1);
for (let n = 0; n < N; n++) { L[n] += pl[n]; R[n] += pr[n]; }
// end fade + soft clip
let peak = 0;
for (let n = 0; n < N; n++) {
  const t = n / SR, f = Math.min(1, (DUR - t) / 2.0) * Math.min(1, t / 0.05);
  L[n] = Math.tanh(L[n] * f * 1.2); R[n] = Math.tanh(R[n] * f * 1.2);
  peak = Math.max(peak, Math.abs(L[n]), Math.abs(R[n]));
}
const out = Buffer.alloc(44 + N * 4);
out.write('RIFF', 0); out.writeUInt32LE(36 + N * 4, 4); out.write('WAVE', 8); out.write('fmt ', 12);
out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22); out.writeUInt32LE(SR, 24);
out.writeUInt32LE(SR * 4, 28); out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(N * 4, 40);
const g = 0.89 / peak;
for (let n = 0; n < N; n++) {
  out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[n] * g)) * 32767), 44 + n * 4);
  out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[n] * g)) * 32767), 46 + n * 4);
}
fs.writeFileSync(path.join(HERE, 'music.wav'), out);
console.log(`music.wav  ${DUR}s  peak ${peak.toFixed(2)}`);

// Cuts the ElevenLabs narration into its 8 lines at the pauses and places each line at the start
// of its scene, so every fact is spoken over its own picture.
//   node 02-facts/audio/place_vo.mjs [02-facts/audio/vo/take.mp3]   -> 02-facts/audio/vo.wav
// Then: node <skill>/scripts/mix.mjs 02-facts   (ducks the music under the voice and muxes final.mp4)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] || path.join(HERE, 'vo', 'take.mp3');
const BEAT = 60 / 90;
// where each line starts (s): scene start + a short breath, in step with film.js SCENES
const SLOTS = [0.45, 9, 20, 30, 40, 52, 64, 74].map((b, i) => (i === 0 ? b : b * BEAT + 0.35));
const LINES = 8;

const ff = (args) => spawnSync('ffmpeg', ['-hide_banner', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });

// 1. find the pauses; keep the LINES-1 longest as the line breaks
const det = ff(['-i', SRC, '-af', 'silencedetect=n=-38dB:d=0.25', '-f', 'null', '-']).stderr;
const sil = [];
let start = null;
for (const ln of det.split('\n')) {
  const a = /silence_start: ([\d.]+)/.exec(ln), b = /silence_end: ([\d.]+)/.exec(ln);
  if (a) start = Number(a[1]);
  if (b && start !== null) { sil.push({ s: start, e: Number(b[1]) }); start = null; }
}
const dur = Number(/Duration: (\d+):(\d+):([\d.]+)/.exec(det).slice(1).reduce((acc, v, i) => acc + Number(v) * [3600, 60, 1][i], 0));
const inner = sil.filter((x) => x.s > 0.3 && x.e < dur - 0.3);
const breaks = inner.sort((p, q) => (q.e - q.s) - (p.e - p.s)).slice(0, LINES - 1).sort((p, q) => p.s - q.s);
if (breaks.length < LINES - 1) { console.error(`only ${breaks.length + 1} lines found in ${SRC}`); process.exit(1); }
const cuts = [0, ...breaks.map((x) => (x.s + x.e) / 2), dur];

// 2. place each line at its slot
const parts = [], inputs = [];
for (let i = 0; i < LINES; i++) {
  const a = cuts[i], b = cuts[i + 1];
  const ms = Math.round(SLOTS[i] * 1000);
  inputs.push('-ss', a.toFixed(3), '-t', (b - a).toFixed(3), '-i', SRC);
  parts.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,silenceremove=start_periods=1:start_threshold=-40dB,adelay=${ms}|${ms}[v${i}]`);
  const next = SLOTS[i + 1] ?? 60;
  console.log(`line ${i + 1}: take ${a.toFixed(2)}-${b.toFixed(2)}s (${(b - a).toFixed(2)}s) -> ${SLOTS[i].toFixed(2)}s${SLOTS[i] + (b - a) > next ? '  ⚠ runs into the next scene' : ''}`);
}
const graph = parts.join(';') + ';' + Array.from({ length: LINES }, (_, i) => `[v${i}]`).join('') +
  `amix=inputs=${LINES}:normalize=0,apad=whole_dur=60,atrim=0:60,highpass=f=70,acompressor=threshold=-20dB:ratio=3:attack=5:release=120[vo]`;
const r = ff([...inputs, '-filter_complex', graph, '-map', '[vo]', '-c:a', 'pcm_s16le', path.join(HERE, 'vo.wav')]);
if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
console.log('-> vo.wav');

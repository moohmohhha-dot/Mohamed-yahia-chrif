/**
 * Camera + product choreography. Each keyframe is tied to a DOM marker
 * (`data-kf="<id>"`). Scrolling between two markers interpolates between
 * their keyframes, so the 3D scene and the page copy always stay in sync.
 */
export type HotspotSide = 'front' | 'back' | 'none';

export type Keyframe = {
  id: string;
  /** horizontal offset applied only on wide layouts (moves the phone away from the copy) */
  layoutX: number;
  /** absolute phone offset (used for macro shots) */
  pos: [number, number, number];
  rot: [number, number, number];
  cam: [number, number, number];
  look: [number, number, number];
  /** screen brightness, 0..2 */
  screen: number;
  /** 0 = lock-screen visuals, 1 = full display demo */
  demo: number;
  /** narrow overhead light beam */
  beam: number;
  /** architectural environment visibility */
  arch: number;
  /** studio floor visibility */
  floor: number;
  /** overall studio light level */
  light: number;
  /** macro shots skip the mobile framing adjustments */
  macro: boolean;
  hotspots: HotspotSide;
};

const TAU = Math.PI * 2;

export const keyframes: Keyframe[] = [
  {
    id: 'hero',
    layoutX: 0.78, pos: [0, 0, 0], rot: [0.08, -0.42, 0.04],
    cam: [0, 0, 4.4], look: [0, 0, 0],
    screen: 1, demo: 0, beam: 0, arch: 0.25, floor: 0.6, light: 1, macro: false, hotspots: 'front',
  },
  {
    id: 'silhouette',
    layoutX: 0.62, pos: [0, 0, 0], rot: [0.04, 0.85, -0.02],
    cam: [0, 0.1, 4.7], look: [0, 0, 0],
    screen: 0.12, demo: 0, beam: 1, arch: 0, floor: 0.25, light: 0.28, macro: false, hotspots: 'none',
  },
  {
    id: 'display',
    layoutX: -0.6, pos: [0, 0, 0], rot: [0, 0.14, 0],
    cam: [0, 0, 3.0], look: [0, 0, 0],
    screen: 1.25, demo: 1, beam: 0, arch: 0, floor: 0.2, light: 0.7, macro: false, hotspots: 'none',
  },
  {
    id: 'camera',
    layoutX: 0.6, pos: [0, 0, 0], rot: [0.12, Math.PI - 0.38, 0.05],
    cam: [0, 0, 3.7], look: [0, 0, 0],
    screen: 0.4, demo: 0, beam: 0.2, arch: 0.1, floor: 0.5, light: 1, macro: false, hotspots: 'back',
  },
  {
    id: 'materials-lens',
    layoutX: -0.36, pos: [0.15, -0.47, 0], rot: [0.05, Math.PI + 0.25, 0],
    cam: [0, 0, 1.35], look: [0, 0, 0],
    screen: 0.2, demo: 0, beam: 0, arch: 0, floor: 0, light: 1.1, macro: true, hotspots: 'none',
  },
  {
    id: 'materials-edge',
    layoutX: -0.42, pos: [0.14, -0.22, 0], rot: [0.12, 4.3, 0.16],
    cam: [0, 0, 1.75], look: [0, 0, 0],
    screen: 0.2, demo: 0, beam: 0, arch: 0, floor: 0, light: 1.1, macro: true, hotspots: 'none',
  },
  {
    id: 'studio',
    layoutX: 0.66, pos: [0, 0, 0], rot: [0.08, 3.55, 0.03],
    cam: [0, 0.15, 4.3], look: [0, 0, 0],
    screen: 0.3, demo: 0, beam: 0.35, arch: 0.2, floor: 1, light: 1.05, macro: false, hotspots: 'none',
  },
  {
    id: 'reveal',
    layoutX: 0, pos: [0, 0.15, 0], rot: [0.02, TAU - 0.3, 0],
    cam: [0, 0.9, 9.6], look: [0, 0.25, 0],
    screen: 1, demo: 0.3, beam: 0.45, arch: 1, floor: 1, light: 1, macro: false, hotspots: 'none',
  },
  {
    id: 'creator',
    layoutX: 1.2, pos: [0, 0, 0], rot: [0.1, TAU + 0.45, 0.08],
    cam: [0, 0, 5.6], look: [0, 0, 0],
    screen: 0.6, demo: 0, beam: 0, arch: 0.35, floor: 0.4, light: 0.55, macro: false, hotspots: 'none',
  },
  {
    id: 'final',
    layoutX: 0, pos: [0, 0.86, 0], rot: [0.02, TAU, 0],
    cam: [0, 0, 6.6], look: [0, 0, 0],
    screen: 0.9, demo: 0, beam: 1, arch: 0, floor: 0.3, light: 0.3, macro: false, hotspots: 'none',
  },
];

export const keyframeIndex = new Map(keyframes.map((k, i) => [k.id, i]));

export type Sampled = Omit<Keyframe, 'id' | 'macro' | 'hotspots'> & {
  hotspots: HotspotSide;
  macro: number;
};

export const createSample = (): Sampled => ({
  layoutX: 0, pos: [0, 0, 0], rot: [0, 0, 0], cam: [0, 0, 5], look: [0, 0, 0],
  screen: 1, demo: 0, beam: 0, arch: 0, floor: 0, light: 1, macro: 0, hotspots: 'none',
});

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => t * t * (3 - 2 * t);

/** Writes the interpolated keyframe at `story` into `out` (no allocations). */
export function sampleKeyframes(story: number, out: Sampled): Sampled {
  const max = keyframes.length - 1;
  const s = Math.min(Math.max(story, 0), max);
  const i = Math.min(Math.floor(s), max - 1);
  const t = ease(s - i);
  const a = keyframes[i];
  const b = keyframes[i + 1];
  for (let k = 0; k < 3; k++) {
    out.pos[k] = lerp(a.pos[k], b.pos[k], t);
    out.rot[k] = lerp(a.rot[k], b.rot[k], t);
    out.cam[k] = lerp(a.cam[k], b.cam[k], t);
    out.look[k] = lerp(a.look[k], b.look[k], t);
  }
  out.layoutX = lerp(a.layoutX, b.layoutX, t);
  out.screen = lerp(a.screen, b.screen, t);
  out.demo = lerp(a.demo, b.demo, t);
  out.beam = lerp(a.beam, b.beam, t);
  out.arch = lerp(a.arch, b.arch, t);
  out.floor = lerp(a.floor, b.floor, t);
  out.light = lerp(a.light, b.light, t);
  out.macro = lerp(a.macro ? 1 : 0, b.macro ? 1 : 0, t);
  out.hotspots = Math.abs(s - Math.round(s)) < 0.22 ? keyframes[Math.round(s)].hotspots : 'none';
  return out;
}

/** shared, frame-updated sample (written by CameraRig, read by everything else) */
export const frame = createSample();

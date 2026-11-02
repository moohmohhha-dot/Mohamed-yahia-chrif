import { create } from 'zustand';
import { finishes } from '../data/product';

export type Quality = 'high' | 'medium' | 'low';

type UIState = {
  introDone: boolean;
  introRun: number;
  finishId: string;
  soundOn: boolean;
  activeHotspot: string | null;
  quality: Quality;
  menuOpen: boolean;
  activeSection: string;
  setIntroDone: (v: boolean) => void;
  replayIntro: () => void;
  setFinish: (id: string) => void;
  toggleSound: () => void;
  setActiveHotspot: (id: string | null) => void;
  setQuality: (q: Quality) => void;
  setMenuOpen: (v: boolean) => void;
  setActiveSection: (id: string) => void;
};

export const useUI = create<UIState>((set) => ({
  introDone: false,
  introRun: 0,
  finishId: finishes[0].id,
  soundOn: false,
  activeHotspot: null,
  quality: 'high',
  menuOpen: false,
  activeSection: 'hero',
  setIntroDone: (v) => set({ introDone: v }),
  replayIntro: () => set((s) => ({ introDone: false, introRun: s.introRun + 1, activeHotspot: null })),
  setFinish: (id) => set({ finishId: id }),
  toggleSound: () => set((s) => ({ soundOn: !s.soundOn })),
  setActiveHotspot: (id) => set({ activeHotspot: id }),
  setQuality: (q) => set({ quality: q }),
  setMenuOpen: (v) => set({ menuOpen: v }),
  setActiveSection: (id) => set({ activeSection: id }),
}));

/**
 * Per-frame motion values. Mutated directly (never through React) so the
 * render loop stays allocation- and re-render-free.
 */
export const motion = {
  /** continuous story position derived from scroll (index into keyframes) */
  storyTarget: 0,
  story: 0,
  /** intro progress 0 → 1 (camera dolly / light ramp) */
  intro: 0,
  /** 1 while the opening titles are on screen: phone framed higher and centred */
  introHold: 1,
  /** normalised pointer, -1..1 */
  pointer: { x: 0, y: 0 },
  pointerSmooth: { x: 0, y: 0 },
  /** user drag rotation */
  drag: { yaw: 0, pitch: 0, vYaw: 0, vPitch: 0, active: false, lastInput: 0 },
  resetRequested: false,
  reducedMotion: false,
};

export const requestReset = () => {
  motion.resetRequested = true;
  motion.drag.vYaw = 0;
  motion.drag.vPitch = 0;
};

import { useRef, type ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { motion } from '../lib/store';
import { audio } from '../lib/audio';
import { frame, sampleKeyframes } from './keyframes';

/** Layout facts derived from the viewport each frame, shared with the rest of the scene. */
export const stage = {
  layout: 1, // 1 = wide (copy beside the phone), 0 = narrow (centred)
  portrait: 0, // 1 = tall phone screen
  intro: 0, // eased intro progress
  hold: 1, // opening-title framing, eases to 0 when the showroom opens
  phone: new THREE.Vector3(),
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const damp = (current: number, target: number, lambda: number, dt: number) =>
  THREE.MathUtils.damp(current, target, lambda, dt);

/** Drives the story position, camera dolly and parallax. Must mount before other frame consumers. */
export function CameraRig() {
  const { camera, size } = useThree();
  const look = useRef(new THREE.Vector3());

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const reduced = motion.reducedMotion;

    motion.story = damp(motion.story, motion.storyTarget, reduced ? 12 : 3.2, dt);
    sampleKeyframes(motion.story, frame);

    motion.pointerSmooth.x = damp(motion.pointerSmooth.x, motion.pointer.x, 2.6, dt);
    motion.pointerSmooth.y = damp(motion.pointerSmooth.y, motion.pointer.y, 2.6, dt);
    audio.setPan(motion.pointerSmooth.x);

    const aspect = size.width / size.height;
    stage.layout = clamp01((aspect - 0.9) / 0.5);
    stage.portrait = 1 - clamp01((aspect - 0.62) / 0.45);
    stage.intro = reduced ? motion.intro : easeOutCubic(motion.intro);
    stage.hold = damp(stage.hold, motion.introHold, reduced ? 20 : 1.8, dt);

    const px = reduced ? 0 : motion.pointerSmooth.x;
    const py = reduced ? 0 : motion.pointerSmooth.y;
    const nonMacro = 1 - frame.macro;
    const dolly = (1 - stage.intro) * 11;
    const portraitPush = 1 + stage.portrait * 0.32 * nonMacro;

    camera.position.set(
      frame.cam[0] + px * 0.28 * (1 - frame.macro * 0.7),
      frame.cam[1] + py * 0.16 * (1 - frame.macro * 0.7) + (1 - stage.intro) * 0.6,
      frame.cam[2] * portraitPush + dolly + stage.hold * 2.4,
    );
    look.current.set(frame.look[0], frame.look[1], frame.look[2]);
    camera.lookAt(look.current);
  });

  return null;
}

/** Applies keyframed transform + drag/inertia + idle float to the phone. */
export function PhoneRig({ children }: { children: ReactNode }) {
  const group = useRef<THREE.Group>(null);
  const time = useRef(0);

  useFrame((_, rawDt) => {
    const g = group.current;
    if (!g) return;
    const dt = Math.min(rawDt, 0.05);
    const d = motion.drag;
    const reduced = motion.reducedMotion;
    time.current += dt;

    // inertia after release
    if (!d.active) {
      d.yaw += d.vYaw * dt * 60;
      d.pitch += d.vPitch * dt * 60;
      const decay = Math.exp(-dt * 3.5);
      d.vYaw *= decay;
      d.vPitch *= decay;
    }
    d.pitch = THREE.MathUtils.clamp(d.pitch, -0.7, 0.7);

    // return to the authored angle when resetting or while the story moves
    const travelling = Math.abs(motion.storyTarget - motion.story) > 0.04;
    if ((motion.resetRequested || travelling) && !d.active) {
      d.yaw = Math.atan2(Math.sin(d.yaw), Math.cos(d.yaw));
      d.yaw = damp(d.yaw, 0, motion.resetRequested ? 3.2 : 1.6, dt);
      d.pitch = damp(d.pitch, 0, motion.resetRequested ? 3.2 : 1.6, dt);
      if (Math.abs(d.yaw) < 0.002 && Math.abs(d.pitch) < 0.002) {
        d.yaw = 0;
        d.pitch = 0;
        motion.resetRequested = false;
      }
    }

    const intro = stage.intro;
    const nonMacro = 1 - frame.macro;
    const idle = reduced ? 0 : Math.sin(time.current * 0.45) * 0.05 * nonMacro;
    const float = reduced ? 0 : Math.sin(time.current * 0.8) * 0.025 * nonMacro;
    const px = reduced ? 0 : motion.pointerSmooth.x;
    const py = reduced ? 0 : motion.pointerSmooth.y;

    g.position.set(
      frame.pos[0] + frame.layoutX * stage.layout * (1 - stage.hold),
      frame.pos[1] + float + stage.portrait * (0.62 * nonMacro + 0.06 * frame.macro) - (1 - intro) * 0.25 + stage.hold * 0.5,
      frame.pos[2],
    );
    g.rotation.set(
      frame.rot[0] + d.pitch - py * 0.1 * nonMacro,
      frame.rot[1] + d.yaw + idle + px * 0.16 * nonMacro + (1 - intro) * 1.9,
      frame.rot[2] - (1 - intro) * 0.15,
    );
    stage.phone.copy(g.position);
  });

  return <group ref={group}>{children}</group>;
}

if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug')) {
  (window as unknown as Record<string, unknown>).__nd = { motion, frame, stage };
}

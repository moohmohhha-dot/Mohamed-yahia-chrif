import { Component, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { motion } from '../lib/store';
import { hasWebGL } from '../lib/webgl';
import LoadingScreen from './LoadingScreen';
import FallbackPhone from './FallbackPhone';
import { HotspotLayer } from './HotspotLayer';

// The whole 3D bundle is code-split so the shell paints immediately.
const ProductScene = lazy(() => import('../scenes/ProductScene'));

class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn('[MOHAMED] 3D scene failed, switching to the HTML/CSS fallback.', error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Fixed full-viewport stage that hosts the WebGL scene behind the story.
 * Handles drag-to-rotate (mouse + touch) with inertia; vertical touch
 * movement is left to the browser so the page still scrolls on phones.
 */
export default function HeroScene() {
  const [webgl] = useState(hasWebGL);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let lastX = 0;
    let lastY = 0;
    let lastT = 0;
    let id: number | null = null;

    const down = (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button, a')) return;
      id = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
      lastT = performance.now();
      motion.drag.active = true;
      motion.drag.vYaw = 0;
      motion.drag.vPitch = 0;
      motion.resetRequested = false;
      el.classList.add('is-dragging');
    };
    const move = (e: PointerEvent) => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      motion.pointer.x = (e.clientX / w) * 2 - 1;
      motion.pointer.y = -((e.clientY / h) * 2 - 1);
      if (id !== e.pointerId || !motion.drag.active) return;
      const now = performance.now();
      const frames = Math.max((now - lastT) / 16.7, 0.5);
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      const yaw = dx * 0.0085;
      const pitch = e.pointerType === 'touch' ? 0 : dy * 0.005;
      motion.drag.yaw += yaw;
      motion.drag.pitch += pitch;
      motion.drag.vYaw = yaw / frames;
      motion.drag.vPitch = pitch / frames;
      motion.drag.lastInput = now;
      lastX = e.clientX;
      lastY = e.clientY;
      lastT = now;
    };
    const up = (e: PointerEvent) => {
      if (id !== e.pointerId) return;
      id = null;
      motion.drag.active = false;
      if (performance.now() - lastT > 80) {
        motion.drag.vYaw = 0;
        motion.drag.vPitch = 0;
      }
      el.classList.remove('is-dragging');
    };

    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);

  // keyboard rotation for non-pointer users
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select')) return;
      if (e.key === 'ArrowLeft' && e.altKey) motion.drag.vYaw = -0.06;
      if (e.key === 'ArrowRight' && e.altKey) motion.drag.vYaw = 0.06;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div ref={stageRef} className="stage" data-webgl={webgl}>
      <p className="sr-only">
        Interactive 3D concept smartphone. Drag horizontally to rotate it, scroll to move through the story, or use the
        feature buttons and finish selectors on the page.
      </p>
      {webgl ? (
        <SceneBoundary fallback={<FallbackPhone />}>
          <Suspense fallback={<LoadingScreen />}>
            <ProductScene />
          </Suspense>
          <HotspotLayer />
        </SceneBoundary>
      ) : (
        <FallbackPhone />
      )}
    </div>
  );
}

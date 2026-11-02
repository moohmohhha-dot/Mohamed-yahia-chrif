import { useEffect, useRef } from 'react';
import { finishes } from '../data/product';
import { motion, useUI } from '../lib/store';

/**
 * HTML/CSS 3D fallback used when WebGL is unavailable or the scene fails.
 * Still rotates with drag and pointer movement, and still reacts to finishes.
 */
export default function FallbackPhone() {
  const ref = useRef<HTMLDivElement>(null);
  const finishId = useUI((s) => s.finishId);
  const finish = finishes.find((f) => f.id === finishId) ?? finishes[0];

  useEffect(() => {
    let raf = 0;
    let yaw = 0;
    const tick = () => {
      const d = motion.drag;
      if (!d.active) {
        d.yaw += d.vYaw;
        d.vYaw *= 0.94;
      }
      if (motion.resetRequested) {
        d.yaw *= 0.9;
        if (Math.abs(d.yaw) < 0.002) motion.resetRequested = false;
      }
      const target = -0.4 + motion.storyTarget * 0.6 + d.yaw + motion.pointer.x * 0.2;
      yaw += (target - yaw) * 0.08;
      if (ref.current) {
        ref.current.style.transform = `rotateX(${(-motion.pointer.y * 8).toFixed(2)}deg) rotateY(${((yaw * 180) / Math.PI).toFixed(2)}deg)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="fallback" style={{ ['--frame' as string]: finish.frame, ['--back' as string]: finish.back }}>
      <div className="fallback__glow" aria-hidden="true" />
      <div className="fallback__phone" ref={ref} aria-hidden="true">
        <div className="fallback__face fallback__face--front">
          <div className="fallback__screen">
            <span className="fallback__punch" />
            <span className="fallback__brand">MOHAMED</span>
          </div>
        </div>
        <div className="fallback__face fallback__face--back">
          <span className="fallback__lens" style={{ top: '7%' }} />
          <span className="fallback__lens" style={{ top: '16.5%' }} />
          <span className="fallback__lens" style={{ top: '26%' }} />
          <span className="fallback__lens fallback__lens--small" />
        </div>
        <div className="fallback__face fallback__face--side" />
        <div className="fallback__face fallback__face--side fallback__face--left" />
      </div>
      <p className="fallback__note">3D rendering is unavailable on this device — showing a simplified CSS model.</p>
    </div>
  );
}

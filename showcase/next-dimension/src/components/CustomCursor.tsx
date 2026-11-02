import { useEffect, useRef } from 'react';

/**
 * A small trailing ring for fine pointers. The native cursor is kept, so
 * text selection, links and form controls behave exactly as usual.
 */
export default function CustomCursor() {
  const ring = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fine = window.matchMedia('(pointer: fine)').matches;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const el = ring.current;
    if (!fine || reduced || !el) return;

    let x = -100;
    let y = -100;
    let cx = x;
    let cy = y;
    let raf = 0;

    const move = (e: PointerEvent) => {
      x = e.clientX;
      y = e.clientY;
      const t = e.target as HTMLElement;
      el.classList.toggle('is-hover', !!t.closest('button, a, [role="button"]'));
      el.classList.add('is-on');
    };
    const leave = () => el.classList.remove('is-on');
    const down = () => el.classList.add('is-down');
    const up = () => el.classList.remove('is-down');
    const tick = () => {
      cx += (x - cx) * 0.2;
      cy += (y - cy) * 0.2;
      el.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
      raf = requestAnimationFrame(tick);
    };
    window.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerleave', leave);
    window.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener('pointermove', move);
      document.removeEventListener('pointerleave', leave);
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      cancelAnimationFrame(raf);
    };
  }, []);

  return <div ref={ring} className="cursor" aria-hidden="true" />;
}

import { useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { audio } from '../lib/audio';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: 'primary' | 'ghost' | 'text';
  strength?: number;
};

/** A button that leans toward the pointer. Inert for touch and reduced motion. */
export default function MagneticButton({ children, variant = 'primary', strength = 0.28, className = '', onClick, ...rest }: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  const inner = useRef<HTMLSpanElement>(null);

  const canMagnet = () =>
    window.matchMedia('(pointer: fine)').matches && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  return (
    <button
      ref={ref}
      type="button"
      className={`btn btn--${variant} ${className}`}
      onPointerMove={(e) => {
        if (!canMagnet() || !ref.current) return;
        const r = ref.current.getBoundingClientRect();
        const x = (e.clientX - (r.left + r.width / 2)) * strength;
        const y = (e.clientY - (r.top + r.height / 2)) * strength;
        ref.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        if (inner.current) inner.current.style.transform = `translate3d(${x * 0.35}px, ${y * 0.35}px, 0)`;
      }}
      onPointerEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        audio.tick(((r.left + r.width / 2) / window.innerWidth) * 2 - 1, 1.2);
      }}
      onPointerLeave={() => {
        if (ref.current) ref.current.style.transform = '';
        if (inner.current) inner.current.style.transform = '';
      }}
      onClick={(e) => {
        audio.tick(0, 0.8);
        onClick?.(e);
      }}
      {...rest}
    >
      <span ref={inner} className="btn__inner">
        {children}
      </span>
    </button>
  );
}

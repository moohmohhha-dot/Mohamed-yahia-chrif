import { useEffect, useRef } from 'react';
import gsap from 'gsap';
import { brand, hero } from '../data/product';
import { motion, requestReset, useUI } from '../lib/store';
import { scrollToSection } from '../lib/scroll';
import { prefersReducedMotion } from '../lib/reducedMotion';
import MagneticButton from './MagneticButton';
import ColorSelector from './ColorSelector';

export default function HeroCopy() {
  const introDone = useUI((s) => s.introDone);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const q = gsap.utils.selector(el);
    if (!introDone) {
      gsap.set(q('.js-hero'), { opacity: 0, y: 24 });
      return;
    }
    if (prefersReducedMotion()) {
      gsap.set(q('.js-hero'), { opacity: 1, y: 0 });
      return;
    }
    const t = gsap.to(q('.js-hero'), { opacity: 1, y: 0, duration: 1.2, stagger: 0.09, ease: 'expo.out', delay: 0.15 });
    return () => {
      t.kill();
    };
  }, [introDone]);

  const explore = () => {
    // a guided half-turn so the visitor immediately sees the object is real 3D
    motion.resetRequested = false;
    motion.drag.vYaw = prefersReducedMotion() ? 0 : 0.11;
  };

  return (
    <section id="hero" data-section="hero" data-kf="hero" className="chapter chapter--hero" aria-labelledby="hero-title">
      <div className="hero" ref={ref}>
        <p className="eyebrow js-hero">{hero.eyebrow}</p>
        <h1 id="hero-title" className="hero__title">
          {hero.headline.map((line) => (
            <span key={line} className="hero__line js-hero">{line}</span>
          ))}
        </h1>
        <p className="hero__sub js-hero">{hero.sub}</p>
        <div className="hero__actions js-hero">
          <MagneticButton variant="primary" onClick={explore}>
            {hero.primary}
            <span className="btn__arrow" aria-hidden="true">↻</span>
          </MagneticButton>
          <MagneticButton variant="ghost" onClick={() => scrollToSection('silhouette')}>
            {hero.secondary}
          </MagneticButton>
        </div>
        <div className="hero__controls js-hero">
          <ColorSelector size="compact" id="hero-finish" />
          <button type="button" className="reset" onClick={requestReset}>
            <span aria-hidden="true">⟲</span> RESET VIEW
          </button>
        </div>
        <p className="hero__concept js-hero">{brand.productLabel}. {brand.conceptLabel}</p>
      </div>
      <p className="hint js-hint" aria-hidden={!introDone}>
        <span className="hint__line" aria-hidden="true" />
        {hero.hint}
      </p>
    </section>
  );
}

import { useCallback, useEffect, useRef } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { brand, intro } from '../data/product';
import { motion, useUI } from '../lib/store';
import { prefersReducedMotion } from '../lib/reducedMotion';
import MagneticButton from './MagneticButton';

/**
 * Cinematic opening. A spark of light, particles rushing past, the camera
 * dollying onto the phone, then the wordmark and two lines of copy.
 * Skippable at any time (button or Escape) and never blocks the site.
 */
export default function IntroSequence() {
  const introDone = useUI((s) => s.introDone);
  const introRun = useUI((s) => s.introRun);
  const setIntroDone = useUI((s) => s.setIntroDone);
  const root = useRef<HTMLDivElement>(null);
  const cta = useRef<HTMLDivElement>(null);
  const tl = useRef<gsap.core.Timeline | null>(null);
  const proxy = useRef({ v: 0 });
  const leaving = useRef(false);

  const finish = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    tl.current?.pause();
    motion.introHold = 0;
    const reduced = prefersReducedMotion();
    gsap.to(proxy.current, {
      v: 1,
      duration: reduced ? 0.01 : 0.9,
      ease: 'power2.out',
      onUpdate: () => {
        motion.intro = proxy.current.v;
      },
    });
    gsap.to(root.current, {
      autoAlpha: 0,
      duration: reduced ? 0.2 : 0.9,
      ease: 'power2.inOut',
      onComplete: () => {
        motion.intro = 1;
        setIntroDone(true);
      },
    });
  }, [setIntroDone]);

  useEffect(() => {
    if (introDone) {
      document.documentElement.classList.remove('is-locked');
      ScrollTrigger.refresh();
      return;
    }
    const el = root.current;
    if (!el) return;
    leaving.current = false;
    document.documentElement.classList.add('is-locked');
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    motion.storyTarget = 0;
    motion.story = 0;
    motion.introHold = 1;
    proxy.current.v = 0;
    motion.intro = 0;

    const reduced = prefersReducedMotion();
    const q = gsap.utils.selector(el);
    gsap.set(el, { autoAlpha: 1 });

    el.classList.toggle('intro--static', reduced);
    if (reduced) {
      motion.intro = 1;
      proxy.current.v = 1;
      gsap.set(q('.intro__veil'), { opacity: 0.55 });
      gsap.set(q('.intro__spark'), { opacity: 0 });
      gsap.set(q('.intro__wordmark span, .intro__line--2, .intro__cta'), { opacity: 1, yPercent: 0, y: 0 });
      gsap.set(q('.intro__line--1'), { opacity: 1, y: 0 });
      return;
    }

    const t = gsap.timeline({ defaults: { ease: 'power3.out' } });
    t.set(q('.intro__veil'), { opacity: 1 })
      .set(q('.intro__wordmark span'), { yPercent: 110, opacity: 0 })
      .set(q('.intro__line, .intro__cta'), { opacity: 0, y: 14 })
      .fromTo(q('.intro__spark'), { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 1.1 }, 0.2)
      .to(proxy.current, {
        v: 1,
        duration: 6.2,
        ease: 'power2.inOut',
        onUpdate: () => {
          motion.intro = proxy.current.v;
        },
      }, 0.7)
      .to(q('.intro__veil'), { opacity: 0.35, duration: 2.6, ease: 'power1.inOut' }, 0.9)
      .to(q('.intro__spark'), { scale: 6, opacity: 0, duration: 2.2, ease: 'power2.in' }, 1.6)
      .to(q('.intro__wordmark span'), { yPercent: 0, opacity: 1, stagger: 0.07, duration: 1.3, ease: 'expo.out' }, 3.2)
      .fromTo(q('.intro__line--1'), { opacity: 0, y: 14, filter: 'blur(8px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 1.2 }, 4.0)
      .to(q('.intro__line--1'), { opacity: 0, y: -10, filter: 'blur(6px)', duration: 0.8, ease: 'power2.in' }, 6.4)
      .fromTo(q('.intro__line--2'), { opacity: 0, y: 14, filter: 'blur(8px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 1.2 }, 7.0)
      .to(q('.intro__cta'), { opacity: 1, y: 0, duration: 1 }, 7.6)
      .to(q('.intro__veil'), { opacity: 0.15, duration: 1.5 }, 7.0)
      .add(() => cta.current?.querySelector('button')?.focus({ preventScroll: true }), 8.2);
    tl.current = t;

    return () => {
      t.kill();
    };
  }, [introDone, introRun]);

  useEffect(() => {
    if (introDone) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && finish();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [introDone, finish]);

  if (introDone) return null;

  return (
    <div ref={root} className="intro" role="dialog" aria-modal="true" aria-label="Opening sequence">
      <div className="intro__veil" aria-hidden="true" />
      <div className="intro__spark" aria-hidden="true" />
      <div className="intro__content">
        <h1 className="intro__wordmark wordmark" aria-label={brand.name}>
          {brand.name.split('').map((c, i) => (
            <span key={i} aria-hidden="true">{c}</span>
          ))}
        </h1>
        <div className="intro__lines">
          <p className="intro__line intro__line--1">{intro.lineOne}</p>
          <p className="intro__line intro__line--2">{intro.lineTwo}</p>
        </div>
        <div ref={cta} className="intro__cta">
          <MagneticButton variant="primary" onClick={finish}>
            {intro.cta}
            <span className="btn__arrow" aria-hidden="true">→</span>
          </MagneticButton>
        </div>
      </div>
      <button type="button" className="intro__skip" onClick={finish}>
        {intro.skip} <span aria-hidden="true">ESC</span>
      </button>
      <p className="intro__disclaimer">{brand.disclaimer}</p>
    </div>
  );
}

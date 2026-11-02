import { useEffect } from 'react';
import Navigation from './components/Navigation';
import IntroSequence from './components/IntroSequence';
import HeroScene from './components/HeroScene';
import HeroCopy from './components/HeroCopy';
import ScrollStory from './components/ScrollStory';
import AboutMohamed from './components/AboutMohamed';
import FinalReveal from './components/FinalReveal';
import HotspotPanel from './components/HotspotPanel';
import ScrollProgress from './components/ScrollProgress';
import CustomCursor from './components/CustomCursor';
import { useStoryScroll } from './lib/useStoryScroll';
import { useReducedMotion } from './lib/reducedMotion';
import { motion, useUI } from './lib/store';
import { initialQuality } from './lib/webgl';

/** Writes smoothed pointer values to CSS variables for multi-layer DOM parallax. */
function usePointerParallax(reduced: boolean) {
  useEffect(() => {
    if (reduced) return;
    const root = document.documentElement;
    let x = 0;
    let y = 0;
    let raf = 0;
    const tick = () => {
      x += (motion.pointer.x - x) * 0.08;
      y += (motion.pointer.y - y) * 0.08;
      root.style.setProperty('--px', x.toFixed(4));
      root.style.setProperty('--py', y.toFixed(4));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      root.style.setProperty('--px', '0');
      root.style.setProperty('--py', '0');
    };
  }, [reduced]);
}

export default function App() {
  const reduced = useReducedMotion();
  const introDone = useUI((s) => s.introDone);
  const setQuality = useUI((s) => s.setQuality);

  useStoryScroll();
  usePointerParallax(reduced);

  useEffect(() => {
    setQuality(initialQuality());
  }, [setQuality]);

  useEffect(() => {
    document.documentElement.dataset.intro = introDone ? 'done' : 'running';
  }, [introDone]);

  return (
    <>
      <a className="skip-link" href="#hero">Skip to content</a>
      <HeroScene />
      <IntroSequence />
      <Navigation />
      <ScrollProgress />
      <main className="content" aria-hidden={!introDone ? true : undefined}>
        <HeroCopy />
        <ScrollStory />
        <AboutMohamed />
        <FinalReveal />
      </main>
      <HotspotPanel />
      <CustomCursor />
    </>
  );
}

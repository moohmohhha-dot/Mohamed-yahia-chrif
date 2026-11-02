import { useEffect } from 'react';
import { keyframeIndex } from '../scenes/keyframes';
import { motion, useUI } from './store';
import { audio } from './audio';

type Marker = { index: number; center: number };

/**
 * Converts the page scroll position into a continuous "story position"
 * by locating the viewport centre between `[data-kf]` markers.
 * Also drives the scroll-progress CSS variable and the active section.
 */
export function useStoryScroll() {
  useEffect(() => {
    let markers: Marker[] = [];
    let sections: { id: string; top: number }[] = [];
    let raf = 0;

    const measure = () => {
      const y = window.scrollY;
      markers = Array.from(document.querySelectorAll<HTMLElement>('[data-kf]'))
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { index: keyframeIndex.get(el.dataset.kf!) ?? 0, center: r.top + y + r.height / 2 };
        })
        .sort((a, b) => a.center - b.center);
      sections = Array.from(document.querySelectorAll<HTMLElement>('[data-section]')).map((el) => ({
        id: el.dataset.section!,
        top: el.getBoundingClientRect().top + y,
      }));
      update();
    };

    const update = () => {
      raf = 0;
      const vh = window.innerHeight;
      const y = window.scrollY + vh / 2;
      if (markers.length) {
        let story = markers[0].index;
        if (y >= markers[markers.length - 1].center) story = markers[markers.length - 1].index;
        else {
          for (let i = 0; i < markers.length - 1; i++) {
            const a = markers[i];
            const b = markers[i + 1];
            if (y >= a.center && y < b.center) {
              story = a.index + ((y - a.center) / (b.center - a.center)) * (b.index - a.index);
              break;
            }
          }
        }
        motion.storyTarget = story;
      }

      const max = document.documentElement.scrollHeight - vh;
      const p = max > 0 ? window.scrollY / max : 0;
      document.documentElement.style.setProperty('--scroll', p.toFixed(4));
      audio.setDepth(p);

      let active = sections[0]?.id ?? 'hero';
      for (const s of sections) if (window.scrollY + vh * 0.45 >= s.top) active = s.id;
      if (useUI.getState().activeSection !== active) useUI.getState().setActiveSection(active);
    };

    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', measure);
    // fonts can shift layout after load
    document.fonts?.ready.then(measure).catch(() => undefined);
    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', measure);
      cancelAnimationFrame(raf);
    };
  }, []);
}

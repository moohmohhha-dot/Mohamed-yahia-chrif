import { useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { hotspots, materialsDetails, story, type StoryChapter } from '../data/product';
import { useUI } from '../lib/store';
import { audio } from '../lib/audio';
import SplitWords from './SplitWords';
import ColorSelector from './ColorSelector';

function ChapterCopy({ chapter, children }: { chapter: StoryChapter; children?: React.ReactNode }) {
  return (
    <div className={`copy copy--${chapter.align}`}>
      <p className="copy__kicker js-fade">
        <span className="copy__index">{chapter.index}</span>
        {chapter.kicker}
      </p>
      <SplitWords as="h2" text={chapter.headline} className="copy__title js-words" id={`${chapter.id}-title`} />
      <p className="copy__body js-fade">{chapter.body}</p>
      {children}
      {chapter.note && <p className="copy__note js-fade">{chapter.note}</p>}
    </div>
  );
}

function Ghost({ word }: { word: string }) {
  return (
    <span className="ghost js-ghost" aria-hidden="true">
      {word}
    </span>
  );
}

function Chapter({ chapter, children, className = '' }: { chapter: StoryChapter; children?: React.ReactNode; className?: string }) {
  return (
    <section
      id={chapter.id}
      data-section={chapter.id}
      data-kf={chapter.id}
      className={`chapter chapter--${chapter.id} ${className}`}
      aria-labelledby={`${chapter.id}-title`}
    >
      <Ghost word={chapter.ghost} />
      <ChapterCopy chapter={chapter}>{children}</ChapterCopy>
    </section>
  );
}

function FeatureChips() {
  const active = useUI((s) => s.activeHotspot);
  const setActive = useUI((s) => s.setActiveHotspot);
  const camera = hotspots.filter((h) => h.normal[2] < 0);
  return (
    <ul className="chips js-fade" aria-label="Camera feature highlights">
      {camera.map((h) => (
        <li key={h.id}>
          <button
            type="button"
            className={`chip${active === h.id ? ' is-active' : ''}`}
            aria-pressed={active === h.id}
            onClick={() => {
              audio.tick(0, 1.1);
              setActive(active === h.id ? null : h.id);
            }}
          >
            <span className="chip__dot" aria-hidden="true" />
            {h.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

function Materials() {
  const c = story.materials;
  return (
    <section
      id="materials"
      data-section="materials"
      className="chapter chapter--materials"
      aria-labelledby="materials-title"
    >
      <span className="kf-marker" data-kf="materials-lens" style={{ top: '30%' }} aria-hidden="true" />
      <span className="kf-marker" data-kf="materials-edge" style={{ top: '72%' }} aria-hidden="true" />
      <div className="sticky">
        <Ghost word={c.ghost} />
        <ChapterCopy chapter={c}>
          <ol className="details js-fade">
            {materialsDetails.map((d, i) => (
              <li key={d.id} className="details__item js-detail" data-i={i}>
                <span className="details__label">{d.label}</span>
                <span className="details__text">{d.text}</span>
              </li>
            ))}
          </ol>
        </ChapterCopy>
      </div>
    </section>
  );
}

export default function ScrollStory() {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.utils.toArray<HTMLElement>('.js-words').forEach((el) => {
          gsap.from(el.querySelectorAll('.split__word'), {
            yPercent: 115,
            rotate: 4,
            opacity: 0,
            duration: 1.15,
            stagger: 0.055,
            ease: 'expo.out',
            scrollTrigger: { trigger: el, start: 'top 82%', toggleActions: 'play none none reverse' },
          });
        });
        gsap.utils.toArray<HTMLElement>('.js-fade').forEach((el) => {
          gsap.from(el, {
            opacity: 0,
            y: 26,
            duration: 1,
            ease: 'power3.out',
            scrollTrigger: { trigger: el, start: 'top 88%', toggleActions: 'play none none reverse' },
          });
        });
        // oversized ghost typography travels with scroll progress
        gsap.utils.toArray<HTMLElement>('.js-ghost').forEach((el) => {
          gsap.fromTo(
            el,
            { xPercent: 10, opacity: 0 },
            {
              xPercent: -14,
              opacity: 1,
              ease: 'none',
              scrollTrigger: { trigger: el.closest('section'), start: 'top bottom', end: 'bottom top', scrub: 0.6 },
            },
          );
        });
      });

      // materials detail list highlights in step with the macro shots
      const details = gsap.utils.toArray<HTMLElement>('.js-detail');
      gsap.timeline({
        scrollTrigger: {
          trigger: '#materials',
          start: 'top top',
          end: 'bottom bottom',
          onUpdate: (self) => {
            const idx = Math.min(details.length - 1, Math.floor(self.progress * details.length));
            details.forEach((d, i) => d.classList.toggle('is-active', i === idx));
          },
        },
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  return (
    <div ref={root} className="story">
      <Chapter chapter={story.silhouette} />
      <Chapter chapter={story.display}>
        <div className="display-meter js-fade" aria-hidden="true">
          <span>LIGHT</span>
          <i />
          <span>DEPTH</span>
          <i />
          <span>MOTION</span>
        </div>
      </Chapter>
      <Chapter chapter={story.camera}>
        <FeatureChips />
      </Chapter>
      <Materials />
      <Chapter chapter={story.studio}>
        <div className="js-fade">
          <ColorSelector size="large" id="studio-finish" />
        </div>
      </Chapter>
      <Chapter chapter={story.reveal} />
    </div>
  );
}

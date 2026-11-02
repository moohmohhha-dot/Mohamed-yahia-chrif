import { useUI } from '../lib/store';
import { scrollToSection } from '../lib/scroll';

const chapters = [
  { id: 'hero', label: 'Experience' },
  { id: 'silhouette', label: 'Silhouette' },
  { id: 'display', label: 'Display' },
  { id: 'camera', label: 'Camera' },
  { id: 'materials', label: 'Materials' },
  { id: 'studio', label: 'Color Studio' },
  { id: 'reveal', label: 'Reveal' },
  { id: 'creator', label: 'Creator' },
  { id: 'final', label: 'Finale' },
];

/** Top progress hairline + vertical chapter indicator. */
export default function ScrollProgress() {
  const active = useUI((s) => s.activeSection);
  const index = Math.max(0, chapters.findIndex((c) => c.id === active));

  return (
    <>
      <div className="progress" aria-hidden="true">
        <span className="progress__bar" />
      </div>
      <nav className="chapters" aria-label="Chapters">
        <span className="chapters__count" aria-hidden="true">
          {String(index + 1).padStart(2, '0')} <i>/</i> {String(chapters.length).padStart(2, '0')}
        </span>
        <ol>
          {chapters.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={`chapters__dot${c.id === active ? ' is-active' : ''}`}
                aria-label={`Go to ${c.label}`}
                aria-current={c.id === active ? 'step' : undefined}
                onClick={() => scrollToSection(c.id)}
              >
                <span className="chapters__label">{c.label}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
    </>
  );
}

import { useEffect, useRef } from 'react';
import { hotspots } from '../data/product';
import { useUI } from '../lib/store';

/** Concise feature explanation opened from a 3D hotspot or a feature chip. */
export default function HotspotPanel() {
  const activeId = useUI((s) => s.activeHotspot);
  const setActive = useUI((s) => s.setActiveHotspot);
  const section = useUI((s) => s.activeSection);
  const closeRef = useRef<HTMLButtonElement>(null);
  const hotspot = hotspots.find((h) => h.id === activeId);

  useEffect(() => {
    if (!activeId) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setActive(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeId, setActive]);

  // close when the visitor moves to another chapter
  useEffect(() => {
    setActive(null);
  }, [section, setActive]);

  return (
    <aside className={`panel${hotspot ? ' is-open' : ''}`} aria-live="polite" aria-hidden={!hotspot}>
      {hotspot && (
        <div className="panel__inner" role="dialog" aria-labelledby="panel-title">
          <span className="panel__kicker">FEATURE · {hotspot.label.toUpperCase()}</span>
          <h3 id="panel-title" className="panel__title">{hotspot.title}</h3>
          <p className="panel__body">{hotspot.body}</p>
          <p className="panel__note">Conceptual highlight — not an official specification.</p>
          <button ref={closeRef} type="button" className="panel__close" onClick={() => setActive(null)} aria-label="Close feature details">
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}
    </aside>
  );
}

import { hotspots } from '../data/product';
import { useUI } from '../lib/store';
import { audio } from '../lib/audio';
import { hotspotElements as elements } from './hotspotRegistry';

export function HotspotLayer() {
  const activeId = useUI((s) => s.activeHotspot);
  const setActive = useUI((s) => s.setActiveHotspot);

  return (
    <div className="hotspots" aria-label="3D feature hotspots">
      {hotspots.map((h) => {
        const active = activeId === h.id;
        return (
          <button
            key={h.id}
            ref={(el) => {
              if (el) elements.set(h.id, el);
              else elements.delete(h.id);
            }}
            type="button"
            className={`hotspot${active ? ' is-active' : ''}`}
            data-visible="false"
            tabIndex={-1}
            aria-hidden="true"
            aria-label={`Feature: ${h.label}. Open details`}
            onPointerEnter={() => audio.tick(0, 1.4)}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              audio.tick(0, 1);
              setActive(active ? null : h.id);
            }}
          >
            <span className="hotspot__dot" aria-hidden="true" />
            <span className="hotspot__label">{h.label}</span>
          </button>
        );
      })}
    </div>
  );
}

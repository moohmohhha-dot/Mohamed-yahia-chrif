import { useEffect } from 'react';
import { brand, navigation } from '../data/product';
import { useUI } from '../lib/store';
import { audio } from '../lib/audio';
import { scrollToSection } from '../lib/scroll';

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`wordmark ${className}`} aria-label={brand.name}>
      {brand.name.split('').map((c, i) => (
        <span key={i} aria-hidden="true">{c}</span>
      ))}
    </span>
  );
}

export default function Navigation() {
  const soundOn = useUI((s) => s.soundOn);
  const toggleSound = useUI((s) => s.toggleSound);
  const menuOpen = useUI((s) => s.menuOpen);
  const setMenuOpen = useUI((s) => s.setMenuOpen);
  const introDone = useUI((s) => s.introDone);
  const active = useUI((s) => s.activeSection);

  useEffect(() => {
    if (soundOn) audio.enable();
    else audio.disable();
  }, [soundOn]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen, setMenuOpen]);

  const go = (id: string) => {
    setMenuOpen(false);
    audio.tick(0, 1);
    scrollToSection(id);
  };

  const isCurrent = (target: string) =>
    target === active || (target === 'camera' && active === 'display') || (target === 'materials' && active === 'studio');

  return (
    <header className={`nav${introDone ? ' is-ready' : ''}${menuOpen ? ' is-open' : ''}`}>
      <button type="button" className="nav__brand" onClick={() => go('hero')} aria-label="MOHAMED — back to the start">
        <Wordmark />
      </button>

      <nav className="nav__links" aria-label="Primary">
        {navigation.map((item) => (
          <button
            key={item.target}
            type="button"
            className={`nav__link${isCurrent(item.target) ? ' is-active' : ''}`}
            onClick={() => go(item.target)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="nav__tools">
        <button
          type="button"
          className={`sound${soundOn ? ' is-on' : ''}`}
          onClick={toggleSound}
          aria-pressed={soundOn}
          aria-label={soundOn ? 'Turn sound off' : 'Turn sound on'}
        >
          <span className="sound__bars" aria-hidden="true">
            <i /> <i /> <i /> <i />
          </span>
          <span className="sound__label">SOUND {soundOn ? 'ON' : 'OFF'}</span>
        </button>
        <button
          type="button"
          className="nav__menu"
          aria-expanded={menuOpen}
          aria-controls="mobile-menu"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <span aria-hidden="true" />
          <span aria-hidden="true" />
        </button>
      </div>

      <div id="mobile-menu" className="menu" hidden={!menuOpen}>
        <ul>
          {navigation.map((item, i) => (
            <li key={item.target} style={{ ['--i' as string]: i }}>
              <button type="button" onClick={() => go(item.target)}>
                <span className="menu__index">0{i + 1}</span>
                {item.label}
              </button>
            </li>
          ))}
        </ul>
        <p className="menu__note">{brand.disclaimer}</p>
      </div>
    </header>
  );
}

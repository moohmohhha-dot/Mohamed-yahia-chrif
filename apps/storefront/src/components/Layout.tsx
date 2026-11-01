import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, DEMO, qs, STORE, type AiState, type Suggestions } from '../api';
import { LOCALES, useI18n, type Locale } from '../i18n';
import { useLoad, useShop } from '../store';
import { Assistant } from './Assistant';

function SearchBox() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [s, setS] = useState<Suggestions | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) return setS(null);
    const timer = setTimeout(() => {
      void api<Suggestions>('GET', `/v1/stores/${STORE}/search/suggest?${qs({ q: q.trim(), locale })}`).then(setS, () => setS(null));
    }, 180);
    return () => clearTimeout(timer);
  }, [q, locale]);
  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };
  const has = s && (s.completions.length || s.products.length || s.brands.length || s.categories.length || s.queries.length);
  return (
    <form
      className="search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim()) go(`/shop?${qs({ q: q.trim() })}`);
      }}
    >
      <input
        id="site-search"
        type="search"
        value={q}
        placeholder={t('search.placeholder')}
        aria-label={t('search.label')}
        autoComplete="off"
        onChange={(e) => (setQ(e.target.value), setOpen(true))}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      <button type="submit" className="icon-btn" aria-label={t('search.label')}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="m20 20-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      {open && has ? (
        <div className="suggest" data-testid="suggestions">
          {[...new Set([...s!.completions, ...s!.queries])].slice(0, 4).map((c) => (
            <button type="button" key={`c-${c}`} onMouseDown={() => go(`/shop?${qs({ q: c })}`)}>
              <span className="muted">⌕</span> {c}
            </button>
          ))}
          {s!.products.slice(0, 4).map((p) => (
            <button type="button" key={`p-${p.slug}`} onMouseDown={() => go(`/p/${p.slug}`)}>
              {p.name} <span className="muted small">{t('search.product')}</span>
            </button>
          ))}
          {s!.brands.slice(0, 2).map((b) => (
            <button type="button" key={`b-${b.slug}`} onMouseDown={() => go(`/shop?${qs({ brand: b.slug })}`)}>
              {b.name} <span className="muted small">{t('search.brand')}</span>
            </button>
          ))}
          {s!.categories.slice(0, 2).map((c) => (
            <button type="button" key={`k-${c.slug}`} onMouseDown={() => go(`/shop?${qs({ category: c.slug })}`)}>
              {c.name} <span className="muted small">{t('search.category')}</span>
            </button>
          ))}
        </div>
      ) : null}
    </form>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { t, locale, setLocale } = useI18n();
  const { count, user, toast } = useShop();
  const location = useLocation();
  const main = useRef<HTMLElement>(null);
  const ai = useLoad(() => api<AiState>('GET', `/v1/stores/${STORE}/ai`), []);
  useEffect(() => {
    window.scrollTo(0, 0);
    main.current?.scrollTo?.(0, 0);
  }, [location.pathname]);
  return (
    <div className="site">
      {DEMO && (
        <div className="demo-bar" data-testid="demo-bar">
          {t('demo.banner')}
        </div>
      )}
      <header className="header">
        <div className="header-row">
          <Link to="/" className="logo" aria-label="MB Parfum">
            <span className="logo-mark">MB</span>
            <span className="logo-text">
              PARFUM<small>by ARUMA</small>
            </span>
          </Link>
          <SearchBox />
          <div className="header-actions">
            <select aria-label={t('common.language')} value={locale} onChange={(e) => setLocale(e.target.value as Locale)} className="lang">
              {LOCALES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
            <Link to="/account" className="header-link">
              {user ? user.displayName.split(' ')[0] : t('nav.account')}
            </Link>
            <Link to="/cart" className="cart-link" aria-label={t('nav.cart')}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M6 7h12l-1 13H7L6 7Z M9 7a3 3 0 0 1 6 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              </svg>
              {count > 0 && (
                <span className="badge" data-testid="cart-count">
                  {count}
                </span>
              )}
            </Link>
          </div>
        </div>
        <nav className="nav">
          {(
            [
              ['/', 'nav.home'],
              ['/shop', 'nav.shop'],
              ['/shop?gender=women', 'nav.women'],
              ['/shop?gender=men', 'nav.men'],
              ['/gifts', 'nav.gifts'],
              ['/compare', 'nav.compare'],
            ] as const
          ).map(([to, key]) => {
            // Women / Men are the shop with a filter: only one menu entry is lit at a time.
            const here = location.pathname + location.search;
            const active = to.includes('?') ? here === to : to === '/shop' ? location.pathname === '/shop' && !/gender=(women|men)/.test(location.search) : location.pathname === to;
            return (
              <Link key={to} to={to} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
                {t(key)}
              </Link>
            );
          })}
        </nav>
      </header>
      <main ref={main} className="main">
        {children}
      </main>
      <footer className="footer">
        <div className="trust">
          <div>
            <strong>{t('trust.cod')}</strong>
            <span>{t('trust.codText')}</span>
          </div>
          <div>
            <strong>{t('trust.delivery')}</strong>
            <span>{t('trust.deliveryText')}</span>
          </div>
          <div>
            <strong>{t('trust.returns')}</strong>
            <span>{t('trust.returnsText')}</span>
          </div>
          <div>
            <strong>{t('trust.genuine')}</strong>
            <span>{t('trust.genuineText')}</span>
          </div>
        </div>
        <p className="muted small">© 2026 MB Parfum · {t('footer.operated')}</p>
      </footer>
      {toast && (
        <div className="toast" role="status" data-testid="toast">
          {toast}
        </div>
      )}
      {ai.data?.assistant && <Assistant />}
    </div>
  );
}

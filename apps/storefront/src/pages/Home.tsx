import { Link } from 'react-router-dom';
import { api, qs, STORE, type Category, type SearchResult } from '../api';
import { Bottle } from '../components/Bottle';
import { Grid, Loading, Section } from '../components/ui';
import { useI18n } from '../i18n';
import { useLoad } from '../store';

export function HomePage() {
  const { t, tx, locale } = useI18n();
  const popular = useLoad(() => api<SearchResult>('GET', `/v1/stores/${STORE}/search?${qs({ sort: 'popular', pageSize: 8, locale })}`), [locale]);
  const newest = useLoad(() => api<SearchResult>('GET', `/v1/stores/${STORE}/search?${qs({ sort: 'newest', pageSize: 4, locale })}`), [locale]);
  const categories = useLoad(() => api<Category[]>('GET', `/v1/stores/${STORE}/categories?${qs({ locale })}`), [locale]);
  const hero = popular.data?.results.slice(0, 3) ?? [];

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">{t('home.eyebrow')}</span>
          <h1>{t('home.title')}</h1>
          <p className="lead">{t('home.lead')}</p>
          <div className="row">
            <Link to="/shop" className="btn btn-primary btn-lg">
              {t('home.shopAll')}
            </Link>
            <Link to="/gifts" className="btn btn-ghost btn-lg">
              {t('home.findGift')}
            </Link>
          </div>
        </div>
        <div className="hero-art" aria-hidden="true">
          {(hero.length ? hero.map((p) => p.slug) : ['a', 'b', 'c']).map((seed, i) => (
            <div key={seed} className={`hero-bottle hero-bottle-${i}`}>
              <Bottle seed={seed} label={hero[i]?.brand} size="lg" />
            </div>
          ))}
        </div>
      </section>

      <Section title={t('home.families')}>
        <div className="families">
          {categories.data?.map((c) => (
            <Link key={c.slug} to={`/shop?${qs({ category: c.slug })}`} className={`family family-${c.slug}`}>
              <span className="family-name">{c.name}</span>
              <span className="family-hint">{tx(`family.${c.slug}`, 'family.default')}</span>
            </Link>
          ))}
          <Link to="/shop?gender=women" className="family family-women">
            <span className="family-name">{t('nav.women')}</span>
            <span className="family-hint">{t('family.women')}</span>
          </Link>
          <Link to="/shop?gender=men" className="family family-men">
            <span className="family-name">{t('nav.men')}</span>
            <span className="family-hint">{t('family.men')}</span>
          </Link>
        </div>
      </Section>

      <Section
        title={t('home.bestSellers')}
        action={
          <Link to="/shop?sort=popular" className="link">
            {t('common.seeAll')}
          </Link>
        }
      >
        {popular.data ? <Grid products={popular.data.results} /> : <Loading />}
      </Section>

      <section className="gift-band">
        <div>
          <span className="eyebrow">{t('gift.eyebrow')}</span>
          <h2>{t('gift.bandTitle')}</h2>
          <p>{t('gift.bandText')}</p>
        </div>
        <Link to="/gifts" className="btn btn-primary btn-lg">
          {t('home.findGift')}
        </Link>
      </section>

      <Section title={t('home.new')}>{newest.data ? <Grid products={newest.data.results} /> : <Loading />}</Section>
    </>
  );
}

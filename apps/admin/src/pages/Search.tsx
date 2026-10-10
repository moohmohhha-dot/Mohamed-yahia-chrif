import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Card, Empty, ErrorBox, Field, Kv, Loading, useAction, useLoad } from '../components/ui';
import { useI18n } from '../i18n';

const DAYS = 30;
type Status = { documents: number; visible: number; queued: number; lastIndexedAt: string | null };
type QueryRow = { query: string; count: number; lastResults: number };
type Analytics = { totals: { searches: number; zero: number; voice: number }; topQueries: QueryRow[]; zeroResults: QueryRow[] };
type Synonym = { id: string; storeId: string | null; terms: string[]; createdAt: string };
type Store = { id: string; slug: string; name: string };

/** Search: index health, what customers search (and do not find), and synonyms across Arabic, French and English. */
export function SearchPage() {
  const { t, date } = useI18n();
  const { can } = useAuth();
  const manage = can('search.manage');
  const status = useLoad(() => api<Status>('GET', '/v1/admin/search/status'), []);
  const stats = useLoad(() => api<Analytics>('GET', `/v1/admin/search/analytics?days=${DAYS}`), []);
  const synonyms = useLoad(() => (manage ? api<Synonym[]>('GET', '/v1/admin/search/synonyms') : Promise.resolve([])), [manage]);
  const stores = useLoad(() => (manage ? api<Store[]>('GET', '/v1/admin/stores') : Promise.resolve([])), [manage]);
  const [terms, setTerms] = useState('');
  const [storeId, setStoreId] = useState('');
  const [queued, setQueued] = useState<number | null>(null);
  const add = useAction();
  const reindex = useAction();
  const remove = useAction();
  const storeName = (id: string | null) => (id ? (stores.data?.find((s) => s.id === id)?.name ?? id) : t('search.allStores'));

  const queries = (rows: QueryRow[], testId: string) =>
    rows.length === 0 ? (
      <Empty />
    ) : (
      <table data-testid={testId}>
        <thead>
          <tr>
            <th>{t('search.query')}</th>
            <th className="num">{t('search.count')}</th>
            <th className="num">{t('search.lastResults')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.query}>
              <td>{r.query}</td>
              <td className="num">{r.count}</td>
              <td className="num">{r.lastResults}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );

  return (
    <>
      <h1>{t('section.search')}</h1>
      <p className="muted">{t('search.intro')}</p>

      <Card title={t('search.index')}>
        <ErrorBox error={status.error} />
        {!status.data ? (
          <Loading />
        ) : (
          <div data-testid="search-status">
            <Kv
              rows={[
                [t('search.documents'), status.data.documents],
                [t('search.visible'), status.data.visible],
                [t('search.queued'), status.data.queued],
                [t('search.lastIndexed'), status.data.lastIndexedAt ? date(status.data.lastIndexedAt) : '—'],
              ]}
            />
          </div>
        )}
        {manage && (
          <div className="row">
            <button
              disabled={reindex.pending}
              onClick={() =>
                void reindex.run(async () => {
                  setQueued((await api<{ queued: number }>('POST', '/v1/admin/search/reindex', {})).queued);
                  await status.reload();
                })
              }
            >
              {t('search.reindex')}
            </button>
            {queued !== null && <span className="muted small">{t('search.reindexed', { n: queued })}</span>}
          </div>
        )}
        <ErrorBox error={reindex.error} />
        <p className="muted small">{t('search.reindexHint')}</p>
      </Card>

      <Card title={t('search.statsTitle', { n: DAYS })}>
        <ErrorBox error={stats.error} />
        {!stats.data ? (
          <Loading />
        ) : (
          <>
            <div className="row" data-testid="search-totals">
              <span className="pill">
                {t('search.searches')}: <strong>{stats.data.totals.searches}</strong>
              </span>
              <span className="pill">
                {t('search.zero')}: <strong>{stats.data.totals.zero}</strong>
              </span>
              <span className="pill">
                {t('search.voice')}: <strong>{stats.data.totals.voice}</strong>
              </span>
            </div>
            <h3>{t('search.top')}</h3>
            {queries(stats.data.topQueries, 'top-queries')}
            <h3>{t('search.zeroTitle')}</h3>
            <p className="muted small">{t('search.zeroHint')}</p>
            {queries(stats.data.zeroResults, 'zero-queries')}
          </>
        )}
      </Card>

      {manage && (
        <Card title={t('search.synonyms')}>
          <p className="muted small" style={{ marginTop: 0 }}>
            {t('search.synonymsHint')}
          </p>
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              const list = terms.split(/[,،]/).map((w) => w.trim()).filter(Boolean);
              void add
                .run(() => api('POST', '/v1/admin/search/synonyms', { terms: list, ...(storeId ? { storeId } : {}) }))
                .then((ok) => ok && (setTerms(''), void synonyms.reload()));
            }}
          >
            <Field label={t('search.terms')} hint={t('search.termsHint')}>
              <input value={terms} onChange={(e) => setTerms(e.target.value)} required data-testid="synonym-terms" />
            </Field>
            <Field label={t('search.scope')}>
              <select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                <option value="">{t('search.allStores')}</option>
                {stores.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <div>
              <button className="primary" disabled={add.pending}>
                {t('search.add')}
              </button>
            </div>
          </form>
          <ErrorBox error={add.error ?? remove.error ?? synonyms.error} />
          {!synonyms.data ? (
            <Loading />
          ) : (
            <table data-testid="synonyms">
              <tbody>
                {synonyms.data.map((g) => (
                  <tr key={g.id}>
                    <td>
                      {g.terms.map((w) => (
                        <span key={w} className="pill">
                          {w}
                        </span>
                      ))}
                    </td>
                    <td className="small muted">{storeName(g.storeId)}</td>
                    <td>
                      <button className="danger" disabled={remove.pending} onClick={() => void remove.run(() => api('DELETE', `/v1/admin/search/synonyms/${g.id}`)).then(() => synonyms.reload())}>
                        {t('search.remove')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </>
  );
}

import { useState } from 'react';
import { api } from '../api';
import { Card, ErrorBox, Field, Loading, useAction, useLoad } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { can, useMerchant } from '../merchant-context';
import { nameIn } from './common';

type Summary = { count: number; average: number | null; distribution: Record<'1' | '2' | '3' | '4' | '5', number> };
type Review = {
  id: string;
  type: 'product' | 'merchant';
  productNames: Record<string, string> | null;
  rating: number;
  title: string | null;
  body: string | null;
  author: string | null;
  verifiedPurchase: boolean;
  helpfulCount: number;
  merchantReply: string | null;
  reported: 'open' | 'upheld' | 'dismissed' | null;
  publishedAt: string;
};
type Data = { merchantRating: Summary; productRating: { count: number; average: number | null }; reviews: Review[] };

const REPORT_REASONS = ['fake', 'spam', 'offensive', 'personal_info', 'off_topic', 'conflict_of_interest', 'other'] as const;

export const Stars = ({ value }: { value: number }) => (
  <span aria-label={`${value} / 5`} style={{ color: '#c58b00', letterSpacing: 1 }}>
    {'★'.repeat(Math.round(value))}
    <span style={{ opacity: 0.3 }}>{'★'.repeat(5 - Math.round(value))}</span>
  </span>
);

/** What buyers say about the merchant and its products; public replies and reports (ARUMA moderates). */
export function ReviewsPage() {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const [type, setType] = useState<'' | 'product' | 'merchant'>('');
  const data = useLoad(() => api<Data>('GET', `/v1/merchants/${merchant.id}/reviews${type ? `?type=${type}` : ''}`), [merchant.id, type]);
  const fmt = (v: number | null) => (v === null ? '—' : v.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }));

  return (
    <>
      <h1>{t('section.reviews')}</h1>
      <p className="muted">{t('reviews.intro')}</p>
      <ErrorBox error={data.error} />
      {!data.data ? (
        <Loading />
      ) : (
        <>
          <div className="form-grid">
            <Card title={t('reviews.sellerRating')}>
              <p style={{ margin: 0, fontSize: '1.6em' }} data-testid="seller-rating">
                {fmt(data.data.merchantRating.average)} <Stars value={data.data.merchantRating.average ?? 0} />
              </p>
              <p className="muted small">{t('reviews.count', { count: data.data.merchantRating.count })}</p>
              <table>
                <tbody>
                  {(['5', '4', '3', '2', '1'] as const).map((k) => (
                    <tr key={k}>
                      <td className="small">{k} ★</td>
                      <td className="num small">{data.data!.merchantRating.distribution[k]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title={t('reviews.productsRating')}>
              <p style={{ margin: 0, fontSize: '1.6em' }}>
                {fmt(data.data.productRating.average)} <Stars value={data.data.productRating.average ?? 0} />
              </p>
              <p className="muted small">{t('reviews.count', { count: data.data.productRating.count })}</p>
            </Card>
          </div>
          <div className="row" style={{ margin: '12px 0' }}>
            {(['', 'product', 'merchant'] as const).map((k) => (
              <button key={k || 'all'} className={type === k ? 'primary' : ''} onClick={() => setType(k)}>
                {k ? t(`reviews.type.${k}` as MessageKey) : t('orders.all')}
              </button>
            ))}
          </div>
          {data.data.reviews.length === 0 ? (
            <p className="muted">{t('reviews.empty')}</p>
          ) : (
            data.data.reviews.map((r) => <ReviewCard key={r.id} review={r} onDone={() => void data.reload()} />)
          )}
        </>
      )}
    </>
  );
}

function ReviewCard({ review: r, onDone }: { review: Review; onDone: () => void }) {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const manage = can(merchant.role, 'manageTeam');
  const [reply, setReply] = useState(r.merchantReply ?? '');
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<'reply' | 'report' | null>(null);
  const action = useAction();
  const base = `/v1/merchants/${merchant.id}/reviews/${r.id}`;
  const send = (fn: () => Promise<unknown>) =>
    action.run(async () => {
      await fn();
      setMode(null);
      onDone();
    });

  return (
    <div data-testid={`review-${r.id}`}>
      <Card
        title={
          <span className="row">
            <Stars value={r.rating} /> {r.title && <strong>{r.title}</strong>}
          </span>
        }
        actions={<span className="muted small">{new Date(r.publishedAt).toLocaleDateString(locale)}</span>}
      >
        <p className="small muted" style={{ margin: 0 }}>
          {r.type === 'product' ? nameIn(r.productNames ?? {}, locale) : t('reviews.type.merchant')} · {r.author}
          {r.verifiedPurchase && <span className="badge badge-good" style={{ marginInlineStart: 6 }}>{t('reviews.verified')}</span>}
          {r.helpfulCount > 0 && <> · {t('reviews.helpful', { count: r.helpfulCount })}</>}
        </p>
        {r.body && <p style={{ whiteSpace: 'pre-wrap' }}>{r.body}</p>}
        {r.merchantReply && mode !== 'reply' && (
          <blockquote className="small" style={{ borderInlineStart: '3px solid var(--border)', margin: 0, paddingInlineStart: 10 }}>
            <strong>{t('reviews.yourReply')}</strong> {r.merchantReply}
          </blockquote>
        )}
        {r.reported && <p className="small muted">{t(`reviews.reported.${r.reported}` as MessageKey)}</p>}
        {manage && (
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={() => setMode(mode === 'reply' ? null : 'reply')}>{r.merchantReply ? t('reviews.editReply') : t('reviews.reply')}</button>
            {!r.reported && (
              <button className="danger" onClick={() => setMode(mode === 'report' ? null : 'report')}>
                {t('reviews.report')}
              </button>
            )}
          </div>
        )}
        {mode === 'reply' && (
          <form
            className="stack"
            style={{ marginTop: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              void send(() => api('POST', `${base}/reply`, { text: reply.trim() }));
            }}
          >
            <Field label={t('reviews.publicReply')} hint={t('reviews.replyRules')}>
              <textarea required minLength={2} maxLength={1000} rows={3} value={reply} onChange={(e) => setReply(e.target.value)} />
            </Field>
            <div>
              <button className="primary" disabled={action.pending}>
                {t('reviews.publishReply')}
              </button>
            </div>
          </form>
        )}
        {mode === 'report' && (
          <form
            className="row"
            style={{ marginTop: 8, alignItems: 'flex-end' }}
            onSubmit={(e) => {
              e.preventDefault();
              void send(() => api('POST', `${base}/report`, { reason }));
            }}
          >
            <Field label={t('reviews.reportReason')} hint={t('reviews.reportRules')}>
              <select required value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="" />
                {REPORT_REASONS.map((x) => (
                  <option key={x} value={x}>
                    {t(`reportReason.${x}` as MessageKey)}
                  </option>
                ))}
              </select>
            </Field>
            <button className="danger" disabled={action.pending}>
              {t('reviews.sendReport')}
            </button>
          </form>
        )}
        <ErrorBox error={action.error} />
      </Card>
    </div>
  );
}

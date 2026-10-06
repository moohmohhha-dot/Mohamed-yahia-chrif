import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Badge, Card, Empty, ErrorBox, Kv, Loading, Pager, ReasonAction, Tabs, useLoad } from '../components/ui';
import { useI18n } from '../i18n';

const STATUSES = ['pending', 'published', 'rejected', 'hidden', 'withdrawn'] as const;
const PAGE = 50;
type Review = { id: string; type: string; rating: number; title: string | null; body: string | null; status: string; flags: { code: string; detail?: string }[]; reportCount: number; helpfulCount: number; verifiedPurchase: boolean; moderationNote: string | null; createdAt: string };
type ReviewDetail = Review & {
  author: { displayName?: string; publicName?: string } & Record<string, unknown>;
  merchantReply: string | null;
  reports: { reason: string; note: string | null; status: string; createdAt: string }[];
  events: { type: string; actorType: string; note: string | null; createdAt: string }[];
};
const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);

/** Moderation queue: reviews held by the automatic checks or reported by buyers. */
export function ReviewsPage() {
  const { t, label, date } = useI18n();
  const [params, setParams] = useSearchParams();
  const selected = params.get('id');
  const [status, setStatus] = useState<(typeof STATUSES)[number] | ''>('pending');
  const [reported, setReported] = useState(false);
  const [page, setPage] = useState(1);
  const list = useLoad(() => api<Review[]>('GET', `/v1/admin/reviews?page=${page}&pageSize=${PAGE}${status ? `&status=${status}` : ''}${reported ? '&reported=true' : ''}`), [status, reported, page, selected]);
  if (selected) return <ReviewView reviewId={selected} onBack={() => setParams({})} />;
  return (
    <>
      <h1>{t('section.reviews')}</h1>
      <Tabs value={status} options={STATUSES} onChange={(v) => (setStatus(v), setPage(1))} prefix="reviewStatus" allLabel="common.all" />
      <label className="row small" style={{ marginBottom: 12 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={reported} onChange={(e) => (setReported(e.target.checked), setPage(1))} /> {t('reviews.reportedOnly')}
      </label>
      <ErrorBox error={list.error} />
      {!list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <Empty />
      ) : (
        <Card>
          <table>
            <tbody>
              {list.data.map((r) => (
                <tr key={r.id}>
                  <td style={{ color: '#c58b00' }}>{stars(r.rating)}</td>
                  <td>
                    <button className="link" onClick={() => setParams({ id: r.id })}>
                      {r.title || (r.body ?? '').slice(0, 60) || label('reviewType', r.type)}
                    </button>
                    <div className="small">
                      {r.flags.map((f) => (
                        <span key={f.code} className="pill">
                          {label('reviewFlag', f.code)}
                        </span>
                      ))}
                      {r.reportCount > 0 && <span className="pill">{t('reviews.reports', { n: r.reportCount })}</span>}
                    </div>
                  </td>
                  <td className="small">{label('reviewType', r.type)}</td>
                  <td>
                    <Badge prefix="reviewStatus" value={r.status} />
                  </td>
                  <td className="small">{date(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={page} setPage={setPage} count={list.data.length} pageSize={PAGE} />
        </Card>
      )}
    </>
  );
}

function ReviewView({ reviewId, onBack }: { reviewId: string; onBack: () => void }) {
  const { t, label, date } = useI18n();
  const url = `/v1/admin/reviews/${reviewId}`;
  const review = useLoad(() => api<ReviewDetail>('GET', url), [url]);
  if (review.error) return <ErrorBox error={review.error} />;
  if (!review.data) return <Loading />;
  const r = review.data;
  const moderate = (action: string) => (note: string) => api('POST', `${url}/moderate`, { action, note }).then(() => review.reload());
  const actions: Record<string, string[]> = { pending: ['publish', 'reject'], published: ['hide'], hidden: ['restore'], rejected: ['publish'] };
  return (
    <>
      <div className="topbar">
        <h1 className="row">
          <span style={{ color: '#c58b00' }}>{stars(r.rating)}</span> <Badge prefix="reviewStatus" value={r.status} />
        </h1>
        <button className="link" onClick={onBack}>
          {t('reviews.back')}
        </button>
      </div>
      <div className="split">
        <Card title={r.title ?? label('reviewType', r.type)}>
          <p style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{r.body}</p>
          <Kv
            rows={[
              [t('reviews.author'), String(r.author.displayName ?? r.author.publicName ?? '—')],
              [t('reviews.verified'), r.verifiedPurchase ? t('common.yes') : t('common.no')],
              [t('reviews.flags'), r.flags.map((f) => `${label('reviewFlag', f.code)}${f.detail ? ` (${f.detail})` : ''}`).join(', ') || '—'],
              [t('reviews.helpful'), r.helpfulCount],
              [t('reviews.merchantReply'), r.merchantReply],
              [t('reviews.lastNote'), r.moderationNote],
            ]}
          />
          <div className="row" style={{ marginTop: 12 }}>
            {(actions[r.status] ?? []).map((a) => (
              <ReasonAction key={a} label={label('moderation', a)} danger={a === 'reject' || a === 'hide'} minLength={3} onConfirm={moderate(a)} />
            ))}
          </div>
        </Card>
        <Card title={t('reviews.reportsTitle')}>
          {r.reports.length === 0 ? (
            <Empty />
          ) : (
            <table>
              <tbody>
                {r.reports.map((rep, i) => (
                  <tr key={i}>
                    <td>{label('reportReason', rep.reason)}</td>
                    <td className="small muted">{rep.note}</td>
                    <td>
                      <Badge prefix="reportStatus" value={rep.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h3>{t('orders.history')}</h3>
          <table>
            <tbody>
              {r.events.map((e, i) => (
                <tr key={i}>
                  <td className="small">{date(e.createdAt)}</td>
                  <td className="small">{label('reviewEvent', e.type)}</td>
                  <td className="small">{label('actor', e.actorType)}</td>
                  <td className="small muted">{e.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}

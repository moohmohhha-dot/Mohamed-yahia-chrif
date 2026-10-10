import { useState } from 'react';
import { api, ApiError, money } from '../api';
import { Card, ErrorBox, Field, Loading, useAction, useLoad } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { can, useMerchant } from '../merchant-context';

type Totals = { orders: number; cancelled: number; returned: number; revenueMinor: number; units: number; averageOrderMinor: number };
type Insights = {
  currency: string;
  days: number;
  sales: {
    current: Totals;
    previous: Totals;
    change: { revenuePct: number | null; ordersPct: number | null };
    cancellationRatePct: number;
    byDay: { day: string; orders: number; revenueMinor: number }[];
    topProducts: { sku: string; name: string; units: number; revenueMinor: number }[];
  };
  demand: { offerId: string; sku: string; name: string; available: number; soldLast28Days: number; perDay: number; daysLeft: number | null; reorder: number; status: string }[];
  pricing: { offerId: string; sku: string; name: string; priceMinor: number; otherSellers: number; lowestOtherMinor: number | null; gapPct: number | null; position: string; suggestion: string | null }[];
  promotions: { offerId: string; sku: string; name: string; available: number; reason: string; ideas: string[] }[];
  analysis: { headline: string; points: string[]; actions: string[] } | null;
};
type AiState = { assistant: boolean; salesAnalysis: boolean; classification: boolean };

const STATUS_TONE: Record<string, string> = { out: 'bad', low: 'warn', overstock: 'warn', no_sales: 'muted', ok: 'good' };

/** Sales analysis, demand prediction, price positions and promotion ideas; AI writing and assistant when ARUMA switches them on. */
export function InsightsPage() {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const [days, setDays] = useState(30);
  const insights = useLoad(() => api<Insights>('GET', `/v1/merchants/${merchant.id}/insights?days=${days}&currency=DZD&locale=${locale}`), [merchant.id, days, locale]);
  const ai = useLoad(() => api<AiState>('GET', `/v1/merchants/${merchant.id}/ai`), [merchant.id]);
  const fmt = (minor: number) => money.format(minor, insights.data?.currency ?? 'DZD', locale);

  if (!can(merchant.role, 'manageTeam') || (insights.error instanceof ApiError && insights.error.status === 403)) {
    return (
      <>
        <h1>{t('section.analytics')}</h1>
        <p className="muted">{t('insights.ownersOnly')}</p>
      </>
    );
  }
  const d = insights.data;
  const max = d ? Math.max(1, ...d.sales.byDay.map((x) => x.revenueMinor)) : 1;
  return (
    <>
      <h1>{t('section.analytics')}</h1>
      <p className="muted">{t('insights.intro')}</p>
      <div className="row">
        <Field label={t('insights.period')}>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 30, 90].map((n) => (
              <option key={n} value={n}>
                {t('insights.daysN', { n })}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <ErrorBox error={insights.error} />
      {!d ? (
        <Loading />
      ) : (
        <>
          {d.analysis && (
            <Card title={t('ai.analysisTitle')}>
              <div data-testid="ai-analysis">
                <p>
                  <strong>{d.analysis.headline}</strong>
                </p>
                <ul>
                  {[...d.analysis.points, ...d.analysis.actions].map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
                <p className="muted small">{t('ai.byAi')}</p>
              </div>
            </Card>
          )}
          <div className="grid" data-testid="sales-totals">
            {(
              [
                ['insights.orders', String(d.sales.current.orders), d.sales.change.ordersPct],
                ['insights.revenue', fmt(d.sales.current.revenueMinor), d.sales.change.revenuePct],
                ['insights.units', String(d.sales.current.units), null],
                ['insights.average', fmt(d.sales.current.averageOrderMinor), null],
                ['insights.cancelRate', `${d.sales.cancellationRatePct} %`, null],
                ['insights.returned', String(d.sales.current.returned), null],
              ] as [MessageKey, string, number | null][]
            ).map(([label, value, change]) => (
              <div className="stat" key={label}>
                <div className="muted small">{t(label)}</div>
                <div className="value">{value}</div>
                {change !== null && <div className="muted small">{t('insights.vsPrevious', { n: change > 0 ? `+${change}` : change })}</div>}
              </div>
            ))}
          </div>
          <Card title={t('insights.byDay')}>
            <div className="bars" aria-hidden>
              {d.sales.byDay.map((x) => (
                <div key={x.day} className="bar" title={`${x.day}: ${fmt(x.revenueMinor)} · ${x.orders}`} style={{ height: `${Math.max(2, (x.revenueMinor / max) * 100)}%` }} />
              ))}
            </div>
          </Card>
          <Card title={t('insights.top')}>
            {d.sales.topProducts.length === 0 ? (
              <p className="muted">{t('insights.none')}</p>
            ) : (
              <table data-testid="top-products">
                <thead>
                  <tr>
                    <th>{t('insights.product')}</th>
                    <th className="num">{t('insights.sold')}</th>
                    <th className="num">{t('insights.revenue')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.sales.topProducts.map((p) => (
                    <tr key={p.sku}>
                      <td>
                        {p.name} <span className="muted small" dir="ltr">{p.sku}</span>
                      </td>
                      <td className="num">{p.units}</td>
                      <td className="num">{fmt(p.revenueMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card title={t('insights.stockTitle')}>
            <p className="muted small">{t('insights.stockHint')}</p>
            <table data-testid="stock-forecast">
              <thead>
                <tr>
                  <th>{t('insights.product')}</th>
                  <th className="num">{t('insights.available')}</th>
                  <th className="num">{t('insights.perDay')}</th>
                  <th className="num">{t('insights.daysLeft')}</th>
                  <th className="num">{t('insights.reorder')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {d.demand.map((x) => (
                  <tr key={x.offerId}>
                    <td>
                      {x.name} <span className="muted small" dir="ltr">{x.sku}</span>
                    </td>
                    <td className="num">{x.available}</td>
                    <td className="num">{x.perDay}</td>
                    <td className="num">{x.daysLeft ?? '—'}</td>
                    <td className="num">{x.reorder || '—'}</td>
                    <td>
                      <span className={`badge badge-${STATUS_TONE[x.status] ?? 'muted'}`}>{t(`insights.status.${x.status}` as MessageKey)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title={t('insights.pricesTitle')}>
            <p className="muted small">{t('insights.pricesHint')}</p>
            <table data-testid="price-positions">
              <thead>
                <tr>
                  <th>{t('insights.product')}</th>
                  <th className="num">{t('insights.yourPrice')}</th>
                  <th className="num">{t('insights.lowestOther')}</th>
                  <th className="num">{t('insights.gap')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.pricing.map((p) => (
                  <tr key={p.offerId}>
                    <td>
                      {p.name} <span className="muted small" dir="ltr">{p.sku}</span>
                    </td>
                    <td className="num">{fmt(p.priceMinor)}</td>
                    <td className="num">{p.lowestOtherMinor === null ? '—' : fmt(p.lowestOtherMinor)}</td>
                    <td className="num">{p.gapPct === null ? '—' : `${p.gapPct > 0 ? '+' : ''}${p.gapPct} %`}</td>
                    <td>
                      <span className={`badge badge-${p.position === 'above' ? 'warn' : 'good'}`}>{t(`insights.position.${p.position}` as MessageKey)}</span>
                      {p.suggestion && <div className="small">{t(`insights.suggestion.${p.suggestion}` as MessageKey)}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title={t('insights.promotionsTitle')}>
            <p className="muted small">{t('insights.promotionsHint')}</p>
            {d.promotions.length === 0 ? (
              <p className="muted">{t('insights.none')}</p>
            ) : (
              <ul data-testid="promotion-ideas">
                {d.promotions.map((p) => (
                  <li key={p.offerId}>
                    <strong>{p.name}</strong> — {t(`insights.reason.${p.reason}` as MessageKey)} ({t('insights.available')}: {p.available})
                    <div className="small">{p.ideas.map((i) => t(`insights.idea.${i}` as MessageKey)).join(' · ')}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
      {ai.data?.assistant && <Assistant />}
    </>
  );
}

/** The merchant assistant: shown only when ARUMA switched it on. Conversations stay in this page. */
function Assistant() {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [question, setQuestion] = useState('');
  const action = useAction();
  return (
    <Card title={t('ai.assistantTitle')}>
      <p className="muted small">{t('ai.assistantHint')}</p>
      <div className="stack" data-testid="assistant">
        {messages.map((m, i) => (
          <p key={i} className={m.role === 'user' ? 'muted' : ''}>
            <strong>{m.role === 'user' ? t('ai.you') : t('ai.assistantTitle')}:</strong> {m.content}
          </p>
        ))}
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const next = [...messages, { role: 'user' as const, content: question.trim() }].slice(-20);
          void action.run(async () => {
            const r = await api<{ reply: string }>('POST', `/v1/merchants/${merchant.id}/assistant`, { messages: next, locale, currency: 'DZD' });
            setMessages([...next, { role: 'assistant', content: r.reply }]);
            setQuestion('');
          });
        }}
      >
        <Field label={t('ai.question')}>
          <input required maxLength={2000} value={question} onChange={(e) => setQuestion(e.target.value)} />
        </Field>
        <button className="primary" disabled={action.pending}>
          {t('ai.ask')}
        </button>
      </form>
      <ErrorBox error={action.error} />
      <p className="muted small">{t('ai.byAi')}</p>
    </Card>
  );
}

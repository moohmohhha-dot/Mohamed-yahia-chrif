import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, download, money } from '../api';
import { Card, ErrorBox, Field, Loading, useAction, useLoad } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { can, useMerchant } from '../merchant-context';

const STATUSES = ['open', 'under_review', 'decided', 'appealed', 'resolved', 'withdrawn'] as const;
type Status = (typeof STATUSES)[number];
type Kind = 'customer_merchant' | 'merchant_customer' | 'merchant_aruma';
const tone: Record<Status, string> = { open: 'warn', under_review: 'warn', decided: 'warn', appealed: 'warn', resolved: 'good', withdrawn: 'muted' };
/** Mirrors the server's list (apps/core/src/modules/disputes/service.ts). */
const CATEGORIES: Record<'merchant_customer' | 'merchant_aruma', string[]> = {
  merchant_customer: ['false_claim', 'item_not_returned', 'returned_damaged', 'cod_refusal_abuse', 'abusive_behavior', 'other'],
  merchant_aruma: ['commission', 'fees', 'payout', 'settlement', 'account_status', 'review_moderation', 'other'],
};

type Summary = { id: string; number: string; kind: Kind; category: string; status: Status; side: 'claimant' | 'respondent'; subject: string; outcome: string | null; respondDueAt: string | null; respondedAt: string | null; createdAt: string };
type Detail = Summary & {
  merchant: string;
  customer: string | null;
  order: { id: string; number: string; totalMinor: number; status: string } | null;
  description: string;
  requestedRemedy: string;
  requestedAmountMinor: number | null;
  currency: string;
  escalationReason: string | null;
  decision: { outcome: string; remedy: string; amountMinor: number | null; text: string; decidedAt: string; appealDueAt: string } | null;
  appeal: { reason: string; at: string; result: string | null; outcome: string | null; text: string | null; decidedAt: string | null } | null;
  finalOutcome: string | null;
  canAppeal: boolean;
  execution: { status: 'none' | 'pending' | 'done' };
  messages: { id: string; authorType: string; authorName: string | null; body: string; createdAt: string }[];
  files: { id: string; kind: 'evidence' | 'document'; uploaderType: string; fileName: string | null; createdAt: string }[];
  events: { type: string; toStatus: Status | null; actorType: string; actorName: string | null; note: string | null; createdAt: string }[];
};

export function DisputeStatusBadge({ status }: { status: Status }) {
  const { t } = useI18n();
  return <span className={`badge badge-${tone[status]}`}>{t(`disputeStatus.${status}` as MessageKey)}</span>;
}

/** Disputes with customers and with ARUMA: owners and managers argue them; ARUMA decides. */
export function DisputesPage() {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const [params, setParams] = useSearchParams();
  const selected = params.get('dispute');
  const [status, setStatus] = useState<Status | ''>('');
  const [opening, setOpening] = useState(false);
  const allowed = can(merchant.role, 'manageTeam');
  const list = useLoad(
    () => (allowed ? api<Summary[]>('GET', `/v1/merchants/${merchant.id}/disputes${status ? `?status=${status}` : ''}`) : Promise.resolve([])),
    [merchant.id, status, selected, opening, allowed],
  );

  if (!allowed)
    return (
      <>
        <h1>{t('section.disputes')}</h1>
        <p className="muted">{t('disputes.ownersOnly')}</p>
      </>
    );
  if (selected) return <DisputeDetail disputeId={selected} onBack={() => setParams({})} />;
  if (opening) return <OpenDispute onDone={(id) => (setOpening(false), id && setParams({ dispute: id }))} />;

  return (
    <>
      <div className="topbar">
        <h1>{t('section.disputes')}</h1>
        <button className="primary" onClick={() => setOpening(true)}>
          {t('disputes.open')}
        </button>
      </div>
      <p className="muted">{t('disputes.intro')}</p>
      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        {(['', ...STATUSES] as const).map((st) => (
          <button key={st || 'all'} className={status === st ? 'primary' : ''} onClick={() => setStatus(st)}>
            {st ? t(`disputeStatus.${st}` as MessageKey) : t('orders.all')}
          </button>
        ))}
      </div>
      <ErrorBox error={list.error} />
      {!list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <p className="muted">{t('disputes.empty')}</p>
      ) : (
        <Card>
          <table>
            <thead>
              <tr>
                <th>{t('disputes.number')}</th>
                <th>{t('disputes.kind')}</th>
                <th>{t('disputes.subject')}</th>
                <th>{t('common.status')}</th>
                <th>{t('disputes.openedOn')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((d) => (
                <tr key={d.id}>
                  <td dir="ltr">
                    <button className="link" onClick={() => setParams({ dispute: d.id })}>
                      {d.number}
                    </button>
                  </td>
                  <td className="small">
                    {t(`disputeKind.${d.kind}` as MessageKey)}
                    <div className="muted">{t(`disputeSide.${d.side}` as MessageKey)}</div>
                  </td>
                  <td>
                    {d.subject}
                    <div className="muted small">{t(`disputeCategory.${d.category}` as MessageKey)}</div>
                  </td>
                  <td>
                    <DisputeStatusBadge status={d.status} />
                    {d.status === 'open' && d.side === 'respondent' && !d.respondedAt && d.respondDueAt && (
                      <div className="muted small">{t('returns.answerBy', { date: new Date(d.respondDueAt).toLocaleString(locale) })}</div>
                    )}
                  </td>
                  <td className="small">{new Date(d.createdAt).toLocaleDateString(locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function OpenDispute({ onDone }: { onDone: (id?: string) => void }) {
  const { t } = useI18n();
  const merchant = useMerchant();
  const [kind, setKind] = useState<'merchant_customer' | 'merchant_aruma'>('merchant_customer');
  const [form, setForm] = useState({ category: '', orderId: '', subject: '', description: '', compensation: false });
  const orders = useLoad(() => api<{ id: string; number: string; status: string; customerName: string }[]>('GET', `/v1/merchants/${merchant.id}/orders`), [merchant.id]);
  const action = useAction();
  const set = (k: keyof typeof form, v: string | boolean) => setForm({ ...form, [k]: v });

  return (
    <>
      <div className="topbar">
        <h1>{t('disputes.open')}</h1>
        <button onClick={() => onDone()}>{t('common.cancel')}</button>
      </div>
      <Card>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              const d = await api<{ id: string }>('POST', `/v1/merchants/${merchant.id}/disputes`, {
                kind,
                category: form.category,
                orderId: kind === 'merchant_customer' ? form.orderId : form.orderId || undefined,
                subject: form.subject.trim(),
                description: form.description.trim(),
                requestedRemedy: form.compensation ? 'merchant_compensation' : 'none',
              });
              onDone(d.id);
            });
          }}
        >
          <Field label={t('disputes.against')}>
            <select value={kind} onChange={(e) => (setKind(e.target.value as typeof kind), set('category', ''))}>
              <option value="merchant_customer">{t('disputes.againstCustomer')}</option>
              <option value="merchant_aruma">{t('disputes.againstAruma')}</option>
            </select>
          </Field>
          <Field label={t('disputes.category')}>
            <select required value={form.category} onChange={(e) => set('category', e.target.value)}>
              <option value="" />
              {CATEGORIES[kind].map((c) => (
                <option key={c} value={c}>
                  {t(`disputeCategory.${c}` as MessageKey)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('orders.number')} hint={kind === 'merchant_aruma' ? t('disputes.orderOptional') : undefined}>
            <select required={kind === 'merchant_customer'} value={form.orderId} onChange={(e) => set('orderId', e.target.value)}>
              <option value="" />
              {(orders.data ?? [])
                .filter((o) => o.status !== 'new')
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.number} · {o.customerName} · {t(`status.${o.status}` as MessageKey)}
                  </option>
                ))}
            </select>
          </Field>
          <Field label={t('disputes.subject')}>
            <input required minLength={5} maxLength={160} value={form.subject} onChange={(e) => set('subject', e.target.value)} />
          </Field>
          <Field label={t('disputes.description')} hint={t('disputes.descriptionHint')}>
            <textarea required minLength={20} maxLength={5000} rows={5} value={form.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
          <label className="row">
            <input type="checkbox" checked={form.compensation} onChange={(e) => set('compensation', e.target.checked)} /> {t('disputes.askCompensation')}
          </label>
          <ErrorBox error={action.error} />
          <div>
            <button className="primary" disabled={action.pending}>
              {t('disputes.submit')}
            </button>
          </div>
        </form>
      </Card>
    </>
  );
}

function DisputeDetail({ disputeId, onBack }: { disputeId: string; onBack: () => void }) {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const url = `/v1/merchants/${merchant.id}/disputes/${disputeId}`;
  const dispute = useLoad(() => api<Detail>('GET', url), [url]);
  const action = useAction();
  const [message, setMessage] = useState('');
  const [fileKind, setFileKind] = useState<'evidence' | 'document'>('evidence');
  const [mode, setMode] = useState<'appeal' | 'escalate' | 'withdraw' | null>(null);
  const [reason, setReason] = useState('');
  if (dispute.error) return <ErrorBox error={dispute.error} />;
  if (!dispute.data) return <Loading />;
  const d = dispute.data;
  const fmt = (v: number | null) => (v === null ? '' : money.format(v, d.currency, locale));
  const live = !['resolved', 'withdrawn'].includes(d.status);
  const run = (fn: () => Promise<unknown>) =>
    action.run(async () => {
      await fn();
      setMode(null);
      setReason('');
      await dispute.reload();
    });
  const outcomeText = (o: string | null) => (o ? t(`disputeOutcome.${o}` as MessageKey) : '');

  return (
    <>
      <div className="topbar">
        <h1 className="row">
          <span dir="ltr">{d.number}</span> <DisputeStatusBadge status={d.status} />
        </h1>
        <button className="link" onClick={onBack}>{t('disputes.back')}</button>
      </div>

      <Card title={d.subject}>
        <p className="small muted" style={{ marginTop: 0 }}>
          {t(`disputeKind.${d.kind}` as MessageKey)} · {t(`disputeCategory.${d.category}` as MessageKey)} · {t(`disputeSide.${d.side}` as MessageKey)}
        </p>
        <p style={{ whiteSpace: 'pre-wrap' }}>{d.description}</p>
        <table>
          <tbody>
            {d.customer && (
              <tr>
                <td className="muted">{t('orders.customer')}</td>
                <td>{d.customer}</td>
              </tr>
            )}
            {d.order && (
              <tr>
                <td className="muted">{t('orders.number')}</td>
                <td dir="ltr">
                  {d.order.number} · {fmt(d.order.totalMinor)}
                </td>
              </tr>
            )}
            <tr>
              <td className="muted">{t('disputes.requested')}</td>
              <td>
                {t(`disputeRemedy.${d.requestedRemedy}` as MessageKey)} {fmt(d.requestedAmountMinor)}
              </td>
            </tr>
            {d.status === 'open' && d.respondDueAt && !d.respondedAt && (
              <tr>
                <td className="muted">{t('disputes.answerDue')}</td>
                <td>{new Date(d.respondDueAt).toLocaleString(locale)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {d.decision && (
        <div data-testid="dispute-decision">
          <Card title={t('disputes.decision')}>
            <p>
              <strong>{outcomeText(d.decision.outcome)}</strong> · {t(`disputeRemedy.${d.decision.remedy}` as MessageKey)} {fmt(d.decision.amountMinor)}
            </p>
            <p style={{ whiteSpace: 'pre-wrap' }}>{d.decision.text}</p>
            {d.status === 'decided' && <p className="muted small">{t('disputes.appealUntil', { date: new Date(d.decision.appealDueAt).toLocaleString(locale) })}</p>}
            {d.appeal && (
              <>
                <h3>{t('disputes.appeal')}</h3>
                <p className="small" style={{ whiteSpace: 'pre-wrap' }}>
                  {d.appeal.reason}
                </p>
                {d.appeal.result ? (
                  <>
                    <p>
                      <strong>{t(`appealResult.${d.appeal.result}` as MessageKey)}</strong> · {outcomeText(d.appeal.outcome)}
                    </p>
                    <p style={{ whiteSpace: 'pre-wrap' }}>{d.appeal.text}</p>
                  </>
                ) : (
                  <p className="muted small">{t('disputes.appealPending')}</p>
                )}
              </>
            )}
            {d.status === 'resolved' && (
              <p className="small">
                {t('disputes.final', { outcome: outcomeText(d.finalOutcome) })} {t(`disputeExecution.${d.execution.status}` as MessageKey)}
              </p>
            )}
          </Card>
        </div>
      )}

      {live && (
        <div className="row" style={{ margin: '12px 0', flexWrap: 'wrap' }}>
          {d.canAppeal && (
            <>
              <button className="primary" onClick={() => setMode('appeal')}>
                {t('disputes.appealAction')}
              </button>
              <button disabled={action.pending} onClick={() => void run(() => api('POST', `${url}/accept`))}>
                {t('disputes.accept')}
              </button>
            </>
          )}
          {d.status === 'open' && <button onClick={() => setMode('escalate')}>{t('disputes.escalate')}</button>}
          {d.side === 'claimant' && ['open', 'under_review'].includes(d.status) && (
            <button className="danger" onClick={() => setMode('withdraw')}>
              {t('disputes.withdraw')}
            </button>
          )}
        </div>
      )}
      {mode && (
        <Card title={t(`disputes.${mode}Action` as MessageKey)}>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api('POST', `${url}/${mode}`, mode === 'withdraw' ? { note: reason.trim() } : { reason: reason.trim() }));
            }}
          >
            <Field label={t('disputes.reason')} hint={t(`disputes.${mode}Hint` as MessageKey)}>
              <textarea required minLength={mode === 'withdraw' ? 3 : 10} maxLength={2000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="row">
              <button className="primary" disabled={action.pending}>
                {t('disputes.send')}
              </button>
              <button type="button" onClick={() => setMode(null)}>
                {t('common.cancel')}
              </button>
            </div>
          </form>
        </Card>
      )}
      <ErrorBox error={action.error} />

      <Card title={t('disputes.messages')}>
        <div data-testid="dispute-thread" className="stack">
          {d.messages.length === 0 && <p className="muted">{t('disputes.noMessages')}</p>}
          {d.messages.map((msg) => (
            <div key={msg.id} style={{ borderInlineStart: `3px solid ${msg.authorType === 'merchant' ? 'var(--accent, #2b6cb0)' : 'var(--border)'}`, paddingInlineStart: 10 }}>
              <div className="small muted">
                {msg.authorType === 'platform' ? 'ARUMA' : msg.authorName ?? t(`actor.${msg.authorType}` as MessageKey)} · {new Date(msg.createdAt).toLocaleString(locale)}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{msg.body}</div>
            </div>
          ))}
        </div>
        {live && (
          <form
            className="stack"
            style={{ marginTop: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api('POST', `${url}/messages`, { body: message.trim() })).then((sent) => sent && setMessage(''));
            }}
          >
            <Field label={t('disputes.yourMessage')} hint={t('disputes.messageHint')}>
              <textarea required maxLength={5000} rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
            </Field>
            <div>
              <button className="primary" disabled={action.pending}>
                {t('disputes.send')}
              </button>
            </div>
          </form>
        )}
      </Card>

      <Card
        title={t('disputes.files')}
        actions={
          live ? (
            <span className="row">
              <select aria-label={t('disputes.fileKind')} value={fileKind} onChange={(e) => setFileKind(e.target.value as typeof fileKind)}>
                <option value="evidence">{t('disputeFile.evidence')}</option>
                <option value="document">{t('disputeFile.document')}</option>
              </select>
              <input
                type="file"
                aria-label={t('disputes.addFile')}
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const form = new FormData();
                  form.append('file', file);
                  e.target.value = '';
                  void run(() => api('POST', `${url}/files?kind=${fileKind}`, form));
                }}
              />
            </span>
          ) : undefined
        }
      >
        {d.files.length === 0 ? (
          <p className="muted">{t('disputes.noFiles')}</p>
        ) : (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {d.files.map((f, i) => (
              <button key={f.id} onClick={() => void download(`${url}/files/${f.id}`, f.fileName ?? `file-${i + 1}`)}>
                {t(`disputeFile.${f.kind}` as MessageKey)} · {t(`actor.${f.uploaderType}` as MessageKey)} · {i + 1}
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card title={t('returns.history')}>
        <p className="muted small">{t('orders.historyReadonly')}</p>
        <table data-testid="dispute-history">
          <tbody>
            {d.events.map((e, i) => (
              <tr key={i}>
                <td className="small">{new Date(e.createdAt).toLocaleString(locale)}</td>
                <td className="small">
                  {t(`disputeEvent.${e.type}` as MessageKey)}
                  {e.toStatus && (
                    <>
                      {' '}
                      <DisputeStatusBadge status={e.toStatus} />
                    </>
                  )}
                </td>
                <td className="small">{e.actorType === 'platform' ? 'ARUMA' : e.actorName ?? t(`actor.${e.actorType}` as MessageKey)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

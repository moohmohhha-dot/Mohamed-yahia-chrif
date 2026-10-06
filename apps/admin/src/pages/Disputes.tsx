import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, download } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, Empty, ErrorBox, Field, Kv, Loading, Pager, ReasonAction, Tabs, useAction, useLoad } from '../components/ui';
import { useI18n } from '../i18n';

const STATUSES = ['under_review', 'appealed', 'open', 'decided', 'resolved', 'withdrawn'] as const;
const PAGE = 50;
type Row = { id: string; number: string; kind: string; category: string; status: string; subject: string; createdAt: string };
type Dispute = Row & {
  merchant: string;
  customer: string | null;
  order: { number: string; totalMinor: number; status: string } | null;
  description: string;
  requestedRemedy: string;
  requestedAmountMinor: number | null;
  currency: string;
  escalationReason: string | null;
  decision: { outcome: string; remedy: string; amountMinor: number | null; text: string; decidedAt: string; appealDueAt: string } | null;
  appeal: { reason: string; at: string; result: string | null; outcome: string | null; text: string | null } | null;
  finalOutcome: string | null;
  execution: { status: string; reference?: string | null };
  messages: { id: string; authorType: string; authorName: string | null; body: string; internal: boolean; createdAt: string }[];
  files: { id: string; kind: string; uploaderType: string; fileName: string | null; internal: boolean }[];
  events: { type: string; toStatus: string | null; actorType: string; actorName: string | null; note: string | null; createdAt: string }[];
};

export function DisputesPage() {
  const { t, label, date } = useI18n();
  const [params, setParams] = useSearchParams();
  const selected = params.get('id');
  const [status, setStatus] = useState<(typeof STATUSES)[number] | ''>('under_review');
  const [page, setPage] = useState(1);
  const list = useLoad(() => api<Row[]>('GET', `/v1/admin/disputes?page=${page}&pageSize=${PAGE}${status ? `&status=${status}` : ''}`), [status, page, selected]);
  if (selected) return <DisputeView disputeId={selected} onBack={() => setParams({})} />;
  return (
    <>
      <h1>{t('section.disputes')}</h1>
      <Tabs value={status} options={STATUSES} onChange={(v) => (setStatus(v), setPage(1))} prefix="disputeStatus" allLabel="common.all" />
      <ErrorBox error={list.error} />
      {!list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <Empty />
      ) : (
        <Card>
          <table>
            <thead>
              <tr>
                <th>{t('disputes.number')}</th>
                <th>{t('disputes.kind')}</th>
                <th>{t('disputes.subject')}</th>
                <th>{t('common.status')}</th>
                <th>{t('orders.placed')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((d) => (
                <tr key={d.id}>
                  <td dir="ltr">
                    <button className="link" onClick={() => setParams({ id: d.id })}>
                      {d.number}
                    </button>
                  </td>
                  <td className="small">{label('disputeKind', d.kind)}</td>
                  <td>
                    {d.subject}
                    <div className="muted small">{label('disputeCategory', d.category)}</div>
                  </td>
                  <td>
                    <Badge prefix="disputeStatus" value={d.status} />
                  </td>
                  <td className="small">{date(d.createdAt)}</td>
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

function DecisionFields({ kind, value, onChange, currency }: { kind: string; value: { outcome: string; remedy: string; amount: string }; onChange: (v: { outcome: string; remedy: string; amount: string }) => void; currency: string }) {
  const { t, label } = useI18n();
  const remedies = kind === 'customer_merchant' ? ['none', 'refund', 'store_credit'] : ['none', 'merchant_compensation'];
  return (
    <div className="form-grid">
      <Field label={t('disputes.outcome')}>
        <select value={value.outcome} onChange={(e) => onChange({ ...value, outcome: e.target.value })}>
          {['claimant', 'respondent', 'partial'].map((o) => (
            <option key={o} value={o}>
              {label('disputeOutcome', o)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('disputes.remedy')}>
        <select value={value.remedy} onChange={(e) => onChange({ ...value, remedy: e.target.value })}>
          {remedies.map((r) => (
            <option key={r} value={r}>
              {label('disputeRemedy', r)}
            </option>
          ))}
        </select>
      </Field>
      {value.remedy !== 'none' && (
        <Field label={t('orders.amount', { currency })}>
          <input required inputMode="decimal" value={value.amount} onChange={(e) => onChange({ ...value, amount: e.target.value })} />
        </Field>
      )}
    </div>
  );
}

function DisputeView({ disputeId, onBack }: { disputeId: string; onBack: () => void }) {
  const { t, label, money, date } = useI18n();
  const { can, staff } = useAuth();
  const url = `/v1/admin/disputes/${disputeId}`;
  const dispute = useLoad(() => api<Dispute>('GET', url), [url]);
  const [message, setMessage] = useState('');
  const [internal, setInternal] = useState(true);
  const [decision, setDecision] = useState({ outcome: 'claimant', remedy: 'none', amount: '' });
  const [appealResult, setAppealResult] = useState<'upheld' | 'overturned' | 'modified'>('upheld');
  const [reference, setReference] = useState('');
  const action = useAction();
  if (dispute.error) return <ErrorBox error={dispute.error} />;
  if (!dispute.data) return <Loading />;
  const d = dispute.data;
  const fmt = (v: number | null) => (v === null ? '' : money(v, d.currency));
  const reload = () => void dispute.reload();
  const amountMinor = decision.remedy === 'none' ? undefined : Math.round(Number(decision.amount.replace(',', '.')) * 100);
  const live = !['resolved', 'withdrawn'].includes(d.status);

  return (
    <>
      <div className="topbar">
        <h1 className="row">
          <span dir="ltr">{d.number}</span> <Badge prefix="disputeStatus" value={d.status} />
        </h1>
        <button className="link" onClick={onBack}>
          {t('disputes.back')}
        </button>
      </div>
      <div className="split">
        <Card title={d.subject}>
          <p style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{d.description}</p>
          <Kv
            rows={[
              [t('disputes.kind'), label('disputeKind', d.kind)],
              [t('disputes.category'), label('disputeCategory', d.category)],
              [t('products.merchant'), d.merchant],
              [t('orders.customer'), d.customer],
              [t('orders.number'), d.order && `${d.order.number} · ${fmt(d.order.totalMinor)}`],
              [t('disputes.requested'), `${label('disputeRemedy', d.requestedRemedy)} ${fmt(d.requestedAmountMinor)}`],
              [t('returns.escalation'), d.escalationReason],
            ]}
          />
        </Card>
        <Card title={t('disputes.decision')}>
          {d.decision ? (
            <>
              <p>
                <strong>{label('disputeOutcome', d.decision.outcome)}</strong> · {label('disputeRemedy', d.decision.remedy)} {fmt(d.decision.amountMinor)}
              </p>
              <p className="small" style={{ whiteSpace: 'pre-wrap' }}>
                {d.decision.text}
              </p>
              {d.appeal && (
                <>
                  <h3>{t('disputes.appeal')}</h3>
                  <p className="small">{d.appeal.reason}</p>
                  {d.appeal.result && (
                    <p>
                      <strong>{label('appealResult', d.appeal.result)}</strong> · {label('disputeOutcome', d.appeal.outcome)} — {d.appeal.text}
                    </p>
                  )}
                </>
              )}
              <p className="small muted">
                {label('disputeExecution', d.execution.status)} {d.execution.reference}
              </p>
            </>
          ) : (
            <p className="muted">{t('disputes.noDecision')}</p>
          )}
        </Card>
      </div>

      {can('disputes.decide') && ['open', 'under_review'].includes(d.status) && (
        <Card title={t('disputes.decide')}>
          <ReasonAction
            label={t('disputes.decide')}
            minLength={20}
            reasonLabel={t('disputes.reasons')}
            extra={<DecisionFields kind={d.kind} value={decision} onChange={setDecision} currency={d.currency} />}
            onConfirm={(text) => api('POST', `${url}/decision`, { outcome: decision.outcome, remedy: decision.remedy, amountMinor, text }).then(reload)}
          />
        </Card>
      )}
      {can('disputes.decide') && d.status === 'appealed' && (
        <Card title={t('disputes.decideAppeal')}>
          <p className="muted small">{t('disputes.appealOtherAdmin')}</p>
          <ReasonAction
            label={t('disputes.decideAppeal')}
            minLength={20}
            reasonLabel={t('disputes.reasons')}
            extra={
              <>
                <Field label={t('disputes.appealResult')}>
                  <select value={appealResult} onChange={(e) => setAppealResult(e.target.value as typeof appealResult)}>
                    {(['upheld', 'overturned', 'modified'] as const).map((r) => (
                      <option key={r} value={r}>
                        {label('appealResult', r)}
                      </option>
                    ))}
                  </select>
                </Field>
                {appealResult !== 'upheld' && <DecisionFields kind={d.kind} value={decision} onChange={setDecision} currency={d.currency} />}
              </>
            }
            onConfirm={(text) =>
              api('POST', `${url}/appeal-decision`, appealResult === 'upheld' ? { result: appealResult, text } : { result: appealResult, outcome: decision.outcome, remedy: decision.remedy, amountMinor, text }).then(reload)
            }
          />
        </Card>
      )}
      {can('refunds.execute') && d.status === 'resolved' && d.execution.status === 'pending' && (
        <Card title={t('returns.refund')}>
          <form className="row" onSubmit={(e) => (e.preventDefault(), void action.run(() => api('POST', `${url}/refund`, reference.trim() ? { externalReference: reference.trim() } : {}).then(reload)))}>
            <input placeholder={t('orders.transferReference')} aria-label={t('orders.transferReference')} value={reference} onChange={(e) => setReference(e.target.value)} style={{ maxWidth: 260 }} />
            <button className="primary" disabled={action.pending}>
              {t('returns.recordTransfer')}
            </button>
          </form>
          <ErrorBox error={action.error} />
        </Card>
      )}

      <Card title={t('disputes.messages')}>
        <div className="stack" data-testid="dispute-thread">
          {d.messages.length === 0 && <Empty />}
          {d.messages.map((m) => (
            <div key={m.id} style={{ borderInlineStart: `3px solid ${m.internal ? 'var(--warn)' : m.authorType === 'platform' ? 'var(--accent)' : 'var(--border)'}`, paddingInlineStart: 10 }}>
              <div className="small muted">
                {m.authorName ?? label('actor', m.authorType)} · {label('actor', m.authorType)} · {date(m.createdAt)} {m.internal && <span className="badge badge-warn">{t('disputes.internal')}</span>}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
            </div>
          ))}
        </div>
        {live && can('disputes.handle') && (
          <form
            className="stack"
            style={{ marginTop: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(() => api('POST', `${url}/messages`, { body: message.trim(), internal }).then(() => (setMessage(''), reload())));
            }}
          >
            <Field label={t('disputes.yourMessage', { name: staff!.displayName })}>
              <textarea required rows={3} maxLength={5000} value={message} onChange={(e) => setMessage(e.target.value)} />
            </Field>
            <label className="row small">
              <input type="checkbox" style={{ width: 'auto' }} checked={internal} onChange={(e) => setInternal(e.target.checked)} /> {t('disputes.internalNote')}
            </label>
            <div>
              <button className="primary" disabled={action.pending}>
                {internal ? t('disputes.addNote') : t('disputes.sendToParties')}
              </button>
            </div>
          </form>
        )}
        {d.files.length > 0 && (
          <div className="row" style={{ marginTop: 12 }}>
            {d.files.map((f, i) => (
              <button key={f.id} onClick={() => void download(`${url}/files/${f.id}`, f.fileName ?? `file-${i + 1}`)}>
                {label('disputeFile', f.kind)} · {label('actor', f.uploaderType)} {f.internal ? `· ${t('disputes.internal')}` : ''}
              </button>
            ))}
          </div>
        )}
      </Card>
      <Card title={t('orders.history')}>
        <table>
          <tbody>
            {d.events.map((e, i) => (
              <tr key={i}>
                <td className="small">{date(e.createdAt)}</td>
                <td className="small">
                  {label('disputeEvent', e.type)} {e.toStatus && <Badge prefix="disputeStatus" value={e.toStatus} />}
                </td>
                <td className="small">{e.actorName ?? label('actor', e.actorType)}</td>
                <td className="small muted">{e.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

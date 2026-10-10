import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, Empty, ErrorBox, Field, Json, Kv, Loading, ReasonAction, useAction, useLoad } from '../components/ui';
import { useI18n } from '../i18n';

type Block = { id: string; phone: string; reason: string; createdAt: string; liftedAt: string | null; liftReason: string | null };
type Policy = { requireConfirmation: boolean; maxCallAttempts: number; maxDeliveryAttempts: number; blockAfterRefusals: number; maxAmountMinor: number | null; source: string };

/** Fraud: customer risk on cash-on-delivery, blocked phone numbers, and the platform rules. */
export function FraudPage() {
  const { t, date } = useI18n();
  const { can } = useAuth();
  const blocks = useLoad(() => (can('fraud.manage') ? api<Block[]>('GET', '/v1/admin/cod/blocks') : Promise.resolve([])), []);
  const [phone, setPhone] = useState('');
  const [risk, setRisk] = useState<Record<string, unknown> | null>(null);
  const [blockPhone, setBlockPhone] = useState('');
  const action = useAction();
  return (
    <>
      <h1>{t('section.fraud')}</h1>
      <p className="muted">{t('fraud.intro')}</p>
      {can('fraud.manage') && (
        <div className="split">
          <Card title={t('fraud.risk')}>
            <form className="row" onSubmit={(e) => (e.preventDefault(), void action.run(async () => setRisk(await api('GET', `/v1/admin/cod/risk?phone=${encodeURIComponent(phone.trim())}`))))}>
              <input required placeholder="0555 12 34 56" aria-label={t('users.phone')} value={phone} onChange={(e) => setPhone(e.target.value)} style={{ maxWidth: 220 }} dir="ltr" />
              <button className="primary" disabled={action.pending}>
                {t('fraud.check')}
              </button>
            </form>
            {risk && (
              <div style={{ marginTop: 12 }} data-testid="risk">
                <Kv
                  rows={[
                    [t('fraud.level'), <><Badge prefix="riskLevel" value={String(risk.level)} /> {t('fraud.score', { n: Number(risk.score) })}</>],
                    [t('fraud.blocked'), risk.blocked ? <Badge prefix="riskLevel" value="blocked" /> : t('common.no')],
                    [t('fraud.signals'), <Json value={risk.reasons} />],
                    [t('fraud.history'), <Json value={risk.history} />],
                  ]}
                />
              </div>
            )}
          </Card>
          <Card title={t('fraud.block')}>
            <ReasonAction
              label={t('fraud.blockPhone')}
              danger
              extra={
                <Field label={t('users.phone')}>
                  <input required value={blockPhone} onChange={(e) => setBlockPhone(e.target.value)} dir="ltr" />
                </Field>
              }
              onConfirm={(reason) => api('POST', '/v1/admin/cod/blocks', { phone: blockPhone.trim(), reason }).then(() => blocks.reload())}
            />
            <p className="muted small">{t('fraud.blockHint')}</p>
          </Card>
        </div>
      )}
      <ErrorBox error={action.error} />
      {can('fraud.manage') && (
        <Card title={t('fraud.blocks')}>
          {!blocks.data ? (
            <Loading />
          ) : blocks.data.length === 0 ? (
            <Empty />
          ) : (
            <table>
              <tbody>
                {blocks.data.map((b) => (
                  <tr key={b.id}>
                    <td dir="ltr">{b.phone}</td>
                    <td className="small">
                      {b.reason}
                      <div className="muted">{date(b.createdAt)}</div>
                    </td>
                    <td>{b.liftedAt ? <span className="small muted">{t('fraud.lifted', { date: date(b.liftedAt) })} — {b.liftReason}</span> : <ReasonAction label={t('fraud.lift')} onConfirm={(reason) => api('POST', `/v1/admin/cod/blocks/${b.id}/lift`, { reason }).then(() => blocks.reload())} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
      <CodPolicy />
    </>
  );
}

function CodPolicy() {
  const { t } = useI18n();
  const { can } = useAuth();
  const policy = useLoad(() => api<Policy>('GET', '/v1/admin/cod/policy'), []);
  const [form, setForm] = useState<Policy | null>(null);
  const action = useAction();
  const p = form ?? policy.data;
  if (!p) return null;
  const edit = can('cod.policy');
  const set = (k: keyof Policy, v: number | boolean | null) => setForm({ ...p, [k]: v });
  return (
    <Card title={t('fraud.codPolicy')}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          const { source: _s, ...body } = p;
          void action.run(() => api('PUT', '/v1/admin/cod/policy', body).then(() => policy.reload()));
        }}
      >
        <Field label={t('fraud.requireConfirmation')}>
          <select disabled={!edit} value={String(p.requireConfirmation)} onChange={(e) => set('requireConfirmation', e.target.value === 'true')}>
            <option value="true">{t('common.yes')}</option>
            <option value="false">{t('common.no')}</option>
          </select>
        </Field>
        <Field label={t('fraud.maxCalls')}>
          <input disabled={!edit} type="number" min={1} max={10} value={p.maxCallAttempts} onChange={(e) => set('maxCallAttempts', Number(e.target.value))} />
        </Field>
        <Field label={t('fraud.maxDeliveries')}>
          <input disabled={!edit} type="number" min={1} max={10} value={p.maxDeliveryAttempts} onChange={(e) => set('maxDeliveryAttempts', Number(e.target.value))} />
        </Field>
        <Field label={t('fraud.blockAfter')}>
          <input disabled={!edit} type="number" min={0} max={50} value={p.blockAfterRefusals} onChange={(e) => set('blockAfterRefusals', Number(e.target.value))} />
        </Field>
        {edit && (
          <div style={{ alignSelf: 'end' }}>
            <button className="primary" disabled={action.pending}>
              {t('common.save')}
            </button>
          </div>
        )}
      </form>
      <ErrorBox error={action.error} />
      {action.done && <p className="small">{t('common.saved')}</p>}
    </Card>
  );
}

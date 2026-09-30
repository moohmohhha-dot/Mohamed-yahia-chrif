import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Card, ErrorBox, Field, Loading, StatusBadge, useAction, useLoad } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { useMerchant } from '../merchant-context';
import { nameIn, sizeLabel, type Offer } from './common';

type Movement = { id: string; delta: number; quantityAfter: number; reason: string; note: string | null; actor: string | null; createdAt: string };
const REASONS = ['restock', 'correction', 'damaged', 'returned'] as const;

export function InventoryPage() {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const { data, error, reload } = useLoad(() => api<Offer[]>('GET', `/v1/merchants/${merchant.id}/offers`), [merchant.id]);
  const [open, setOpen] = useState<string | null>(null);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return (
    <>
      <h1>{t('section.inventory')}</h1>
      {data.length === 0 && <p className="muted">{t('offers.empty')}</p>}
      {data.map((offer) => (
        <Card
          key={offer.id}
          title={
            <span className="row">
              {nameIn(offer.product.names, locale)} · {sizeLabel(offer.options)} <span className="muted small" dir="ltr">{offer.sku}</span>
            </span>
          }
          actions={
            <>
              <StatusBadge status={offer.status} />
              <strong data-testid={`stock-${offer.sku}`}>
                {t('inventory.stock')}: {offer.stockQuantity}
              </strong>
              <button onClick={() => setOpen(open === offer.id ? null : offer.id)}>
                {open === offer.id ? t('common.close') : t('inventory.adjust')}
              </button>
            </>
          }
        >
          {open === offer.id && <Adjust merchantId={merchant.id} offer={offer} onDone={() => void reload()} />}
        </Card>
      ))}
    </>
  );
}

function Adjust({ merchantId, offer, onDone }: { merchantId: string; offer: Offer; onDone: () => void }) {
    const { t, locale } = useI18n();
    const merchant = { id: merchantId };
    const history = useLoad(() => api<Movement[]>('GET', `/v1/merchants/${merchant.id}/offers/${offer.id}/inventory`), [offer.id, offer.stockQuantity]);
    const [form, setForm] = useState({ delta: '', reason: 'restock', note: '' });
    const action = useAction();
    const submit = (e: FormEvent) => {
      e.preventDefault();
      void action.run(async () => {
        await api('POST', `/v1/merchants/${merchant.id}/offers/${offer.id}/inventory`, {
          delta: Number(form.delta),
          reason: form.reason,
          ...(form.note ? { note: form.note } : {}),
        });
        setForm({ delta: '', reason: 'restock', note: '' });
        onDone();
      });
    };
    return (
      <div className="stack">
        <form className="form-grid" onSubmit={submit}>
          <Field label={t('inventory.delta')}>
            <input required type="number" step={1} value={form.delta} onChange={(e) => setForm({ ...form, delta: e.target.value })} dir="ltr" />
          </Field>
          <Field label={t('inventory.reason')}>
            <select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
              {REASONS.map((r) => (
                <option key={r} value={r}>
                  {t(`reason.${r}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('inventory.note')}>
            <input value={form.note} maxLength={500} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
          <div style={{ alignSelf: 'end' }}>
            <button className="primary" disabled={action.pending || !form.delta || form.delta === '0'}>
              {t('common.save')}
            </button>
          </div>
        </form>
        <ErrorBox error={action.error} />
        <h3>{t('inventory.history')}</h3>
        <p className="muted small">{t('inventory.readonly')}</p>
        {history.data && (
          <table>
            <thead>
              <tr>
                <th>{t('inventory.date')}</th>
                <th>{t('inventory.reason')}</th>
                <th className="num">±</th>
                <th className="num">{t('inventory.after')}</th>
                <th>{t('inventory.by')}</th>
                <th>{t('inventory.note')}</th>
              </tr>
            </thead>
            <tbody>
              {history.data.map((m) => (
                <tr key={m.id}>
                  <td className="small">{new Date(m.createdAt).toLocaleString(locale)}</td>
                  <td>{t(`reason.${m.reason}` as MessageKey)}</td>
                  <td className="num" dir="ltr">{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                  <td className="num">{m.quantityAfter}</td>
                  <td>{m.actor ?? '—'}</td>
                  <td>{m.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }

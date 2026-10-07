import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Card, ErrorBox, Field, Loading, useAction, useLoad } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { can, useMerchant } from '../merchant-context';
import { AccountSecurity } from './AccountSecurity';

type Merchant = { name: string; activityCode: string; activityDescription: string | null; contactPhone: string | null; contactEmail: string | null };
type Member = { userId: string; displayName: string; email: string; role: 'owner' | 'manager' | 'staff' };
type Store = { storeSlug: string; storeName: string; commissionBps: number; status: string };

export function SettingsPage() {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const manage = can(merchant.role, 'manageTeam');
  const details = useLoad(() => api<Merchant>('GET', `/v1/merchants/${merchant.id}`), [merchant.id]);
  const staff = useLoad(() => api<Member[]>('GET', `/v1/merchants/${merchant.id}/staff`), [merchant.id]);
  const stores = useLoad(() => api<Store[]>('GET', `/v1/merchants/${merchant.id}/stores`), [merchant.id]);

  return (
    <>
      <h1>{t('section.settings')}</h1>
      <Card title={t('settings.profile')}>
        {!details.data ? <Loading /> : <ProfileForm current={details.data} disabled={!manage} onSaved={() => (merchant.refresh(), void details.reload())} />}
      </Card>
      <Card title={t('settings.staff')}>
        <ErrorBox error={staff.error} />
        {staff.data && <Team members={staff.data} manage={manage} onChange={() => void staff.reload()} />}
      </Card>
      <Card title={t('settings.stores')}>
        <p className="muted small">{t('settings.commissionReadOnly')}</p>
        <table>
          <tbody>
            {stores.data?.map((s) => (
              <tr key={s.storeSlug}>
                <td>{s.storeName}</td>
                <td className="num" data-testid={`commission-${s.storeSlug}`}>
                  {(s.commissionBps / 100).toLocaleString(locale)} %
                </td>
                <td>{t(`status.${s.status}` as MessageKey)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {stores.data?.length === 0 && <p className="muted">{t('dash.noStores')}</p>}
      </Card>
      <AccountSecurity />
    </>
  );
}

function ProfileForm({ current, disabled, onSaved }: { current: Merchant; disabled: boolean; onSaved: () => void }) {
  const { t } = useI18n();
  const merchant = useMerchant();
  const [form, setForm] = useState({
    name: current.name,
    activityCode: current.activityCode,
    activityDescription: current.activityDescription ?? '',
    contactPhone: current.contactPhone ?? '',
    contactEmail: current.contactEmail ?? '',
  });
  const action = useAction();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      await api('PATCH', `/v1/merchants/${merchant.id}`, {
        name: form.name,
        activityCode: form.activityCode,
        activityDescription: form.activityDescription || null,
        contactPhone: form.contactPhone || null,
        contactEmail: form.contactEmail || null,
      });
      onSaved();
    });
  };
  return (
    <form className="stack" onSubmit={submit}>
      <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0 }} className="form-grid">
        <Field label={t('merchants.name')}>
          <input required value={form.name} onChange={set('name')} />
        </Field>
        <Field label={t('merchants.activityCode')}>
          <input required value={form.activityCode} onChange={set('activityCode')} dir="ltr" />
        </Field>
        <Field label={t('merchants.contactPhone')}>
          <input type="tel" value={form.contactPhone} onChange={set('contactPhone')} dir="ltr" />
        </Field>
        <Field label={t('merchants.contactEmail')}>
          <input type="email" value={form.contactEmail} onChange={set('contactEmail')} dir="ltr" />
        </Field>
        <Field label={t('merchants.activityDescription')}>
          <textarea rows={2} value={form.activityDescription} onChange={set('activityDescription')} />
        </Field>
      </fieldset>
      <ErrorBox error={action.error} />
      {action.done && <span className="muted small">{t('common.saved')}</span>}
      {!disabled && (
        <div>
          <button className="primary" disabled={action.pending}>
            {t('common.save')}
          </button>
        </div>
      )}
    </form>
  );
}

function Team({ members, manage, onChange }: { members: Member[]; manage: boolean; onChange: () => void }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const merchant = useMerchant();
  const [form, setForm] = useState({ email: '', role: 'staff' });
  const action = useAction();
  const base = `/v1/merchants/${merchant.id}/staff`;
  return (
    <div className="stack">
      <table>
        <tbody>
          {members.map((m) => (
            <tr key={m.userId}>
              <td>{m.displayName}</td>
              <td dir="ltr">{m.email}</td>
              <td>{t(`role.${m.role}` as MessageKey)}</td>
              <td className="num">
                {manage && m.role !== 'owner' && m.userId !== user?.id && (merchant.role === 'owner' || m.role === 'staff') && (
                  <button className="danger" disabled={action.pending} onClick={() => void action.run(async () => (await api('DELETE', `${base}/${m.userId}`), onChange()))}>
                    {t('settings.remove')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {manage && (
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await api('PUT', base, form);
              setForm({ email: '', role: 'staff' });
              onChange();
            });
          }}
        >
          <Field label={t('settings.staffEmail')}>
            <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} dir="ltr" />
          </Field>
          <Field label={t('settings.role')}>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="staff">{t('role.staff')}</option>
              {merchant.role === 'owner' && <option value="manager">{t('role.manager')}</option>}
            </select>
          </Field>
          <div style={{ alignSelf: 'end' }}>
            <button disabled={action.pending}>{t('settings.addStaff')}</button>
          </div>
        </form>
      )}
      <ErrorBox error={action.error} />
    </div>
  );
}

import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { Card, ErrorBox, Field, Loading, StatusBadge, useAction, useLoad } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';

type Membership = { merchant: { id: string; name: string; type: string; verificationStatus: string }; role: string };

export function MerchantsPage() {
  const { t } = useI18n();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { data, error } = useLoad(() => api<Membership[]>('GET', '/v1/me/merchants'), []);
  const [form, setForm] = useState({
    type: 'individual',
    name: '',
    slug: '',
    country: 'DZ',
    activityCode: 'perfume_retail',
    activityDescription: '',
    contactPhone: '',
    contactEmail: user?.email ?? '',
  });
  const action = useAction();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const create = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== ''));
      const merchant = await api<{ id: string }>('POST', '/v1/merchants', body);
      navigate(`/m/${merchant.id}/dashboard`);
    });
  };

  return (
    <div className="main" style={{ margin: '0 auto' }}>
      <div className="topbar">
        <h1>ARUMA · {t('app.title')}</h1>
        <div className="row">
          <LanguageSwitcher />
          <button onClick={() => void logout()}>{t('common.logout')}</button>
        </div>
      </div>
      <Card title={t('merchants.title')}>
        <ErrorBox error={error} />
        {!data ? (
          <Loading />
        ) : data.length === 0 ? (
          <p className="muted">{t('merchants.empty')}</p>
        ) : (
          <table>
            <tbody>
              {data.map(({ merchant, role }) => (
                <tr key={merchant.id}>
                  <td>{merchant.name}</td>
                  <td>{t(`merchants.type.${merchant.type}` as MessageKey)}</td>
                  <td>{t(`role.${role}` as MessageKey)}</td>
                  <td><StatusBadge status={merchant.verificationStatus} /></td>
                  <td className="num">
                    <button onClick={() => navigate(`/m/${merchant.id}/dashboard`)}>{t('merchants.open')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title={t('merchants.create')}>
        <form className="stack" onSubmit={create}>
          <Field label={t('merchants.type')} hint={t(`merchants.typeHint.${form.type}` as MessageKey)}>
            <select value={form.type} onChange={set('type')}>
              <option value="individual">{t('merchants.type.individual')}</option>
              <option value="business">{t('merchants.type.business')}</option>
            </select>
          </Field>
          <div className="form-grid">
            <Field label={t('merchants.name')}>
              <input required value={form.name} onChange={set('name')} />
            </Field>
            <Field label={t('merchants.slug')} hint={t('merchants.slugHint')}>
              <input required pattern="[a-z0-9]+(-[a-z0-9]+)*" value={form.slug} onChange={set('slug')} dir="ltr" />
            </Field>
            <Field label={t('merchants.country')}>
              <select value={form.country} onChange={set('country')}>
                <option value="DZ">DZ</option>
                <option value="FR">FR</option>
              </select>
            </Field>
            <Field label={t('merchants.activityCode')}>
              <input required pattern="[a-z][a-z0-9_]+" value={form.activityCode} onChange={set('activityCode')} dir="ltr" />
            </Field>
            <Field label={t('merchants.contactPhone')}>
              <input type="tel" placeholder="+213555000000" value={form.contactPhone} onChange={set('contactPhone')} dir="ltr" />
            </Field>
            <Field label={t('merchants.contactEmail')}>
              <input type="email" value={form.contactEmail} onChange={set('contactEmail')} dir="ltr" />
            </Field>
          </div>
          <Field label={t('merchants.activityDescription')}>
            <textarea rows={2} value={form.activityDescription} onChange={set('activityDescription')} />
          </Field>
          <ErrorBox error={action.error} />
          <div>
            <button className="primary" disabled={action.pending}>{t('common.create')}</button>
          </div>
        </form>
      </Card>
    </div>
  );
}

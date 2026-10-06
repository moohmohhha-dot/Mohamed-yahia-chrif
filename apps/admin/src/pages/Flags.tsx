import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Card, ErrorBox, Field, Loading, ReasonAction, useLoad } from '../components/ui';
import { useI18n } from '../i18n';

type Flag = { key: string; description: string; enabledByDefault: boolean; updatedAt: string; overrides: { storeId: string; storeSlug: string; enabled: boolean }[] };
type Store = { id: string; slug: string; name: string };

/** Feature switches: on or off for every store, or per store (e.g. try a feature on MB Parfum first). Every change needs a reason. */
export function FlagsPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const flags = useLoad(() => api<Flag[]>('GET', '/v1/admin/feature-flags'), []);
  const stores = useLoad(() => api<Store[]>('GET', '/v1/admin/stores'), []);
  const [choice, setChoice] = useState<Record<string, { storeId: string; value: string }>>({});
  const edit = can('flags.manage');
  if (flags.error) return <ErrorBox error={flags.error} />;
  if (!flags.data) return <Loading />;
  const reload = () => void flags.reload();
  return (
    <>
      <h1>{t('section.flags')}</h1>
      <p className="muted">{t('flags.intro')}</p>
      {flags.data.map((f) => {
        const c = choice[f.key] ?? { storeId: stores.data?.[0]?.id ?? '', value: 'on' };
        return (
          <div key={f.key} data-testid={`flag-${f.key}`}>
            <Card
              title={
                <span className="row">
                  <code>{f.key}</code> <span className={`badge badge-${f.enabledByDefault ? 'good' : 'muted'}`}>{f.enabledByDefault ? t('flags.on') : t('flags.off')}</span>
                </span>
              }
            >
              <p className="muted small" style={{ marginTop: 0 }}>
                {f.description}
              </p>
              {f.overrides.length > 0 && (
                <p className="small">
                  {f.overrides.map((o) => (
                    <span key={o.storeId} className="pill">
                      {o.storeSlug}: {o.enabled ? t('flags.on') : t('flags.off')}
                    </span>
                  ))}
                </p>
              )}
              {edit && (
                <div className="row">
                  <ReasonAction
                    label={f.enabledByDefault ? t('flags.turnOffAll') : t('flags.turnOnAll')}
                    danger={f.enabledByDefault}
                    onConfirm={(reason) => api('PUT', `/v1/admin/feature-flags/${f.key}`, { enabledByDefault: !f.enabledByDefault, reason }).then(reload)}
                  />
                  <ReasonAction
                    label={t('flags.perStore')}
                    extra={
                      <div className="form-grid">
                        <Field label={t('products.store')}>
                          <select value={c.storeId} onChange={(e) => setChoice({ ...choice, [f.key]: { ...c, storeId: e.target.value } })}>
                            {stores.data?.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label={t('common.status')}>
                          <select value={c.value} onChange={(e) => setChoice({ ...choice, [f.key]: { ...c, value: e.target.value } })}>
                            <option value="on">{t('flags.on')}</option>
                            <option value="off">{t('flags.off')}</option>
                            <option value="default">{t('flags.followDefault')}</option>
                          </select>
                        </Field>
                      </div>
                    }
                    onConfirm={(reason) => api('PUT', `/v1/admin/feature-flags/${f.key}/stores/${c.storeId}`, { enabled: c.value === 'default' ? null : c.value === 'on', reason }).then(reload)}
                  />
                </div>
              )}
            </Card>
          </div>
        );
      })}
    </>
  );
}

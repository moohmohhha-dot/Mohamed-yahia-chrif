import { useState } from 'react';
import { api } from '../api';
import { Card, Empty, ErrorBox, Field, Json, Loading, Pager, useLoad } from '../components/ui';
import { useI18n } from '../i18n';

const PAGE = 100;
type Alert = { severity: 'high' | 'medium' | 'info'; code: string; count: number; subject: string | null; lastAt: string };
type Entry = { id: string; action: string; actorType: string; actorName: string | null; actorEmail: string | null; entityType: string; entityId: string; ip: string | null; metadata: Record<string, unknown>; createdAt: string };

/** The audit log: who did what, when and from where. It cannot be changed or deleted, by anyone. */
export function SecurityPage() {
  const { t, date, label } = useI18n();
  const [filters, setFilters] = useState({ action: '', entityType: '', entityId: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page), pageSize: String(PAGE), ...Object.fromEntries(Object.entries(applied).filter(([, v]) => v.trim())) });
  const log = useLoad(() => api<Entry[]>('GET', `/v1/admin/audit-log?${qs}`), [qs.toString()]);
  const presets = ['staff.role', 'identity.user', 'identity.login.failed', 'identity.mfa', 'security.access_denied', 'catalog.product', 'platform.feature_flag', 'merchants.'];
  const alerts = useLoad(() => api<{ alerts: Alert[]; subjects: Record<string, string> }>('GET', '/v1/admin/security/alerts'), []);
  return (
    <>
      <h1>{t('section.security')}</h1>
      <p className="muted">{t('security.intro')}</p>
      <Card title={t('security.alerts')}>
        <ErrorBox error={alerts.error} />
        {!alerts.data ? (
          <Loading />
        ) : alerts.data.alerts.length === 0 ? (
          <p className="muted" data-testid="no-alerts">{t('security.noAlerts')}</p>
        ) : (
          <table data-testid="alerts">
            <tbody>
              {alerts.data.alerts.map((a, i) => (
                <tr key={i}>
                  <td>
                    <span className={`badge badge-${a.severity === 'high' ? 'bad' : a.severity === 'medium' ? 'warn' : 'muted'}`}>{label('severity', a.severity)}</span>
                  </td>
                  <td>
                    <strong>{label('alert', a.code)}</strong>
                    <div className="muted small" dir="ltr">
                      {(a.subject && alerts.data!.subjects[a.subject]) ?? a.subject}
                    </div>
                  </td>
                  <td className="num">{a.count}</td>
                  <td className="small">{date(a.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">{t('security.alertsHint')}</p>
      </Card>
      <Card>
        <form className="form-grid" onSubmit={(e) => (e.preventDefault(), setPage(1), setApplied(filters))}>
          <Field label={t('security.action')} hint={t('security.actionHint')}>
            <input value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} dir="ltr" />
          </Field>
          <Field label={t('security.entityType')}>
            <input value={filters.entityType} onChange={(e) => setFilters({ ...filters, entityType: e.target.value })} dir="ltr" />
          </Field>
          <Field label={t('security.entityId')}>
            <input value={filters.entityId} onChange={(e) => setFilters({ ...filters, entityId: e.target.value })} dir="ltr" />
          </Field>
          <div style={{ alignSelf: 'end' }}>
            <button className="primary">{t('common.search')}</button>
          </div>
        </form>
        <div className="row small" style={{ marginTop: 8 }}>
          {presets.map((p) => (
            <button key={p} className="link" onClick={() => (setPage(1), setFilters({ action: p, entityType: '', entityId: '' }), setApplied({ action: p, entityType: '', entityId: '' }))}>
              {p}
            </button>
          ))}
        </div>
      </Card>
      <ErrorBox error={log.error} />
      {!log.data ? (
        <Loading />
      ) : log.data.length === 0 ? (
        <Empty />
      ) : (
        <Card>
          <table data-testid="audit-log">
            <thead>
              <tr>
                <th>{t('security.when')}</th>
                <th>{t('security.action')}</th>
                <th>{t('security.who')}</th>
                <th>{t('security.what')}</th>
                <th>{t('security.details')}</th>
              </tr>
            </thead>
            <tbody>
              {log.data.map((e) => (
                <tr key={e.id}>
                  <td className="small">{date(e.createdAt)}</td>
                  <td className="small" dir="ltr">
                    {e.action}
                  </td>
                  <td className="small">
                    {e.actorName ?? t('security.system')}
                    <div className="muted" dir="ltr">
                      {e.actorEmail} {e.ip}
                    </div>
                  </td>
                  <td className="small" dir="ltr">
                    {e.entityType}
                    <div className="muted">{e.entityId.slice(0, 13)}</div>
                  </td>
                  <td style={{ maxWidth: 320 }}>
                    <Json value={e.metadata} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={page} setPage={setPage} count={log.data.length} pageSize={PAGE} />
        </Card>
      )}
    </>
  );
}

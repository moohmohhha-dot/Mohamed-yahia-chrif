import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, Empty, ErrorBox, Field, Kv, Loading, Pager, ReasonAction, Tabs, useAction, useLoad } from '../components/ui';
import { useI18n } from '../i18n';

const ROLES = ['super_admin', 'finance_admin', 'support_admin', 'content_admin', 'security_admin', 'operations_admin'] as const;
const PAGE = 50;

type UserRow = { id: string; email: string | null; phone: string | null; displayName: string; country: string | null; status: string; createdAt: string; staffRoles: string[]; merchants: number };
type UserDetail = {
  id: string;
  email: string | null;
  phone: string | null;
  displayName: string;
  locale: string | null;
  country: string | null;
  status: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  createdAt: string;
  staffRoles: string[];
  staffHistory?: { role: string; reason: string; grantedAt: string; revokedAt: string | null; revokeReason: string | null }[];
  merchants: { merchantId: string; name: string; role: string; verificationStatus: string }[];
  orders: { currency: string; count: number; totalMinor: number }[];
  activeSessions: number;
  mfaEnabled: boolean;
  storeCredit?: { currency: string; balanceMinor: number }[];
};

export function UsersPage() {
  const { t, label, date } = useI18n();
  const [params, setParams] = useSearchParams();
  const selected = params.get('id');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'' | 'active' | 'suspended'>('');
  const [staffOnly, setStaffOnly] = useState(false);
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page), pageSize: String(PAGE), ...(search ? { q: search } : {}), ...(status ? { status } : {}), ...(staffOnly ? { staff: 'true' } : {}) });
  const list = useLoad(() => api<UserRow[]>('GET', `/v1/admin/users?${qs}`), [qs.toString(), selected]);
  if (selected) return <UserDetailView userId={selected} onBack={() => setParams({})} />;

  return (
    <>
      <h1>{t('section.users')}</h1>
      <form
        className="row"
        style={{ marginBottom: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setSearch(q.trim());
        }}
      >
        <input style={{ maxWidth: 320 }} placeholder={t('users.search')} aria-label={t('users.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="primary">{t('common.search')}</button>
        <label className="row small">
          <input type="checkbox" style={{ width: 'auto' }} checked={staffOnly} onChange={(e) => (setStaffOnly(e.target.checked), setPage(1))} /> {t('users.staffOnly')}
        </label>
      </form>
      <Tabs value={status} options={['active', 'suspended'] as const} onChange={(v) => (setStatus(v), setPage(1))} prefix="userStatus" allLabel="common.all" />
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
                <th>{t('common.name')}</th>
                <th>{t('users.contact')}</th>
                <th>{t('users.roles')}</th>
                <th>{t('common.status')}</th>
                <th>{t('users.since')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((u) => (
                <tr key={u.id}>
                  <td>
                    <button className="link" onClick={() => setParams({ id: u.id })}>
                      {u.displayName}
                    </button>
                  </td>
                  <td className="small" dir="ltr">
                    {u.email}
                    <div className="muted">{u.phone}</div>
                  </td>
                  <td className="small">
                    {u.staffRoles.map((r) => (
                      <span key={r} className="pill">
                        {label('role', r)}
                      </span>
                    ))}
                    {u.merchants > 0 && <span className="pill">{t('users.merchantMember', { n: u.merchants })}</span>}
                  </td>
                  <td>
                    <Badge prefix="userStatus" value={u.status} />
                  </td>
                  <td className="small">{date(u.createdAt, false)}</td>
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

function UserDetailView({ userId, onBack }: { userId: string; onBack: () => void }) {
  const { t, label, date, money } = useI18n();
  const { can, staff } = useAuth();
  const url = `/v1/admin/users/${userId}`;
  const user = useLoad(() => api<UserDetail>('GET', url), [url]);
  const [role, setRole] = useState<(typeof ROLES)[number]>('support_admin');
  if (user.error) return <ErrorBox error={user.error} />;
  if (!user.data) return <Loading />;
  const u = user.data;
  const self = u.id === staff!.id;
  const reload = () => void user.reload();

  return (
    <>
      <div className="topbar">
        <h1 className="row">
          {u.displayName} <Badge prefix="userStatus" value={u.status} />
        </h1>
        <button className="link" onClick={onBack}>
          {t('users.back')}
        </button>
      </div>
      <div className="split">
        <Card title={t('users.profile')}>
          <Kv
            rows={[
              [t('users.email'), <span dir="ltr">{u.email} {u.email && (u.emailVerified ? '✓' : '')}</span>],
              [t('users.phone'), <span dir="ltr">{u.phone}</span>],
              [t('users.country'), u.country],
              [t('users.since'), date(u.createdAt)],
              [t('users.sessions'), u.activeSessions],
              [t('mfa.title'), u.mfaEnabled ? t('mfa.on') : t('mfa.off')],
              [t('users.orders'), u.orders.length ? u.orders.map((o) => `${o.count} · ${money(o.totalMinor, o.currency)}`).join(' / ') : '0'],
              ...(u.storeCredit ? ([[t('users.storeCredit'), u.storeCredit.map((c) => money(c.balanceMinor, c.currency)).join(' / ') || '0']] as [string, string][]) : []),
            ]}
          />
        </Card>
        <Card title={t('users.merchants')}>
          {u.merchants.length === 0 ? (
            <Empty />
          ) : (
            <table>
              <tbody>
                {u.merchants.map((m) => (
                  <tr key={m.merchantId}>
                    <td>{m.name}</td>
                    <td>{label('merchantRole', m.role)}</td>
                    <td>
                      <Badge prefix="verificationStatus" value={m.verificationStatus} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {!self && (can('users.manage') || can('security.manage')) && (
        <Card title={t('users.actions')}>
          <div className="row">
            {can('users.manage') && u.status === 'active' && (
              <ReasonAction label={t('users.suspend')} danger onConfirm={(reason) => api('POST', `${url}/suspend`, { reason }).then(reload)} />
            )}
            {can('users.manage') && u.status === 'suspended' && (
              <ReasonAction label={t('users.reactivate')} onConfirm={(reason) => api('POST', `${url}/reactivate`, { reason }).then(reload)} />
            )}
            {can('security.manage') && u.mfaEnabled && (
              <ReasonAction label={t('mfa.reset')} danger onConfirm={(reason) => api('POST', `${url}/mfa/reset`, { reason }).then(reload)} />
            )}
            {can('security.manage') && u.activeSessions > 0 && (
              <ReasonAction label={t('users.endSessions')} onConfirm={(reason) => api('POST', `${url}/sessions/end`, { reason }).then(reload)} />
            )}
          </div>
          <p className="muted small">{t('users.actionsHint')}</p>
        </Card>
      )}

      {(u.staffRoles.length > 0 || can('staff.manage')) && (
        <Card title={t('users.staffRoles')}>
          <div className="row" style={{ marginBottom: 8 }}>
            {u.staffRoles.length === 0 && <span className="muted">{t('users.noRole')}</span>}
            {u.staffRoles.map((r) => (
              <span key={r} className="row pill">
                {label('role', r)}
                {can('staff.manage') && !(self && r === 'super_admin') && (
                  <ReasonAction label={t('users.revoke')} danger onConfirm={(reason) => api('POST', `${url}/staff-roles/${r}/revoke`, { reason }).then(reload)} />
                )}
              </span>
            ))}
          </div>
          {can('staff.manage') && u.status === 'active' && (
            <ReasonAction
              label={t('users.grant')}
              extra={
                <Field label={t('users.role')}>
                  <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                    {ROLES.filter((r) => !u.staffRoles.includes(r)).map((r) => (
                      <option key={r} value={r}>
                        {label('role', r)}
                      </option>
                    ))}
                  </select>
                </Field>
              }
              onConfirm={(reason) => api('POST', `${url}/staff-roles`, { role, reason }).then(reload)}
            />
          )}
          {u.staffHistory && u.staffHistory.length > 0 && (
            <>
              <h3>{t('users.roleHistory')}</h3>
              <table>
                <tbody>
                  {u.staffHistory.map((h, i) => (
                    <tr key={i}>
                      <td>{label('role', h.role)}</td>
                      <td className="small">
                        {date(h.grantedAt)} · {h.reason}
                      </td>
                      <td className="small">{h.revokedAt ? `${date(h.revokedAt)} · ${h.revokeReason}` : <Badge prefix="userStatus" value="active" />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Card>
      )}
    </>
  );
}

type StaffData = {
  roles: Record<string, string[]>;
  active: { id: string; userId: string; displayName: string; email: string | null; userStatus: string; role: string; reason: string; grantedAt: string; grantedByName: string | null }[];
  history: { id: string; displayName: string; role: string; reason: string; grantedAt: string; grantedByName: string | null; revokedAt: string | null; revokedByName: string | null; revokeReason: string | null }[];
};

/** Who is ARUMA staff, what each role may do, and every grant and removal. */
export function StaffPage() {
  const { t, label, date } = useI18n();
  const { can } = useAuth();
  const navigate = useNavigate();
  const data = useLoad(() => api<StaffData>('GET', '/v1/admin/staff'), []);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<(typeof ROLES)[number]>('support_admin');
  const [reason, setReason] = useState('');
  const action = useAction();
  if (data.error) return <ErrorBox error={data.error} />;
  if (!data.data) return <Loading />;
  const d = data.data;
  const permissions = d.roles.super_admin ?? []; // every permission, in the server's logical order

  return (
    <>
      <h1>{t('section.staff')}</h1>
      {can('staff.manage') && (
        <Card title={t('staff.add')}>
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                const found = await api<UserRow[]>('GET', `/v1/admin/users?q=${encodeURIComponent(email.trim())}`);
                const user = found.find((u) => u.email?.toLowerCase() === email.trim().toLowerCase());
                if (!user) throw new Error(t('staff.noAccount'));
                await api('POST', `/v1/admin/users/${user.id}/staff-roles`, { role, reason: reason.trim() });
                setEmail('');
                setReason('');
                await data.reload();
              });
            }}
          >
            <Field label={t('users.email')} hint={t('staff.emailHint')}>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label={t('users.role')}>
              <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {label('role', r)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('common.reason')}>
              <input required minLength={5} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div style={{ alignSelf: 'end' }}>
              <button className="primary" disabled={action.pending}>
                {t('users.grant')}
              </button>
            </div>
          </form>
          <ErrorBox error={action.error} />
        </Card>
      )}
      <Card title={t('staff.active')}>
        <table data-testid="staff-active">
          <tbody>
            {d.active.map((g) => (
              <tr key={g.id}>
                <td>
                  <button className="link" onClick={() => navigate(`/users?id=${g.userId}`)}>
                    {g.displayName}
                  </button>
                  <div className="muted small" dir="ltr">
                    {g.email}
                  </div>
                </td>
                <td>{label('role', g.role)}</td>
                <td className="small">
                  {date(g.grantedAt, false)} · {g.grantedByName ?? t('staff.serverConsole')}
                  <div className="muted">{g.reason}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">{t('staff.openUser')}</p>
      </Card>
      <Card title={t('staff.matrix')}>
        <div style={{ overflowX: 'auto' }}>
          <table className="matrix small">
            <thead>
              <tr>
                <th />
                {ROLES.map((r) => (
                  <th key={r}>{label('role', r)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {permissions.map((p) => (
                <tr key={p}>
                  <td>{label('permission', p)}</td>
                  {ROLES.map((r) => (
                    <td key={r}>{d.roles[r]?.includes(p) ? '✓' : ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title={t('users.roleHistory')}>
        <table>
          <tbody>
            {d.history.map((h) => (
              <tr key={h.id}>
                <td>{h.displayName}</td>
                <td>{label('role', h.role)}</td>
                <td className="small">
                  + {date(h.grantedAt)} · {h.grantedByName ?? t('staff.serverConsole')} · {h.reason}
                  {h.revokedAt && (
                    <div>
                      − {date(h.revokedAt)} · {h.revokedByName} · {h.revokeReason}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

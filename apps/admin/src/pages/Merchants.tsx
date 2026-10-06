import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, download } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, Empty, ErrorBox, Kv, Loading, Pager, ReasonAction, Tabs, useLoad } from '../components/ui';
import { useI18n } from '../i18n';

const STATUSES = ['under_review', 'verified', 'unverified', 'suspended'] as const;
const PAGE = 50;
type Merchant = { id: string; type: string; slug: string; name: string; country: string; activityCode: string; contactEmail: string | null; contactPhone: string | null; status: string; verificationStatus: string; suspendedAt: string | null; suspensionReason: string | null; createdAt: string };
type Check = { kind: string; required: boolean; status: string; note: string | null; submittedAt: string | null; reviewedAt: string | null; missing: { fields: string[]; documents: string[] } };
type MerchantFile = {
  merchant: Merchant;
  identity: { fullName: string; dateOfBirth: string; nationality: string; documentType: string; documentNumberLast4: string; documentNumber?: string } | null;
  business: { legalName: string; legalForm: string; registrationType: string; registrationNumber: string; taxId: string | null } | null;
  addresses: { line1: string; city: string; region: string | null; country: string }[];
  payoutMethod: { type: string; holderName: string; institutionName: string | null; currency: string; accountNumberLast4: string; accountNumber?: string } | null;
  documents: { id: string; kind: string; fileName: string | null; contentType: string; createdAt: string }[];
  verification: { status: string; suspended: { at: string; reason: string } | null; checks: Check[] };
};
type StoreLink = { storeId: string; slug: string; name: string; status: string; commissionBps: number | null };
type Balance = { currency: string; pendingMinor: number; availableMinor: number; settledMinor: number; totalOwedMinor: number };

function MerchantList({ fixedStatus }: { fixedStatus?: (typeof STATUSES)[number] }) {
  const { t, label, date } = useI18n();
  const [params, setParams] = useSearchParams();
  const selected = params.get('id');
  const [status, setStatus] = useState<(typeof STATUSES)[number] | ''>(fixedStatus ?? '');
  const [page, setPage] = useState(1);
  const list = useLoad(
    () => api<Merchant[]>('GET', `/v1/admin/merchants?page=${page}&pageSize=${PAGE}${status ? `&verificationStatus=${status}` : ''}`),
    [status, page, selected],
  );
  if (selected) return <MerchantDetail merchantId={selected} onBack={() => setParams({})} />;
  return (
    <>
      <h1>{t(fixedStatus ? 'section.verification' : 'section.merchants')}</h1>
      {fixedStatus ? <p className="muted">{t('verification.intro')}</p> : <Tabs value={status} options={STATUSES} onChange={(v) => (setStatus(v), setPage(1))} prefix="verificationStatus" allLabel="common.all" />}
      <ErrorBox error={list.error} />
      {!list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <Empty>{fixedStatus ? t('verification.empty') : undefined}</Empty>
      ) : (
        <Card>
          <table>
            <thead>
              <tr>
                <th>{t('common.name')}</th>
                <th>{t('merchants.type')}</th>
                <th>{t('merchants.contact')}</th>
                <th>{t('common.status')}</th>
                <th>{t('users.since')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((m) => (
                <tr key={m.id}>
                  <td>
                    <button className="link" onClick={() => setParams({ id: m.id })}>
                      {m.name}
                    </button>
                    <div className="muted small">{m.slug}</div>
                  </td>
                  <td>{label('merchantType', m.type)}</td>
                  <td className="small" dir="ltr">
                    {m.contactEmail}
                    <div className="muted">{m.contactPhone}</div>
                  </td>
                  <td>
                    <Badge prefix="verificationStatus" value={m.verificationStatus} />
                  </td>
                  <td className="small">{date(m.createdAt, false)}</td>
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

export const MerchantsPage = () => <MerchantList />;
/** The verification queue: merchants waiting for ARUMA to check their identity, business and payout account. */
export const VerificationPage = () => <MerchantList fixedStatus="under_review" />;

function MerchantDetail({ merchantId, onBack }: { merchantId: string; onBack: () => void }) {
  const { t, label, date, money } = useI18n();
  const { can } = useAuth();
  const url = `/v1/admin/merchants/${merchantId}`;
  const file = useLoad(() => api<MerchantFile>('GET', url), [url]);
  const stores = useLoad(() => api<StoreLink[]>('GET', `${url}/stores`), [url]);
  const balances = useLoad(() => (can('finance.read') ? api<{ balances: Balance[] }>('GET', `/v1/admin/finance/merchants/${merchantId}`) : Promise.resolve(null)), [merchantId]);
  const [bps, setBps] = useState<Record<string, string>>({});
  if (file.error) return <ErrorBox error={file.error} />;
  if (!file.data) return <Loading />;
  const f = file.data;
  const m = f.merchant;
  const reload = () => void file.reload();
  const review = can('verification.review');

  return (
    <>
      <div className="topbar">
        <h1 className="row">
          {m.name} <Badge prefix="verificationStatus" value={f.verification.status} />
        </h1>
        <button className="link" onClick={onBack}>
          {t('merchants.back')}
        </button>
      </div>
      {f.verification.suspended && (
        <div className="alert alert-bad">
          {t('merchants.suspendedSince', { date: date(f.verification.suspended.at) })} — {f.verification.suspended.reason}
        </div>
      )}
      <div className="split">
        <Card title={t('merchants.profile')}>
          <Kv
            rows={[
              [t('merchants.type'), label('merchantType', m.type)],
              [t('merchants.activity'), m.activityCode],
              [t('users.country'), m.country],
              [t('users.email'), <span dir="ltr">{m.contactEmail}</span>],
              [t('users.phone'), <span dir="ltr">{m.contactPhone}</span>],
              [t('merchants.address'), f.addresses.map((a) => `${a.line1}, ${a.city}${a.region ? `, ${a.region}` : ''}`).join(' / ')],
              [t('users.since'), date(m.createdAt)],
            ]}
          />
        </Card>
        <Card title={t('merchants.identity')}>
          <Kv
            rows={[
              [t('merchants.fullName'), f.identity?.fullName],
              [t('merchants.document'), f.identity && `${label('documentType', f.identity.documentType)} · ${f.identity.documentNumber ?? `••••${f.identity.documentNumberLast4}`}`],
              [t('merchants.business'), f.business && `${f.business.legalName} (${f.business.legalForm}) · ${f.business.registrationNumber}`],
              [t('merchants.payout'), f.payoutMethod && `${label('payoutType', f.payoutMethod.type)} · ${f.payoutMethod.holderName} · ${f.payoutMethod.accountNumber ?? `••••${f.payoutMethod.accountNumberLast4}`}`],
            ]}
          />
          {!review && <p className="muted small">{t('merchants.masked')}</p>}
        </Card>
      </div>

      <Card title={t('merchants.checks')}>
        <table data-testid="checks">
          <tbody>
            {f.verification.checks
              .filter((c) => c.required || c.status !== 'unverified')
              .map((c) => (
                <tr key={c.kind}>
                  <td>{label('check', c.kind)}</td>
                  <td>
                    <Badge prefix="verificationStatus" value={c.status} />
                    {c.note && <div className="muted small">{c.note}</div>}
                  </td>
                  <td className="small">{c.submittedAt && t('merchants.submitted', { date: date(c.submittedAt) })}</td>
                  <td>
                    {review && c.status === 'under_review' && (
                      <div className="row">
                        <button className="primary" onClick={() => void api('POST', `${url}/verifications/${c.kind}`, { decision: 'approve' }).then(reload)}>
                          {t('merchants.approve')}
                        </button>
                        <ReasonAction label={t('merchants.reject')} danger reasonLabel={t('merchants.rejectNote')} onConfirm={(note) => api('POST', `${url}/verifications/${c.kind}`, { decision: 'reject', note }).then(reload)} />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {review && f.documents.length > 0 && (
          <>
            <h3>{t('merchants.documents')}</h3>
            <div className="row">
              {f.documents.map((d) => (
                <button key={d.id} onClick={() => void download(`${url}/documents/${d.id}/file`, d.fileName ?? d.kind)}>
                  {label('documentKind', d.kind)}
                </button>
              ))}
            </div>
            <p className="muted small">{t('merchants.documentsAudited')}</p>
          </>
        )}
      </Card>

      <div className="split">
        <Card title={t('merchants.stores')}>
          {!stores.data || stores.data.length === 0 ? (
            <Empty />
          ) : (
            <table>
              <tbody>
                {stores.data.map((s) => (
                  <tr key={s.storeId}>
                    <td>{s.name}</td>
                    <td>{s.commissionBps === null ? t('merchants.defaultCommission') : `${s.commissionBps / 100} %`}</td>
                    <td>
                      {can('commission.manage') && (
                        <form
                          className="row"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const v = bps[s.storeId]?.trim();
                            void api('PUT', `/v1/admin/stores/${s.slug}/merchants/${merchantId}`, { commissionBps: v ? Math.round(Number(v) * 100) : null }).then(() => stores.reload());
                          }}
                        >
                          <input style={{ width: 90 }} inputMode="decimal" placeholder="%" aria-label={t('merchants.commission')} value={bps[s.storeId] ?? ''} onChange={(e) => setBps({ ...bps, [s.storeId]: e.target.value })} />
                          <button>{t('common.save')}</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {can('commission.manage') && <p className="muted small">{t('merchants.commissionHint')}</p>}
        </Card>
        {balances.data && (
          <Card title={t('merchants.balance')}>
            <table>
              <tbody>
                {balances.data.balances.map((b) => (
                  <tr key={b.currency}>
                    <td className="small">
                      {t('balance.pending')}: {money(b.pendingMinor, b.currency)}
                      <br />
                      {t('balance.available')}: {money(b.availableMinor, b.currency)}
                      <br />
                      {t('balance.settled')}: {money(b.settledMinor, b.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {can('merchants.manage') && (
        <Card title={t('users.actions')}>
          {m.suspendedAt ? (
            <button onClick={() => void api('POST', `${url}/unsuspend`).then(reload)}>{t('merchants.unsuspend')}</button>
          ) : (
            <ReasonAction label={t('merchants.suspend')} danger onConfirm={(reason) => api('POST', `${url}/suspend`, { reason }).then(reload)} />
          )}
          <p className="muted small">{t('merchants.suspendHint')}</p>
        </Card>
      )}
    </>
  );
}


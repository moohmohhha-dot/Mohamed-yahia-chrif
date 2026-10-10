import { useState, type FormEvent } from 'react';
import { api, download } from '../api';
import { ErrorBox, Field, Loading, StatusBadge, useAction, useLoad } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { can, useMerchant } from '../merchant-context';

type Check = {
  kind: 'phone' | 'email' | 'identity' | 'business' | 'payout';
  required: boolean;
  status: string;
  note: string | null;
  missing: { fields: string[]; documents: string[] };
  ready: boolean;
};
type Overview = { status: string; type: 'individual' | 'business'; suspended: { reason: string } | null; checks: Check[] };
type Doc = { id: string; kind: string; fileName: string | null; createdAt: string };
type Profile = {
  merchant: { contactPhone: string | null; contactEmail: string | null };
  identity: Record<string, string> | null;
  business: Record<string, string> | null;
  addresses: { kind: string; line1: string; line2: string | null; city: string; region: string; postalCode: string | null; country: string }[];
  payoutMethod: Record<string, string> | null;
  documents: Doc[];
};

export function VerificationPage() {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const overview = useLoad(() => api<Overview>('GET', `/v1/merchants/${merchant.id}/verification`), [merchant.id]);
  const canSeeFile = can(merchant.role, 'manageTeam');
  const profile = useLoad(
    () => (canSeeFile ? api<Profile>('GET', `/v1/merchants/${merchant.id}/profile`) : Promise.resolve(null)),
    [merchant.id, canSeeFile],
  );
  const refresh = async () => {
    await Promise.all([overview.reload(), profile.reload()]);
    merchant.refresh();
  };

  if (overview.error) return <ErrorBox error={overview.error} />;
  if (!overview.data) return <Loading />;
  const o = overview.data;
  return (
    <>
      <h1>{t('section.verification')}</h1>
      <div className="row" style={{ marginBottom: 16 }}>
        <strong>{t('verif.overall')}:</strong> <StatusBadge status={o.status} />
        <span className="muted">· {t(`merchants.type.${o.type}` as MessageKey)}</span>
      </div>
      {o.suspended && <div className="alert alert-bad">{o.suspended.reason}</div>}
      {o.checks.map((check) => (
        <details className="check" key={check.kind} open={check.required && check.status !== 'verified'} data-testid={`check-${check.kind}`}>
          <summary>
            <strong>{t(`check.${check.kind}` as MessageKey)}</strong>
            <span className="row">
              <span className="muted small">{check.required ? t('verif.required') : t('verif.optional')}</span>
              <StatusBadge status={check.status} />
            </span>
          </summary>
          <div className="stack" style={{ marginTop: 12 }}>
            {check.note && (
              <div className="alert alert-warn">
                {t('verif.note')}: {check.note}
              </div>
            )}
            {check.status === 'unverified' && (check.missing.fields.length > 0 || check.missing.documents.length > 0) && (
              <p className="missing">
                {t('verif.missing')}:{' '}
                {[...check.missing.fields.map((f) => t(`field.${f}` as MessageKey)), ...check.missing.documents.map((d) => t(`doc.${d}` as MessageKey))].join(locale === 'ar' ? '، ' : ', ')}
              </p>
            )}
            {canSeeFile && profile.data !== undefined && (
              <CheckBody check={check} type={o.type} profile={profile.data} onChange={refresh} />
            )}
          </div>
        </details>
      ))}
    </>
  );
}

function CheckBody({ check, type, profile, onChange }: { check: Check; type: Overview['type']; profile: Profile | null; onChange: () => Promise<void> }) {
  const { t } = useI18n();
  const merchant = useMerchant();
  const owner = can(merchant.role, 'ownerOnly');
  if (!profile) return <Loading />;
  const address = profile.addresses.find((a) => a.kind === 'registered');
  const addressHere = (check.kind === 'identity' && type === 'individual') || (check.kind === 'business' && type === 'business');

  if (check.kind === 'phone' || check.kind === 'email') {
    const target = check.kind === 'phone' ? profile.merchant.contactPhone : profile.merchant.contactEmail;
    return <CodeVerification kind={check.kind} target={target} status={check.status} onChange={onChange} />;
  }

  const docKinds: Record<string, string[]> = {
    identity: ['id_front', 'id_back', 'selfie'],
    business: [
      profile.business?.registrationType === 'auto_entrepreneur'
        ? 'auto_entrepreneur_card'
        : profile.business?.registrationType === 'craft_register'
          ? 'craft_register_card'
          : 'commercial_register',
      ...(type === 'business' ? ['tax_id_card', 'articles_of_association'] : []),
    ],
    payout: ['payout_proof'],
  };
  const docOwnerOnly = check.kind !== 'business';

  return (
    <>
      {!owner && check.kind !== 'business' && <p className="muted small">{t('verif.ownerOnly')}</p>}
      {check.kind === 'identity' && owner && <IdentityForm current={profile.identity} onChange={onChange} />}
      {check.kind === 'business' && owner && <BusinessForm current={profile.business} type={type} onChange={onChange} />}
      {check.kind === 'payout' && owner && <PayoutForm current={profile.payoutMethod} onChange={onChange} />}
      {addressHere && <AddressForm current={address} onChange={onChange} />}
      {(owner || !docOwnerOnly) && (
        <>
          <h3>{t('verif.documents')}</h3>
          {docKinds[check.kind]!.map((kind) => (
            <DocumentRow key={kind} kind={kind} current={profile.documents.find((d) => d.kind === kind)} onChange={onChange} />
          ))}
        </>
      )}
      {owner && check.status === 'unverified' && (
        <SubmitCheck kind={check.kind} ready={check.ready} onChange={onChange} />
      )}
    </>
  );
}

function CodeVerification({ kind, target, status, onChange }: { kind: 'phone' | 'email'; target: string | null; status: string; onChange: () => Promise<void> }) {
  const { t } = useI18n();
  const merchant = useMerchant();
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const action = useAction();
  const base = `/v1/merchants/${merchant.id}/verifications/${kind}`;
  if (!target) return null;
  return (
    <div className="stack">
      <p dir="ltr" style={{ textAlign: 'start' }}>{target}</p>
      {status !== 'verified' && status !== 'suspended' && (
        <div className="row">
          <button disabled={action.pending} onClick={() => void action.run(async () => (await api('POST', `${base}/send-code`), setSent(true)))}>
            {t('verif.sendCode')}
          </button>
          {sent && <span className="muted small">{t('verif.codeSent', { to: target })}</span>}
        </div>
      )}
      {sent && status !== 'verified' && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await api('POST', `${base}/confirm`, { code });
              setSent(false);
              await onChange();
            });
          }}
        >
          <input aria-label={t('verif.code')} placeholder={t('verif.code')} inputMode="numeric" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 160 }} dir="ltr" />
          <button className="primary" disabled={action.pending || code.length !== 6}>
            {t('verif.confirm')}
          </button>
        </form>
      )}
      <ErrorBox error={action.error} />
    </div>
  );
}

type FieldSpec = { name: string; label: MessageKey; type?: 'text' | 'date' | 'select'; options?: { value: string; label: MessageKey | string }[]; required?: boolean; ltr?: boolean };

/** Small declarative form: fields → PUT body. Empty optional fields are omitted. */
/** `secret` fields (ID or account numbers) are cleared after saving, so they do not linger on screen. */
function SimpleForm({ fields, initial, method, path, onChange, secret = [] }: { fields: FieldSpec[]; initial: Record<string, string>; method: 'PUT' | 'PATCH'; path: string; onChange: () => Promise<void>; secret?: string[] }) {
  const { t } = useI18n();
  const [values, setValues] = useState(initial);
  const action = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '' && v !== undefined));
    void action.run(async () => {
      await api(method, path, body);
      setValues((v) => ({ ...v, ...Object.fromEntries(secret.map((k) => [k, ''])) }));
      await onChange();
    });
  };
  return (
    <form className="stack" onSubmit={submit}>
      <div className="form-grid">
        {fields.map((f) => (
          <Field key={f.name} label={`${t(f.label)}${f.required ? '' : ` (${t('common.optional')})`}`}>
            {f.type === 'select' ? (
              <select value={values[f.name] ?? ''} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
                {f.options!.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label.includes('.') ? t(o.label as MessageKey) : o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                name={f.name}
                type={f.type ?? 'text'}
                required={f.required}
                value={values[f.name] ?? ''}
                dir={f.ltr ? 'ltr' : undefined}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
              />
            )}
          </Field>
        ))}
      </div>
      <ErrorBox error={action.error} />
      {action.done && <span className="muted small">{t('common.saved')}</span>}
      <div>
        <button disabled={action.pending}>{t('common.save')}</button>
      </div>
    </form>
  );
}

const COUNTRIES = [{ value: 'DZ', label: 'DZ' }, { value: 'FR', label: 'FR' }];

function IdentityForm({ current, onChange }: { current: Record<string, string> | null; onChange: () => Promise<void> }) {
  const { t } = useI18n();
  const merchant = useMerchant();
  return (
    <>
      <h3>{t('field.identity')}</h3>
      {current && <p className="muted small">{t('field.documentNumber')}: {t('verif.masked', { last4: current.documentNumberLast4 ?? '' })}</p>}
      <SimpleForm
        method="PUT"
        path={`/v1/merchants/${merchant.id}/identity`}
        secret={['documentNumber']}
        onChange={onChange}
        initial={{
          fullName: current?.fullName ?? '',
          dateOfBirth: current?.dateOfBirth ?? '',
          nationality: current?.nationality ?? 'DZ',
          documentType: current?.documentType ?? 'national_id',
          documentNumber: '',
          documentExpiry: current?.documentExpiry ?? '',
        }}
        fields={[
          { name: 'fullName', label: 'field.fullName', required: true },
          { name: 'dateOfBirth', label: 'field.dateOfBirth', type: 'date', required: true },
          { name: 'nationality', label: 'field.nationality', type: 'select', options: COUNTRIES, required: true },
          {
            name: 'documentType',
            label: 'field.documentType',
            type: 'select',
            required: true,
            options: ['national_id', 'passport', 'driving_license'].map((v) => ({ value: v, label: `docType.${v}` })),
          },
          { name: 'documentNumber', label: 'field.documentNumber', required: true, ltr: true },
          { name: 'documentExpiry', label: 'field.documentExpiry', type: 'date' },
        ]}
      />
    </>
  );
}

function AddressForm({ current, onChange }: { current: Profile['addresses'][number] | undefined; onChange: () => Promise<void> }) {
  const { t } = useI18n();
  const merchant = useMerchant();
  return (
    <>
      <h3>{t('verif.address')}</h3>
      <SimpleForm
        method="PUT"
        path={`/v1/merchants/${merchant.id}/address`}
        onChange={onChange}
        initial={{
          line1: current?.line1 ?? '',
          line2: current?.line2 ?? '',
          city: current?.city ?? '',
          region: current?.region ?? '',
          postalCode: current?.postalCode ?? '',
          country: current?.country ?? 'DZ',
        }}
        fields={[
          { name: 'line1', label: 'field.line1', required: true },
          { name: 'line2', label: 'field.line2' },
          { name: 'city', label: 'field.city', required: true },
          { name: 'region', label: 'field.region', required: true },
          { name: 'postalCode', label: 'field.postalCode', ltr: true },
          { name: 'country', label: 'merchants.country', type: 'select', options: COUNTRIES, required: true },
        ]}
      />
    </>
  );
}

function BusinessForm({ current, type, onChange }: { current: Record<string, string> | null; type: Overview['type']; onChange: () => Promise<void> }) {
  const { t } = useI18n();
  const merchant = useMerchant();
  const company = type === 'business';
  return (
    <>
      <h3>{t('field.business')}</h3>
      <SimpleForm
        method="PUT"
        path={`/v1/merchants/${merchant.id}/business`}
        onChange={onChange}
        initial={{
          registrationType: current?.registrationType ?? (company ? 'commercial_register' : 'auto_entrepreneur'),
          registrationNumber: current?.registrationNumber ?? '',
          legalName: current?.legalName ?? '',
          legalForm: current?.legalForm ?? '',
          taxId: current?.taxId ?? '',
          statisticalId: current?.statisticalId ?? '',
          taxArticleNumber: current?.taxArticleNumber ?? '',
        }}
        fields={[
          {
            name: 'registrationType',
            label: 'field.registrationType',
            type: 'select',
            required: true,
            options: ['commercial_register', 'auto_entrepreneur', 'craft_register'].map((v) => ({ value: v, label: `reg.${v}` })),
          },
          { name: 'registrationNumber', label: 'field.registrationNumber', required: true, ltr: true },
          { name: 'legalName', label: 'field.legalName', required: company },
          { name: 'legalForm', label: 'field.legalForm', required: company },
          { name: 'taxId', label: 'field.taxId', required: company, ltr: true },
          { name: 'statisticalId', label: 'field.statisticalId', ltr: true },
          { name: 'taxArticleNumber', label: 'field.taxArticleNumber', ltr: true },
        ]}
      />
    </>
  );
}

function PayoutForm({ current, onChange }: { current: Record<string, string> | null; onChange: () => Promise<void> }) {
  const { t } = useI18n();
  const merchant = useMerchant();
  return (
    <>
      <h3>{t('field.payoutMethod')}</h3>
      {current && (
        <p className="muted small">
          {current.holderName} · {t('verif.masked', { last4: current.accountNumberLast4 ?? '' })}
        </p>
      )}
      <SimpleForm
        method="PUT"
        path={`/v1/merchants/${merchant.id}/payout-method`}
        secret={['accountNumber']}
        onChange={onChange}
        initial={{
          type: current?.type ?? 'bank_account',
          holderName: current?.holderName ?? '',
          accountNumber: '',
          institutionName: current?.institutionName ?? '',
          currency: current?.currency ?? 'DZD',
        }}
        fields={[
          {
            name: 'type',
            label: 'field.payoutType',
            type: 'select',
            required: true,
            options: ['bank_account', 'postal_account'].map((v) => ({ value: v, label: `payoutType.${v}` })),
          },
          { name: 'holderName', label: 'field.holderName', required: true },
          { name: 'accountNumber', label: 'field.accountNumber', required: true, ltr: true },
          { name: 'institutionName', label: 'field.institutionName' },
          { name: 'currency', label: 'field.currency', type: 'select', required: true, options: [{ value: 'DZD', label: 'DZD' }, { value: 'EUR', label: 'EUR' }] },
        ]}
      />
    </>
  );
}

function DocumentRow({ kind, current, onChange }: { kind: string; current: Doc | undefined; onChange: () => Promise<void> }) {
  const { t } = useI18n();
  const merchant = useMerchant();
  const action = useAction();
  const upload = (file: File) =>
    action.run(async () => {
      const form = new FormData();
      form.append('file', file);
      await api('POST', `/v1/merchants/${merchant.id}/documents?kind=${kind}`, form);
      await onChange();
    });
  return (
    <div className="row" style={{ justifyContent: 'space-between', borderBottom: '1px solid var(--border)', padding: '6px 0' }}>
      <span>{t(`doc.${kind}` as MessageKey)}</span>
      <span className="row">
        {current && (
          <button className="link" onClick={() => void download(`/v1/merchants/${merchant.id}/documents/${current.id}/file`, current.fileName ?? current.id)}>
            {t('verif.current')}
          </button>
        )}
        <label className="row">
          <span className="muted small">{t('common.upload')}</span>
          <input
            type="file"
            aria-label={t(`doc.${kind}` as MessageKey)}
            data-doc={kind}
            accept="application/pdf,image/jpeg,image/png,image/webp"
            disabled={action.pending}
            onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
            style={{ maxWidth: 220 }}
          />
        </label>
      </span>
      <ErrorBox error={action.error} />
    </div>
  );
}

function SubmitCheck({ kind, ready, onChange }: { kind: string; ready: boolean; onChange: () => Promise<void> }) {
  const { t } = useI18n();
  const merchant = useMerchant();
  const action = useAction();
  return (
    <div className="row">
      <button
        className="primary"
        disabled={!ready || action.pending}
        onClick={() =>
          void action.run(async () => {
            await api('POST', `/v1/merchants/${merchant.id}/verifications/${kind}/submit`);
            await onChange();
          })
        }
      >
        {t('common.submit')}
      </button>
      {ready && <span className="muted small">{t('verif.ready')}</span>}
      <ErrorBox error={action.error} />
    </div>
  );
}

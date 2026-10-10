import { useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api';
import { Card, ErrorBox, Field, Loading, useAction, useLoad } from '../components/ui';
import { useI18n } from '../i18n';

type Status = { enabled: boolean; recoveryCodesLeft: number; sessionVerified: boolean };

/** The signed-in person's own security: password and two-step verification (recommended for owners and managers). */
export function AccountSecurity() {
  const { t } = useI18n();
  const status = useLoad(() => api<Status>('GET', '/v1/me/mfa'), []);
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'off' | 'renew' | null>(null);
  const [pw, setPw] = useState({ current: '', next: '' });
  const action = useAction();
  const pwAction = useAction();
  const reset = () => (setCode(''), setPassword(''), setMode(null), setSetup(null));
  if (!status.data) return <Card title={t('settings.security')}>{status.error ? <ErrorBox error={status.error} /> : <Loading />}</Card>;
  const s = status.data;

  return (
    <Card title={t('settings.security')}>
      <h3 style={{ marginTop: 0 }}>
        {t('mfa.title')} · <span className={`badge badge-${s.enabled ? 'good' : 'muted'}`}>{s.enabled ? t('mfa.on') : t('mfa.off')}</span>
      </h3>
      <p className="muted small">{t('mfa.optionalIntro')}</p>
      {codes && (
        <div className="stack">
          <p className="small">{t('mfa.recoveryIntro')}</p>
          <pre data-testid="recovery-codes" dir="ltr" style={{ background: 'var(--bg)', padding: 8, borderRadius: 8 }}>
            {codes.join('\n')}
          </pre>
          <div>
            <button onClick={() => setCodes(null)}>{t('common.close')}</button>
          </div>
        </div>
      )}
      {!codes && !s.enabled && !setup && (
        <button
          className="primary"
          disabled={action.pending}
          onClick={() =>
            void action.run(async () => {
              const data = await api<{ secret: string; otpauthUri: string }>('POST', '/v1/me/mfa/setup');
              setSetup({ secret: data.secret, qr: await QRCode.toDataURL(data.otpauthUri, { margin: 1, width: 200 }) });
            })
          }
        >
          {t('mfa.turnOn')}
        </button>
      )}
      {setup && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              const res = await api<{ recoveryCodes: string[] }>('POST', '/v1/me/mfa/enable', { code: code.trim() });
              reset();
              setCodes(res.recoveryCodes);
              await status.reload();
            });
          }}
        >
          <ol className="small" style={{ paddingInlineStart: 18, margin: 0 }}>
            <li>{t('mfa.step1')}</li>
            <li>{t('mfa.step2')}</li>
            <li>{t('mfa.step3')}</li>
          </ol>
          <img src={setup.qr} alt={t('mfa.qr')} width={200} height={200} style={{ background: '#fff', padding: 6, borderRadius: 8 }} />
          <Field label={t('mfa.key')} hint={t('mfa.keyHint')}>
            <input readOnly value={setup.secret.replace(/(.{4})/g, '$1 ').trim()} dir="ltr" data-testid="mfa-secret" />
          </Field>
          <Field label={t('mfa.code')}>
            <input required inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" />
          </Field>
          <div className="row">
            <button className="primary" disabled={action.pending}>
              {t('mfa.turnOn')}
            </button>
            <button type="button" onClick={reset}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}
      {!codes && s.enabled && (
        <>
          <p className="small">{t('mfa.codesLeft', { n: s.recoveryCodesLeft })}</p>
          {mode === null ? (
            <div className="row">
              <button onClick={() => setMode('renew')}>{t('mfa.newCodes')}</button>
              <button className="danger" onClick={() => setMode('off')}>
                {t('mfa.turnOff')}
              </button>
            </div>
          ) : (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void action.run(async () => {
                  if (mode === 'renew') setCodes((await api<{ recoveryCodes: string[] }>('POST', '/v1/me/mfa/recovery-codes', { code: code.trim() })).recoveryCodes);
                  else await api('POST', '/v1/me/mfa/disable', { password, code: code.trim() });
                  reset();
                  await status.reload();
                });
              }}
            >
              {mode === 'off' && (
                <Field label={t('password.current')}>
                  <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </Field>
              )}
              <Field label={t('mfa.code')}>
                <input required inputMode="numeric" autoComplete="one-time-code" maxLength={16} value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" />
              </Field>
              <div className="row">
                <button className={mode === 'off' ? 'danger' : 'primary'} disabled={action.pending}>
                  {mode === 'off' ? t('mfa.turnOff') : t('mfa.newCodes')}
                </button>
                <button type="button" onClick={reset}>
                  {t('common.cancel')}
                </button>
              </div>
            </form>
          )}
        </>
      )}
      <ErrorBox error={action.error} />

      <h3>{t('password.change')}</h3>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void pwAction.run(async () => {
            await api('POST', '/v1/me/password', { currentPassword: pw.current, newPassword: pw.next });
            setPw({ current: '', next: '' });
          });
        }}
      >
        <Field label={t('password.current')}>
          <input type="password" required autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
        </Field>
        <Field label={t('password.new')} hint={t('password.hint')}>
          <input type="password" required minLength={10} autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
        </Field>
        <div style={{ alignSelf: 'end' }}>
          <button className="primary" disabled={pwAction.pending}>
            {t('password.change')}
          </button>
        </div>
      </form>
      <ErrorBox error={pwAction.error} />
      {pwAction.done && <p className="small" role="status">{t('password.changed')}</p>}
    </Card>
  );
}

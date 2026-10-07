import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api';
import { useAuth } from '../auth';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { Card, ErrorBox, Field, Loading, useAction } from '../components/ui';
import { useI18n } from '../i18n';

/**
 * Two-step verification setup, required before using the Admin Panel. The QR code is drawn in the browser:
 * the secret is never sent anywhere else.
 */
export function MfaSetupPage() {
  const { t } = useI18n();
  const { staff, reload, logout } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const start = useAction();
  const confirm = useAction();

  useEffect(() => {
    if (staff!.mfa.enabled) return; // enabled on another device: sign in again with a code
    void start.run(async () => {
      const data = await api<{ secret: string; otpauthUri: string }>('POST', '/v1/me/mfa/setup');
      setSetup({ ...data, qr: await QRCode.toDataURL(data.otpauthUri, { margin: 1, width: 220 }) });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="auth-page">
      <Card title={t('mfa.title')} actions={<LanguageSwitcher />}>
        {staff!.mfa.enabled ? (
          <div className="stack">
            <p>{t('mfa.signInAgain')}</p>
            <button onClick={() => void logout()}>{t('common.logout')}</button>
          </div>
        ) : recoveryCodes ? (
          <div className="stack">
            <div className="alert alert-good">{t('mfa.enabled')}</div>
            <p className="small">{t('mfa.recoveryIntro')}</p>
            <pre className="json" data-testid="recovery-codes" dir="ltr" style={{ fontSize: '0.95rem', maxHeight: 'none' }}>
              {recoveryCodes.join('\n')}
            </pre>
            <div className="row">
              <button
                onClick={() => {
                  const url = URL.createObjectURL(new Blob([`ARUMA — ${staff!.email}\n\n${recoveryCodes.join('\n')}\n`], { type: 'text/plain' }));
                  Object.assign(document.createElement('a'), { href: url, download: 'aruma-recovery-codes.txt' }).click();
                  URL.revokeObjectURL(url);
                }}
              >
                {t('mfa.download')}
              </button>
              <button className="primary" onClick={() => void reload()}>
                {t('mfa.continue')}
              </button>
            </div>
          </div>
        ) : !setup ? (
          <>
            <ErrorBox error={start.error} />
            <Loading />
          </>
        ) : (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void confirm.run(async () => setRecoveryCodes((await api<{ recoveryCodes: string[] }>('POST', '/v1/me/mfa/enable', { code: code.trim() })).recoveryCodes));
            }}
          >
            <p className="small">{t('mfa.required')}</p>
            <ol className="small" style={{ paddingInlineStart: 18, margin: 0 }}>
              <li>{t('mfa.step1')}</li>
              <li>{t('mfa.step2')}</li>
              <li>{t('mfa.step3')}</li>
            </ol>
            <div style={{ textAlign: 'center' }}>
              <img src={setup.qr} alt={t('mfa.qr')} width={220} height={220} style={{ background: '#fff', padding: 6, borderRadius: 8 }} />
            </div>
            <Field label={t('mfa.key')} hint={t('mfa.keyHint')}>
              <input readOnly value={setup.secret.replace(/(.{4})/g, '$1 ').trim()} dir="ltr" data-testid="mfa-secret" onFocus={(e) => e.target.select()} />
            </Field>
            <Field label={t('mfa.code')}>
              <input required inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" />
            </Field>
            <ErrorBox error={confirm.error} />
            <div className="row">
              <button className="primary" disabled={confirm.pending}>
                {t('mfa.turnOn')}
              </button>
              <button type="button" onClick={() => void logout()}>
                {t('common.logout')}
              </button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}

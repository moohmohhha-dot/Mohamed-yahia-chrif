import { useState } from 'react';
import { useAuth } from '../auth';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { Card, ErrorBox, Field, useAction } from '../components/ui';
import { useI18n } from '../i18n';

/** Staff sign in with their ARUMA account; only accounts holding a staff role get in. */
export function LoginPage() {
  const { t } = useI18n();
  const { login, notStaff, logout } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const action = useAction();
  return (
    <div className="auth-page">
      <Card title={t('auth.title')} actions={<LanguageSwitcher />}>
        <p className="muted small">{t('auth.staffOnly')}</p>
        {notStaff ? (
          <div className="stack">
            <div className="alert alert-warn" role="alert">
              {t('auth.notStaff')}
            </div>
            <button onClick={() => void logout()}>{t('common.logout')}</button>
          </div>
        ) : (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(() => login(email, password));
            }}
          >
            <Field label={t('auth.email')}>
              <input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label={t('auth.password')}>
              <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <ErrorBox error={action.error} />
            <button className="primary" disabled={action.pending}>
              {t('auth.signIn')}
            </button>
          </form>
        )}
      </Card>
    </div>
  );
}

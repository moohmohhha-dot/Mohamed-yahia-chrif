import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { Card, ErrorBox, Field, useAction } from '../components/ui';
import { useI18n } from '../i18n';

export function LoginPage() {
  const { t, locale } = useI18n();
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ email: '', password: '', displayName: '' });
  const action = useAction();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run(() =>
      mode === 'login' ? login(form.email, form.password) : register(form.email, form.password, form.displayName, locale),
    );
  };

  return (
    <div className="auth-page">
      <Card title={mode === 'login' ? t('auth.title') : t('auth.registerTitle')} actions={<LanguageSwitcher />}>
        <form className="stack" onSubmit={submit}>
          {mode === 'register' && (
            <Field label={t('auth.displayName')}>
              <input required value={form.displayName} onChange={set('displayName')} autoComplete="name" />
            </Field>
          )}
          <Field label={t('auth.email')}>
            <input required type="email" value={form.email} onChange={set('email')} autoComplete="email" />
          </Field>
          <Field label={t('auth.password')}>
            <input
              required
              type="password"
              minLength={mode === 'register' ? 8 : 1}
              value={form.password}
              onChange={set('password')}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </Field>
          <ErrorBox error={action.error} />
          <button className="primary" disabled={action.pending}>
            {mode === 'login' ? t('auth.signIn') : t('auth.signUp')}
          </button>
          <p className="muted small">
            {mode === 'login' ? t('auth.noAccount') : t('auth.haveAccount')}{' '}
            <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
              {mode === 'login' ? t('auth.signUp') : t('auth.signIn')}
            </button>
          </p>
        </form>
      </Card>
    </div>
  );
}

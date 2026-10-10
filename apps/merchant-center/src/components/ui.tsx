import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useI18n, type MessageKey } from '../i18n';

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-header">
          {title && <h2>{title}</h2>}
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

const tone: Record<string, string> = {
  verified: 'good',
  active: 'good',
  under_review: 'warn',
  draft: 'muted',
  unverified: 'muted',
  archived: 'muted',
  suspended: 'bad',
};
export function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  return <span className={`badge badge-${tone[status] ?? 'muted'}`}>{t(`status.${status}` as MessageKey)}</span>;
}

export function ErrorBox({ error }: { error: unknown }) {
  const { errorText } = useI18n();
  if (!error) return null;
  return (
    <div className="alert alert-bad" role="alert">
      {errorText(error)}
    </div>
  );
}

export function Loading() {
  const { t } = useI18n();
  return <p className="muted">{t('common.loading')}</p>;
}

/** Loads data and exposes a reload function; keeps pages free of fetch boilerplate. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const reload = useCallback(() => {
    setError(null);
    return load().then(setData, setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => void reload(), [reload]);
  return { data, error, reload };
}

/** Wraps an async action with pending/error/success state for forms and buttons. */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    setDone(false);
    try {
      await fn();
      setDone(true);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setPending(false);
    }
  };
  return { pending, error, done, run };
}

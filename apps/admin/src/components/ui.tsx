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

const GOOD = ['verified', 'active', 'published', 'delivered', 'completed', 'resolved', 'successful', 'paid', 'done', 'confirmed', 'balanced', 'approved'];
const BAD = ['suspended', 'rejected', 'failed', 'cancelled', 'hidden', 'blocked', 'declined', 'refused', 'inspection_failed', 'deleted', 'unreachable'];
const MUTED = ['draft', 'archived', 'unverified', 'withdrawn', 'none', 'not_required'];

/** A status from the API, translated (`prefix.value`) and coloured. */
export function Badge({ prefix, value }: { prefix: string; value: string | null | undefined }) {
  const { label } = useI18n();
  if (!value) return null;
  const tone = GOOD.includes(value) ? 'good' : BAD.includes(value) ? 'bad' : MUTED.includes(value) ? 'muted' : 'warn';
  return <span className={`badge badge-${tone}`}>{label(prefix, value)}</span>;
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

export function Empty({ children }: { children?: ReactNode }) {
  const { t } = useI18n();
  return <p className="muted">{children ?? t('common.empty')}</p>;
}

/** Key–value list for detail panels. */
export function Kv({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

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

/**
 * A button that asks for a written reason before acting: every ARUMA decision is explained and recorded.
 * `extra` renders more fields (e.g. a status or an amount) above the reason.
 */
export function ReasonAction({
  label,
  danger,
  onConfirm,
  minLength = 5,
  reasonLabel,
  extra,
  testId,
}: {
  label: string;
  danger?: boolean;
  onConfirm: (reason: string) => Promise<unknown>;
  minLength?: number;
  reasonLabel?: string;
  extra?: ReactNode;
  testId?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const action = useAction();
  if (!open)
    return (
      <button className={danger ? 'danger' : ''} onClick={() => setOpen(true)} data-testid={testId}>
        {label}
      </button>
    );
  return (
    <form
      className="stack card"
      style={{ width: '100%', marginBottom: 0 }}
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          await onConfirm(reason.trim());
          setOpen(false);
          setReason('');
        });
      }}
    >
      <strong>{label}</strong>
      {extra}
      <Field label={reasonLabel ?? t('common.reason')} hint={t('common.reasonHint')}>
        <textarea required minLength={minLength} maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorBox error={action.error} />
      <div className="row">
        <button className={danger ? 'primary danger' : 'primary'} disabled={action.pending}>
          {t('common.confirm')}
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

/** Previous / next page for lists. */
export function Pager({ page, setPage, count, pageSize }: { page: number; setPage: (p: number) => void; count: number; pageSize: number }) {
  const { t } = useI18n();
  if (page === 1 && count < pageSize) return null;
  return (
    <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
      <button disabled={page === 1} onClick={() => setPage(page - 1)}>
        {t('common.previous')}
      </button>
      <span className="muted small">{t('common.page', { page })}</span>
      <button disabled={count < pageSize} onClick={() => setPage(page + 1)}>
        {t('common.next')}
      </button>
    </div>
  );
}

/** Tabs for filters (status…). */
export function Tabs<T extends string>({ value, options, onChange, prefix, allLabel }: { value: T | ''; options: readonly T[]; onChange: (v: T | '') => void; prefix: string; allLabel?: MessageKey }) {
  const { t, label } = useI18n();
  return (
    <div className="row" style={{ marginBottom: 12 }}>
      {allLabel !== undefined && (
        <button className={value === '' ? 'primary' : ''} onClick={() => onChange('')}>
          {t(allLabel)}
        </button>
      )}
      {options.map((o) => (
        <button key={o} className={value === o ? 'primary' : ''} onClick={() => onChange(o)}>
          {label(prefix, o)}
        </button>
      ))}
    </div>
  );
}

export function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined || (typeof value === 'object' && Object.keys(value as object).length === 0)) return <span className="muted">—</span>;
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

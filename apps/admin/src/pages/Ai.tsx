import { api } from '../api';
import { useAuth } from '../auth';
import { Card, ErrorBox, Kv, Loading, ReasonAction, useLoad } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';

type Flag = { key: string; enabledByDefault: boolean; storesOn: number; storesOff: number };
type Usage = { requests: number; ok: number; failed: number; limited: number; tokens: number; avgLatencyMs: number };
type Overview = {
  provider: { configured: boolean; provider: string; model: string | null; timeoutMs: number; dailyTokenBudget: number; userHourlyLimit: number };
  master: Flag | null;
  tokensToday: number;
  days: number;
  features: { key: string; audience: string; engine: string; phase?: number; flag: Flag | null; usage: Usage }[];
};

/** The AI layer: provider, master switch, every feature with its switch and usage. Switches are feature flags (audited, with a reason). */
export function AiPage() {
  const { t, locale } = useI18n();
  const number = (n: number) => new Intl.NumberFormat(locale).format(n);
  const { can } = useAuth();
  const overview = useLoad(() => api<Overview>('GET', '/v1/admin/ai'), []);
  const edit = can('flags.manage');
  if (overview.error) return <ErrorBox error={overview.error} />;
  if (!overview.data) return <Loading />;
  const d = overview.data;
  const reload = () => void overview.reload();
  // Customer features can differ per store; merchant and staff features are one switch for everyone.
  const toggle = (flag: Flag, testId: string, perStore = true) =>
    edit && (
      <ReasonAction
        testId={testId}
        label={perStore ? (flag.enabledByDefault ? t('flags.turnOffAll') : t('flags.turnOnAll')) : flag.enabledByDefault ? t('ai.turnOff') : t('ai.turnOn')}
        danger={flag.enabledByDefault}
        onConfirm={(reason) => api('PUT', `/v1/admin/feature-flags/${flag.key}`, { enabledByDefault: !flag.enabledByDefault, reason }).then(reload)}
      />
    );
  const state = (flag: Flag) => (
    <>
      <span className={`badge badge-${flag.enabledByDefault ? 'good' : 'muted'}`}>{flag.enabledByDefault ? t('flags.on') : t('flags.off')}</span>
      {flag.storesOn + flag.storesOff > 0 && <div className="muted small">{t('ai.stores', { on: flag.storesOn, off: flag.storesOff })}</div>}
    </>
  );

  return (
    <>
      <h1>{t('section.ai')}</h1>
      <p className="muted">{t('ai.intro')}</p>
      <Card title={t('ai.provider')}>
        {!d.provider.configured ? (
          <p className="alert alert-warn" data-testid="ai-off">
            {t('ai.providerOff')}
          </p>
        ) : (
          <Kv
            rows={[
              [t('ai.provider'), d.provider.provider],
              [t('ai.model'), <code key="m">{d.provider.model}</code>],
            ]}
          />
        )}
        <Kv
          rows={[
            [t('ai.tokensToday'), `${number(d.tokensToday)} / ${number(d.provider.dailyTokenBudget)}`],
            [t('ai.timeout'), `${d.provider.timeoutMs / 1000} s`],
            [t('ai.hourly'), d.provider.userHourlyLimit],
          ]}
        />
      </Card>
      {d.master && (
        <Card title={t('ai.master')}>
          <div className="row" data-testid="ai-master">
            {state(d.master)}
            {toggle(d.master, 'ai-master-toggle')}
          </div>
          <p className="muted small">{t('ai.masterHint')}</p>
        </Card>
      )}
      <Card title={t('ai.features')}>
        <table data-testid="ai-features">
          <thead>
            <tr>
              <th>{t('ai.feature')}</th>
              <th>{t('ai.engine')}</th>
              <th>{t('ai.switch')}</th>
              <th className="num">{t('ai.requests')}</th>
              <th className="num">{t('ai.failed')}</th>
              <th className="num">{t('ai.limited')}</th>
              <th className="num">{t('ai.tokens')}</th>
              <th className="num">{t('ai.latency')}</th>
            </tr>
          </thead>
          <tbody>
            {d.features.map((f) => (
              <tr key={f.key} data-testid={`ai-feature-${f.key}`}>
                <td>
                  <strong>{t(`aiFeature.${f.key}` as MessageKey)}</strong>
                  <div className="muted small">{t(`aiAudience.${f.audience}` as MessageKey)}</div>
                </td>
                <td className="small">
                  {t(`aiEngine.${f.engine}` as MessageKey)}
                  {f.phase && <div className="muted">{t('soon.phase', { phase: f.phase })}</div>}
                </td>
                <td>
                  {f.flag ? (
                    <div className="stack">
                      {state(f.flag)}
                      {toggle(f.flag, `ai-toggle-${f.key}`, f.audience === 'customer')}
                    </div>
                  ) : (
                    <span className="muted small">{t('ai.noSwitch')}</span>
                  )}
                </td>
                <td className="num">{f.usage.requests}</td>
                <td className="num">{f.usage.failed}</td>
                <td className="num">{f.usage.limited}</td>
                <td className="num">{number(f.usage.tokens)}</td>
                <td className="num">{f.usage.avgLatencyMs ? `${f.usage.avgLatencyMs} ms` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          {t('ai.usage', { n: d.days })} · {t('ai.perStoreHint')}
        </p>
      </Card>
    </>
  );
}

import { Card } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';

/** A section whose module ships in a later phase: says what it will do and when. No sample data. */
export function ComingSoon({ section, phase }: { section: string; phase: number }) {
  const { t } = useI18n();
  return (
    <>
      <h1>{t(`section.${section}` as MessageKey)}</h1>
      <Card>
        <p>
          <span className="badge badge-muted">{t('soon.phase', { phase })}</span>
        </p>
        <p>{t(`soon.${section}` as MessageKey)}</p>
        <p className="muted small">{t('soon.ready')}</p>
      </Card>
    </>
  );
}

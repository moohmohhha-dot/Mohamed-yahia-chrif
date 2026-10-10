import { Card } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { phaseOf, type SectionId } from '../sections';

export function ComingSoon({ section }: { section: SectionId }) {
  const { t } = useI18n();
  const finance = ['balance', 'settlements', 'payouts', 'sales'].includes(section);
  return (
    <>
      <h1>{t(`section.${section}` as MessageKey)}</h1>
      <Card title={t('soon.title', { phase: phaseOf(section) ?? '' })}>
        <p className="muted">{t('soon.intro')}</p>
        <p>{t(`soon.${section}` as MessageKey)}</p>
        {finance && <div className="alert alert-warn">{t('soon.rules')}</div>}
      </Card>
    </>
  );
}

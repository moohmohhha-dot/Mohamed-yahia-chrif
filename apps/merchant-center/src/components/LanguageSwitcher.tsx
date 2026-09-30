import { LOCALES, useI18n, type Locale } from '../i18n';

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <select aria-label={t('common.language')} value={locale} onChange={(e) => setLocale(e.target.value as Locale)} style={{ width: 'auto' }}>
      {LOCALES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </select>
  );
}

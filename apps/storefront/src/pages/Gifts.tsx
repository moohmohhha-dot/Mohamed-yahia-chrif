import { useState } from 'react';
import { api, STORE, type Card } from '../api';
import { ErrorBox, Grid } from '../components/ui';
import { useI18n } from '../i18n';

type Ideas = { understood: { gender?: string; budgetMin?: number; budgetMax?: number; likes: string[] }; source: 'rules' | 'ai'; relaxed: boolean; products: Card[] };

/** Gift finder: who it is for, a budget, what they like — in a sentence or with the buttons. */
export function GiftsPage() {
  const { t, locale, money } = useI18n();
  const [forWhom, setForWhom] = useState('');
  const [gender, setGender] = useState<'' | 'women' | 'men' | 'unisex'>('');
  const [budget, setBudget] = useState('');
  const [ideas, setIdeas] = useState<Ideas | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  const find = async (text = forWhom) => {
    setPending(true);
    setError(null);
    try {
      setIdeas(await api<Ideas>('POST', `/v1/stores/${STORE}/gift-ideas`, { forWhom: text || undefined, gender: gender || undefined, budgetMax: budget ? Number(budget) : undefined, locale }));
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="gifts">
      <div className="gift-intro">
        <span className="eyebrow">{t('gift.eyebrow')}</span>
        <h1>{t('gift.title')}</h1>
        <p className="lead">{t('gift.lead')}</p>
      </div>
      <form
        className="gift-form"
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <label className="field">
          <span>{t('gift.describe')}</span>
          <textarea id="gift-text" rows={2} maxLength={300} value={forWhom} onChange={(e) => setForWhom(e.target.value)} placeholder={t('gift.placeholder')} />
        </label>
        <div className="chips">
          {(['gift.example1', 'gift.example2', 'gift.example3'] as const).map((k) => (
            <button type="button" key={k} className="chip-btn" onClick={() => (setForWhom(t(k)), void find(t(k)))}>
              {t(k)}
            </button>
          ))}
        </div>
        <div className="form-row">
          <label className="field">
            <span>{t('shop.for')}</span>
            <select id="gift-gender" value={gender} onChange={(e) => setGender(e.target.value as typeof gender)}>
              <option value="">{t('gift.anyone')}</option>
              <option value="women">{t('gender.women')}</option>
              <option value="men">{t('gender.men')}</option>
              <option value="unisex">{t('gender.unisex')}</option>
            </select>
          </label>
          <label className="field">
            <span>{t('gift.budget')}</span>
            <select id="gift-budget" value={budget} onChange={(e) => setBudget(e.target.value)}>
              <option value="">{t('gift.anyBudget')}</option>
              {[6000, 9000, 12000, 18000].map((b) => (
                <option key={b} value={b}>
                  {t('shop.max', { price: money(b * 100) })}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-primary btn-lg" disabled={pending} data-testid="find-gifts">
            {t('gift.find')}
          </button>
        </div>
      </form>
      <ErrorBox error={error} />
      {ideas && (
        <div className="stack" data-testid="gift-results">
          <div className="chips">
            <span className="muted small">{t('shop.understood')}</span>
            {ideas.understood.gender && <span className="chip">{t(`gender.${ideas.understood.gender}` as 'gender.women')}</span>}
            {ideas.understood.budgetMax && <span className="chip">{t('shop.max', { price: money(ideas.understood.budgetMax * 100) })}</span>}
            {ideas.understood.likes.map((l) => (
              <span key={l} className="chip">
                {l}
              </span>
            ))}
          </div>
          {ideas.relaxed && <p className="note">{t('gift.relaxed')}</p>}
          <Grid products={ideas.products} empty={<p className="empty">{t('gift.none')}</p>} />
        </div>
      )}
    </div>
  );
}

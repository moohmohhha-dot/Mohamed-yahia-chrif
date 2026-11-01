import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, STORE, type Card } from '../api';
import { useI18n } from '../i18n';

type Message = { role: 'user' | 'assistant'; content: string; products?: Card[] };

/**
 * Shopping assistant, shown only when ARUMA switched it on for this store. It finds and explains this
 * store's perfumes; it cannot see the account or orders, or buy anything. The conversation stays in the page.
 */
export function Assistant() {
  const { t, locale, money } = useI18n();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const send = async (question: string) => {
    const next: Message[] = [...messages, { role: 'user', content: question }];
    setMessages(next);
    setText('');
    setPending(true);
    setFailed(false);
    try {
      const r = await api<{ reply: string; products: Card[] }>('POST', `/v1/stores/${STORE}/assistant`, { locale, messages: next.slice(-20).map(({ role, content }) => ({ role, content })) });
      setMessages([...next, { role: 'assistant', content: r.reply, products: r.products }]);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  if (!open)
    return (
      <button className="assistant-fab" onClick={() => setOpen(true)} data-testid="assistant-open">
        <span aria-hidden="true">✦</span> {t('assistant.open')}
      </button>
    );
  return (
    <aside className="assistant" aria-label={t('assistant.title')} data-testid="assistant">
      <div className="assistant-head">
        <strong>{t('assistant.title')}</strong>
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label={t('common.close')}>
          ✕
        </button>
      </div>
      <div className="assistant-body">
        {messages.length === 0 && (
          <div className="stack-sm">
            <p className="muted small">{t('assistant.intro')}</p>
            {(['assistant.example1', 'assistant.example2', 'assistant.example3'] as const).map((k) => (
              <button key={k} className="chip-btn" onClick={() => void send(t(k))}>
                {t(k)}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble bubble-${m.role}`}>
            <p>{m.content}</p>
            {m.products && m.products.length > 0 && (
              <div className="bubble-products">
                {m.products.slice(0, 4).map((p) => (
                  <Link key={p.slug} to={`/p/${p.slug}`} onClick={() => setOpen(false)}>
                    {p.name} · {money(p.priceFrom.amountMinor)}
                  </Link>
                ))}
              </div>
            )}
          </div>
        ))}
        {pending && <p className="muted small">{t('assistant.thinking')}</p>}
        {failed && <p className="alert alert-bad small">{t('assistant.unavailable')}</p>}
      </div>
      <form
        className="assistant-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() && !pending) void send(text.trim());
        }}
      >
        <input id="assistant-input" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder={t('assistant.placeholder')} aria-label={t('assistant.placeholder')} />
        <button className="btn btn-primary" disabled={pending}>
          {t('assistant.send')}
        </button>
      </form>
      <p className="muted tiny">{t('assistant.disclaimer')}</p>
    </aside>
  );
}

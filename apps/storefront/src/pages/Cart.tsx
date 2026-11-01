import { Link } from 'react-router-dom';
import { Bottle } from '../components/Bottle';
import { useI18n } from '../i18n';
import { useShop } from '../store';

export function CartPage() {
  const { t, money, ml } = useI18n();
  const { cart, setQuantity, subtotalMinor } = useShop();
  if (!cart.length)
    return (
      <div className="narrow">
        <h1>{t('cart.title')}</h1>
        <p className="lead">{t('cart.empty')}</p>
        <Link to="/shop" className="btn btn-primary">
          {t('home.shopAll')}
        </Link>
      </div>
    );
  return (
    <div className="cart">
      <h1>{t('cart.title')}</h1>
      <div className="cart-body">
        <ul className="cart-lines" data-testid="cart-lines">
          {cart.map((l) => (
            <li key={l.offerId} className="cart-line">
              <Link to={`/p/${l.productSlug}`} className="cart-thumb">
                <Bottle seed={l.productSlug} label={l.brand} hue={l.hue} size="sm" />
              </Link>
              <div className="cart-info">
                <Link to={`/p/${l.productSlug}`} className="plain">
                  <strong>{l.name}</strong>
                </Link>
                <span className="muted small">
                  {[l.brand, l.sizeMl ? ml(l.sizeMl) : null].filter(Boolean).join(' · ')}
                </span>
                <span className="muted small">{t('product.soldBy', { seller: l.merchant })}</span>
              </div>
              <div className="qty">
                <button onClick={() => setQuantity(l.offerId, l.quantity - 1)} aria-label="−">
                  −
                </button>
                <span>{l.quantity}</span>
                <button onClick={() => setQuantity(l.offerId, l.quantity + 1)} aria-label="+">
                  +
                </button>
              </div>
              <strong className="cart-price">{money(l.unitPriceMinor * l.quantity)}</strong>
              <button className="link small" onClick={() => setQuantity(l.offerId, 0)}>
                {t('cart.remove')}
              </button>
            </li>
          ))}
        </ul>
        <aside className="summary">
          <div className="row-between">
            <span>{t('cart.subtotal')}</span>
            <strong data-testid="subtotal">{money(subtotalMinor)}</strong>
          </div>
          <p className="muted small">{t('cart.deliveryNext')}</p>
          <Link to="/checkout" className="btn btn-primary btn-lg block" data-testid="go-checkout">
            {t('cart.checkout')}
          </Link>
          <p className="muted small">{t('product.cod')}</p>
        </aside>
      </div>
    </div>
  );
}

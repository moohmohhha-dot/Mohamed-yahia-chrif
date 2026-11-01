import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { AccountPage, OrderPage } from './pages/Account';
import { CartPage } from './pages/Cart';
import { CheckoutPage } from './pages/Checkout';
import { ComparePage } from './pages/Compare';
import { GiftsPage } from './pages/Gifts';
import { HomePage } from './pages/Home';
import { ProductPage } from './pages/Product';
import { ShopPage } from './pages/Shop';

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/shop" element={<ShopPage />} />
        <Route path="/p/:slug" element={<ProductPage />} />
        <Route path="/compare" element={<ComparePage />} />
        <Route path="/gifts" element={<GiftsPage />} />
        <Route path="/cart" element={<CartPage />} />
        <Route path="/checkout" element={<CheckoutPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/account/orders/:id" element={<OrderPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

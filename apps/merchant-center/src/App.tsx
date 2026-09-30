import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Loading } from './components/ui';
import { MerchantShell } from './components/Shell';
import { LoginPage } from './pages/Login';
import { MerchantsPage } from './pages/Merchants';

export function App() {
  const { user, ready } = useAuth();
  if (!ready) return <Loading />;
  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/" element={<MerchantsPage />} />
      <Route path="/m/:merchantId/*" element={<MerchantShell />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

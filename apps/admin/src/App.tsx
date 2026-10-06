import { useAuth } from './auth';
import { Loading } from './components/ui';
import { Shell } from './components/Shell';
import { LoginPage } from './pages/Login';

export function App() {
  const { staff, ready } = useAuth();
  if (!ready) return <Loading />;
  return staff ? <Shell /> : <LoginPage />;
}

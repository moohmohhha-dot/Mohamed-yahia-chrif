import { useAuth } from './auth';
import { Loading } from './components/ui';
import { Shell } from './components/Shell';
import { LoginPage } from './pages/Login';
import { MfaSetupPage } from './pages/MfaSetup';

export function App() {
  const { staff, ready } = useAuth();
  if (!ready) return <Loading />;
  if (!staff) return <LoginPage />;
  // Staff work only with two-step verification: set it up before anything else.
  if (staff.mfa.required && !staff.mfa.sessionVerified) return <MfaSetupPage />;
  return <Shell />;
}

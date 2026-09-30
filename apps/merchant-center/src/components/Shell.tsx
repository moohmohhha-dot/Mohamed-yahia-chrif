import type { ComponentType } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { useI18n, type MessageKey } from '../i18n';
import { MerchantCtx, type MerchantRole } from '../merchant-context';
import { ComingSoon } from '../pages/ComingSoon';
import { DashboardPage } from '../pages/Dashboard';
import { InventoryPage } from '../pages/Inventory';
import { OffersPage } from '../pages/Offers';
import { PayoutsPage } from '../pages/Payouts';
import { ProductsPage } from '../pages/Products';
import { SettingsPage } from '../pages/Settings';
import { VariantsPage } from '../pages/Variants';
import { VerificationPage } from '../pages/Verification';
import { NAV, type SectionId } from '../sections';
import { LanguageSwitcher } from './LanguageSwitcher';
import { ErrorBox, Loading, StatusBadge, useLoad } from './ui';

const PAGES: Partial<Record<SectionId, ComponentType>> = {
  dashboard: DashboardPage,
  products: ProductsPage,
  variants: VariantsPage,
  offers: OffersPage,
  inventory: InventoryPage,
  payouts: PayoutsPage,
  verification: VerificationPage,
  settings: SettingsPage,
};

type Membership = { merchant: { id: string; name: string; type: 'individual' | 'business'; verificationStatus: string }; role: MerchantRole };

export function MerchantShell() {
  const { merchantId } = useParams();
  const { t } = useI18n();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { data, error, reload } = useLoad(() => api<Membership[]>('GET', '/v1/me/merchants'), []);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const membership = data.find((m) => m.merchant.id === merchantId);
  if (!membership) return <Navigate to="/" replace />;
  const current = { ...membership.merchant, role: membership.role, refresh: () => void reload() };

  return (
    <MerchantCtx.Provider value={current}>
      <div className="layout">
        <aside className="sidebar">
          <div className="brand">
            ARUMA · {t('app.title')}
            <small>{current.name}</small>
          </div>
          <nav>
            {NAV.map((group) => (
              <div className="nav-group" key={group.group}>
                <div className="nav-group-title">{t(group.group)}</div>
                {group.sections.map((section) => (
                  <NavLink key={section.id} to={`/m/${current.id}/${section.id}`} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
                    <span>{t(`section.${section.id}` as MessageKey)}</span>
                    {section.phase && <span className="soon">{t('soon.badge')}</span>}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
        </aside>
        <main className="main">
          <div className="topbar">
            <div className="row">
              <StatusBadge status={current.verificationStatus} />
              <span className="muted small">
                {user?.displayName} · {t(`role.${current.role}` as MessageKey)}
              </span>
            </div>
            <div className="row">
              <button className="link" onClick={() => navigate('/')}>
                {t('common.switchMerchant')}
              </button>
              <LanguageSwitcher />
              <button onClick={() => void logout()}>{t('common.logout')}</button>
            </div>
          </div>
          <Routes>
            {NAV.flatMap((g) => g.sections).map(({ id }) => {
              const Page = PAGES[id];
              return <Route key={id} path={id} element={Page ? <Page /> : <ComingSoon section={id} />} />;
            })}
            <Route path="*" element={<Navigate to={`/m/${current.id}/dashboard`} replace />} />
          </Routes>
        </main>
      </div>
    </MerchantCtx.Provider>
  );
}

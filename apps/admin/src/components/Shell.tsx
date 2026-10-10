import type { ComponentType } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '../auth';
import { useI18n, type MessageKey } from '../i18n';
import { AiPage } from '../pages/Ai';
import { AnalyticsPage } from '../pages/Analytics';
import { ComingSoon } from '../pages/ComingSoon';
import { DisputesPage } from '../pages/Disputes';
import { CommissionPage, FinancePage, PayoutsPage, SettlementsPage } from '../pages/Finance';
import { FlagsPage } from '../pages/Flags';
import { FraudPage } from '../pages/Fraud';
import { MerchantsPage, VerificationPage } from '../pages/Merchants';
import { InventoryPage, OffersPage, ProductsPage } from '../pages/Catalog';
import { OrdersPage, PaymentsPage } from '../pages/Orders';
import { OverviewPage } from '../pages/Overview';
import { ReturnsPage } from '../pages/Returns';
import { ReviewsPage } from '../pages/Reviews';
import { SearchPage } from '../pages/Search';
import { SecurityPage } from '../pages/Security';
import { ShippingPage } from '../pages/Shipping';
import { StaffPage, UsersPage } from '../pages/Users';
import { NAV } from '../sections';
import { LanguageSwitcher } from './LanguageSwitcher';

const PAGES: Record<string, ComponentType> = {
  overview: OverviewPage,
  analytics: AnalyticsPage,
  users: UsersPage,
  staff: StaffPage,
  merchants: MerchantsPage,
  verification: VerificationPage,
  products: ProductsPage,
  offers: OffersPage,
  inventory: InventoryPage,
  search: SearchPage,
  orders: OrdersPage,
  payments: PaymentsPage,
  shipping: ShippingPage,
  returns: ReturnsPage,
  disputes: DisputesPage,
  finance: FinancePage,
  commission: CommissionPage,
  settlements: SettlementsPage,
  payouts: PayoutsPage,
  reviews: ReviewsPage,
  fraud: FraudPage,
  security: SecurityPage,
  flags: FlagsPage,
  ai: AiPage,
};

export function Shell() {
  const { t, label } = useI18n();
  const { staff, can, logout } = useAuth();
  const nav = NAV.map((g) => ({ ...g, sections: g.sections.filter((s) => can(...s.permissions)) })).filter((g) => g.sections.length);
  const first = nav[0]?.sections[0]?.id ?? 'overview';

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          ARUMA · {t('app.title')}
          <small>{staff!.roles.map((r) => label('role', r)).join(' · ')}</small>
        </div>
        <nav>
          {nav.map((group) => (
            <div className="nav-group" key={group.group}>
              <div className="nav-group-title">{t(group.group)}</div>
              {group.sections.map((section) => (
                <NavLink key={section.id} to={`/${section.id}`} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
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
          <span className="muted small" data-testid="whoami">
            {staff!.displayName} · {staff!.email}
          </span>
          <div className="row">
            <LanguageSwitcher />
            <button onClick={() => void logout()}>{t('common.logout')}</button>
          </div>
        </div>
        <Routes>
          {nav.flatMap((g) => g.sections).map(({ id, phase }) => {
            const Page = PAGES[id];
            return <Route key={id} path={`/${id}`} element={phase || !Page ? <ComingSoon section={id} phase={phase ?? 1} /> : <Page />} />;
          })}
          <Route path="*" element={<Navigate to={`/${first}`} replace />} />
        </Routes>
      </main>
    </div>
  );
}

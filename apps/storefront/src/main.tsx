import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, MemoryRouter } from 'react-router-dom';
import { DEMO } from './api';
import { App } from './App';
import { I18nProvider } from './i18n';
import { ShopProvider } from './store';
import './styles.css';

// The demo is shown inside viewers that do not let a page change its address: it navigates in memory.
const Router = DEMO ? MemoryRouter : BrowserRouter;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <ShopProvider>
        <Router>
          <App />
        </Router>
      </ShopProvider>
    </I18nProvider>
  </StrictMode>,
);

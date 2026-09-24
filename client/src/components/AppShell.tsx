import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { PasswordForm } from '../auth/AuthGate';
import { useAuth } from '../auth/context';
import { authError } from '../auth/transport';
import AppModal from './AppModal';
import MobileNavigation from './MobileNavigation';
import MoreNavigation from './MoreNavigation';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import './app-shell.css';

export default function AppShell({ children }: { children: ReactNode }) {
  const { signOut } = useAuth();
  const location = useLocation();
  const [panel, setPanel] = useState<'more' | 'password' | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState('');

  // Close stale overlays on browser back/forward, including query-only navigation.
  useEffect(() => { setPanel(null); }, [location.key]);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 768px)');
    const closeMobilePanel = () => { if (desktop.matches) setPanel((current) => current === 'more' ? null : current); };
    desktop.addEventListener('change', closeMobilePanel);
    return () => desktop.removeEventListener('change', closeMobilePanel);
  }, []);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true); setError('');
    try { await signOut(); }
    catch (failure) { setError(authError(failure, 'Could not sign out.')); }
    finally { setSigningOut(false); }
  }
  const accountActions = {
    onChangePassword: () => setPanel('password'),
    onSignOut: () => { void handleSignOut(); },
    signingOut,
  };

  return <div className="app-shell">
    <a href="#main-content" className="app-skip-link">Skip to content</a>
    <Topbar {...accountActions} />
    {error && panel !== 'more' && <p role="alert" className="bg-red-50 p-3 text-red-800">{error}</p>}
    <div className="app-shell-body">
      <Sidebar />
      <main id="main-content" tabIndex={-1} className="app-main">{children}</main>
    </div>
    <MobileNavigation moreOpen={panel === 'more'} onMore={() => setPanel('more')} />
    {panel === 'more' && <MoreNavigation {...accountActions} error={error} onDismiss={() => setPanel(null)} />}
    {panel === 'password' && <AppModal id="account-settings" title="Account settings" onDismiss={() => setPanel(null)}>
      <PasswordForm onDone={() => setPanel(null)} />
    </AppModal>}
  </div>;
}

import { House, KeyRound, LogOut } from 'lucide-react';
import { Link, matchPath, useLocation } from 'react-router-dom';
import { useAuth, roleLabels } from '../auth/context';
import AcademyBrand from './AcademyBrand';
import { getNavigationItems } from './navigation';

type Props = { onChangePassword: () => void; onSignOut: () => void; signingOut: boolean };

export default function Topbar({ onChangePassword, onSignOut, signingOut }: Props) {
  const { account } = useAuth();
  const { pathname } = useLocation();
  const current = getNavigationItems(account?.role).find((item) => matchPath({ path: item.to, end: false }, pathname));
  return <header className="app-topbar print:hidden">
    <Link className="mobile-brand-link" to="/dashboard" aria-label="Smart Kids Academy home"><AcademyBrand /></Link>
    <div className="app-breadcrumb"><House size={16} aria-hidden="true" /><span>Your workspace</span><span aria-hidden="true">/</span><strong>{current?.label || 'Home'}</strong></div>
    <div className="desktop-account">
      <span className="account-name">{account?.displayName}<small>{account && roleLabels[account.role]}</small></span>
      <button type="button" onClick={onChangePassword} className="ska-link"><KeyRound size={17} aria-hidden="true" /><span>Change password</span></button>
      <button type="button" disabled={signingOut} onClick={onSignOut} className="ska-link"><LogOut size={17} aria-hidden="true" /><span>{signingOut ? 'Signing out…' : 'Sign out'}</span></button>
    </div>
  </header>;
}

import { KeyRound, LogOut } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { roleLabels, useAuth } from '../auth/context';
import { getMoreItems } from './navigation';
import AppModal from './AppModal';

type Props = {
  onDismiss: () => void; onChangePassword: () => void; onSignOut: () => void;
  signingOut: boolean; error: string;
};

export default function MoreNavigation({ onDismiss, onChangePassword, onSignOut, signingOut, error }: Props) {
  const { account } = useAuth();
  return <AppModal id="more-navigation" title="More" sheet onDismiss={onDismiss}>
    <nav aria-label="More navigation" className="grid gap-1">
      {getMoreItems(account?.role).map((item) => <NavLink key={item.to} to={item.to} onClick={onDismiss}
        className={({ isActive }) => `flex min-h-12 items-center gap-3 rounded-xl px-3 py-3 font-medium ${
          isActive ? 'bg-blue-50 text-blue-800' : 'text-slate-700 hover:bg-slate-100'}`}>
        <item.icon size={20} aria-hidden="true" /><span>{item.label}</span>
      </NavLink>)}
    </nav>
    <section aria-label="Your account" className="mt-4 border-t border-slate-200 pt-4">
      <p className="break-words font-semibold text-slate-900">{account?.displayName}</p>
      <p className="mb-3 text-sm text-slate-600">{account && roleLabels[account.role]}</p>
      {error && <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-red-800">{error}</p>}
      <div className="grid gap-1">
        <button type="button" onClick={onChangePassword} className="flex min-h-12 items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-slate-100">
          <KeyRound size={20} aria-hidden="true" />Change password
        </button>
        <button type="button" disabled={signingOut} onClick={onSignOut} className="flex min-h-12 items-center gap-3 rounded-xl px-3 py-3 text-left text-red-800 hover:bg-red-50 disabled:opacity-50">
          <LogOut size={20} aria-hidden="true" />{signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </section>
  </AppModal>;
}

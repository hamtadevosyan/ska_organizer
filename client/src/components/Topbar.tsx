// src/components/Topbar.tsx
import { useAuth, roleLabels } from "../auth/context";

type Props = { onChangePassword: () => void; onSignOut: () => void; signingOut: boolean };

const Topbar = ({ onChangePassword, onSignOut, signingOut }: Props) => {
  const { account } = useAuth();
  return (
    <header className="app-topbar flex flex-wrap items-center justify-between gap-3 border-b bg-white shadow-sm print:hidden">
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-800 text-xs font-bold text-white md:hidden">SKA</span>
        <div>
          <p className="text-lg font-bold text-slate-950 md:hidden">SKA Organizer</p>
          <p className="text-xs text-slate-600 md:hidden">Smart Kids Academy</p>
          <p className="hidden font-serif text-xl font-bold text-gray-900 md:block">Smart Kids Academy</p>
        </div>
      </div>

      <div className="hidden flex-wrap items-center gap-3 md:flex">
        <select aria-label="Language" className="min-h-11 rounded border px-2 py-1 text-sm">
          <option>English</option>
          <option>Spanish</option>
        </select>
        <span className="text-sm text-gray-700">{account?.displayName} · {account && roleLabels[account.role]}</span>
        <button type="button" onClick={onChangePassword} className="min-h-11 px-2 text-sm underline">Change password</button>
        <button type="button" disabled={signingOut} onClick={onSignOut} className="min-h-11 px-2 text-sm underline">{signingOut ? 'Signing out…' : 'Sign out'}</button>
      </div>
    </header>
  );
};

export default Topbar;

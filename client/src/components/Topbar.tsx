// src/components/Topbar.tsx
import { useState } from "react";
import { useAuth, roleLabels } from "../auth/context";
import { PasswordForm } from "../auth/AuthGate";
import { authError } from "../auth/transport";
import { Menu } from "lucide-react";

const Topbar = ({ onToggleSidebar }: { onToggleSidebar: () => void }) => {
  const { account, signOut } = useAuth();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (<>
    <header className="print:hidden flex justify-between items-center px-6 py-4 bg-white shadow-sm border-b">
      <div className="flex flex-wrap items-center gap-3">
        {/* Hamburger Icon (Mobile) */}
        <button
          aria-label="Toggle navigation"
          onClick={onToggleSidebar}
          className="md:hidden p-2 text-gray-700 hover:bg-gray-200 rounded"
        >
          <Menu size={24} />
        </button>
        <h1 className="text-xl font-bold text-gray-900 font-serif">
          Smart Kids Academy
        </h1>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select className="border rounded px-2 py-1 text-sm">
          <option>English</option>
          <option>Spanish</option>
        </select>
        <span className="text-sm text-gray-700">{account?.displayName} · {account && roleLabels[account.role]}</span>
        <button onClick={() => setPasswordOpen(true)} className="text-sm underline">Change password</button>
        <button disabled={busy} onClick={() => { setBusy(true); setError(''); void signOut().catch((failure) => setError(authError(failure, 'Could not sign out.'))).finally(() => setBusy(false)); }} className="text-sm underline">{busy ? 'Signing out…' : 'Sign out'}</button>
      </div>
    </header>
    {error && <p role="alert" className="bg-red-50 p-3 text-red-800">{error}</p>}
    {passwordOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"><div role="dialog" aria-modal="true" aria-label="Change password" className="w-full max-w-md rounded-xl bg-white p-6"><PasswordForm onDone={() => setPasswordOpen(false)} /></div></div>}
    </>
  );
};

export default Topbar;


import { Fragment, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useAuth } from './context';
import { authError } from './transport';

export function PasswordForm({ onDone }: { onDone?: () => void }) {
  const { changePassword, account, signOut } = useAuth();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (password !== confirm) { setError('The new passwords do not match.'); return; }
    setBusy(true);
    try { await changePassword(current, password); setCurrent(''); setPassword(''); setConfirm(''); onDone?.(); }
    catch (failure) { setError(authError(failure, 'Could not change your password.')); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="space-y-4">
    <h2 className="text-2xl font-bold">Change password</h2>
    <p>{account?.mustChangePassword ? 'Change your temporary password before opening the application.' : 'Changing your password signs out your other sessions.'}</p>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <label className="block">Current password<input required type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} className="mt-1 block w-full rounded border p-3" /></label>
    <label className="block">New password<input required type="password" minLength={15} maxLength={128} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1 block w-full rounded border p-3" /></label>
    <p className="text-sm text-slate-600">Use 15–128 characters. Spaces are allowed.</p>
    <label className="block">Confirm new password<input required type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} className="mt-1 block w-full rounded border p-3" /></label>
    <button disabled={busy} className="rounded bg-emerald-700 px-4 py-2 font-semibold text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save password'}</button>
    {onDone ? <button type="button" disabled={busy} onClick={onDone} className="ml-3 underline">Cancel</button> :
      <button type="button" disabled={busy} onClick={() => { setBusy(true); void signOut().catch((failure) => setError(authError(failure, 'Could not sign out.'))).finally(() => setBusy(false)); }} className="ml-3 underline">Sign out</button>}
  </form>;
}
export default function AuthGate({ children }: { children: ReactNode }) {
  const { account, ready, notice, signIn } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try { await signIn(username, password); setPassword(''); }
    catch (failure) { setError(authError(failure, 'Could not sign in.')); setPassword(''); }
    finally { setBusy(false); }
  }
  if (!ready) return <div role="status" className="p-8">Checking your session…</div>;
  if (account && !account.mustChangePassword) return <Fragment key={`${account.id}:${account.role}`}>{children}</Fragment>;
  return <main className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
    <section className="w-full max-w-md rounded-2xl bg-white p-8 shadow-lg">
      <p className="mb-6 text-sm font-bold text-emerald-800">SMART KIDS ACADEMY ORGANIZER</p>
      {account ? <PasswordForm /> : <form onSubmit={submit} className="space-y-4">
        <h1 className="text-3xl font-bold">Sign in</h1>
        <p className="text-slate-600">Use the account provided by your administrator.</p>
        {notice && <p role="status" className="rounded bg-amber-50 p-3 text-amber-900">{notice}</p>}
        {error && <p role="alert" className="text-red-700">{error}</p>}
        <label className="block">Username<input required autoComplete="username" autoCapitalize="none" maxLength={64} value={username} onChange={(event) => setUsername(event.target.value)} className="mt-1 block w-full rounded border p-3" /></label>
        <label className="block">Password<input required type="password" autoComplete="current-password" maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1 block w-full rounded border p-3" /></label>
        <button disabled={busy} className="w-full rounded bg-emerald-700 px-4 py-3 font-semibold text-white disabled:opacity-50">{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="text-sm text-slate-500">Need access or a password reset? Contact your administrator.</p>
      </form>}
    </section>
  </main>;
}

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import { roleLabels, useAuth } from '../auth/context';
import type { Account, DocumentAccess, Role } from '../auth/context';
import { authError } from '../auth/transport';

type Audit = { id: string; actorUsername: string; action: string; entityId: string | null; occurredAt: string };
const base = `${API_BASE_URL}/api/admin`;
const inputClass = 'mt-1 block w-full rounded border p-2';
const empty = { username: '', displayName: '', role: 'editor' as Role, documentAccess: 'none' as DocumentAccess, password: '' };
const accessForRole = (access: DocumentAccess | undefined, role: Role): DocumentAccess => role === 'admin' ? 'edit' :
  role === 'viewer' && access === 'edit' ? 'view' : access || 'none';
function DocumentAccessOptions({ role }: { role: Role }) {
  return <><option value="none">No access</option><option value="view">View documents</option>
    <option value="edit" disabled={role === 'viewer'}>Upload and update documents</option></>;
}
export default function Accounts() {
  const { account: current } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [events, setEvents] = useState<Audit[]>([]);
  const [form, setForm] = useState(empty);
  const [selected, setSelected] = useState<Account | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [offset, setOffset] = useState(0);
  const load = useCallback(async () => {
    const [people, audit] = await Promise.all([axios.get<{ data: Account[] }>(`${base}/accounts`), axios.get<{ data: Audit[] }>(`${base}/audit?limit=25&offset=${offset}`)]);
    setAccounts(people.data.data); setEvents(audit.data.data);
  }, [offset]);
  useEffect(() => {
    if (current?.role !== 'admin') return;
    let active = true;
    setLoading(true);
    void load().catch((failure) => { if (active && !axios.isCancel(failure)) setError(authError(failure, 'Could not load accounts.')); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load, current?.role]);
  if (current?.role !== 'admin') return <p role="alert">Administrator access is required.</p>;
  async function change(operation: () => Promise<unknown>, success: string) {
    setBusy(true); setError(''); setMessage('');
    try {
      await operation(); setMessage(success);
      // A refresh failure must not claim that the already committed change failed.
      try { await load(); } catch { setError('The change was saved, but the list could not refresh. Use Refresh.'); }
    } catch (failure) { if (!axios.isCancel(failure)) setError(authError(failure, 'Could not save this change.')); }
    finally { setBusy(false); }
  }
  function create(event: FormEvent) {
    event.preventDefault();
    void change(async () => { await axios.post(`${base}/accounts`, form); setForm(empty); }, 'Account created. Give the temporary password directly to the authorized user. They must change it when signing in.');
  }
  function update(event: FormEvent) {
    event.preventDefault(); if (!selected) return;
    if (!window.confirm(`Save access changes for ${selected.username}? Changes to role, document access or status sign out their existing sessions.`)) return;
    void change(async () => { const response = await axios.put<{ data: Account }>(`${base}/accounts/${selected.id}`, selected); setSelected(response.data.data); }, 'Account access updated.');
  }
  function reset(event: FormEvent) {
    event.preventDefault(); if (!selected) return;
    if (!window.confirm(`Reset the password for ${selected.username} and sign out all their sessions?`)) return;
    void change(async () => { await axios.post(`${base}/accounts/${selected.id}/password`, { password: resetPassword }); setResetPassword(''); setSelected({ ...selected, mustChangePassword: true }); }, 'Password reset. The user must change this temporary password when signing in.');
  }
  return <div className="mx-auto max-w-6xl space-y-6 p-4">
    <div className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-3xl font-bold">Accounts</h1><p className="mt-2 text-slate-600">Grant access only to people authorized to use the organizer.</p></div>
      <button disabled={busy || loading} onClick={() => { setError(''); setLoading(true); void load().catch((failure) => setError(authError(failure, 'Could not refresh.'))).finally(() => setLoading(false)); }} className="rounded border bg-white px-4 py-2">Refresh</button></div>
    {error && <p role="alert" className="rounded bg-red-50 p-3 text-red-800">{error}</p>}
    {message && <p role="status" className="rounded bg-emerald-50 p-3 text-emerald-800">{message}</p>}
    {loading && <p role="status">Loading accounts…</p>}
    <div className="grid gap-6 lg:grid-cols-2">
      <form onSubmit={create} className="rounded-xl bg-white p-6 shadow-sm"><fieldset disabled={busy || loading} className="space-y-4">
        <h2 className="text-xl font-bold">Create account</h2>
        <label className="block">Username<input required autoComplete="off" autoCapitalize="none" pattern="[a-zA-Z0-9._\-]{3,64}" maxLength={64} value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} className={inputClass} /></label>
        <label className="block">Display name<input required maxLength={100} value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} className={inputClass} /></label>
        <label className="block">Access<select value={form.role} onChange={(event) => { const role = event.target.value as Role; setForm({ ...form, role, documentAccess: accessForRole(form.documentAccess, role) }); }} className={inputClass}>{Object.entries(roleLabels).map(([role, label]) => <option key={role} value={role}>{label}</option>)}</select></label>
        <p className="text-sm text-slate-600">Editors can change operational data. Read-only accounts can view and print. Administrators also manage accounts.</p>
        <label className="block">Child documents<select disabled={form.role === 'admin'} value={accessForRole(form.documentAccess, form.role)} onChange={(event) => setForm({ ...form, documentAccess: event.target.value as DocumentAccess })} className={inputClass}><DocumentAccessOptions role={form.role} /></select></label>
        <p className="text-sm text-slate-600">Child documents have separate permission from the roster. Administrators always have full document access.</p>
        <label className="block">Temporary password<input required type="password" minLength={15} maxLength={128} autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} className={inputClass} /></label>
        <p className="text-sm text-slate-600">Use 15–128 characters. This password is not shown again.</p>
        <button className="rounded bg-emerald-700 px-4 py-2 font-semibold text-white">Create account</button>
      </fieldset></form>
      <section className="rounded-xl bg-white p-6 shadow-sm space-y-4"><h2 className="text-xl font-bold">Manage an account</h2>
        <label className="block">Account<select disabled={busy || loading} value={selected?.id || ''} onChange={(event) => { setSelected(accounts.find((item) => item.id === event.target.value) || null); setResetPassword(''); setMessage(''); }} className={inputClass}>
          <option value="">Choose an account</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.displayName} ({item.username}){item.disabled ? ' — Disabled' : ''}</option>)}</select></label>
        {selected && <><form onSubmit={update}><fieldset disabled={busy || loading} className="space-y-4">
          <label className="block">Account display name<input required maxLength={100} value={selected.displayName} onChange={(event) => setSelected({ ...selected, displayName: event.target.value })} className={inputClass} /></label>
          <label className="block">Account access<select disabled={selected.id === current.id} value={selected.role} onChange={(event) => { const role = event.target.value as Role; setSelected({ ...selected, role, documentAccess: accessForRole(selected.documentAccess, role) }); }} className={inputClass}>{Object.entries(roleLabels).map(([role, label]) => <option key={role} value={role}>{label}</option>)}</select></label>
          <label className="block">Account child documents<select disabled={selected.role === 'admin'} value={accessForRole(selected.documentAccess, selected.role)} onChange={(event) => setSelected({ ...selected, documentAccess: event.target.value as DocumentAccess })} className={inputClass}><DocumentAccessOptions role={selected.role} /></select></label>
          <p className="text-sm text-slate-600">View permission includes previews, downloads and earlier versions. Upload and update permission also allows revising documents.</p>
          <label className="block"><input type="checkbox" disabled={selected.id === current.id} checked={selected.disabled} onChange={(event) => setSelected({ ...selected, disabled: event.target.checked })} /> Disabled</label>
          {selected.id === current.id && <p className="text-sm text-slate-600">Another administrator must change your access. Use Change password in the header for your own password.</p>}
          <button className="rounded border px-4 py-2">Save account</button>
        </fieldset></form>
        {selected.id !== current.id && <form onSubmit={reset} className="border-t pt-4"><fieldset disabled={busy || loading} className="space-y-3">
          <label className="block">Replacement temporary password<input required type="password" minLength={15} maxLength={128} autoComplete="new-password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} className={inputClass} /></label>
          <button className="rounded border px-4 py-2">Reset password</button>
        </fieldset></form>}</>}
      </section>
    </div>
    <section className="rounded-xl bg-white p-6 shadow-sm"><h2 className="mb-4 text-xl font-bold">Activity audit</h2>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">When</th><th className="p-2">Account</th><th className="p-2">Action</th><th className="p-2">Record</th></tr></thead><tbody>{events.map((event) => <tr key={event.id} className="border-t"><td className="p-2 whitespace-nowrap">{new Date(event.occurredAt).toLocaleString()}</td><td className="p-2">{event.actorUsername}</td><td className="p-2">{event.action.replaceAll('.', ' ').replaceAll('_', ' ')}</td><td className="p-2 break-all">{event.entityId || '—'}</td></tr>)}</tbody></table></div>
      {!loading && !events.length && <p>No events on this page.</p>}
      <div className="mt-4 flex gap-4"><button disabled={busy || loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Newer</button><button disabled={busy || loading || events.length < 25} onClick={() => setOffset(offset + 25)}>Older</button></div>
    </section>
  </div>;
}

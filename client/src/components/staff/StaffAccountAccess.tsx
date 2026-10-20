import { useEffect, useState } from 'react';
import axios from 'axios';
import { staffAccountOptionsUrl } from '../../api/staffAccountOptions';
import type { StaffAccountOption } from '../../api/staffAccountOptions';
import { roleLabels } from '../../auth/context';
export function StaffAccountAccess({ staffId }: { staffId: string }) {
  const [result, setResult] = useState<{ id: string; person: StaffAccountOption | null } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true; const controller = new AbortController(); setError(false);
    void axios.get<{ data: StaffAccountOption[] }>(staffAccountOptionsUrl, { signal: controller.signal })
      .then(response => { if (active) setResult({ id: staffId, person: response.data.data.find(person => person.id === staffId) ?? null }); })
      .catch(failure => { if (active && !axios.isCancel(failure)) setError(true); });
    return () => { active = false; controller.abort(); };
  }, [staffId]);
  const person = result?.id === staffId ? result.person : undefined;
  return <section className="mt-4 rounded-xl border p-4"><h3 className="font-semibold">Sign-in access</h3>
    {error ? <p role="alert">Could not load the linked account. Check Accounts.</p> : person === undefined ? <p>Loading sign-in access…</p>
      : person?.account ? <p>{person.account.username} · {roleLabels[person.account.role]} · {person.account.disabled ? 'Disabled' : 'Enabled'}</p>
        : <p>No sign-in account is linked to this staff member.</p>}
    <a className="mt-2 inline-block underline" href="/accounts">Manage staff links and permissions in Accounts</a>
  </section>;
}

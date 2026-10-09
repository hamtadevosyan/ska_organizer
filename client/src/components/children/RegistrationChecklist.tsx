import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { ClipboardCheck, Upload } from 'lucide-react';
import { authError, onSessionExpired } from '../../auth/transport';
import { getRegistrationChecklist } from '../../api/registrationForms';
import type { RegistrationChecklist as Checklist, RegistrationForm } from '../../api/registrationForms';
import { BlankFormActions } from '../registration/BlankFormActions';

const labels = { missing: 'Missing', needs_review: 'Needs review', complete: 'Complete', outdated: 'Updated form needed' };
export function RegistrationChecklist({ childId, refreshKey, busy, canEdit, admin, onAttach, onSelect, onForms, focusOnOpen = false }: {
  childId: string; refreshKey: number; busy: boolean; canEdit: boolean; admin: boolean; focusOnOpen?: boolean;
  onAttach: (form: RegistrationForm) => void; onSelect: (id: string) => void; onForms: (forms: RegistrationForm[]) => void;
}) {
  const [result, setResult] = useState<{ key: number; checklist: Checklist } | null>(null);
  const [error, setError] = useState(''); const [expired, setExpired] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null); const formCallback = useRef(onForms); formCallback.current = onForms;
  useEffect(() => { if (focusOnOpen) heading.current?.focus({ preventScroll: true }); }, [focusOnOpen]);
  useEffect(() => onSessionExpired(() => { setResult(null); setError(''); setExpired(true); formCallback.current([]); }), []);
  useEffect(() => {
    setResult(null); setError(''); formCallback.current([]);
    if (expired || busy) return;
    const controller = new AbortController();
    void getRegistrationChecklist(childId, controller.signal).then(checklist => {
      if (controller.signal.aborted) return;
      if (!Array.isArray(checklist.items) || !Number.isSafeInteger(checklist.requiredTotal) || !Number.isSafeInteger(checklist.requiredComplete)) throw new Error('Invalid checklist response.');
      setResult({ key: refreshKey, checklist }); formCallback.current(checklist.items.map(item => item.form));
    }).catch(failure => { if (!controller.signal.aborted && !axios.isCancel(failure)) setError(authError(failure, 'Could not check registration forms. Refresh documents to try again.')); });
    return () => controller.abort();
  }, [childId, refreshKey, busy, expired]);
  const checklist = !busy && result?.key === refreshKey ? result.checklist : null;
  const required = checklist?.items.filter(item => item.form.required) || [];
  const verifiedComplete = !checklist?.missingBasicInfo?.length && !!checklist?.items.length && checklist.complete && checklist.requiredTotal === required.length && checklist.requiredComplete === required.length && required.every(item => item.status === 'complete');
  if (expired) return null;
  return <section aria-label="Registration checklist" className="min-w-0 space-y-4 rounded-2xl border border-blue-100 bg-blue-50/50 p-4">
    <h3 ref={heading} tabIndex={-1} className="flex items-center gap-2 text-lg font-bold"><ClipboardCheck size={21} aria-hidden="true" />Registration checklist</h3>
    <p className="text-sm text-slate-600">Give parents the blank forms, attach their completed copies, then check each copy before marking it reviewed.</p>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error} Registration completion could not be verified.</p>}
    {!checklist && !error && <p role="status">Checking registration forms…</p>}
    {!!checklist?.missingBasicInfo?.length && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-amber-900">Missing basic information: {checklist.missingBasicInfo.join(', ')}. Edit the child profile to complete these items.</p>}
    {checklist && (!checklist.items.length ? <div className="space-y-2 rounded-xl bg-white p-4"><p>No registration forms have been set up. Registration completion cannot be verified.</p>{admin ? <a href="/registration-forms" className="font-semibold text-blue-800 underline">Upload blank registration forms</a> : <p className="text-sm text-slate-600">Ask an administrator to upload the required blank forms.</p>}</div> : <>
      <p role="status" className={'rounded-xl p-3 font-semibold ' + (verifiedComplete ? 'bg-emerald-50 text-emerald-800' : 'bg-white text-slate-800')}>{checklist.percentage !== undefined && <span>Enrollment {checklist.percentage}% · </span>}Required forms: {checklist.requiredComplete} of {checklist.requiredTotal} complete{verifiedComplete ? ' · Registration complete' : ' · Registration incomplete'}</p>
      <div className="space-y-3">{checklist.items.map(item => <article aria-label={item.form.title} key={item.form.id} className="min-w-0 space-y-3 rounded-xl border bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><h4 className="break-words font-bold">{item.form.title}</h4><p className="mt-1 text-sm text-slate-600">{item.form.required ? 'Required' : 'Optional'} · Blank form version {item.form.templateRevision}</p></div><span className={'rounded-full px-3 py-1 text-sm font-semibold ' + (item.status === 'complete' ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900')}>{labels[item.status] || 'Needs review'}</span></div>
        {item.form.instructions && <p className="whitespace-pre-wrap break-words text-sm text-slate-700">{item.form.instructions}</p>}
        {item.status === 'outdated' && <p className="text-sm text-amber-900">The blank form has changed. Attach a new completed copy of the current version, then review it.</p>}
        <BlankFormActions form={item.form} disabled={busy} />
        <div className="flex flex-wrap gap-2">{canEdit && <button type="button" disabled={busy} aria-label={'Attach completed ' + item.form.title} onClick={() => onAttach(item.form)} className="ska-button is-primary"><Upload size={17} aria-hidden="true" />Attach completed copy</button>}
          {item.document && <button type="button" disabled={busy} aria-label={(canEdit && item.status === 'needs_review' ? 'Review completed ' : 'View completed ') + item.form.title} onClick={() => onSelect(item.document!.id)} className="ska-button">{canEdit && item.status === 'needs_review' ? 'Review completed copy' : 'View completed copy'}</button>}</div>
      </article>)}</div>
      {canEdit && <p className="text-sm text-slate-600">Already saved a completed copy? Open it in Documents below and use Edit document details to link it to a registration form.</p>}
    </>)}
  </section>;
}

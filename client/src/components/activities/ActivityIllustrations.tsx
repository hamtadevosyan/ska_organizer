import { useContext, useEffect, useRef, useState } from 'react';
import type { Illustration } from '../../api/activities';
import { readActivityImage } from '../../api/activityImages';
import { AuthContext, verifiedWorkAccess } from '../../auth/context';
import { authError, onSessionExpired, onWorkAccessRequired } from '../../auth/transport';

export function ActivityIllustrations({ images, classroom = false, initiallyOpen = false, onRemove, resolvedSources }: {
  images?: Illustration[] | null; classroom?: boolean; initiallyOpen?: boolean; onRemove?: (id: string) => void;
  resolvedSources?: Record<string, string>;
}) {
  const auth = useContext(AuthContext);
  const session = auth?.account?.id || '';
  const checkedIn = auth?.account?.workAccess?.checkedIn;
  const allowed = !auth || !!auth.account && auth.ready && verifiedWorkAccess(auth.account);
  const pictures = (Array.isArray(images) ? images : []).filter(image => image && typeof image.id === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(image.id) && Number.isInteger(image.step) && image.step >= 1 && image.step <= 6 &&
    typeof image.caption === 'string').slice(0, 6).sort((a, b) => a.step - b.step);
  const signature = pictures.map(image => image.id).join(',');
  const records = useRef(pictures); records.current = pictures;
  const [open, setOpen] = useState(initiallyOpen);
  const [sources, setSources] = useState<Record<string, string>>({});
  const [sourceScope, setSourceScope] = useState('');
  const currentScope = session + '|' + String(classroom) + '|' + signature;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => { if (initiallyOpen) setOpen(true); }, [initiallyOpen]);
  useEffect(() => {
    if (!open || !signature || !allowed || resolvedSources !== undefined) return;
    const request = new AbortController(); const urls: string[] = []; let alive = true;
    setSources({}); setSourceScope(currentScope); setError(''); setLoading(true);
    const clearProtectedPictures = () => {
      request.abort(); urls.forEach(url => URL.revokeObjectURL(url)); urls.length = 0;
      if (alive) { setSources({}); setOpen(false); }
    };
    const expired = onSessionExpired(clearProtectedPictures);
    const workExpired = onWorkAccessRequired(clearProtectedPictures);
    void Promise.allSettled(records.current.map(async picture => {
      try {
        const blob = await readActivityImage(picture.id, classroom, request.signal);
        if (!alive || request.signal.aborted) return;
        const url = URL.createObjectURL(blob); urls.push(url);
        setSources(value => ({ ...value, [picture.id]: url }));
      } catch (failure) {
        if (alive && !request.signal.aborted) setError(authError(failure, 'Some step pictures could not be loaded. Try again.'));
      }
    })).finally(() => { if (alive && !request.signal.aborted) setLoading(false); });
    return () => { alive = false; request.abort(); expired(); workExpired(); urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [signature, classroom, open, retry, session, checkedIn, allowed, currentScope, resolvedSources]);
  if (!pictures.length) return null;
  return <section aria-label="Activity step pictures" className="mt-3 min-w-0 space-y-3 rounded-xl border border-violet-200 bg-violet-50 p-3 print:border-0 print:bg-white print:p-0">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold">Step pictures</h3>
      <button type="button" className="ska-button print:hidden" onClick={() => setOpen(value => !value)}>{open ? 'Hide step pictures' : 'Show step pictures'}</button></div>
    <p className="text-sm">AI illustrations. An adult must check that each picture matches the instructions before use.</p>
    {open && allowed && <>
      {loading && <p role="status">Loading step pictures…</p>}
      {error && <p role="alert">{error} <button type="button" className="underline print:hidden" onClick={() => setRetry(value => value + 1)}>Retry pictures</button></p>}
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">{pictures.map(picture => <figure key={picture.id} className="min-w-0 break-inside-avoid rounded-lg bg-white p-2">
        {(resolvedSources?.[picture.id] || sourceScope === currentScope && sources[picture.id]) && <img src={resolvedSources?.[picture.id] || sources[picture.id]} alt={'Step ' + picture.step + ': ' + picture.caption} width={picture.width} height={picture.height}
          className="mx-auto block h-auto max-h-96 w-full object-contain print:max-h-48" />}
        <figcaption className="mt-2 whitespace-pre-wrap break-words text-sm"><strong>Step {picture.step}:</strong> {picture.caption}</figcaption>
        {onRemove && <button type="button" className="ska-button mt-2 print:hidden" aria-label={'Remove picture for step ' + picture.step} onClick={() => onRemove(picture.id)}>Remove picture</button>}
      </figure>)}</div>
    </>}
  </section>;
}

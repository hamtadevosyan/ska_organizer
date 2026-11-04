import { useContext, useEffect, useRef, useState } from 'react';
import type { Entry } from '../../api/activities';
import { readActivityImage } from '../../api/activityImages';
import { AuthContext } from '../../auth/context';
import { authError, onSessionExpired, onWorkAccessRequired } from '../../auth/transport';

// Print pictures are loaded only after Print is chosen. This hook owns every
// temporary URL it passes to the print view and releases them on scope changes.
export function useActivityPicturePrint(entries: Entry[]) {
  const auth = useContext(AuthContext);
  const ids = [...new Set(entries.flatMap(entry => (entry.activity?.illustrations || []).map(image => image.id)))];
  const signature = ids.join(',');
  const scope = (auth?.account?.id || '') + '|' + signature;
  const request = useRef<AbortController | null>(null);
  const urls = useRef<string[]>([]);
  const mounted = useRef(true);
  const [prepared, setPrepared] = useState<{ scope: string; sources: Record<string, string> }>({ scope: '', sources: {} });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function release() {
    request.current?.abort(); request.current = null;
    urls.current.forEach(url => URL.revokeObjectURL(url)); urls.current = [];
  }
  const stop = useRef(release); stop.current = release;
  useEffect(() => {
    mounted.current = true;
    setBusy(false); setError(''); setPrepared({ scope: '', sources: {} });
    const clear = () => { stop.current(); if (mounted.current) { setPrepared({ scope: '', sources: {} }); setBusy(false); } };
    const expired = onSessionExpired(clear), workExpired = onWorkAccessRequired(clear);
    return () => { mounted.current = false; stop.current(); expired(); workExpired(); };
  }, [scope]);
  async function print() {
    if (request.current) return;
    if (!ids.length) { window.print(); return; }
    release(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(''); setPrepared({ scope: '', sources: {} });
    try {
      const sources: Record<string, string> = {};
      for (const id of ids) {
        const blob = await readActivityImage(id, false, controller.signal);
        if (controller.signal.aborted || !mounted.current) return;
        const url = URL.createObjectURL(blob); urls.current.push(url); sources[id] = url;
        await new Promise<void>((resolve, reject) => {
          const image = new Image();
          const clear = () => { image.onload = null; image.onerror = null; controller.signal.removeEventListener('abort', cancelled); };
          const cancelled = () => { clear(); image.src = ''; resolve(); };
          image.onload = () => { clear(); resolve(); }; image.onerror = () => { clear(); reject(new Error('A step picture could not be prepared for printing.')); };
          controller.signal.addEventListener('abort', cancelled, { once: true });
          image.src = url;
        });
      }
      if (controller.signal.aborted || !mounted.current) return;
      setPrepared({ scope, sources });
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!controller.signal.aborted && mounted.current) window.print();
    } catch (failure) {
      if (!controller.signal.aborted && mounted.current && request.current === controller) { release(); setBusy(false); setPrepared({ scope: '', sources: {} }); setError(authError(failure, 'Could not prepare step pictures for printing. Try again.')); }
    } finally {
      if (request.current === controller) { request.current = null; if (mounted.current) setBusy(false); }
    }
  }
  function cancel() { release(); setBusy(false); setPrepared({ scope: '', sources: {} }); setError('Print preparation cancelled.'); }
  return { print, busy, error, cancel, sources: prepared.scope === scope ? prepared.sources : {} };
}

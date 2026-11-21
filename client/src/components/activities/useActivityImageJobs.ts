import { useEffect, useRef, useState } from 'react';
import type { ActivityDetails, Illustration } from '../../api/activities';
import { cancelActivityImageJob, createActivityImageJob, readActivityImageJob } from '../../api/activityImages';
import type { ActivityImageJob } from '../../api/activityImages';
import { authError, onSessionExpired, onWorkAccessRequired } from '../../auth/transport';

function pause(signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = window.setTimeout(done, 1500);
    signal.addEventListener('abort', done, { once: true });
  });
}
type Active = { index: number; controller: AbortController; id: string | null };
export function useActivityImageJobs(onImages: (index: number, images: Illustration[]) => void) {
  const active = useRef<Active | null>(null);
  const mounted = useRef(true);
  const completed = useRef(onImages); completed.current = onImages;
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [jobs, setJobs] = useState<Record<number, ActivityImageJob>>({});
  function cancel(show = true) {
    const current = active.current; if (!current) return;
    active.current = null; current.controller.abort();
    if (current.id) void cancelActivityImageJob(current.id).catch(() => {});
    if (mounted.current) {
      setActiveIndex(null);
      if (show) setJobs(values => ({ ...values, [current.index]: { id: current.id || '', status: 'cancelled', completed: 0, total: values[current.index]?.total || 0, images: [], message: 'Picture generation cancelled. Your activity is unchanged.' } }));
    }
  }
  const stop = useRef(cancel); stop.current = cancel;
  useEffect(() => {
    mounted.current = true;
    const expired = onSessionExpired(() => stop.current(false));
    const workExpired = onWorkAccessRequired(() => stop.current(false));
    return () => { mounted.current = false; stop.current(false); expired(); workExpired(); };
  }, []);
  async function start(index: number, details: ActivityDetails, steps: string[]) {
    if (active.current || !steps.length || steps.length > 6) return;
    const current: Active = { index, controller: new AbortController(), id: null };
    active.current = current; setActiveIndex(index);
    setJobs(values => ({ ...values, [index]: { id: '', status: 'queued', completed: 0, total: steps.length, images: [] } }));
    try {
      let value = await createActivityImageJob({ name: details.name.trim(), description: details.description.trim(), steps: steps.map(step => step.trim()) }, current.controller.signal);
      if (!mounted.current || active.current !== current || current.controller.signal.aborted) {
        if (value?.id) void cancelActivityImageJob(value.id).catch(() => {});
        return;
      }
      current.id = value.id;
      while (mounted.current && active.current === current && !current.controller.signal.aborted) {
        setJobs(values => ({ ...values, [index]: value }));
        if (value.status === 'complete') { completed.current(index, value.images); break; }
        if (value.status === 'failed' || value.status === 'cancelled') break;
        await pause(current.controller.signal);
        if (active.current !== current || current.controller.signal.aborted) return;
        value = await readActivityImageJob(current.id!, current.controller.signal);
      }
    } catch (failure) {
      if (mounted.current && active.current === current && !current.controller.signal.aborted) {
        if (current.id) void cancelActivityImageJob(current.id).catch(() => {});
        setJobs(values => ({ ...values, [index]: { id: current.id || '', status: 'failed', completed: 0, total: steps.length, images: [], message: authError(failure, 'Could not create step pictures. Try again when the image machine is available.') } }));
      }
    } finally {
      if (active.current === current) { active.current = null; if (mounted.current) setActiveIndex(null); }
    }
  }
  return { activeIndex, jobs, start, cancel, reset: () => { cancel(false); setJobs({}); } };
}

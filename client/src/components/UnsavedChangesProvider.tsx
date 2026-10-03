import { useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useBlocker } from 'react-router-dom';
import AppModal from './AppModal';
import { UnsavedChangesContext } from './UnsavedChangesContext';

// One blocker covers both drafts. State lives only in the signed-in React tree.
export default function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [work, setWork] = useState({ dirty: false, busy: false });
  const current = useRef(work);
  const report = useCallback((dirty: boolean, busy: boolean) => {
    current.current = { dirty, busy };
    setWork((old) => old.dirty === dirty && old.busy === busy ? old : { dirty, busy });
  }, []);
  const blocker = useBlocker(useCallback(() => current.current.dirty || current.current.busy, []));
  return <UnsavedChangesContext.Provider value={report}>
    {children}
    {blocker.state === 'blocked' && <AppModal id="unsaved-planner" title="Leave your unsaved work?" onDismiss={() => blocker.reset()}>
      <p className="mt-3 text-slate-700">{work.busy ? 'A save is in progress. Keep editing and wait for its result before leaving.' : 'Your unsaved schedule and activity details will be discarded. Saved activities stay in the catalog.'}</p>
      <div className="mt-5 flex flex-wrap gap-3">
        <button type="button" autoFocus className="ska-button is-primary" onClick={() => blocker.reset()}>Keep editing</button>
        <button type="button" disabled={work.busy} className="ska-button" onClick={() => blocker.proceed()}>Discard and leave</button>
      </div>
    </AppModal>}
  </UnsavedChangesContext.Provider>;
}

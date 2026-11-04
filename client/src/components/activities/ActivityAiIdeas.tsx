import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BookOpen, Sparkles } from 'lucide-react';
import AppModal from '../AppModal';
import { ActivityForm } from './ActivityForm';
import { ActivityTutorialLinks } from './ActivityTutorialLinks';
import { ActivityIllustrations } from './ActivityIllustrations';
import { useActivityImageJobs } from './useActivityImageJobs';
import { authError } from '../../auth/transport';
import { activityAiStatus, draftActivityIdeas } from '../../api/activityAi';
import type { ActivityAiDraft, ActivityAiFocus, ActivityAiResult, ActivityAiSource, ActivityAiStatus } from '../../api/activityAi';
import type { Activity, ActivityDetails, Illustration } from '../../api/activities';
import { activityImageStatus } from '../../api/activityImages';
import type { ActivityImageStatus } from '../../api/activityImages';
import type { Room } from '../../api/rooms';

type Props = { room: Room; onSaved: (activity: Activity) => void; onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void };
const focusOptions: [ActivityAiFocus, string][] = [['balanced', 'A little of everything'], ['language', 'Language & early literacy'],
  ['creative', 'Art & creative expression'], ['physical', 'Movement & coordination'], ['discovery', 'Discovery & early math'], ['social', 'Social & emotional skills']];
function rememberNames(previous: string[], incoming: string[]) {
  const names = new Map<string, string>();
  for (const value of [...previous, ...incoming]) {
    const name = value.trim();
    if (!name || name.length > 100) continue;
    const key = name.toLocaleLowerCase();
    names.delete(key); names.set(key, name);
  }
  return [...names.values()].slice(-20);
}
// Keep provenance with the saved activity using its existing plain-text description.
function editableDetails(draft: ActivityAiDraft, sources: ActivityAiSource[]): ActivityDetails {
  const references = sources.filter(source => draft.sourceIds.includes(source.id));
  const description = draft.description + '\n\nAI-assisted educational draft. Review safety and suitability before use.';
  const referenceFormats = [
    (source: ActivityAiSource) => '[' + source.id + '] ' + source.title + ' — ' + source.publisher + '; ' + source.version + '; ' + source.section,
    (source: ActivityAiSource) => '[' + source.id + '] ' + source.version + '; ' + source.section,
    (source: ActivityAiSource) => '[' + source.id + '] ' + source.version,
  ];
  const notes = references.length ? referenceFormats.map(format => '\n\nPlanning references:\n' + references.map(format).join('\n')) : [''];
  // Full instructions and source identities survive. Very long metadata uses compact
  // local source IDs and complete versions, rather than truncating an instruction.
  const note = notes.find(value => description.length + value.length <= 4000) || notes[notes.length - 1];
  return { name: draft.name, description: description + note,
    durationMinutes: draft.durationMinutes, ageMinMonths: draft.ageMinMonths, ageMaxMonths: draft.ageMaxMonths,
    roomId: draft.roomId, materials: draft.materials, materialsNotes: draft.materialsNotes || '', materialsLinks: [], tutorialLinks: draft.tutorialLinks || [] };
}
export function ActivityAiIdeas({ room, onSaved, onCancel, onDirtyChange, onBusyChange }: Props) {
  const [status, setStatus] = useState<ActivityAiStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [retry, setRetry] = useState(0);
  const [focus, setFocus] = useState<ActivityAiFocus>('balanced');
  const [theme, setTheme] = useState('');
  const [count, setCount] = useState('3');
  const [minutes, setMinutes] = useState('20');
  const [includeVideos, setIncludeVideos] = useState(true);
  const [result, setResult] = useState<ActivityAiResult | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [saved, setSaved] = useState<number[]>([]);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [imageStatus, setImageStatus] = useState<ActivityImageStatus | null>(null);
  const [imageRetry, setImageRetry] = useState(0);
  const [pictures, setPictures] = useState<Record<number, Illustration[]>>({});
  const imageJobs = useActivityImageJobs((index, images) => { setPictures(values => ({ ...values, [index]: images })); setDirty(true); });
  const controller = useRef<AbortController | null>(null);
  const turn = useRef(0);
  // Only this dialog's completed AI suggestions are remembered. Saved library
  // records and abandoned/failed requests never become generation context.
  const recentNames = useRef<string[]>([]);
  const numeric = (value: string, minimum: number, maximum: number) => /^\d+$/.test(value) && Number(value) >= minimum && Number(value) <= maximum;
  const valid = numeric(count, 1, 5) && numeric(minutes, 5, 120);
  useLayoutEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    const request = new AbortController(); setChecking(true); setError('');
    void activityAiStatus(request.signal).then(value => { if (!request.signal.aborted) setStatus(value); })
      .catch(failure => { if (!request.signal.aborted) setError(authError(failure, 'Could not check the local AI connection.')); })
      .finally(() => { if (!request.signal.aborted) setChecking(false); });
    return () => request.abort();
  }, [retry]);
  useEffect(() => () => { turn.current++; controller.current?.abort(); }, []);
  useEffect(() => {
    const request = new AbortController();
    setImageStatus(null);
    void activityImageStatus(request.signal).then(value => { if (!request.signal.aborted) setImageStatus(value); })
      .catch(failure => { if (!request.signal.aborted) setImageStatus({ enabled: false, available: false, busy: false, model: null, message: authError(failure, 'Step pictures are not available. Check the image machine setup.') }); });
    return () => request.abort();
  }, [imageRetry]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function changed() { setDirty(true); setConfirmCancel(false); setError(''); setNotice(''); }
  function stop() { turn.current++; controller.current?.abort(); setPending(false); }
  function dismiss() {
    if (saving) return;
    stop(); imageJobs.cancel();
    if (dirty) setConfirmCancel(true); else onCancel();
  }
  async function generate() {
    if (!valid || pending || saving || checking || imageJobs.activeIndex !== null || !status?.available) return;
    const request = new AbortController(); controller.current?.abort(); controller.current = request;
    const currentTurn = ++turn.current; setPending(true); setError(''); setNotice(''); setConfirmCancel(false); setDirty(true);
    try {
      const value = await draftActivityIdeas({ roomId: room.id, focus, theme: theme.trim(), activityCount: Number(count), durationMinutes: Number(minutes), includeVideos, avoidNames: [...recentNames.current] }, request.signal);
      if (request.signal.aborted || currentTurn !== turn.current) return;
      recentNames.current = rememberNames(recentNames.current, value.drafts.map(draft => draft.name));
      setResult(value); setSelected(null); setSaved([]); setPictures({}); imageJobs.reset();
    } catch (failure) {
      if (!request.signal.aborted && currentTurn === turn.current) setError(authError(failure, 'Could not create AI ideas. Your library and week are unchanged.'));
    } finally { if (!request.signal.aborted && currentTurn === turn.current) setPending(false); }
  }
  function activitySaved(activity: Activity) {
    onSaved(activity); setSaved(values => [...values, selected!]); setSelected(null);
    setNotice('Activity saved to your library. Choose Generate week to include saved ideas in your plan.');
  }
  const selectedDraft = result && selected !== null ? result.drafts[selected] : null;
  return <AppModal id="activity-ai-ideas" title="AI activity ideas" initialFocusId="activity-ai-focus" onDismiss={dismiss}>
    <div className="planner-ai planner-reuse">
      <div className="planner-generation-intro"><Sparkles size={26} aria-hidden="true" /><div><strong>Fresh ideas for little minds</strong><p>Create varied step-by-step activity guides with preparation, questions, age adaptations and cleanup. Create more ideas to explore different activities, then review and save the ones you love.</p></div></div>
      <p className="planner-copy-summary"><strong>{room.name}</strong> · Ages {room.ageMinMonths}–{room.ageMaxMonths} months<br />Ideas stay on your local AI server. Child names, health records and staff details are not included.</p>
      <p>These are educational drafts. Check safety, suitability and materials before use. AI ideas do not establish regulatory compliance or replace your judgment.</p>
      {checking ? <p role="status">Checking local AI…</p> : !status?.available ? <section className="planner-ai-unavailable" aria-label="Local AI availability"><h3>Local AI is not ready</h3><p>{status?.message || 'Check the local AI connection and try again.'}</p><p>You can keep creating activities and planning the week manually.</p><button type="button" className="ska-button" onClick={() => setRetry(value => value + 1)}>Check AI connection</button></section> : <p className="planner-generation-small">Local model: {status.model} · {status.sourceCount} approved planning {status.sourceCount === 1 ? 'source' : 'sources'} available</p>}
      {selectedDraft && result ? <section aria-label="Review AI activity" className="planner-ai-edit">
        <p>Review and edit every detail. Save activity adds this idea to your library; your schedule stays as it is.</p>
        <ActivityForm key={selected!} activity={null} initialDetails={{ ...editableDetails(selectedDraft, result.sources), illustrations: pictures[selected!] || [] }} room={room}
          helpText="You can change the name, instructions, ages and materials before saving. Link materials to Inventory for stock and purchasing checks."
          onDirtyChange={() => setDirty(true)} onBusyChange={busy => { setSaving(busy); onBusyChange(busy); }} onSaved={activitySaved} onClose={() => setSelected(null)} />
      </section> : <>
        <fieldset disabled={pending || saving || checking || imageJobs.activeIndex !== null || !status?.available} className="planner-ai-settings">
          <label className="ska-field">Development focus<select id="activity-ai-focus" value={focus} onChange={event => { changed(); setFocus(event.target.value as ActivityAiFocus); }}>{focusOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="ska-field">Theme (optional)<input maxLength={120} value={theme} placeholder="For example, autumn leaves" onChange={event => { changed(); setTheme(event.target.value); }} /></label>
          <p className="planner-generation-small">Use a topic, not personal information about children or employees.</p>
          <div className="planner-generation-times"><label className="ska-field">Number of ideas<input type="number" min="1" max="5" step="1" value={count} aria-invalid={!numeric(count, 1, 5)} onChange={event => { changed(); setCount(event.target.value); }} /></label>
            <label className="ska-field">Minutes per activity<input type="number" min="5" max="120" step="1" value={minutes} aria-invalid={!numeric(minutes, 5, 120)} onChange={event => { changed(); setMinutes(event.target.value); }} /></label></div>
          {!valid && <p role="alert">Choose 1–5 ideas and 5–120 minutes per activity.</p>}
          <label className="flex min-h-[44px] items-center gap-2"><input type="checkbox" checked={includeVideos} onChange={event => { changed(); setIncludeVideos(event.target.checked); }} />Include how-to video links</label>
          <p className="planner-generation-small">Ideas may include a related video example or a YouTube search for demonstrations. Search results are unreviewed. External websites open only when you choose a link.</p>
          <button type="button" className="ska-button is-primary" disabled={!valid} onClick={() => void generate()}><Sparkles size={18} aria-hidden="true" />{result ? 'Create more AI ideas' : 'Create AI ideas'}</button>
        </fieldset>
        {pending && <div className="planner-generation-pending" role="status"><p>Creating ideas on your local AI server…</p><button type="button" className="ska-button" onClick={() => { stop(); setNotice('AI generation stopped. Your library and week are unchanged.'); }}>Stop AI generation</button></div>}
        {result && <section aria-label="AI activity ideas preview" className="planner-ai-results"><h3>Choose an idea to make your own</h3>
          {result.warnings.length > 0 && <ul className="planner-generation-warnings">{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
          {result.drafts.map((draft, index) => <article key={index} className="planner-ai-card" aria-label={'AI idea ' + (index + 1)}>
            <span className="planner-ai-number">Idea {index + 1}</span><h3>{draft.name}</h3><p>{draft.durationMinutes} minutes · Ages {draft.ageMinMonths}–{draft.ageMaxMonths} months</p><p className="planner-ai-text">{draft.description}</p>
            {!!draft.materialsNotes && <p className="planner-ai-text"><strong>Suggested materials:</strong> {draft.materialsNotes}</p>}
            <ActivityTutorialLinks links={draft.tutorialLinks} />
            {!draft.tutorialLinks?.length && <p className="planner-generation-small">No related how-to video was selected for this idea.</p>}
            {!!draft.sourceIds.length && <p className="planner-generation-small">Planning references: {draft.sourceIds.join(', ')}</p>}
            {!!draft.visualSteps?.length && !saved.includes(index) && <section aria-label={'Step pictures for idea ' + (index + 1)} className="mt-3 space-y-2 rounded-xl border border-violet-200 bg-white p-3">
              <p className="text-sm">Optional step pictures are created locally, one at a time. This can take several minutes on the AI laptop. Review every picture before saving it.</p>
              {!imageStatus ? <p role="status">Checking step picture connection…</p> : !imageStatus.available ? <><p>{imageStatus.message || 'Step pictures are not ready. Check the image machine setup. You can still save this activity without pictures.'}</p><button type="button" className="ska-button" onClick={() => setImageRetry(value => value + 1)}>Check picture connection</button></> : <>
                {imageJobs.activeIndex === index ? <><p role="status">Creating step pictures: {imageJobs.jobs[index]?.completed || 0} of {imageJobs.jobs[index]?.total || draft.visualSteps.length} complete.</p>
                  <button type="button" className="ska-button" onClick={() => imageJobs.cancel()}>Cancel picture generation</button></>
                  : <button type="button" className="ska-button" disabled={pending || imageJobs.activeIndex !== null} onClick={() => void imageJobs.start(index, editableDetails(draft, result.sources), draft.visualSteps!)}>{imageJobs.jobs[index]?.status === 'failed' ? 'Retry step pictures' : pictures[index]?.length ? 'Create new step pictures' : 'Create step pictures'}</button>}
                {imageStatus.busy && imageJobs.activeIndex === null && <p>The image machine was busy when checked. You can save without pictures or try again when it is free.</p>}
              </>}
              {(imageJobs.jobs[index]?.status === 'failed' || imageJobs.jobs[index]?.status === 'cancelled') && <p role={imageJobs.jobs[index].status === 'failed' ? 'alert' : 'status'}>{imageJobs.jobs[index].message || 'Step pictures could not be completed. You can save without pictures and try again later.'}</p>}
            </section>}
            <ActivityIllustrations images={pictures[index]} initiallyOpen />
            {saved.includes(index) ? <p role="status" className="planner-save-state is-saved">Saved to library</p> : <button type="button" className="ska-button" disabled={pending || imageJobs.activeIndex !== null} onClick={() => { setSelected(index); setConfirmCancel(false); setNotice(''); }}>Review idea {index + 1}</button>}
          </article>)}
          <p className="planner-generation-small">Generated locally with {result.model}. Saving an idea does not add it to the week or change stock.</p>
        </section>}
      </>}
      {!!result?.sources.length && <details className="planner-ai-sources"><summary><BookOpen size={18} aria-hidden="true" />Planning sources ({result.sources.length})</summary><p>These source excerpts informed the draft. Check the original document and version when a decision depends on a policy or rule.</p>
        {result.sources.map(source => <section key={source.id} aria-label={'Source ' + source.id}><h3>[{source.id}] {source.title}</h3><p>{source.publisher} · {source.version} · {source.section}</p><p>{source.kind === 'regulation' ? 'Regulatory reference' : source.kind === 'policy' ? 'Policy reference' : 'Educational reference'}</p><blockquote>{source.text}</blockquote></section>)}
      </details>}
      {notice && <p role="status" className="planner-notice">{notice}</p>}
      {error && <p role="alert" className="ska-alert is-error">{error}</p>}
      <button type="button" className="ska-button" disabled={saving} onClick={dismiss}>Cancel</button>
      {confirmCancel && <div role="group" aria-label="Discard AI ideas" className="planner-generation-unfilled"><p>Discard these unsaved AI ideas? Activities you already saved will stay in your library.</p><div className="planner-action-buttons"><button type="button" className="ska-button" onClick={onCancel}>Discard AI ideas</button><button type="button" className="ska-button" onClick={() => setConfirmCancel(false)}>Keep editing</button></div></div>}
    </div>
  </AppModal>;
}

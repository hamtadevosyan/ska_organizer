import { useEffect, useState } from 'react';
import axios from 'axios';
import { HeartPulse, Phone, ShieldAlert } from 'lucide-react';
import { useAuth } from '../../auth/context';
import { authError } from '../../auth/transport';
import { emptySafety, readSafety, saveSafety } from '../../api/childSafety';
import type { SafetyCard, SafetyContact, SafetyDetails } from '../../api/childSafety';
import type { DocumentWork } from '../../api/childDocuments';
import './child-safety.css';

const fields = [
  ['allergies', 'Allergy details', 2000], ['dietaryRestrictions', 'Dietary restrictions', 2000],
  ['medicalAlerts', 'Medical alerts', 2000], ['careInstructions', 'Emergency care instructions', 4000],
  ['medicationInstructions', 'Approved medication instructions', 2000], ['medicationLocation', 'Medication location', 500],
  ['physicianName', 'Physician name', 150], ['physicianPhone', 'Physician phone', 80], ['pickupRestrictions', 'Pickup restrictions', 2000],
] as const;
const readable = (value: string) => value || 'Not recorded';
const blankContact = (): SafetyContact => ({ name: '', relationship: '', phone: '' });
export default function ChildSafetyCard({ childId, name, onWorkChange }: { childId: string; name: string; onWorkChange?: (work: DocumentWork) => void }) {
  const { account, serverUnavailable } = useAuth();
  const teacher = account?.role === 'teacher';
  const permitted = !!account && ['admin', 'editor', 'teacher'].includes(account.role);
  const [revision, setRevision] = useState(0);
  const identity = JSON.stringify([account?.id, account?.role, account?.roomId, childId]);
  const [editVersion, setEditVersion] = useState(0);
  const key = JSON.stringify([account?.id, account?.role, account?.roomId, childId, revision, serverUnavailable]);
  const [loaded, setLoaded] = useState<{ key: string; card: SafetyCard } | null>(null);
  const [failure, setFailure] = useState<{ key: string; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(emptySafety);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => { onWorkChange?.({ dirty: editing && dirty, busy }); }, [onWorkChange, editing, dirty, busy]);
  useEffect(() => { setEditing(false); setDraft(emptySafety()); setReviewed(false); setDirty(false); setSaveError(''); setEditVersion(0); }, [identity]);
  useEffect(() => {
    let active = true; const controller = new AbortController();
    setLoaded(null); setFailure(null);
    if (!permitted || serverUnavailable) return () => controller.abort();
    void readSafety(childId, teacher, controller.signal).then(result => {
      let card: SafetyCard;
      if (teacher) {
        if (!('card' in result) || result.state !== 'assigned' || result.room?.id !== account?.roomId || result.childId !== childId) throw new Error('Your class assignment changed. Reload your session.');
        card = result.card;
      } else {
        if ('card' in result) throw new Error('The safety card response was not valid. Reload the card.');
        card = result;
      }
      if (active) setLoaded({ key, card });
    }).catch(error => { if (active && !axios.isCancel(error)) setFailure({ key, text: authError(error, 'Could not load the health and emergency card.') }); });
    return () => { active = false; controller.abort(); };
  }, [key, childId, teacher, permitted, serverUnavailable, account?.roomId]);
  // Periodic/focus refresh clears old clinical details. An administrator's dirty
  // draft remains on screen until they explicitly reload or finish editing.
  useEffect(() => {
    const refresh = () => { if (!editing && document.visibilityState === 'visible') setRevision(value => value + 1); };
    const timer = window.setInterval(refresh, 30000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [editing]);
  const card = loaded?.key === key ? loaded.card : null;
  const error = failure?.key === key ? failure.text : '';
  if (!permitted) return null;
  function change<K extends keyof SafetyDetails>(field: K, value: SafetyDetails[K]) { setDraft(current => ({ ...current, [field]: value })); setDirty(true); setReviewed(false); }
  function contactEditor(field: 'emergencyContacts' | 'authorizedPickup', label: string) {
    return <fieldset className="safety-contact-editor"><legend>{label}</legend>
      {draft[field].map((contact, index) => <div key={index}>
        {(['name', 'relationship', 'phone'] as const).map(part => <label key={part}>{label} {index + 1} {part}<input required={part === 'name' || part === 'phone' && field === 'emergencyContacts'} type={part === 'phone' ? 'tel' : 'text'} maxLength={part === 'name' ? 150 : part === 'phone' ? 80 : 100} value={contact[part]}
          onChange={event => change(field, draft[field].map((value, i) => i === index ? { ...value, [part]: event.target.value } : value))} /></label>)}
        <button type="button" onClick={() => change(field, draft[field].filter((_, i) => i !== index))}>Remove {label.toLowerCase()} {index + 1}</button>
      </div>)}
      <button type="button" disabled={draft[field].length >= 10} onClick={() => change(field, [...draft[field], blankContact()])}>Add {label.toLowerCase()}</button>
    </fieldset>;
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!card || busy || account?.role !== 'admin') return;
    setBusy(true); setSaveError('');
    try {
      const value = await saveSafety(childId, draft, editVersion, reviewed);
      setLoaded({ key, card: value }); setEditing(false); setDirty(false);
    } catch (failure) { setSaveError(authError(failure, 'Could not save the safety card. Your changes are still here.')); }
    finally { setBusy(false); }
  }
  return <section className="child-safety" aria-label={'Health and emergency for ' + name}>
    <header><HeartPulse aria-hidden="true" /><div><h3>Health & emergency</h3><p>{name}</p></div></header>
    {serverUnavailable ? <p role="alert">Current safety information is unavailable while the connection is interrupted. Use the facility emergency backup.</p>
      : error ? <p role="alert">{error}</p> : !card ? <p role="status">Loading current safety information…</p> : <>
        <p className="safety-review">{card.reviewedAt ? 'Last reviewed: ' + new Date(card.reviewedAt).toLocaleString() : 'Not yet reviewed. Ask an administrator to complete this card.'}</p>
        {!editing ? <>
          <div className={'safety-allergy is-' + card.allergyStatus}><ShieldAlert aria-hidden="true" /><div><strong>{card.allergyStatus === 'recorded' ? 'Reported allergies' : card.allergyStatus === 'none' ? 'No allergies reported' : 'Allergy information unknown'}</strong><p>{card.allergyStatus === 'recorded' ? card.allergies : card.allergyStatus === 'unknown' ? 'Do not assume there are no allergies. Confirm the approved care instructions.' : 'As recorded at the last review.'}</p></div></div>
          <dl>{fields.filter(([field]) => field !== 'allergies').map(([field, label]) => <div key={field}><dt>{label}</dt><dd>{field === 'physicianPhone' && card[field] ? <a href={'tel:' + card[field]} aria-label="Call physician">{card[field]}</a> : readable(card[field])}</dd></div>)}</dl>
          <p><strong>Emergency treatment consent:</strong> {card.treatmentConsent === 'on-file' ? 'On file' : card.treatmentConsent === 'not-on-file' ? 'Not on file' : 'Unknown'}</p>
          {(['emergencyContacts', 'authorizedPickup'] as const).map(field => <div key={field}><h4>{field === 'emergencyContacts' ? 'Emergency contacts' : 'Authorized pickup people'}</h4>
            {!card[field].length ? <p>Not recorded. Confirm with the facility.</p> : <ul>{card[field].map((contact, index) => <li key={index}><strong>{contact.name}</strong>{contact.relationship && <span> · {contact.relationship}</span>}<span className="safety-phone"><Phone size={16} aria-hidden="true" />{contact.phone ? <a href={'tel:' + contact.phone} aria-label={'Call ' + contact.name}>{contact.phone}</a> : 'Phone not recorded'}</span></li>)}</ul>}</div>)}
          <p className="safety-note">Follow the approved care plan and facility emergency procedures. Viewing this card does not authorize medication administration or child release by itself.</p>
          {account?.role === 'admin' && <button type="button" onClick={() => { setDraft(Object.fromEntries(Object.keys(emptySafety()).map(field => [field, card[field as keyof SafetyDetails]])) as SafetyDetails); setEditVersion(card.version); setReviewed(false); setEditing(true); setDirty(false); }}>Edit safety card</button>}
          <button type="button" onClick={() => setRevision(value => value + 1)}>Refresh safety card</button>
        </> : <form onSubmit={event => void save(event)}><fieldset disabled={busy}>
          <label>Allergy status<select value={draft.allergyStatus} onChange={event => { const value = event.target.value as SafetyDetails['allergyStatus']; change('allergyStatus', value); if (value !== 'recorded') change('allergies', ''); }}><option value="unknown">Unknown</option><option value="none">No allergies reported</option><option value="recorded">Allergies recorded</option></select></label>
          {fields.map(([field, label, limit]) => <label key={field}>{label}<textarea rows={field === 'careInstructions' ? 4 : 2} maxLength={limit} value={draft[field]} onChange={event => change(field, event.target.value)} /></label>)}
          <label>Emergency treatment consent<select value={draft.treatmentConsent} onChange={event => change('treatmentConsent', event.target.value as SafetyDetails['treatmentConsent'])}><option value="unknown">Unknown</option><option value="on-file">On file</option><option value="not-on-file">Not on file</option></select></label>
          {contactEditor('emergencyContacts', 'Emergency contact')}{contactEditor('authorizedPickup', 'Authorized pickup person')}
          <label className="safety-ack"><input type="checkbox" required checked={reviewed} onChange={event => setReviewed(event.target.checked)} />I verified this card against current parent and medical instructions.</label>
          {saveError && <p role="alert">{saveError}</p>}
          <button type="submit" disabled={!reviewed || busy}>{busy ? 'Saving…' : 'Save reviewed safety card'}</button>
          <button type="button" onClick={() => { if (!dirty || window.confirm('Discard the unsaved safety card changes?')) { setEditing(false); setDirty(false); } }}>Cancel safety changes</button>
        </fieldset></form>}
      </>}
  </section>;
}

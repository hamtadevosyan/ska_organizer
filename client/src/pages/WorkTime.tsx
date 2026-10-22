import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';
import { AuthContext, useAuth } from '../auth/context';
import { authError } from '../auth/transport';
import { API_BASE_URL } from '../lib/api';
import { hours, localTime } from '../components/payroll/types';
import { useUnsavedChanges } from '../components/UnsavedChangesContext';
import './payroll.css';
export type WorkData = {today:string;timeZone:string;staff:{id:string;name:string;active:boolean;scheduleVersion:number;defaultMinutes:number;entries:{effectiveOn:string;minutes:number;reason:string}[]}[];
  items:{staffId:string;name:string;date:string;version:number;plannedMinutes:number;paidMillis:number;extraMillis:number;incomplete:boolean;status:string;reason:string;checkout:string|null;canCorrect:boolean}[]};
const url = API_BASE_URL + '/api/work-time';
export default function WorkTime() {
  const { account, serverUnavailable } = useAuth();
  if (serverUnavailable) return <p role="alert">The connection is interrupted. Reconnect before reviewing work time.</p>;
  if (!account || account.disabled || account.mustChangePassword || !['admin','editor'].includes(account.role)) return <p role="alert">Manager work-time access is required.</p>;
  return <ManagerWorkTime key={account.id+':'+account.role} />;
}
function ManagerWorkTime() {
  const report = useUnsavedChanges(); const [dirty,setDirty] = useState(false);
  const [data,setData] = useState<WorkData|null>(null), [error,setError] = useState(''), [busy,setBusy] = useState(false), [selected,setSelected] = useState(''), [message,setMessage] = useState('');
  const [revision,setRevision] = useState(0); const mounted = useRef(true);
  useEffect(()=>{report(dirty,busy);return()=>report(false,false);},[dirty,busy,report]);
  useEffect(()=>{if(!dirty&&!busy)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty,busy]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{const c=new AbortController();void axios.get<{data:WorkData}>(url,{signal:c.signal}).then(r=>{if(!c.signal.aborted){setData(r.data.data);setError('');}}).catch(e=>{if(!c.signal.aborted&&!axios.isCancel(e)){setData(null);setError(authError(e,'Could not load employee work time.'));}});return()=>c.abort();},[revision]);
  async function save(path:string,body:unknown){if(busy)return;setBusy(true);setError('');setMessage('');try{await axios.post(url+path,body);if(mounted.current){setDirty(false);setData(null);setRevision(n=>n+1);setMessage('Saved.');}}catch(e){if(mounted.current)setError(authError(e,'Could not save this review. Refresh and review the latest record.'));}finally{if(mounted.current)setBusy(false);}}
  function submit(e:FormEvent<HTMLFormElement>,run:(f:FormData)=>void){e.preventDefault();run(new FormData(e.currentTarget));}
  const person=data?.staff.find(s=>s.id===selected); const pending=data?.items.filter(i=>i.status==='pending')||[];
  return <div className="payroll-page ska-core-page"><header><h1>Work time</h1><p>Approved daily hours and extra-time reviews. Pay rates and tax records are restricted to administrators.</p></header>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}<button disabled={busy} onClick={()=>{if(dirty&&!window.confirm('Discard unsaved work-time form changes?'))return;setDirty(false);setRevision(n=>n+1);}}>Refresh work time</button>
    {!data?<p role="status">Loading work time…</p>:<><section><h2>Approved daily hours</h2><label>Employee<select aria-label="Work-time employee" value={selected} disabled={busy} onChange={e=>{if(dirty&&!window.confirm('Discard unsaved work-time form changes?'))return;setDirty(false);setSelected(e.target.value);}}><option value="">Choose an employee</option>{data.staff.map(s=><option key={s.id} value={s.id}>{s.name}{s.active?'':' · Inactive'}</option>)}</select></label>
      {person&&<form onChange={()=>setDirty(true)} key={person.id+':'+person.scheduleVersion} onSubmit={e=>submit(e,f=>void save('/staff/'+encodeURIComponent(person.id)+'/schedule',{version:person.scheduleVersion,approvedHours:Number(f.get('hours')),effectiveOn:f.get('effectiveOn'),reason:f.get('reason')}))}><fieldset disabled={busy}><p>Daily limit: {person.defaultMinutes/60} hours before the first scheduled change. Changes apply to new workdays; an already started day keeps its original limit.</p>
        <label>Approved hours per day<input name="hours" type="number" min="0" max="24" step="any" defaultValue={(person.entries.at(-1)?.minutes??person.defaultMinutes)/60} required /></label>
        <label>Effective date<input name="effectiveOn" type="date" min={data.today} defaultValue={data.today} required /></label><label>Reason for schedule change<input name="reason" maxLength={1000} required /></label><button>Save daily hours</button>
        <ul>{person.entries.map((entry,i)=><li key={i}>{entry.effectiveOn} · {entry.minutes/60} hours/day · {entry.reason}</li>)}</ul></fieldset></form>}
    </section><section><h2>Extra time needs review ({pending.length})</h2><p>Recorded checkouts are kept. Confirm actual work, or correct a verified clock mistake. Actual work is not removed because it was unapproved.</p><p>{data.timeZone} · Last 60 days</p>
      {!pending.length&&<p>No extra time is waiting for review.</p>}{pending.map(row=><article className="payroll-calculation-day" key={row.staffId+':'+row.date}><h3>{row.name} · {row.date}</h3><p>{row.plannedMinutes/60} approved daily hours · {hours(row.paidMillis)} recorded hours · {Math.ceil(row.extraMillis/60000)} extra minutes</p><p>Checkout: {localTime(row.checkout,data.timeZone)}</p>
        <form onChange={()=>setDirty(true)} onSubmit={e=>submit(e,f=>void save('/staff/'+encodeURIComponent(row.staffId)+'/review',{version:row.version,date:row.date,decision:'worked',reason:f.get('reason')}))}><fieldset disabled={busy}><label>Extra-work review note<input name="reason" required maxLength={1000} /></label><button>Confirm extra time was worked</button></fieldset></form>
        {row.canCorrect&&<details><summary>Correct a late clock-out mistake</summary><form onChange={()=>setDirty(true)} onSubmit={e=>submit(e,f=>void save('/staff/'+encodeURIComponent(row.staffId)+'/review',{version:row.version,date:row.date,decision:'clock-error',workEndedAt:row.date+'T'+String(f.get('end')),occurrence:f.get('occurrence')||undefined,noWorkAfterEnd:f.has('confirmed'),reason:f.get('reason')}))}><fieldset disabled={busy}><label>Actual work ended at ({data.timeZone})<input name="end" type="time" step="1" required /></label><label>Repeated daylight-saving time<select name="occurrence"><option value="">Not applicable</option><option value="earlier">First occurrence</option><option value="later">Second occurrence</option></select></label><label>Clock correction reason<input name="reason" required maxLength={1000} /></label><label className="payroll-check"><input name="confirmed" type="checkbox" required />I verified no work was performed after this time.</label><button>Save verified clock correction</button></fieldset></form></details>}
      </article>)}
    </section><section><h2>Recent work-time decisions</h2><ul>{data.items.filter(i=>['confirmed','corrected'].includes(i.status)).map(row=><li key={row.staffId+':'+row.date}>{row.name} · {row.date} · {row.status==='confirmed'?'Extra work confirmed':'Clock mistake corrected'} · {row.reason}</li>)}</ul><Link to="/staff">Staff directory</Link></section></>}
  </div>;
}
export function ExtraTimeAlerts() {
  const auth=useContext(AuthContext); const account=auth?.account, serverUnavailable=auth?.serverUnavailable;
  if(!account||account.disabled||account.mustChangePassword||serverUnavailable||!['admin','editor'].includes(account.role))return null;
  return <ManagerExtraTimeAlerts key={account.id+':'+account.role}/>;
}
function ManagerExtraTimeAlerts(){
  const [count,setCount]=useState<number|null>(null),[error,setError]=useState(false);const pending=useRef<AbortController|null>(null);
  const refresh=useCallback(()=>{pending.current?.abort();const c=new AbortController();pending.current=c;void axios.get<{data:WorkData}>(url,{signal:c.signal}).then(r=>{if(!c.signal.aborted){setCount(r.data.data.items.filter(i=>i.status==='pending').length);setError(false);}}).catch(()=>{if(!c.signal.aborted){setCount(null);setError(true);}});},[]);
  useEffect(()=>{refresh();const visible=()=>{if(document.visibilityState!=='hidden')refresh();};const timer=window.setInterval(visible,60000);window.addEventListener('focus',visible);window.addEventListener('online',visible);return()=>{pending.current?.abort();window.clearInterval(timer);window.removeEventListener('focus',visible);window.removeEventListener('online',visible);};},[refresh]);
  return <section className="ska-panel" aria-label="Extra employee time reminders"><div className="ska-panel-body"><h2>Extra employee time</h2>{error?<p>Could not check extra time. <button className="ska-button" onClick={refresh}>Retry time reminders</button></p>:count===null?<p>Checking work-time reviews…</p>:<p>{count?`${count} workday${count===1?' needs':'s need'} extra-time review.`:'No extra time waiting for review.'} <Link className="ska-link" to="/staff/work-time">Review work time</Link></p>}</div></section>;
}

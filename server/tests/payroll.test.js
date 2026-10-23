const { randomUUID, randomBytes } = require('node:crypto');
const http = require('supertest'); const fs = require('node:fs'); const path = require('node:path');
const db = require('../services/dbAdapter'); const auth = require('../auth/service'); const service = require('../services/payrollService'); const vault = require('../services/payrollVault'); const app = require('../index'); const fixture = require('./helpers/authenticatedRequest');
let key; beforeAll(() => { key = require('./helpers/payrollKey').install(); }); afterAll(() => key.cleanup()); afterEach(() => jest.useRealTimers());
const staff = () => db.createStaff({ id: randomUUID(), name: 'Synthetic employee', role: 'Teacher', active: true, roomId: null, version: 1 });
async function token(account) { const t = randomBytes(32).toString('hex'); const now = new Date(); await db.createSession({ id: auth.digest(t), accountId: account.id, remembered: true, createdAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 30 * 86400000) }); return t; }
const admin = () => token(fixture.credentials().account);
async function actor(role = 'teacher', person) { const account = await db.createAccount({ id: randomUUID(), username: 'synthetic-' + randomUUID(), displayName: 'Synthetic', role, staffMemberId: person?.id || null, disabled: false, mustChangePassword: false, passwordHash: 'not used', roomId: null }); return { account, token: await token(account) }; }
const api = (t, method, route, body) => http(app)[method]('/api' + route).set('Cookie','skao_session=' + t).set('Origin',fixture.origin).set('X-CSRF-Token',auth.csrfToken(t)).send(body);
async function status(t, staffId) { return (await service.clockStatus(t)).staff.find(row => row.id === staffId); }
async function clock(t, staffId, action, requestId = randomUUID()) { const version = (await db.getPayrollRecord('ledger:' + staffId))?.version || 0; await service.managerClock(t, staffId,{ action, requestId, version }); return status(t, staffId); }
function advance(ms) { jest.setSystemTime(new Date(Date.now() + ms)); }
function freeze(value) {
  jest.useFakeTimers({ doNotFake: ['setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','nextTick','queueMicrotask','performance','hrtime'] });
  jest.setSystemTime(new Date(value));
}
async function day() {
  freeze('2026-10-19T15:00:00Z');
  const person = await staff(), t = await admin(), teacher = await actor('teacher', person);
  await clock(t,person.id,'checkin'); advance(8 * 3600000); await clock(t,person.id,'checkout');
  return { person, t, teacher };
}
const profileRules = { mode: 'ca-standard', workweekStart: 1, confirmed: true, reference: 'Synthetic payroll reviewer: standard California daily/weekly overtime, paid rest; actual unpaid meals only; no rounding.', dailyScheduledMinutes: 480 };
async function configure(t, id) {
  await service.profile(t,id,{ version: 0, reason: 'Synthetic setup', legalName: 'Synthetic private legal name', taxId: 'SYNTHETIC-TAX-1234', bankAccount: 'SYNTHETIC-BANK-5678', requiredDocuments: ['Synthetic W-4'], rules: profileRules });
  await service.rate(t,id,{ version: 1, effectiveOn: '2026-01-01', cents: 2000, currency: 'USD', reason: 'Synthetic rate' });
}
async function approve(t,id, paidMillis=8*3600000) { const detail = await service.get(t,id), day = detail.ledger.days.find(row => row.date === '2026-10-19'); return service.approve(t,id,{ version: detail.ledger.version, profileVersion: detail.profile.version, date: '2026-10-19', status: 'approved', mode: 'manual-reviewed', paidMillis: Math.max(paidMillis, day.review.suggestedPaidMillis), premiumCents: 0, overtimeReviewed: true, adjustmentCents: 0, rulesReviewed: true, reason: 'Synthetic administrator reviewed actual hours, proposed paid rounding and any additional pay' }); }
test('personal clock is disabled and the manager projection never returns private payroll fields', async () => {
  const person = await staff(); const t = await admin(); await configure(t,person.id); const teacher = await actor('teacher',person); const foreign = await staff();
  const manager = await service.clockStatus(t); expect(manager.staff.map(row => row.id)).toEqual(expect.arrayContaining([person.id, foreign.id]));
  expect(JSON.stringify(manager)).not.toMatch(/TAX|BANK|rates|legalName|5678|1234|approval/);
  await expect(service.own(teacher.token)).rejects.toMatchObject({ status: 403 });
  await expect(service.clock(teacher.token,{ action:'checkin', requestId:randomUUID(), version:0 })).rejects.toMatchObject({ status: 403 });
  expect((await api(teacher.token,'get','/payroll/staff/' + person.id)).status).toBe(403);
  expect((await api(teacher.token,'get','/time-clock')).status).toBe(403);
  expect((await api(teacher.token,'post','/time-clock',{ action:'checkin', requestId:randomUUID(), version:0, staffId:foreign.id })).status).toBe(403);
});
test.each(['viewer','editor','teacher'])('%s is denied every private payroll operation', async role => {
  const person = await staff(); const a = await actor(role,person); const prefix='/payroll/staff/'+person.id;
  for (const route of [prefix,prefix+'/documents/unknown/1',prefix+'/snapshots/unknown']) expect((await api(a.token,'get',route)).status).toBe(403);
  for (const route of ['profile','rates','corrections','approvals','preview','snapshots','documents']) expect((await api(a.token,'post',prefix+'/'+route,{})).status).toBe(403);
});
test('personal identities cannot clock and managers can clock active employees without sign-in accounts or classes', async () => {
  const no = await actor(); await expect(service.own(no.token)).rejects.toMatchObject({status:403});
  const person = await staff(), t = await admin();
  expect((await clock(t,person.id,'checkin')).checkedIn).toBe(true);
  await db.updateStaff(person.id,{active:false}); await expect(service.managerClock(t,person.id,{action:'checkout',version:1,requestId:randomUUID()})).rejects.toMatchObject({status:403});
});
test('clock writes need CSRF and one current version; retries cannot create duplicate open sessions', async () => {
  const person=await staff(), t=await admin(); const body={action:'checkin',version:0,requestId:randomUUID()};
  expect((await http(app).post('/api/work-time/staff/'+person.id+'/clock').set('Origin',fixture.origin).set('Cookie','skao_session='+t).send(body)).status).toBe(403);
  const results=await Promise.all([service.managerClock(t,person.id,body),service.managerClock(t,person.id,body)]); expect(results.filter(r=>r.replayed)).toHaveLength(1);
  expect((await status(t,person.id)).checkedIn).toBe(true);
  expect(vault.open(await db.getPayrollRecord('ledger:'+person.id)).sessions).toHaveLength(1);
  await expect(service.managerClock(t,person.id,{...body,requestId:randomUUID()})).rejects.toMatchObject({status:409});
  await expect(service.managerClock(t,person.id,{...body,action:'checkout'})).rejects.toMatchObject({status:409});
});
test('legacy unfinished entries never require a break action, block checkout or create a guessed deduction', async () => {
  const {person,t,teacher}=await day(); await clock(t,person.id,'checkin'); advance(3600000);
  await expect(clock(t,person.id,'paid-break')).rejects.toMatchObject({status:400});
  let detail=await service.get(t,person.id); const session=detail.ledger.sessions.at(-1); const now=new Date().toISOString();
  await service.correct(t,person.id,{version:detail.ledger.version,sessionId:session.id,start:session.start,end:null,breaks:[{start:now,end:null,paid:false}],voided:false,reason:'Synthetic historical entry'});
  const raw=await db.getPayrollRecord('ledger:'+person.id), stored=vault.open(raw);
  stored.sessions.at(-1).breaks[0].id='legacy-entry-id';
  stored.sessions.at(-1).breaks[0].actorId='historical-actor';
  await db.savePayrollRecord({...raw,ciphertext:vault.seal(raw,stored)});
  const original=structuredClone(stored.sessions.at(-1).breaks);
  expect((await status(t,person.id)).checkedIn).toBe(true); advance(1800000);
  await clock(t,person.id,'checkout'); detail=await service.get(t,person.id);
  expect(detail.ledger.days[0]).toMatchObject({unpaidMillis:0,paidMillis:9.5*3600000,incomplete:false});
  expect(detail.ledger.sessions.at(-1).breaks).toEqual(original);
  await service.correct(t,person.id,{version:detail.ledger.version,sessionId:session.id,start:session.start,end:detail.ledger.sessions.at(-1).end,voided:false,reason:'Verify checkout while retaining history'});
  detail=await service.get(t,person.id); expect(detail.ledger.sessions.at(-1).breaks).toEqual(original);
  await expect(service.own(teacher.token)).rejects.toMatchObject({status:403});
});
test('private fields are encrypted in storage, masked in responses and preserved on unrelated edits', async () => {
  const person=await staff(), t=await admin(); await configure(t,person.id);
  const raw=await db.getPayrollRecord('profile:'+person.id); expect(raw.ciphertext).not.toMatch(/SYNTHETIC-TAX-1234|SYNTHETIC-BANK-5678|legalName/);
  expect(raw.ciphertext).not.toContain(Buffer.from('SYNTHETIC-TAX-1234').toString('hex'));
  expect(vault.seal(raw,vault.open(raw))).not.toBe(raw.ciphertext);
  expect(() => vault.open({ ...raw, staffId: 'another-employee' })).toThrow();
  expect(() => vault.open({ ...raw, ciphertext: (raw.ciphertext[0] === '0' ? '1' : '0') + raw.ciphertext.slice(1) })).toThrow();
  const detail=await service.get(t,person.id); expect(detail.profile.taxId).toBe('••••1234'); expect(detail.profile.bankAccount).toBe('••••5678'); expect(detail.profile.history).toBeUndefined();
  await service.profile(t,person.id,{version:2,reason:'Rename only',legalName:'Another synthetic name'});
  expect(vault.open(await db.getPayrollRecord(raw.id)).taxId).toBe('SYNTHETIC-TAX-1234');
  await service.profile(t,person.id,{version:3,reason:'Clear obsolete account',bankAccount:null}); expect((await service.get(t,person.id)).profile.bankAccount).toBe('');
});
test('rate history, approved days, exact cents and historical calculation snapshots remain traceable', async () => {
  const {person,t}=await day(); await configure(t,person.id); await approve(t,person.id);
  const preview=await service.preview(t,person.id,{start:'2026-10-19',end:'2026-10-19'});
  expect(preview).toMatchObject({grossCents:16000,workedDays:1,approvedMillis:28800000,canFinalize:true,paymentExecuted:false});
  const payload={start:preview.start,end:preview.end,fingerprint:preview.fingerprint,requestId:randomUUID()}; const saved=await service.finalize(t,person.id,payload);
  expect((await service.finalize(t,person.id,payload)).replayed).toBe(true);
  await service.rate(t,person.id,{version:2,effectiveOn:'2026-10-19',cents:2500,currency:'USD',reason:'Synthetic retroactive correction'});
  const snapshot=await service.snapshot(t,person.id,saved.id); expect(snapshot.preview.grossCents).toBe(16000); expect(snapshot.sourceChanged).toBe(true);
  expect((await service.preview(t,person.id,{start:preview.start,end:preview.end})).grossCents).toBe(20000);
});
test('a correction preserves original times and prior approval, blocks overlaps and requires renewed approval', async () => {
  const {person,t}=await day(); await approve(t,person.id); let detail=await service.get(t,person.id); const session=detail.ledger.sessions[0];
  await service.correct(t,person.id,{version:detail.ledger.version,sessionId:session.id,start:session.start,end:new Date(Date.parse(session.end)-3600000).toISOString(),breaks:[],voided:false,reason:'Synthetic mistaken departure correction'});
  detail=await service.get(t,person.id); expect(detail.ledger.sessions[0].original.end).toBe(session.end); expect(detail.ledger.days[0].approval.status).toBe('needs-review');
  expect(detail.ledger.history.some(h=>h.type==='correction' && h.before.end===session.end)).toBe(true);
});
test('an audit failure rolls back encrypted time, history, version and idempotency together', async () => {
  const person=await staff(), t=await admin(); const audit=jest.spyOn(db,'appendAudit').mockRejectedValueOnce(new Error('Synthetic audit failure'));
  try { await expect(clock(t,person.id,'checkin')).rejects.toThrow('Synthetic audit failure'); } finally { audit.mockRestore(); }
  expect(await db.getPayrollRecord('ledger:'+person.id)).toBeNull(); expect((await status(t,person.id)).checkedIn).toBe(false);
});
test('required payroll documents preserve every revision byte and private downloads reject foreign staff and viewers', async () => {
  const person=await staff(), t=await admin(); await configure(t,person.id); const bytes=fs.readFileSync(path.join(__dirname,'fixtures/child-documents/synthetic.png'));
  const payload={version:0,title:'Synthetic W-4',category:'tax',documentDate:'2026-10-19',reason:'Synthetic signed form',file:{name:'synthetic.png',contentType:'image/png',dataBase64:bytes.toString('base64')}};
  const saved=await service.document(t,person.id,payload); await service.document(t,person.id,{...payload,id:saved.id,version:1,reason:'Synthetic second revision'});
  expect((await service.get(t,person.id)).missingDocuments).toEqual([]);
  expect((await service.content(t,person.id,saved.id,1)).content).toEqual(bytes); expect((await service.content(t,person.id,saved.id,2)).content).toEqual(bytes);
  expect(JSON.stringify(await service.get(t,person.id))).not.toContain(bytes.toString('base64'));
  const other=await staff(); await expect(service.content(t,other.id,saved.id,1)).rejects.toMatchObject({status:404});
  const viewer=await actor('viewer',person); expect((await api(viewer.token,'get','/payroll/staff/'+person.id+'/documents/'+encodeURIComponent(saved.id)+'/1')).status).toBe(403);
});
test('missing/insecure/wrong keys fail closed without substituting empty private records', async () => {
  const person=await staff(), t=await admin(); await configure(t,person.id); const original=fs.readFileSync(key.key);
  fs.chmodSync(key.key,0o644); await expect(service.get(t,person.id)).rejects.toMatchObject({code:'PAYROLL_LOCKED'}); fs.chmodSync(key.key,0o600);
  fs.writeFileSync(key.key,randomBytes(32).toString('hex')); await expect(service.get(t,person.id)).rejects.toMatchObject({code:'PAYROLL_LOCKED'}); fs.writeFileSync(key.key,original);
});

test('extra hours notify admin/editor without exposing pay or tax data and confirmed work remains payable', async () => {
  const {person,t,teacher}=await day(); await configure(t,person.id); await clock(t,person.id,'checkin'); advance(3600000); await clock(t,person.id,'checkout');
  const editor=await actor('editor'); const list=await service.workTime(editor.token);const row=list.items.find(i=>i.staffId===person.id);
  expect(row).toMatchObject({status:'pending',extraMillis:3600000,plannedMinutes:480});expect(JSON.stringify(list)).not.toMatch(/taxId|SYNTHETIC-TAX|bankAccount|rates|legalName/);
  await expect(service.preview(t,person.id,{start:row.date,end:row.date})).resolves.toMatchObject({canFinalize:false});
  await service.reviewWork(editor.token,person.id,{version:row.version,date:row.date,decision:'worked',reason:'Synthetic extra work verified'});
  expect((await service.workTime(editor.token)).items[0].status).toBe('confirmed');
  expect((await service.get(t,person.id)).ledger.days[0].paidMillis).toBe(9*3600000);
  expect((await api(editor.token,'get','/payroll/staff/'+person.id)).status).toBe(403);
  await expect(service.workTime(teacher.token)).rejects.toMatchObject({status:403});
});
test('a verified clock error preserves original checkout, renews approval and is attributed to the editor', async () => {
  const {person,t,teacher}=await day(); let d=await service.get(t,person.id);const session=d.ledger.sessions[0];
  await clock(t,person.id,'checkin');advance(3600000);await clock(t,person.id,'checkout');
  // Correct the synthetic day to a single nine-hour clock session.
  d=await service.get(t,person.id);await service.correct(t,person.id,{version:d.ledger.version,sessionId:d.ledger.sessions[1].id,start:d.ledger.sessions[1].start,end:d.ledger.sessions[1].end,breaks:[],voided:true,reason:'Synthetic duplicate'});
  d=await service.get(t,person.id);await service.correct(t,person.id,{version:d.ledger.version,sessionId:session.id,start:session.start,end:new Date().toISOString(),breaks:[],voided:false,reason:'Synthetic late clockout'});
  const editor=await actor('editor');const row=(await service.workTime(editor.token)).items[0];
  await expect(service.reviewWork(editor.token,person.id,{version:row.version,date:row.date,decision:'clock-error',workEndedAt:session.end,noWorkAfterEnd:false,reason:'Synthetic'})).rejects.toMatchObject({status:400});
  await service.reviewWork(editor.token,person.id,{version:row.version,date:row.date,decision:'clock-error',workEndedAt:session.end,noWorkAfterEnd:true,reason:'Verified employee stopped work at original departure'});
  d=await service.get(t,person.id);expect(d.ledger.sessions[0].original.end).toBe(session.end);expect(d.ledger.history.some(h=>h.type==='clock-error-review'&&h.actorId===editor.account.id)).toBe(true);expect((await service.workTime(editor.token)).items[0].status).toBe('corrected');
});
test('daily hours are effective dated, entered in hours, and cannot alter the limit of an already-started day', async () => {
  const {person,t}=await day();const editor=await actor('editor');
  await service.schedule(editor.token,person.id,{version:0,effectiveOn:'2026-10-19',approvedHours:7.5,reason:'Synthetic new schedule'});
  const list=await service.workTime(editor.token);expect(list.staff[0].entries[0].minutes).toBe(450);expect(list.items[0].plannedMinutes).toBe(480);
  await expect(service.schedule(editor.token,person.id,{version:0,effectiveOn:'2026-10-19',approvedHours:8,reason:'Stale'})).rejects.toMatchObject({status:409});
  await expect(service.schedule(t,person.id,{version:1,effectiveOn:'2026-10-18',approvedHours:8,reason:'Retroactive'})).rejects.toMatchObject({status:400});
});
test('work-time HTTP writes require CSRF and viewers cannot query or change the manager projection', async()=>{
  const {person,t,teacher}=await day();await clock(t,person.id,'checkin');advance(3600000);await clock(t,person.id,'checkout');const editor=await actor('editor');
  const list=await service.workTime(editor.token),row=list.items[0];const body={version:row.version,date:row.date,decision:'worked',reason:'Synthetic review'};
  const path='/work-time/staff/'+person.id+'/review';
  expect((await http(app).post('/api'+path).set('Origin',fixture.origin).set('Cookie','skao_session='+editor.token).send(body)).status).toBe(403);
  expect((await api(teacher.token,'post',path,body)).status).toBe(403);expect((await api(teacher.token,'get','/work-time')).status).toBe(403);
  // A staff record has one sign-in account. day() already links person to the
  // teacher; use a separate employee so this fixture also satisfies PostgreSQL.
  const viewerPerson=await staff(),viewer=await actor('viewer',viewerPerson);
  await expect(service.own(viewer.token)).rejects.toMatchObject({status:403});
  expect((await api(viewer.token,'get','/work-time')).status).toBe(403);
  expect((await api(viewer.token,'post',path,body)).status).toBe(403);
  expect((await api(viewer.token,'post','/work-time/staff/'+person.id+'/schedule',{version:0,effectiveOn:row.date,approvedHours:8,reason:'Viewer must not change a schedule'})).status).toBe(403);
  const audit=jest.spyOn(db,'appendAudit').mockRejectedValueOnce(new Error('Synthetic work review audit failure'));
  try{await expect(service.reviewWork(editor.token,person.id,body)).rejects.toThrow('Synthetic work review audit failure');}finally{audit.mockRestore();}
  expect((await service.workTime(t)).items[0].status).toBe('pending');
});


async function scheduledDay({startTime='08:00',endTime='17:00',arrival='2026-10-19T15:00:00Z',departure='2026-10-20T00:00:00Z',date='2026-10-19'}={}) {
  freeze(arrival); const person=await staff(),t=await admin(),teacher=await actor('teacher',person);
  await service.schedule(t,person.id,{version:0,effectiveOn:date,startTime,endTime,reason:'Synthetic approved clock times'});
  await clock(t,person.id,'checkin');jest.setSystemTime(new Date(departure));await clock(t,person.id,'checkout');
  const list=await service.workTime(t,{start:date,end:date});return {person,t,teacher,row:list.items.find(row=>row.staffId===person.id)};
}
test('approved start and end times are strict, same-day, effective dated and cannot mix with legacy daily hours',async()=>{
  freeze('2026-10-19T15:00:00Z');const person=await staff(),t=await admin();
  for(const fields of [
    {startTime:'8:00',endTime:'17:00'},{startTime:'08:00'},{endTime:'17:00'},
    {startTime:'08:00',endTime:'24:00'},{startTime:'08:60',endTime:'17:00'},
    {startTime:'08:00',endTime:'08:00'},{startTime:'17:00',endTime:'08:00'},
    {startTime:'08:00',endTime:'17:00',approvedHours:9},
  ]) await expect(service.schedule(t,person.id,{version:0,effectiveOn:'2026-10-19',reason:'Invalid synthetic schedule',...fields})).rejects.toMatchObject({status:400});
  await expect(service.schedule(t,person.id,{version:0,effectiveOn:'2026-10-18',startTime:'08:00',endTime:'17:00',reason:'Retroactive'})).rejects.toMatchObject({status:400});
  expect(await db.getPayrollRecord('profile:work-schedule:'+person.id)).toBeNull();
  await service.schedule(t,person.id,{version:0,effectiveOn:'2026-10-19',startTime:'08:00',endTime:'17:00',reason:'Approved daily window'});
  const list=await service.workTime(t),schedule=list.staff.find(row=>row.id===person.id);
  expect(schedule).toMatchObject({scheduleVersion:1,entries:[{startTime:'08:00',endTime:'17:00',timeZone:'America/Los_Angeles',minutes:540}]});
  expect(list.items).toEqual([]);
});
test.each([
  ['inside the approved clock times','2026-10-19T15:00:00Z','2026-10-20T00:00:00Z',0,0,'within-schedule'],
  ['early arrival despite fewer total hours','2026-10-19T14:30:00Z','2026-10-19T22:00:00Z',1800000,0,'pending'],
  ['late checkout despite exactly the daily span','2026-10-19T16:00:00Z','2026-10-20T01:00:00Z',0,3600000,'pending'],
  ['both early arrival and late checkout','2026-10-19T14:30:00Z','2026-10-20T00:30:00Z',1800000,1800000,'pending'],
])('%s compares actual work with the frozen window without capping pay',async(_,arrival,departure,earlyMillis,lateMillis,status)=>{
  const {person,t,row}=await scheduledDay({arrival,departure});
  expect(row).toMatchObject({plannedMinutes:540,plannedStart:'08:00',plannedEnd:'17:00',scheduleTimeZone:'America/Los_Angeles',checkin:new Date(arrival).toISOString(),checkout:new Date(departure).toISOString(),earlyMillis,lateMillis,outsideMillis:earlyMillis+lateMillis,extraMillis:earlyMillis+lateMillis,status,scheduleIssue:null});
  expect(row.paidMillis).toBe(Date.parse(departure)-Date.parse(arrival));
  const ledger=vault.open(await db.getPayrollRecord('ledger:'+person.id));
  expect(ledger.workWindows['2026-10-19']).toMatchObject({startTime:'08:00',endTime:'17:00',timeZone:'America/Los_Angeles'});
  if(status==='pending') {
    await configure(t,person.id);await approve(t,person.id,Math.min(row.paidMillis,8*3600000));
    expect((await service.preview(t,person.id,{start:row.date,end:row.date})).blockers).toContain(row.date+': Extra work time needs manager review in Work time.');
    const current=(await service.workTime(t)).items.find(row=>row.staffId===person.id);
    await service.reviewWork(t,person.id,{version:current.version,date:row.date,decision:'worked',reason:'Verified recorded work outside the approved clock times'});
    expect((await service.workTime(t)).items.find(row=>row.staffId===person.id)).toMatchObject({status:'confirmed',paidMillis:row.paidMillis});
  }
});
test('changing a schedule freezes the started day and applies the new clock times only to later days',async()=>{
  freeze('2026-10-19T15:00:00Z');const person=await staff(),t=await admin(),teacher=await actor('teacher',person);
  await service.schedule(t,person.id,{version:0,effectiveOn:'2026-10-19',startTime:'08:00',endTime:'17:00',reason:'Original approved clock times'});
  await clock(t,person.id,'checkin');
  await service.schedule(t,person.id,{version:1,effectiveOn:'2026-10-19',startTime:'09:00',endTime:'18:00',reason:'Change for the next unstarted day'});
  advance(9*3600000);await clock(t,person.id,'checkout');
  let rows=(await service.workTime(t)).items.filter(row=>row.staffId===person.id);
  expect(rows[0]).toMatchObject({plannedStart:'08:00',plannedEnd:'17:00',status:'within-schedule'});
  jest.setSystemTime(new Date('2026-10-20T16:00:00Z'));await clock(t,person.id,'checkin');advance(9*3600000);await clock(t,person.id,'checkout');
  rows=(await service.workTime(t)).items.filter(row=>row.staffId===person.id);
  expect(rows.map(row=>({date:row.date,start:row.plannedStart,end:row.plannedEnd,status:row.status}))).toEqual([
    {date:'2026-10-20',start:'09:00',end:'18:00',status:'within-schedule'},
    {date:'2026-10-19',start:'08:00',end:'17:00',status:'within-schedule'},
  ]);
});
test('existing duration-only days and confirmed decisions never gain clock windows retrospectively',async()=>{
  const {person,t,teacher}=await day();await clock(t,person.id,'checkin');advance(3600000);await clock(t,person.id,'checkout');
  let row=(await service.workTime(t)).items.find(row=>row.staffId===person.id);
  await service.reviewWork(t,person.id,{version:row.version,date:row.date,decision:'worked',reason:'Legacy duration-only extra work verified'});
  const original=vault.open(await db.getPayrollRecord('ledger:'+person.id)).workReviews[row.date];
  await service.schedule(t,person.id,{version:0,effectiveOn:row.date,startTime:'09:00',endTime:'17:00',reason:'New clock schedule must not rewrite old work'});
  row=(await service.workTime(t)).items.find(row=>row.staffId===person.id);
  expect(row).toMatchObject({plannedStart:null,plannedEnd:null,plannedMinutes:480,extraMillis:3600000,status:'confirmed'});
  expect(vault.open(await db.getPayrollRecord('ledger:'+person.id)).workReviews[row.date]).toEqual(original);
  // Older ledgers without frozen numeric limits must also remain duration-only.
  const raw=await db.getPayrollRecord('ledger:'+person.id),data=vault.open(raw);delete data.workLimits;delete data.workWindows;
  await db.savePayrollRecord({...raw,ciphertext:vault.seal(raw,data)});
  expect((await service.workTime(t)).items.find(row=>row.staffId===person.id)).toMatchObject({plannedStart:null,plannedEnd:null,plannedMinutes:480,status:'confirmed'});
});
test('completed historical unpaid intervals are excluded from early work; unfinished legacy intervals do not infer deductions',async()=>{
  const {person,t}=await scheduledDay({arrival:'2026-10-19T14:00:00Z'});let detail=await service.get(t,person.id),session=detail.ledger.sessions[0];
  await service.correct(t,person.id,{version:detail.ledger.version,sessionId:session.id,start:session.start,end:session.end,voided:false,breaks:[{start:session.start,end:'2026-10-19T15:00:00Z',paid:false}],reason:'Preserve a recorded historical unpaid interval'});
  expect((await service.workTime(t)).items.find(row=>row.staffId===person.id)).toMatchObject({earlyMillis:0,extraMillis:0,status:'within-schedule',paidMillis:9*3600000});
  detail=await service.get(t,person.id);session=detail.ledger.sessions[0];
  await service.correct(t,person.id,{version:detail.ledger.version,sessionId:session.id,start:session.start,end:session.end,voided:false,breaks:[{start:session.start,end:null,paid:false}],reason:'Retain an unfinished historical entry without a guessed end'});
  expect((await service.workTime(t)).items.find(row=>row.staffId===person.id)).toMatchObject({earlyMillis:3600000,extraMillis:3600000,status:'pending',paidMillis:10*3600000,incomplete:false});
});
test('a verified late clock error may shorten only the recorded tail and cannot erase early actual work',async()=>{
  const {person,t,row}=await scheduledDay({arrival:'2026-10-19T14:00:00Z',departure:'2026-10-20T01:00:00Z'});
  const raw=await db.getPayrollRecord('ledger:'+person.id),original=vault.open(raw);
  await expect(service.reviewWork(t,person.id,{version:row.version,date:row.date,decision:'clock-error',workEndedAt:'2026-10-20T00:00:00Z',noWorkAfterEnd:true,reason:'Late checkout corrected but early time remains real'})).rejects.toMatchObject({status:400});
  expect(vault.open(await db.getPayrollRecord(raw.id))).toEqual(original);
  expect((await service.workTime(t)).items.find(row=>row.staffId===person.id)).toMatchObject({status:'pending',earlyMillis:3600000,lateMillis:3600000,paidMillis:11*3600000});
});
test('a new-window late checkout correction retains the original time and records a current review fingerprint',async()=>{
  const {person,t,row}=await scheduledDay({departure:'2026-10-20T01:00:00Z'});
  expect(row).toMatchObject({canCorrect:true,status:'pending',lateMillis:3600000});
  await service.reviewWork(t,person.id,{version:row.version,date:row.date,decision:'clock-error',workEndedAt:'2026-10-20T00:00:00Z',noWorkAfterEnd:true,reason:'Employee verified no work after 5 PM'});
  const next=(await service.workTime(t)).items.find(item=>item.staffId===person.id);
  expect(next).toMatchObject({status:'corrected',lateMillis:0,paidMillis:9*3600000});
  const ledger=vault.open(await db.getPayrollRecord('ledger:'+person.id));
  expect(ledger.sessions[0].original.end).toBe('2026-10-20T01:00:00.000Z');
  expect(ledger.workReviews[row.date]).toMatchObject({decision:'clock-error',reason:'Employee verified no work after 5 PM'});
});
test('new windows use facility clock changes and request explicit review when an approved local time does not exist',async()=>{
  const {person,t,row}=await scheduledDay({startTime:'01:00',endTime:'03:00',date:'2026-11-01',arrival:'2026-11-01T08:00:00Z',departure:'2026-11-01T11:00:00Z'});
  expect(row).toMatchObject({plannedMinutes:120,paidMillis:3*3600000,outsideMillis:0,status:'within-schedule'});
  const spring=await scheduledDay({startTime:'02:30',endTime:'04:00',date:'2027-03-14',arrival:'2027-03-14T10:00:00Z',departure:'2027-03-14T11:00:00Z'});
  expect(spring.row).toMatchObject({plannedStart:'02:30',plannedEnd:'04:00',paidMillis:3600000,status:'pending'});expect(spring.row.scheduleIssue).toMatch(/clocks changed/);
});
test('schedule and outside-time audit failures roll back encrypted fields, versions and decisions together',async()=>{
  freeze('2026-10-19T15:00:00Z');let person=await staff(),t=await admin();
  let audit=jest.spyOn(db,'appendAudit').mockRejectedValueOnce(new Error('Synthetic schedule audit failure'));
  try{await expect(service.schedule(t,person.id,{version:0,effectiveOn:'2026-10-19',startTime:'08:00',endTime:'17:00',reason:'Synthetic rollback'})).rejects.toThrow('Synthetic schedule audit failure');}finally{audit.mockRestore();}
  expect(await db.getPayrollRecord('profile:work-schedule:'+person.id)).toBeNull();
  const result=await scheduledDay({departure:'2026-10-20T01:00:00Z'});({person,t}=result);
  const before=await db.getPayrollRecord('ledger:'+person.id);audit=jest.spyOn(db,'appendAudit').mockRejectedValueOnce(new Error('Synthetic window decision audit failure'));
  try{await expect(service.reviewWork(t,person.id,{version:result.row.version,date:result.row.date,decision:'worked',reason:'Actual extra work verified'})).rejects.toThrow('Synthetic window decision audit failure');}finally{audit.mockRestore();}
  expect(await db.getPayrollRecord(before.id)).toEqual(before);
  expect((await service.workTime(t)).items.find(row=>row.staffId===person.id)).toMatchObject({status:'pending',lateMillis:3600000});
});

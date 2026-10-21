const { randomUUID, randomBytes } = require('node:crypto');
const http = require('supertest'); const fs = require('node:fs'); const path = require('node:path');
const db = require('../services/dbAdapter'); const auth = require('../auth/service'); const service = require('../services/payrollService'); const vault = require('../services/payrollVault'); const app = require('../index'); const fixture = require('./helpers/authenticatedRequest');
let key; beforeAll(() => { key = require('./helpers/payrollKey').install(); }); afterAll(() => key.cleanup()); afterEach(() => jest.useRealTimers());
const staff = () => db.createStaff({ id: randomUUID(), name: 'Synthetic employee', role: 'Teacher', active: true, roomId: null, version: 1 });
async function token(account) { const t = randomBytes(32).toString('hex'); const now = new Date(); await db.createSession({ id: auth.digest(t), accountId: account.id, remembered: true, createdAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 30 * 86400000) }); return t; }
const admin = () => token(fixture.credentials().account);
async function actor(role = 'teacher', person) { const account = await db.createAccount({ id: randomUUID(), username: 'synthetic-' + randomUUID(), displayName: 'Synthetic', role, staffMemberId: person?.id || null, disabled: false, mustChangePassword: false, passwordHash: 'not used', roomId: null }); return { account, token: await token(account) }; }
const api = (t, method, route, body) => http(app)[method]('/api' + route).set('Cookie','skao_session=' + t).set('Origin',fixture.origin).set('X-CSRF-Token',auth.csrfToken(t)).send(body);
async function clock(t, action, requestId = randomUUID()) { const own = await service.own(t); await service.clock(t,{ action, requestId, version: own.version }); return service.own(t); }
function advance(ms) { jest.setSystemTime(new Date(Date.now() + ms)); }
async function day() {
  jest.useFakeTimers({ doNotFake: ['setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','nextTick','queueMicrotask','performance','hrtime'] });
  jest.setSystemTime(new Date('2026-10-19T15:00:00Z'));
  const person = await staff(), t = await admin(), teacher = await actor('teacher', person);
  await clock(teacher.token,'checkin'); advance(8 * 3600000); await clock(teacher.token,'checkout');
  return { person, t, teacher };
}
const profileRules = { mode: 'ca-standard', workweekStart: 1, confirmed: true, reference: 'Synthetic payroll reviewer: standard California daily/weekly overtime, paid rest; actual unpaid meals only; no rounding.', dailyScheduledMinutes: 480 };
async function configure(t, id) {
  await service.profile(t,id,{ version: 0, reason: 'Synthetic setup', legalName: 'Synthetic private legal name', taxId: 'SYNTHETIC-TAX-1234', bankAccount: 'SYNTHETIC-BANK-5678', requiredDocuments: ['Synthetic W-4'], rules: profileRules });
  await service.rate(t,id,{ version: 1, effectiveOn: '2026-01-01', cents: 2000, currency: 'USD', reason: 'Synthetic rate' });
}
async function approve(t,id, regularMillis=8*3600000) { const detail = await service.get(t,id); return service.approve(t,id,{ version: detail.ledger.version, date: '2026-10-19', status: 'approved', regularMillis, overtimeMillis: 0, doubleMillis: 0, adjustmentCents: 0, rulesReviewed: true, reason: 'Synthetic payroll review' }); }
test('own clock derives staff identity and never returns payroll fields or another employee', async () => {
  const person = await staff(); const t = await admin(); await configure(t,person.id); const teacher = await actor('teacher',person); const foreign = await staff();
  const own = await service.own(teacher.token); expect(own.staff.id).toBe(person.id);
  expect(JSON.stringify(own)).not.toMatch(/TAX|BANK|rates|legalName|5678|1234|approval/);
  expect((await api(teacher.token,'get','/payroll/staff/' + person.id)).status).toBe(403);
  expect((await api(teacher.token,'post','/time-clock',{ action:'checkin', requestId:randomUUID(), version:0, staffId:foreign.id })).status).toBe(400);
});
test.each(['viewer','editor','teacher'])('%s is denied every private payroll operation', async role => {
  const person = await staff(); const a = await actor(role,person); const prefix='/payroll/staff/'+person.id;
  for (const route of [prefix,prefix+'/documents/unknown/1',prefix+'/snapshots/unknown']) expect((await api(a.token,'get',route)).status).toBe(403);
  for (const route of ['profile','rates','corrections','approvals','preview','snapshots','documents']) expect((await api(a.token,'post',prefix+'/'+route,{})).status).toBe(403);
});
test('unlinked and deactivated identities cannot clock; a linked employee does not need a class', async () => {
  const no = await actor(); await expect(service.own(no.token)).rejects.toMatchObject({status:403});
  const person = await staff(); const teacher = await actor('teacher',person); expect((await service.own(teacher.token)).staff.id).toBe(person.id);
  await db.updateStaff(person.id,{active:false}); await expect(service.clock(teacher.token,{action:'checkin',version:0,requestId:randomUUID()})).rejects.toMatchObject({status:401});
});
test('clock writes need CSRF and one current version; retries cannot create duplicate open sessions', async () => {
  const person=await staff(), teacher=await actor('teacher',person); const body={action:'checkin',version:0,requestId:randomUUID()};
  expect((await http(app).post('/api/time-clock').set('Origin',fixture.origin).set('Cookie','skao_session='+teacher.token).send(body)).status).toBe(403);
  const results=await Promise.all([service.clock(teacher.token,body),service.clock(teacher.token,body)]); expect(results.filter(r=>r.replayed)).toHaveLength(1);
  expect((await service.own(teacher.token)).checkedIn).toBe(true);
  expect(vault.open(await db.getPayrollRecord('ledger:'+person.id)).sessions).toHaveLength(1);
  await expect(service.clock(teacher.token,{...body,requestId:randomUUID()})).rejects.toMatchObject({status:409});
  await expect(service.clock(teacher.token,{...body,action:'checkout'})).rejects.toMatchObject({status:409});
});
test('legacy paid rest remains paid and unfinished breaks need manager correction, with no self-service break actions', async () => {
  const {person,t,teacher}=await day(); await clock(teacher.token,'checkin'); advance(3600000);
  await expect(clock(teacher.token,'paid-break')).rejects.toMatchObject({status:400});
  let detail=await service.get(t,person.id); const session=detail.ledger.sessions.at(-1); const now=new Date().toISOString();
  await service.correct(t,person.id,{version:detail.ledger.version,sessionId:session.id,start:session.start,end:null,breaks:[{start:now,end:null,paid:false}],voided:false,reason:'Synthetic legacy unfinished break'});
  expect((await service.own(teacher.token)).needsReview).toBe(true); advance(1800000);
  await expect(clock(teacher.token,'checkout')).rejects.toMatchObject({status:409});
  detail=await service.get(t,person.id); await service.correct(t,person.id,{version:detail.ledger.version,sessionId:session.id,start:session.start,end:null,breaks:[{start:now,end:new Date().toISOString(),paid:false}],voided:false,reason:'Synthetic verified break end'});
  advance(60000); await clock(teacher.token,'checkout'); detail=await service.get(t,person.id);
  expect(detail.ledger.days[0].unpaidMillis).toBe(1800000); expect(detail.ledger.days[0].rawMillis-detail.ledger.days[0].paidMillis).toBe(1800000);
  const own=await service.own(teacher.token);expect(Object.keys(own).sort()).toEqual(['checkedIn','needsReview','staff','timeZone','version']);
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
  const person=await staff(), teacher=await actor('teacher',person); const audit=jest.spyOn(db,'appendAudit').mockRejectedValueOnce(new Error('Synthetic audit failure'));
  try { await expect(clock(teacher.token,'checkin')).rejects.toThrow('Synthetic audit failure'); } finally { audit.mockRestore(); }
  expect(await db.getPayrollRecord('ledger:'+person.id)).toBeNull(); expect((await service.own(teacher.token)).checkedIn).toBe(false);
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
  const {person,t,teacher}=await day(); await configure(t,person.id); await clock(teacher.token,'checkin'); advance(3600000); await clock(teacher.token,'checkout');
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
  await clock(teacher.token,'checkin');advance(3600000);await clock(teacher.token,'checkout');
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
  const {person,t,teacher}=await day();await clock(teacher.token,'checkin');advance(3600000);await clock(teacher.token,'checkout');const editor=await actor('editor');
  const list=await service.workTime(editor.token),row=list.items[0];const body={version:row.version,date:row.date,decision:'worked',reason:'Synthetic review'};
  const path='/work-time/staff/'+person.id+'/review';
  expect((await http(app).post('/api'+path).set('Origin',fixture.origin).set('Cookie','skao_session='+editor.token).send(body)).status).toBe(403);
  expect((await api(teacher.token,'post',path,body)).status).toBe(403);expect((await api(teacher.token,'get','/work-time')).status).toBe(403);
  const viewer=await actor('viewer',person);expect((await api(viewer.token,'get','/work-time')).status).toBe(403);
  const audit=jest.spyOn(db,'appendAudit').mockRejectedValueOnce(new Error('Synthetic work review audit failure'));
  try{await expect(service.reviewWork(editor.token,person.id,body)).rejects.toThrow('Synthetic work review audit failure');}finally{audit.mockRestore();}
  expect((await service.workTime(t)).items[0].status).toBe('pending');
});

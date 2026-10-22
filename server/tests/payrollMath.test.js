const { daily, preview, hash, scheduledPayCredit, overtimeContext, overtimeFingerprint } = require('../services/payrollMath');
const rules={mode:'ca-standard',workweekStart:1,confirmed:true,reference:'Synthetic reviewed policy',dailyScheduledMinutes:480};
const profile=(rates=[{id:'rate',effectiveOn:'2026-01-01',cents:2000,currency:'USD',sequence:1}])=>({rules,rates});
const approval=(regularMillis,extra={})=>({status:'approved',regularMillis,overtimeMillis:0,doubleMillis:0,adjustmentCents:0,rulesReviewed:true,rulesFingerprint:hash(rules),...extra});
const manualApproval=(paidMillis,extra={})=>approval(paidMillis,{mode:'manual-reviewed',paidMillis,premiumCents:0,overtimeReviewed:false,...extra});
const session=(date,hours=8)=>({id:date,start:date+'T15:00:00Z',end:new Date(Date.parse(date+'T15:00:00Z')+hours*3600000).toISOString(),breaks:[]});
const ledger=(sessions,approvals={})=>({timeZone:'America/Los_Angeles',sessions,approvals});
function reviewed(data,p=profile()) { const days=daily(data); for(const day of days) if(day.approval?.mode==='manual-reviewed' && day.approval.overtimeReviewed) day.approval.overtimeFingerprint=overtimeFingerprint(day,days,p.rules,p.rates); return data; }
test.each([['2026-03-08T08:00:00Z','2026-03-09T07:00:00Z',23],['2026-11-01T07:00:00Z','2026-11-02T08:00:00Z',25]])('facility-day split preserves DST elapsed time from %s', (start,end,hours)=>{
 const rows=daily(ledger([{id:'synthetic',start,end,breaks:[]}])); expect(rows).toHaveLength(1); expect(rows[0].rawMillis).toBe(hours*3600000);
});
test('cross-midnight work and unpaid breaks split across facility dates without deducting paid rest',()=>{
 const rows=daily(ledger([{id:'night',start:'2026-10-20T06:00:00Z',end:'2026-10-20T08:00:00Z',breaks:[{start:'2026-10-20T06:50:00Z',end:'2026-10-20T07:10:00Z',paid:false},{start:'2026-10-20T07:20:00Z',end:'2026-10-20T07:30:00Z',paid:true}]}]));
 expect(rows.map(d=>[d.date,d.rawMillis,d.unpaidMillis,d.paidMillis])).toEqual([['2026-10-19',3600000,600000,3000000],['2026-10-20',3600000,600000,3000000]]);
});
test('effective rates apply by work date, same-date corrections retain history, and integer money rounds once per day',()=>{
 const data=ledger([session('2026-10-19'),session('2026-10-20')],{'2026-10-19':approval(28800000),'2026-10-20':approval(28800000)});
 const p=profile([{id:'old',effectiveOn:'2026-01-01',cents:2000,currency:'USD',sequence:1},{id:'new',effectiveOn:'2026-10-20',cents:2500,currency:'USD',sequence:2}]);
 const result=preview(data,p,'2026-10-19','2026-10-20');expect(result.canFinalize).toBe(true);expect(result.rows.map(r=>r.grossCents)).toEqual([16000,20000]);expect(result.grossCents).toBe(36000);
 expect(p.rates).toHaveLength(2);
});
test('long days require explicit overtime review and use only the additional pay the administrator entered',()=>{
 const data=ledger([session('2026-10-19',13)],{'2026-10-19':manualApproval(13*3600000)});
 let result=preview(data,profile(),'2026-10-19','2026-10-19');expect(result.canFinalize).toBe(false);expect(result.blockers.join(' ')).toMatch(/explicit administrator review/);
 // Thirteen hours at $20 plus an explicitly reviewed $60, without any factor.
 data.approvals['2026-10-19']=manualApproval(13*3600000,{overtimeReviewed:true,premiumCents:6000});
 reviewed(data);
 result=preview(data,profile(),'2026-10-19','2026-10-19');expect(result.canFinalize).toBe(true);expect(result.grossCents).toBe(32000);
 data.approvals['2026-10-19'].premiumCents=1234;
 expect(preview(data,profile(),'2026-10-19','2026-10-19').grossCents).toBe(27234);
 expect(data.sessions[0]).toEqual(session('2026-10-19',13));
});
test('older overtime allocations cannot silently reuse automatic multipliers in a fresh calculation',()=>{
 const data=ledger([session('2026-10-19',13)],{'2026-10-19':approval(8*3600000,{overtimeMillis:4*3600000,doubleMillis:3600000})});
 const original=structuredClone(data);
 const result=preview(data,profile(),'2026-10-19','2026-10-19');
 expect(result.canFinalize).toBe(false);expect(result.rows[0].grossCents).toBeNull();
 expect(result.blockers.join(' ')).toMatch(/earlier overtime allocation uses automatic multipliers/);
 expect(data).toEqual(original);
});
test('weekly and seventh-day review uses actual work outside the selected pay period',()=>{
 const dates=['2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23','2026-10-24','2026-10-25'];
 const data=ledger(dates.map(d=>session(d)),Object.fromEntries(dates.map(d=>[d,approval(28800000)])));
 let result=preview(data,profile(),'2026-10-25','2026-10-25');expect(result.canFinalize).toBe(false);expect(result.blockers.join(' ')).toMatch(/explicit administrator review/);
 expect(overtimeContext(daily(data).at(-1),daily(data),rules)).toMatchObject({daily:false,weekly:true,seventhDay:true,requiresReview:true,weekMillis:56*3600000});
 data.approvals=Object.fromEntries(dates.map(d=>[d,manualApproval(8*3600000,{overtimeReviewed:true,premiumCents:321})]));
 reviewed(data);
 result=preview(data,profile(),'2026-10-25','2026-10-25');expect(result.canFinalize).toBe(true);expect(result.grossCents).toBe(16321);
});
test('missing checkout, unapproved days, missing rates, unverified/changed policy and under-approved time block finalization',()=>{
 const data=ledger([session('2026-10-19')]);expect(preview(data,profile(),'2026-10-19','2026-10-19').canFinalize).toBe(false);
 data.approvals['2026-10-19']=approval(4*3600000);expect(preview(data,profile(),'2026-10-19','2026-10-19').blockers.join(' ')).toMatch(/below clocked/);
 data.approvals['2026-10-19']=approval(8*3600000);expect(preview(data,profile([]),'2026-10-19','2026-10-19').blockers.join(' ')).toMatch(/No effective/);
 expect(preview(data,{...profile(),rules:{...rules,confirmed:false}},'2026-10-19','2026-10-19').canFinalize).toBe(false);
 expect(preview(data,{...profile(),rules:{...rules,reference:'Changed rules'}},'2026-10-19','2026-10-19').blockers.join(' ')).toMatch(/policy changed/);
 data.sessions[0].end=null;expect(preview(data,profile(),'2026-10-19','2026-10-19').blockers.join(' ')).toMatch(/Missing checkout/);
});
test('mixed rates never select an overtime multiplier instead of the administrator reviewed amount',()=>{
 const data=ledger([session('2026-10-19'),session('2026-10-20',9)],{'2026-10-19':approval(28800000),'2026-10-20':approval(28800000,{overtimeMillis:3600000})});
 const p=profile([...profile().rates,{id:'new',effectiveOn:'2026-10-20',cents:2500,currency:'USD',sequence:2}]);
 expect(preview(data,p,'2026-10-20','2026-10-20').blockers.join(' ')).toMatch(/earlier overtime allocation/);
 data.approvals['2026-10-20']=manualApproval(9*3600000,{overtimeReviewed:true,premiumCents:1000});
 reviewed(data,p);
 expect(preview(data,p,'2026-10-20','2026-10-20')).toMatchObject({canFinalize:true,grossCents:23500});
});
test('negative adjusted gross cannot be finalized',()=>{
 const data=ledger([session('2026-10-19')],{'2026-10-19':approval(28800000,{adjustmentCents:-20000})});
 const result=preview(data,profile(),'2026-10-19','2026-10-19');expect(result.canFinalize).toBe(false);expect(result.blockers.join(' ')).toMatch(/negative/);
});

test('an unfinished legacy entry neither deducts guessed time nor blocks a completed day',()=>{
 const work={...session('2026-10-19'),breaks:[{start:'2026-10-19T18:00:00Z',end:null,paid:false}]};
 const data=ledger([work],{'2026-10-19':approval(28800000)});
 expect(daily(data)[0]).toMatchObject({rawMillis:28800000,paidMillis:28800000,unpaidMillis:0,incomplete:false});
 expect(preview(data,profile(),'2026-10-19','2026-10-19')).toMatchObject({grossCents:16000,canFinalize:true});
 expect(work.breaks[0].end).toBeNull();
 work.end=null;
 expect(daily(data)[0].incomplete).toBe(true);
 expect(preview(data,profile(),'2026-10-19','2026-10-19').blockers.join(' ')).toContain('Missing checkout.');
});

test.each([
 [0,0,false],[8*3600000,8*3600000,false],[8*3600000+1,9*3600000,true],[8.5*3600000,9*3600000,true],[9*3600000,9*3600000,false],[9.5*3600000,10*3600000,false],
])('whole-hour proposal for %s actual milliseconds preserves actual time', (actual,suggested,eligible)=>{
 const day={date:'2026-10-19',paidMillis:actual,incomplete:false};
 const work={plannedMinutes:540,plannedStart:'08:00',plannedEnd:'17:00',outsideMillis:0,scheduleIssue:null};
 const before=structuredClone(day);
 expect(scheduledPayCredit(day,work)).toEqual({eligible,suggestedPaidMillis:suggested,roundingCreditMillis:suggested-actual,scheduledCreditMillis:eligible?suggested-actual:0});
 expect(day).toEqual(before);
});
test.each([
 {outsideMillis:60000}, {scheduleIssue:'Review daylight-saving change'}, {plannedStart:null}, {plannedEnd:null}, {plannedMinutes:480},
])('outside, uncertain or duration-only schedules still round up but cannot receive schedule exemption (%j)', changes=>{
 const day={paidMillis:8.5*3600000,incomplete:false};
 const work={plannedMinutes:540,plannedStart:'08:00',plannedEnd:'17:00',outsideMillis:0,scheduleIssue:null,...changes};
 expect(scheduledPayCredit(day,work)).toEqual({eligible:false,suggestedPaidMillis:9*3600000,roundingCreditMillis:1800000,scheduledCreditMillis:0});
 expect(scheduledPayCredit({...day,incomplete:true},{...work,...{outsideMillis:0,scheduleIssue:null}})).toEqual({eligible:false,suggestedPaidMillis:day.paidMillis,roundingCreditMillis:0,scheduledCreditMillis:0});
});
test('six hours forty-one minutes rounds to seven without changing the actual clock record',()=>{
 const day={date:'2026-10-19',paidMillis:6.695*3600000,incomplete:false};
 expect(scheduledPayCredit(day)).toEqual({eligible:false,suggestedPaidMillis:7*3600000,roundingCreditMillis:18*60000+18000,scheduledCreditMillis:0});
 expect(scheduledPayCredit(day,{plannedMinutes:420,plannedStart:'08:00',plannedEnd:'15:00',outsideMillis:0,scheduleIssue:null})).toEqual({eligible:true,suggestedPaidMillis:7*3600000,roundingCreditMillis:18*60000+18000,scheduledCreditMillis:18*60000+18000});
 expect(day.paidMillis).toBe(6.695*3600000);
});
test('an earlier fractional approval blocks fresh finalization until whole-hour time is explicitly approved',()=>{
 const data=ledger([session('2026-10-19',6.695)],{'2026-10-19':manualApproval(6.695*3600000)});
 const before=structuredClone(data),p=profile();
 expect(preview(data,p,'2026-10-19','2026-10-19').blockers.join(' ')).toMatch(/rounding review/);
 expect(data).toEqual(before);
 data.approvals['2026-10-19']=manualApproval(7*3600000);
 expect(preview(data,p,'2026-10-19','2026-10-19')).toMatchObject({canFinalize:true,grossCents:14000,rawMillis:6.695*3600000,approvedMillis:7*3600000});
});
test('manually approved paid credit remains separate from actual hours and does not manufacture weekly overtime',()=>{
 const dates=['2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23'];
 const data=ledger(dates.map(d=>session(d,7.5)),Object.fromEntries(dates.map(d=>[d,manualApproval(9*3600000)])));
 const days=daily(data);
 expect(overtimeContext(days[4],days,rules)).toMatchObject({weekly:false,weekMillis:37.5*3600000});
 expect(preview(data,profile(),'2026-10-19','2026-10-23')).toMatchObject({rawMillis:37.5*3600000,approvedMillis:45*3600000,grossCents:90000,canFinalize:true});
});
test('outside-schedule work always needs an explicit administrator overtime decision even below eight hours',()=>{
 const data=ledger([session('2026-10-19',3)],{'2026-10-19':manualApproval(3*3600000,{requiresOvertimeReview:true})});
 expect(preview(data,profile(),'2026-10-19','2026-10-19').blockers.join(' ')).toMatch(/explicit administrator review/);
 data.approvals['2026-10-19'].overtimeReviewed=true;
 reviewed(data);
 expect(preview(data,profile(),'2026-10-19','2026-10-19')).toMatchObject({canFinalize:true,grossCents:6000});
});
test('new manual-pay previews cannot share an old algorithm fingerprint',()=>{
 const data=ledger([session('2026-10-19')],{'2026-10-19':approval(8*3600000)}),p=profile(),start='2026-10-19',end=start;
 expect(preview(data,p,start,end).fingerprint).not.toBe(hash({ledger:data,profile:p,start,end}));
});
test('weekly review begins on the day cumulative actual work crosses forty hours and changes to earlier work renew that review',()=>{
 const dates=['2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23'];
 const data=ledger([session(dates[0],9)],{[dates[0]]:manualApproval(9*3600000,{overtimeReviewed:true})});
 reviewed(data); const first=data.approvals[dates[0]].overtimeFingerprint;
 data.sessions.push(session(dates[1],3));data.approvals[dates[1]]=manualApproval(3*3600000);
 expect(overtimeFingerprint(daily(data)[0],daily(data),rules,profile().rates)).toBe(first);
 for(const date of dates.slice(2)){data.sessions.push(session(date,10));data.approvals[date]=manualApproval(10*3600000,{overtimeReviewed:true});}
 expect(preview(data,profile(),dates[0],dates[0]).canFinalize).toBe(true);
 expect(overtimeContext(daily(data)[0],daily(data),rules)).toMatchObject({weekly:false,weekMillis:9*3600000});
 const last=daily(data).at(-1);
 expect(overtimeContext(last,daily(data),rules)).toMatchObject({weekly:true,weekMillis:42*3600000});
 reviewed(data);expect(preview(data,profile(),dates[4],dates[4]).canFinalize).toBe(true);
 data.sessions[0].end=new Date(Date.parse(data.sessions[0].end)+60000).toISOString();
 const result=preview(data,profile(),dates[4],dates[4]);expect(result.canFinalize).toBe(false);
 expect(result.blockers.join(' ')).toMatch(/Recorded work or hourly rate changed after overtime review/);
 expect(data.approvals[dates[0]].overtimeFingerprint).toBe(first);
});
test('an older straight-time approval is not invalidated just because a later workday is unapproved',()=>{
 const data=ledger([session('2026-10-19'),session('2026-10-20',3)],{'2026-10-19':approval(8*3600000)});
 expect(preview(data,profile(),'2026-10-19','2026-10-19')).toMatchObject({canFinalize:true,grossCents:16000});
 expect(data.approvals['2026-10-20']).toBeUndefined();
});
test('an effective rate correction requires a fresh manual overtime decision and never reuses its old additional-pay amount',()=>{
 const data=ledger([session('2026-10-19',9)],{'2026-10-19':manualApproval(9*3600000,{overtimeReviewed:true,premiumCents:1234})}),p=profile();
 reviewed(data,p);expect(preview(data,p,'2026-10-19','2026-10-19')).toMatchObject({canFinalize:true,grossCents:19234});
 p.rates.push({id:'correction',effectiveOn:'2026-10-19',cents:2500,currency:'USD',sequence:2});
 const result=preview(data,p,'2026-10-19','2026-10-19');
 expect(result.canFinalize).toBe(false);expect(result.rows[0].grossCents).toBeNull();
 expect(result.blockers.join(' ')).toMatch(/hourly rate changed after overtime review/);
 expect(data.approvals['2026-10-19'].premiumCents).toBe(1234);
 reviewed(data,p);expect(preview(data,p,'2026-10-19','2026-10-19')).toMatchObject({canFinalize:true,grossCents:23734});
});
test('a future rate has no effect on an earlier overtime decision',()=>{
 const data=ledger([session('2026-10-19',9)],{'2026-10-19':manualApproval(9*3600000,{overtimeReviewed:true,premiumCents:1234})}),p=profile();
 reviewed(data,p);const fingerprint=data.approvals['2026-10-19'].overtimeFingerprint;
 p.rates.push({id:'future',effectiveOn:'2026-11-01',cents:3000,currency:'USD',sequence:2});
 expect(overtimeFingerprint(daily(data)[0],daily(data),rules,p.rates)).toBe(fingerprint);
 expect(preview(data,p,'2026-10-19','2026-10-19')).toMatchObject({canFinalize:true,grossCents:19234});
});
test('a rate correction on an earlier worked day renews the later cumulative weekly overtime review',()=>{
 const dates=['2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23','2026-10-24'];
 const data=ledger(dates.map(date=>session(date,8)),Object.fromEntries(dates.map(date=>[date,manualApproval(8*3600000,{overtimeReviewed:true,premiumCents:500})]))),p=profile();
 reviewed(data,p);const last=daily(data).at(-1);
 expect(overtimeContext(last,daily(data),rules)).toMatchObject({weekly:true,weekMillis:48*3600000});
 p.rates.push({id:'midweek',effectiveOn:'2026-10-20',cents:2500,currency:'USD',sequence:2}, {id:'restore',effectiveOn:'2026-10-21',cents:2000,currency:'USD',sequence:3});
 const result=preview(data,p,dates.at(-1),dates.at(-1));
 expect(result.canFinalize).toBe(false);expect(result.blockers.join(' ')).toMatch(/hourly rate changed after overtime review/);
 expect(preview(data,p,dates[0],dates[0]).canFinalize).toBe(true);
});

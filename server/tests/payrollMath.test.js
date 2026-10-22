const { daily, preview, hash } = require('../services/payrollMath');
const rules={mode:'ca-standard',workweekStart:1,confirmed:true,reference:'Synthetic reviewed policy',dailyScheduledMinutes:480};
const profile=(rates=[{id:'rate',effectiveOn:'2026-01-01',cents:2000,currency:'USD',sequence:1}])=>({rules,rates});
const approval=(regularMillis,extra={})=>({status:'approved',regularMillis,overtimeMillis:0,doubleMillis:0,adjustmentCents:0,rulesReviewed:true,rulesFingerprint:hash(rules),...extra});
const session=(date,hours=8)=>({id:date,start:date+'T15:00:00Z',end:new Date(Date.parse(date+'T15:00:00Z')+hours*3600000).toISOString(),breaks:[]});
const ledger=(sessions,approvals={})=>({timeZone:'America/Los_Angeles',sessions,approvals});
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
test('daily overtime and double time are never silently treated as regular time or capped',()=>{
 const data=ledger([session('2026-10-19',13)],{'2026-10-19':approval(13*3600000)});
 let result=preview(data,profile(),'2026-10-19','2026-10-19');expect(result.canFinalize).toBe(false);expect(result.blockers.join(' ')).toMatch(/daily\/weekly|double-time/);
 data.approvals['2026-10-19']=approval(8*3600000,{overtimeMillis:4*3600000,doubleMillis:3600000});
 result=preview(data,profile(),'2026-10-19','2026-10-19');expect(result.canFinalize).toBe(true);expect(result.grossCents).toBe(32000);
});
test('weekly and seventh-day allocations consider days outside a selected period',()=>{
 const dates=['2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23','2026-10-24','2026-10-25'];
 const data=ledger(dates.map(d=>session(d)),Object.fromEntries(dates.map(d=>[d,approval(28800000)])));
 const result=preview(data,profile(),'2026-10-25','2026-10-25');expect(result.canFinalize).toBe(false);expect(result.blockers.join(' ')).toMatch(/weekly|Seventh-day/);
});
test('missing checkout, unapproved days, missing rates, unverified/changed policy and under-approved time block finalization',()=>{
 const data=ledger([session('2026-10-19')]);expect(preview(data,profile(),'2026-10-19','2026-10-19').canFinalize).toBe(false);
 data.approvals['2026-10-19']=approval(4*3600000);expect(preview(data,profile(),'2026-10-19','2026-10-19').blockers.join(' ')).toMatch(/below clocked/);
 data.approvals['2026-10-19']=approval(8*3600000);expect(preview(data,profile([]),'2026-10-19','2026-10-19').blockers.join(' ')).toMatch(/No effective/);
 expect(preview(data,{...profile(),rules:{...rules,confirmed:false}},'2026-10-19','2026-10-19').canFinalize).toBe(false);
 expect(preview(data,{...profile(),rules:{...rules,reference:'Changed rules'}},'2026-10-19','2026-10-19').blockers.join(' ')).toMatch(/policy changed/);
 data.sessions[0].end=null;expect(preview(data,profile(),'2026-10-19','2026-10-19').blockers.join(' ')).toMatch(/Missing checkout/);
});
test('mixed-rate workweeks with overtime require provider review instead of a guessed regular rate',()=>{
 const data=ledger([session('2026-10-19'),session('2026-10-20',9)],{'2026-10-19':approval(28800000),'2026-10-20':approval(28800000,{overtimeMillis:3600000})});
 const p=profile([...profile().rates,{id:'new',effectiveOn:'2026-10-20',cents:2500,currency:'USD',sequence:2}]);
 expect(preview(data,p,'2026-10-20','2026-10-20').blockers.join(' ')).toMatch(/Multiple rates/);
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

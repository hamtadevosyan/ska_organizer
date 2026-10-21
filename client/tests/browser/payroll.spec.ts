import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIResponse } from '@playwright/test';
import { api, authenticatedApi, origin } from './auth-helpers';
async function data<T>(response: APIResponse, status = 200): Promise<T> { expect(response.status(), await response.text()).toBe(status); return (await response.json()).data as T; }
for (const width of [320, 1280]) test(`own clock and private pay review through HTTP at ${width}px`, async ({ page, browser }) => {
  test.setTimeout(90_000); page.setDefaultTimeout(10_000); await page.setViewportSize({ width, height: 1000 }); const http = await authenticatedApi(page); const suffix = randomUUID().slice(0, 8);
  const room = await data<{ id: string }>(await http.post(api + '/rooms', { data: { name: 'Clock class ' + suffix, ageMinMonths: 0, ageMaxMonths: 60, capacity: 10 } }), 201);
  const employee = await data<{ id: string; name: string }>(await http.post(api + '/staff', { data: { name: 'Clock employee ' + suffix, role: 'Teacher', roomId: room.id } }), 201);
  const password = 'Synthetic payroll changed 20!'; const temporary = 'Synthetic payroll temporary 20!'; const username = 'clock-' + suffix;
  await data(await http.post(api + '/admin/accounts', { data: { username, displayName: employee.name, role: 'teacher', staffMemberId: employee.id, password: temporary } }), 201);
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  try {
    const teacher = await context.newPage(); const response = await teacher.request.post(api + '/auth/login', { headers: { Origin: origin }, data: { username, password: temporary, rememberMe: true } }); expect(response.status()).toBe(200); const login = await response.json() as { csrfToken: string };
    expect((await teacher.request.post(api + '/auth/password', { headers: { Origin: origin, 'X-CSRF-Token': login.csrfToken }, data: { currentPassword: temporary, password } })).status()).toBe(200);
    const cookies = (await context.cookies(api)).filter(cookie => cookie.name === 'skao_session'); await context.addCookies(cookies.map(cookie => ({ ...cookie, expires: -1 })));
    await teacher.goto('/my-time'); await teacher.getByRole('button', { name: 'Check in to work', exact: true }).click();
    await expect(teacher.getByRole('button', { name: 'Check out of work', exact: true })).toBeEnabled(); await expect(teacher.getByRole('button', { name: 'Check in to work', exact: true })).toHaveCount(0);
    await expect(teacher.getByRole('button', { name: /break/i })).toHaveCount(0); await teacher.getByRole('button', { name: 'Check out of work', exact: true }).click();
    await expect(teacher.getByRole('button', { name: 'Check in to work', exact: true })).toBeEnabled(); expect((await teacher.request.get(api + '/payroll/staff/' + employee.id)).status()).toBe(403);
    const own = await data<{ checkedIn: boolean; version: number }>(await teacher.request.get(api + '/time-clock')); expect(JSON.stringify(own)).not.toMatch(/rates|taxId|bankAccount|approvals|sessions|days|Millis/);
    const base = api + '/payroll/staff/' + employee.id;
    const detail=await data<{ledger:{sessions:{id:string}[]}}>(await http.get(base));
    await data(await http.post(base + '/corrections', { data: { version: own.version, sessionId: detail.ledger.sessions[0].id, start: '2026-09-21T15:00:00Z', end: '2026-09-21T23:00:00Z', breaks: [], reason: 'Synthetic historical fixture correction', voided: false } }));
    await page.goto('/payroll'); await page.getByRole('combobox', { name: 'Payroll employee', exact: true }).selectOption(employee.id);
    await page.getByLabel('Legal employee name', { exact: true }).fill('Synthetic legal name'); await page.getByLabel('Employee SSN (optional)', { exact: true }).fill('SYNTHETIC-TAX-1234');
    await page.getByText('Advanced payroll settings',{exact:true}).click();
    await page.getByLabel('Payroll policy review notes', { exact: true }).fill('Synthetic reviewer verified applicable standard rules; no unpaid breaks in synthetic fixture.');
    await page.getByText('The applicable classification, workweek, overtime, paid rest, meal periods, premiums and adjustments have been reviewed.', { exact: true }).click();
    await page.getByLabel('Reason for profile change', { exact: true }).fill('Synthetic payroll profile'); await page.getByRole('button', { name: 'Save private profile', exact: true }).click();
    await expect(page.getByLabel('Employee SSN (optional)', { exact: true })).toHaveAttribute('placeholder', '••••1234');
    await page.getByRole('button', { name: 'Hourly rates', exact: true }).click(); await page.getByLabel('Effective date', { exact: true }).fill('2026-01-01'); await page.getByLabel('Hourly rate', { exact: true }).fill('20'); await page.getByLabel('Reason / correction explanation', { exact: true }).fill('Synthetic base rate'); await page.getByRole('button', { name: 'Add effective rate', exact: true }).click();
    await expect(page.getByText('2026-01-01 · $20.00/hour · Synthetic base rate', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Time & approvals', exact: true }).click(); await page.locator('summary').filter({ hasText: '2026-09-21' }).click();
    await page.getByLabel('I reviewed actual work, overtime, paid rest, unpaid meals and premiums for this date.', { exact: true }).check(); await page.getByLabel('Approval / return reason, including any difference from clocked time', { exact: true }).fill('Synthetic eight hours reviewed'); await page.getByRole('button', { name: 'Save daily decision', exact: true }).click();
    await expect(page.locator('summary').filter({ hasText: '2026-09-21' })).toContainText('approved');
    await page.getByRole('button', { name: 'Pay preview', exact: true }).click(); await page.getByLabel('Pay period start', { exact: true }).fill('2026-09-21'); await page.getByLabel('Pay period end', { exact: true }).fill('2026-09-21'); await page.getByRole('button', { name: 'Calculate gross preview', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Reviewed gross-pay preview: $160.00', exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Save finalized calculation snapshot', exact: true }).click(); await expect(page.getByRole('button', { name: 'Open calculation snapshot', exact: true })).toBeEnabled();
    await page.reload(); await page.getByRole('combobox', { name: 'Payroll employee', exact: true }).selectOption(employee.id); await page.getByRole('button', { name: 'Pay preview', exact: true }).click(); await page.getByRole('button', { name: 'Open calculation snapshot', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Reviewed gross-pay preview: $160.00', exact: true })).toBeVisible(); expect(await page.locator('main').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(width + 1); await page.screenshot({ path: test.info().outputPath('payroll.png'), fullPage: true });
  } finally { await context.close(); }
});
test('editor receives a home reminder and corrects a verified late clockout without private payroll access at 390px', async({page,browser})=>{
 test.setTimeout(90_000);await page.setViewportSize({width:390,height:1000});const http=await authenticatedApi(page);const suffix=randomUUID().slice(0,8);
 const employee=await data<{id:string;name:string}>(await http.post(api+'/staff',{data:{name:'Late clock '+suffix,role:'Other'}}),201);
 const temporary='Synthetic review temporary 20!',password='Synthetic review changed 20!';
 for(const role of ['editor','teacher'])await data(await http.post(api+'/admin/accounts',{data:{username:role+'-'+suffix,displayName:role+' Example',role,...(role==='teacher'?{staffMemberId:employee.id}:{}),password:temporary}}),201);
 const context=await browser.newContext({viewport:{width:390,height:1000}});
 try{
  const other=await context.newPage();
  async function login(role:string){await context.clearCookies();const response=await other.request.post(api+'/auth/login',{headers:{Origin:origin},data:{username:role+'-'+suffix,password:temporary}});expect(response.status()).toBe(200);const csrf=(await response.json()).csrfToken;
   const changed=await other.request.post(api+'/auth/password',{headers:{Origin:origin,'X-CSRF-Token':csrf},data:{currentPassword:temporary,password}});expect(changed.status()).toBe(200);const token=(await changed.json()).csrfToken;const cookies=(await context.cookies(api)).filter(c=>c.name==='skao_session');await context.addCookies(cookies.map(c=>({...c,expires:-1})));return {Origin:origin,'X-CSRF-Token':token};}
  const headers=await login('teacher');expect((await other.request.post(api+'/time-clock',{headers,data:{action:'checkin',version:0,requestId:randomUUID()}})).status()).toBe(200);expect((await other.request.post(api+'/time-clock',{headers,data:{action:'checkout',version:1,requestId:randomUUID()}})).status()).toBe(200);
  const base=api+'/payroll/staff/'+employee.id;const initial=await data<{ledger:{version:number;sessions:{id:string}[]}}>(await http.get(base));
  await data(await http.post(base+'/corrections',{data:{version:initial.ledger.version,sessionId:initial.ledger.sessions[0].id,start:'2026-09-22T15:00:00Z',end:'2026-09-23T00:00:00Z',breaks:[],voided:false,reason:'Synthetic nine-hour late clockout'}}));
  await login('editor');await other.goto('/dashboard');await expect(other.getByRole('region',{name:'Extra employee time reminders'})).toContainText('needs extra-time review');await other.getByRole('link',{name:'Review work time',exact:true}).click();
  await expect(other.getByRole('heading',{name:employee.name+' · 2026-09-22',exact:true})).toBeVisible();expect((await other.request.get(base)).status()).toBe(403);
  await other.getByText('Correct a late clock-out mistake',{exact:true}).click();await other.getByLabel('Actual work ended at (America/Los_Angeles)',{exact:true}).fill('16:00:00');await other.getByLabel('Clock correction reason',{exact:true}).fill('Verified employee stopped work at 4 PM and forgot to clock out');await other.getByLabel('I verified no work was performed after this time.',{exact:true}).check();await other.getByRole('button',{name:'Save verified clock correction',exact:true}).click();
  await expect(other.getByText('No extra time is waiting for review.',{exact:true})).toBeVisible();expect(await other.locator('main').evaluate(e=>e.scrollWidth)).toBeLessThanOrEqual(391);
  const result=await data<{ledger:{sessions:{end:string}[];history:{type:string;before?:{end:string}}[]}}>(await http.get(base));expect(result.ledger.sessions[0].end).toBe('2026-09-22T23:00:00.000Z');expect(result.ledger.history.some(h=>h.type==='clock-error-review'&&h.before?.end==='2026-09-23T00:00:00.000Z')).toBe(true);
 }finally{await context.close();}
});

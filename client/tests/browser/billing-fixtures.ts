import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import type { APIResponse } from '@playwright/test';
import { api, authenticatedApi } from './auth-helpers';

export type BillingHttp = Awaited<ReturnType<typeof authenticatedApi>>;
export type BillingPayer = { amountCents: number; paidCents: number; outstandingCents: number; dueDate: string | null; daysOverdue: number; overdue: boolean };
export type BillingCharge = { id: string; kind: string; title: string; month?: string | null; status?: string; settlementMode?: string; pendingCcrc?: boolean; ccrcReview?: { familyDueDate: string } | null; payers: { family: BillingPayer; ccrc: BillingPayer } };
export type BillingDetail = {
  today: string; timeZone: string; version: number;
  charges: BillingCharge[];
  payments: { id: string; payer?: 'family' | 'ccrc'; date?: string; amountCents: number; creditCents: number; reversed: boolean; allocations?: { chargeId: string; amountCents: number }[] }[];
  totals: { outstandingCents: number; familyOutstandingCents: number; ccrcOutstandingCents: number; creditCents: number; awaitingCcrcCents?: number; awaitingCcrcCount?: number };
};

export async function billingData<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), 'The real billing fixture request must succeed').toBe(status);
  return (await response.json()).data as T;
}

export function billingDate(date: string, days: number) {
  const result = new Date(date + 'T12:00:00Z');
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export async function billingChild(http: BillingHttp, marker = 'TuitionChild') {
  const suffix = randomUUID().slice(0, 8);
  const response = await http.post(api + '/children', { data: {
    firstName: marker + suffix, lastName: 'Synthetic', dateOfBirth: '2023-01-01', roomId: null,
  } });
  expect(response.status()).toBe(201);
  const child = await response.json() as { id: string; firstName: string; lastName: string };
  const path = api + '/billing/children/' + child.id;
  let detail = await billingData<BillingDetail>(await http.get(path));
  detail = await billingData<BillingDetail>(await http.post(path + '/profile', { data: {
    version: detail.version, requestId: randomUUID(), billingStart: detail.today.slice(0, 7) + '-01', billingEnd: null,
    effectiveMonth: detail.today.slice(0, 7), familyCents: 30000, ccrcCents: 70000,
    familyDueDay: 31, ccrcDueDay: 31, registrationCents: 10000, enabled: true,
  } }));
  return { child, path, detail };
}

// Service month and receipt date deliberately cross a month boundary. Use the
// fixture server's calendar so the browser test never needs a production clock
// override or becomes future-dated when it runs in a different month.
export async function ccrcBillingChild(http: BillingHttp) {
  const suffix = randomUUID().slice(0, 8);
  const response = await http.post(api + '/children', { data: {
    firstName: 'VariableCCRC' + suffix, lastName: 'Synthetic', dateOfBirth: '2023-01-01', roomId: null,
  } });
  expect(response.status()).toBe(201);
  const child = await response.json() as { id: string; firstName: string; lastName: string };
  const path = api + '/billing/children/' + child.id;
  let detail = await billingData<BillingDetail>(await http.get(path));
  const previous = new Date(detail.today.slice(0, 7) + '-01T12:00:00Z');
  previous.setUTCMonth(previous.getUTCMonth() - 1);
  const serviceMonth = previous.toISOString().slice(0, 7);
  const serviceEnd = billingDate(detail.today.slice(0, 7) + '-01', -1);
  detail = await billingData<BillingDetail>(await http.post(path + '/profile', { data: {
    version: detail.version, requestId: randomUUID(), billingStart: serviceMonth + '-01', billingEnd: serviceEnd,
    effectiveMonth: serviceMonth, monthlyCents: 120000, ccrcManaged: true,
    familyDueDay: 1, registrationCents: 0, enabled: true,
  } }));
  expect(detail.charges).toHaveLength(1);
  return { child, path, detail, serviceMonth };
}

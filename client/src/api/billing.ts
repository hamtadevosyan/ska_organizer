import axios from 'axios';
import { API_BASE_URL } from '../lib/api';

export type BillingPayer = 'family' | 'ccrc';
export type BillingChild = { id: string; name: string; active: boolean };
export type BillingRate = { effectiveMonth: string; monthlyCents?: number; ccrcManaged?: boolean; familyCents?: number; ccrcCents?: number; familyDueDay: number; ccrcDueDay?: number; at: string; actorId: string };
export type BillingProfile = Omit<BillingRate, 'at' | 'actorId'> & { enabled: boolean; billingStart: string; billingEnd: string | null; registrationCents: number; rates: BillingRate[]; pausedForEnrollment?: boolean; pausedOn?: string };
export type BillingTotals = { chargedCents: number; paidCents: number; receivedCents: number; outstandingCents: number; creditCents: number; familyOutstandingCents: number; ccrcOutstandingCents: number; familyCreditCents: number; ccrcCreditCents: number; overdueCents: number; awaitingCcrcCents?: number; awaitingCcrcCount?: number };
export type BillingBalance = { amountCents: number; paidCents: number; outstandingCents: number; dueDate: string | null; daysOverdue: number; overdue: boolean };
export type BillingCharge = { id: string; kind: 'monthly' | 'registration' | 'manual'; month: string | null; title: string; createdAt: string; amountCents: number; paidCents: number; outstandingCents: number; status: 'unpaid' | 'partial' | 'paid' | 'waived' | 'awaiting_ccrc'; settlementMode?: 'ccrc_actual'; tuitionCents?: number; ccrcReceivedCents?: number; ccrcUnappliedCents?: number; pendingCcrc?: boolean; allocationCapacityCents?: Record<BillingPayer, number>; ccrcReview?: { familyDueDate: string; reason: string; at: string; actorId: string } | null; payers: Record<BillingPayer, BillingBalance>; adjustments: { id: string; payer: BillingPayer; amountCents: number; dueDate?: string; reason: string; at: string; actorId: string }[] };
export type BillingPayment = { id: string; payer: BillingPayer; amountCents: number; date: string; method: string; reference: string; serviceChargeId?: string; serviceMonth?: string; allocatedCents: number; creditCents: number; reversed: boolean; allocations: { chargeId: string; amountCents: number; at: string; actorId: string }[]; at: string; actorId: string; reverseReason?: string };
export type BillingHistory = { id: string; type: string; at: string; actorId: string; actorName?: string; reason?: string };
export type BillingDetail = { child: BillingChild; version: number; today: string; timeZone: string; profile: BillingProfile | null; charges: BillingCharge[]; payments: BillingPayment[]; history: BillingHistory[]; totals: BillingTotals; pendingMonthlyCharges?: number };
export type BillingSummary = { today: string; timeZone: string; children: { child: BillingChild; version: number; profile: BillingProfile | null; totals: BillingTotals; overdueCount: number; pendingMonthlyCharges?: number }[]; totals: BillingTotals };
export type BillingAlerts = { today: string; timeZone: string; count: number; totalOutstandingCents: number; pendingMonthlyCharges?: number; awaitingCcrcCount?: number; awaitingCcrcCents?: number; items: { id: string; childId: string; childName: string; payer: BillingPayer; chargeId: string; title: string; dueDate: string | null; daysOverdue: number; outstandingCents: number }[] };

const base = API_BASE_URL + '/api/billing';
export const BILLING_CHANGED = 'skao-billing-changed';
export const billingMoney = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
export const billingPayer = (payer: BillingPayer) => payer === 'ccrc' ? 'CCRC' : 'Family';
export const billingDollars = (cents: number) => (cents / 100).toFixed(2);
// Convert decimal digits directly, so financial entry never relies on float rounding.
export function billingCents(value: string): number | null {
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(value)) return null;
  const [dollars, fraction = ''] = value.split('.');
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}
export const billingRequestId = () => crypto.randomUUID();
export async function getBillingSummary(signal?: AbortSignal) {
  return (await axios.get<{ data: BillingSummary }>(base, { signal })).data.data;
}
export async function getBillingChild(childId: string, signal?: AbortSignal) {
  return (await axios.get<{ data: BillingDetail }>(base + '/children/' + encodeURIComponent(childId), { signal })).data.data;
}
export async function getBillingAlerts(signal?: AbortSignal) {
  return (await axios.get<{ data: BillingAlerts }>(base + '/alerts', { signal })).data.data;
}
export async function saveBillingChange(childId: string, path: string, body: Record<string, unknown>, signal?: AbortSignal) {
  const result = (await axios.post<{ data: BillingDetail }>(base + '/children/' + encodeURIComponent(childId) + '/' + path, body, { signal })).data.data;
  window.dispatchEvent(new Event(BILLING_CHANGED));
  return result;
}

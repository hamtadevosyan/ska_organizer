export type ClockSession = { id: string; start: string; end: string | null; version: number; voided?: boolean; breaks: { id?: string; start: string; end: string | null; paid: boolean }[] };
export type Approval = { status: string; regularMillis: number; overtimeMillis: number; doubleMillis: number; adjustmentCents: number; reason: string; rulesReviewed: boolean };
export type Day = { date: string; rawMillis: number; unpaidMillis: number; paidMillis: number; incomplete: boolean; approval: Approval | null };
export type Rate = { id: string; effectiveOn: string; cents: number; currency: string; reason: string; sequence: number };
export type Profile = { version: number; legalName: string; paymentMethod: string; payFrequency: string; providerReference: string; instructions: string; taxId: string; bankAccount: string; routingNumber: string; requiredDocuments: string[]; rates: Rate[];
 rules: { mode: string; workweekStart: number; confirmed: boolean; reference: string; dailyScheduledMinutes: number } };
export type Preview = { start: string; end: string; timeZone: string; currency: string | null; workedDays: number; rawMillis: number; approvedMillis: number; grossCents: number; blockers: string[]; canFinalize: boolean; fingerprint: string;
 rows: (Day & { rate: Rate | null; grossCents: number | null; issues: string[] })[] };
export type Details = { staff: { id: string; name: string; active: boolean }; profile: Profile; ledger: { version: number; timeZone: string; sessions: ClockSession[]; days: Day[]; history: { type: string; at?: string; reason?: string; actorId?: string; before?: unknown; after?: unknown }[] };
 documents: { id: string; title: string; category: string; version: number; revisions: { revision: number; documentDate: string; filename: string; byteLength: number; at: string }[] }[]; missingDocuments: string[];
 snapshots: { id: string; start: string; end: string; at: string; grossCents: number; currency: string }[] };
export const hours = (millis: number) => (millis / 3600000).toFixed(3);
export const money = (cents: number | null, currency = 'USD') => cents === null ? 'Unresolved' : new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
export const localTime = (instant: string | null, zone: string) => instant ? new Date(instant).toLocaleString('en-US', { timeZone: zone }) : 'Open';

export const payrollRequestId = () => globalThis.crypto.randomUUID();

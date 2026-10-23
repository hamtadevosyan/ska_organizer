export type ClockSession = { id: string; start: string; end: string | null; version: number; voided?: boolean; breaks: { id?: string; start: string; end: string | null; paid: boolean }[] };
export type Approval = { status: string; regularMillis: number; overtimeMillis: number; doubleMillis: number; adjustmentCents: number; reason: string; rulesReviewed: boolean;
 mode?: 'manual-reviewed'; paidMillis?: number; premiumCents?: number; overtimeReviewed?: boolean; scheduledCreditMillis?: number;
 rateMillis?: number; multiplierHundredths?: number; rateFingerprint?: string;
 hoursOverride?: boolean; clockErrorConfirmed?: boolean; hoursOverrideFingerprint?: string };
export type PayReviewReason = { code: string; message: string; date?: string; action: 'approve' | 'time' | 'work-time' | 'rates' | 'profile' };
export type RecordedSession = { id: string; start: string; end: string | null; dayStart?: string; dayEnd?: string | null; dayMillis?: number; originalStart?: string; originalEnd?: string | null };
export type PayDayReview = { state: 'awaiting-approval' | 'needs-attention' | 'approved'; reasons: PayReviewReason[]; canApproveRecorded: boolean;
  suggestedPaidMillis?: number; scheduledCreditMillis?: number; roundingCreditMillis?: number; requiresRoundingReview?: boolean; shortDayOrdinal?: number; requiresOvertimeReview?: boolean;
  workTime?: { plannedStart: string | null; plannedEnd: string | null; plannedMinutes: number; hasCapturedAllowance?: boolean; scheduleTimeZone: string; timeZone?: string;
    checkin: string | null; checkout: string | null; sessions?: RecordedSession[]; earlyMillis: number; lateMillis: number; outsideMillis: number; status: string; reason: string; scheduleIssue: string | null } };
export type Day = { date: string; rawMillis: number; unpaidMillis: number; paidMillis: number; incomplete: boolean; approval: Approval | null; review?: PayDayReview };
export type Rate = { id: string; effectiveOn: string; cents: number; currency: string; reason: string; sequence: number };
export type Profile = { version: number; legalName: string; paymentMethod: string; payFrequency: string; providerReference: string; instructions: string; taxId: string; bankAccount: string; routingNumber: string; requiredDocuments: string[]; rates: Rate[];
 rules: { mode: string; workweekStart: number; confirmed: boolean; reference: string; dailyScheduledMinutes: number } };
export type Preview = { start: string; end: string; timeZone: string; currency: string | null; workedDays: number; rawMillis: number; approvedMillis: number; grossCents: number; blockers: string[]; canFinalize: boolean; fingerprint: string;
 rows: (Day & { rate: Rate | null; grossCents: number | null; issues: string[] })[] };
export type ShortDayWarning = { staffId: string; name: string; weekStart: string; weekEnd: string; count: number; dates: string[] };
export type Details = { shortDayWarnings?: ShortDayWarning[]; staff: { id: string; name: string; active: boolean }; profile: Profile; ledger: { version: number; timeZone: string; sessions: ClockSession[]; days: Day[]; shortDayWarnings?: ShortDayWarning[]; history: { type: string; at?: string; reason?: string; actorId?: string; before?: unknown; after?: unknown }[] };
 documents: { id: string; title: string; category: string; version: number; revisions: { revision: number; documentDate: string; filename: string; byteLength: number; at: string }[] }[]; missingDocuments: string[];
 snapshots: { id: string; start: string; end: string; at: string; grossCents: number; currency: string }[] };
export const hours = (millis: number) => (millis / 3600000).toFixed(3);
export const duration = (millis: number) => {
  if (!Number.isFinite(millis) || millis < 0) return 'Not available';
  if (millis > 0 && millis < 1000) return 'Less than 1 sec';
  const totalSeconds = Math.floor(millis / 1000);
  const values = [Math.floor(totalSeconds / 3600), Math.floor(totalSeconds % 3600 / 60), totalSeconds % 60];
  return values.map((value, index) => value ? `${value} ${['hr', 'min', 'sec'][index]}` : '').filter(Boolean).join(' ') || '0 min';
};
export const approvedPaidMillis = (approval: Approval) => approval.mode === 'manual-reviewed' ? approval.paidMillis ?? approval.regularMillis : approval.regularMillis + approval.overtimeMillis + approval.doubleMillis;
export const money = (cents: number | null, currency = 'USD') => cents === null ? 'Unresolved' : new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
export const localTime = (instant: string | null, zone: string) => instant ? new Date(instant).toLocaleString('en-US', { timeZone: zone }) : 'Open';
export const datedClock = (instant: string, zone: string) => new Date(instant).toLocaleString('en-US', { timeZone: zone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
export const rateDecision = (fields: FormData, approval: Approval | null) => (approval?.premiumCents ?? 0) > 0 && !fields.has('replaceLegacyPremium')
  ? { premiumCents: approval!.premiumCents }
  : { rateMillis: Number(fields.get('rateMillis') || 0), multiplierHundredths: Number(fields.get('multiplierHundredths') || 100), ...(fields.has('replaceLegacyPremium') ? { replaceLegacyPremium: true } : {}) };

export const payrollRequestId = () => globalThis.crypto.randomUUID();

import { useEffect, useRef, useState } from 'react';
import { duration, money } from './types';
import type { Approval, Rate } from './types';

function calculation(paidMillis: number, rateMillis: number, multiplier: number, rate?: Rate) {
  const regular = paidMillis - rateMillis, factor = multiplier / 100;
  if (!rateMillis) return `All ${duration(paidMillis)} at ${rate ? money(rate.cents, rate.currency) + ' per hour ' : ''}(1×).`;
  const parts = [`${duration(rateMillis)} at ${rate ? money(rate.cents * factor, rate.currency) + ' per hour ' : ''}(${factor}×)`];
  if (regular) parts.push(`${duration(regular)} at ${rate ? money(rate.cents, rate.currency) + ' per hour ' : ''}(1×)`);
  if (!rate) return parts.join(' + ') + '.';
  const numerator = BigInt(regular) * BigInt(rate.cents) * 100n + BigInt(rateMillis) * BigInt(rate.cents) * BigInt(multiplier);
  const cents = Number((numerator + 180000000n) / 360000000n);
  return parts.join(' + ') + ' = ' + money(cents, rate.currency) + ' before any saved adjustment.';
}

export function PayRateSummary({ approval, rate }: { approval: Approval; rate?: Rate | null }) {
  const paid = approval.paidMillis ?? approval.regularMillis;
  return <div className="payroll-rate-summary">
    {approval.rateMillis !== undefined ? <p>{calculation(paid, approval.rateMillis, approval.multiplierHundredths ?? 100, rate || undefined)}</p> : !!approval.premiumCents && <p>Previous fixed extra pay: {money(approval.premiumCents, rate?.currency || 'USD')}. Kept from the earlier reviewed decision.</p>}
    {!!approval.adjustmentCents && <p>Saved pay adjustment: {money(approval.adjustmentCents, rate?.currency || 'USD')}. Retained unchanged.</p>}
  </div>;
}

export default function RateAllocationFields({ date, paidMillis, approval, rate, overtime = false, returning = false, reviewAlways = false, reasonField = true }: { date: string; paidMillis: number; approval: Approval | null; rate?: Rate; overtime?: boolean; returning?: boolean; reviewAlways?: boolean; reasonField?: boolean }) {
  const previousMillis = approval?.rateMillis ?? 0;
  const [hours, setHours] = useState(String(Math.floor(previousMillis / 3600000)));
  const [minutes, setMinutes] = useState(String(Math.floor(previousMillis % 3600000 / 60000)));
  const [edited, setEdited] = useState(false);
  const [multiplier, setMultiplier] = useState(String((approval?.multiplierHundredths ?? 100) / 100));
  const [replace, setReplace] = useState(false);
  const minutesInput = useRef<HTMLInputElement | null>(null);
  const legacy = (approval?.premiumCents ?? 0) > 0, keepingLegacy = legacy && !replace;
  const millis = edited ? (Number(hours) * 60 + Number(minutes)) * 60000 : previousMillis;
  const hundredths = Math.round(Number(multiplier) * 100);
  const whole = /^\d+$/.test(hours) && /^\d+$/.test(minutes) && Number(minutes) < 60;
  const valid = whole && Number.isSafeInteger(millis) && millis >= 0 && millis <= paidMillis && /^\d+(?:\.\d{1,2})?$/.test(multiplier) && hundredths >= 100 && hundredths <= 1000;
  const needsReview = reviewAlways || overtime || !keepingLegacy && (millis > 0 || replace);
  useEffect(() => { minutesInput.current?.setCustomValidity(!returning && !keepingLegacy && !valid ? 'Choose rate hours within the approved paid time and a multiplier from 1 to 10.' : ''); }, [valid, keepingLegacy, returning]);
  return <div className="payroll-manual-review">
    <h5>Pay rate</h5><p>Choose the hours and rate yourself. All remaining approved hours use the regular rate (1×).</p>
    {legacy && <><p>Previous fixed extra pay: {money(approval!.premiumCents!, rate?.currency || 'USD')}. This earlier amount is kept unless you choose to replace it.</p><label className="payroll-check"><input type="checkbox" name="replaceLegacyPremium" checked={replace} onChange={event => setReplace(event.target.checked)} disabled={returning} />Replace previous fixed extra pay with a rate decision for {date}</label></>}
    {!keepingLegacy && <fieldset disabled={returning}>
      <div className="payroll-grid"><label>Hours at selected rate<input aria-label={'Hours at selected rate for ' + date} type="number" min="0" max="48" step="1" inputMode="numeric" value={hours} onChange={event => { setHours(event.target.value); setEdited(true); }} required={!returning} aria-invalid={!valid} /></label><label>Minutes at selected rate<input ref={minutesInput} aria-label={'Minutes at selected rate for ' + date} type="number" min="0" max="59" step="1" inputMode="numeric" value={minutes} onChange={event => { setMinutes(event.target.value); setEdited(true); }} required={!returning} aria-invalid={!valid} /></label><label>Pay multiplier<input aria-label={'Pay multiplier for ' + date} type="number" min="1" max="10" step="0.01" list={'pay-multipliers-' + date} value={multiplier} onChange={event => setMultiplier(event.target.value)} required={!returning} aria-invalid={!valid} /><datalist id={'pay-multipliers-' + date}><option value="1">Regular rate</option><option value="1.5">Time and a half</option><option value="2">Double rate</option></datalist></label></div>
      <input type="hidden" name="rateMillis" value={valid ? millis : ''} /><input type="hidden" name="multiplierHundredths" value={valid ? hundredths : ''} />
      {!edited && previousMillis % 60000 !== 0 && <p>Saved rate time: {duration(previousMillis)}. Seconds are kept until you edit these hours or minutes.</p>}
      {!valid ? <p role="alert">Choose rate hours within the approved paid time and a multiplier from 1 to 10.</p> : <p className="payroll-rate-preview" aria-label={'Rate calculation for ' + date}>{calculation(paidMillis, millis, hundredths, rate)}</p>}
    </fieldset>}
    {!!approval?.adjustmentCents && <p>Saved pay adjustment: {money(approval.adjustmentCents, rate?.currency || 'USD')}. Retained unchanged.</p>}
    {needsReview && <div key={millis + ':' + hundredths + ':' + paidMillis + ':' + replace}>{reasonField && <label>Pay review reason for {date}<input name="payRateReason" maxLength={450} required={!returning} disabled={returning} /></label>}<label className="payroll-check"><input name="payRateReviewed" type="checkbox" required={!returning} disabled={returning} />I reviewed the hours and pay rate for {date}.</label></div>}
  </div>;
}

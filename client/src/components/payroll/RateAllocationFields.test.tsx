import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import RateAllocationFields, { PayRateSummary } from './RateAllocationFields';
import { rateDecision } from './types';
import type { Approval } from './types';

const date = '2026-10-22', hour = 3600000;
const rate = { id: 'rate', cents: 2000, currency: 'USD', effectiveOn: '2026-01-01', reason: 'Approved', sequence: 1 };
const approval: Approval = { status: 'approved', mode: 'manual-reviewed', paidMillis: 9 * hour, regularMillis: 9 * hour, overtimeMillis: 0, doubleMillis: 0, adjustmentCents: 0, reason: 'Reviewed', rulesReviewed: true };
function form({ previous = null, paidMillis = 9 * hour, overtime = false }: { previous?: Approval | null; paidMillis?: number; overtime?: boolean } = {}) {
  const saved = vi.fn();
  const shown = render(<form onSubmit={event => { event.preventDefault(); if (event.currentTarget.reportValidity()) saved(rateDecision(new FormData(event.currentTarget), previous)); }}><RateAllocationFields date={date} paidMillis={paidMillis} approval={previous} rate={rate} overtime={overtime} /><button>Save</button></form>);
  return { ...shown, saved };
}
const field = (name: string) => screen.getByLabelText(name + ' for ' + date);
const choose = (hours: string, multiplier = '1.5', minutes = '0') => {
  fireEvent.change(field('Hours at selected rate'), { target: { value: hours } });
  fireEvent.change(field('Minutes at selected rate'), { target: { value: minutes } });
  fireEvent.change(field('Pay multiplier'), { target: { value: multiplier } });
};
function review() {
  fireEvent.change(field('Pay review reason'), { target: { value: 'Administrator selected this rate for verified work' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'I reviewed the hours and pay rate for ' + date + '.' }));
}

test('ordinary approved hours start entirely at the regular rate without allocating overtime', () => {
  const { saved } = form();
  expect(field('Hours at selected rate')).toHaveValue(0);
  expect(field('Pay multiplier')).toHaveValue(1);
  expect(screen.getByLabelText('Rate calculation for ' + date)).toHaveTextContent('All 9 hr at $20.00 per hour (1×).');
  expect(screen.queryByLabelText(/Additional pay|Premium \/ adjustment/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(saved).toHaveBeenCalledWith({ rateMillis: 0, multiplierHundredths: 100 });
});

test('a selected portion earns the chosen rate and the remaining approved time stays at 1x', () => {
  const { saved } = form(); choose('2');
  expect(screen.getByLabelText('Rate calculation for ' + date)).toHaveTextContent('2 hr at $30.00 per hour (1.5×) + 7 hr at $20.00 per hour (1×) = $200.00');
  fireEvent.click(screen.getByRole('button', { name: 'Save' })); expect(saved).not.toHaveBeenCalled();
  review(); fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(saved).toHaveBeenCalledWith({ rateMillis: 2 * hour, multiplierHundredths: 150 });
});

test('an overtime day still needs a reason and explicit review when the administrator chooses only 1x', () => {
  const { saved } = form({ overtime: true });
  fireEvent.click(screen.getByRole('button', { name: 'Save' })); expect(saved).not.toHaveBeenCalled();
  review(); fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(saved).toHaveBeenCalledWith({ rateMillis: 0, multiplierHundredths: 100 });
});

test.each([{ hours: '10', minutes: '0', multiplier: '1.5' }, { hours: '1', minutes: '60', multiplier: '1.5' }, { hours: '1', minutes: '0', multiplier: '0.5' }, { hours: '1', minutes: '0', multiplier: '10.01' }])('invalid allocation cannot be saved: $hours hr $minutes min at $multiplier', values => {
  const { saved } = form(); choose(values.hours, values.multiplier, values.minutes);
  expect(screen.getByRole('alert')).toHaveTextContent('Choose rate hours within the approved paid time and a multiplier from 1 to 10.');
  fireEvent.click(screen.getByRole('button', { name: 'Save' })); expect(saved).not.toHaveBeenCalled();
});

test('changing a reviewed multiplier clears the previous reason and review acknowledgement', () => {
  form(); choose('2'); review();
  fireEvent.change(field('Pay multiplier'), { target: { value: '2' } });
  expect(field('Pay review reason')).toHaveValue('');
  expect(screen.getByRole('checkbox', { name: 'I reviewed the hours and pay rate for ' + date + '.' })).not.toBeChecked();
});

test('a saved rate decision preloads exactly and preserves subminute time until the time is edited', () => {
  const { saved } = form({ previous: { ...approval, rateMillis: hour + 42000, multiplierHundredths: 175 } });
  expect(field('Hours at selected rate')).toHaveValue(1); expect(field('Pay multiplier')).toHaveValue(1.75);
  expect(screen.getByText('Saved rate time: 1 hr 42 sec. Seconds are kept until you edit these hours or minutes.')).toBeVisible();
  review(); fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(saved).toHaveBeenCalledWith({ rateMillis: hour + 42000, multiplierHundredths: 175 });
});

test('legacy fixed extra pay stays intact until the administrator explicitly replaces it', () => {
  const { saved } = form({ previous: { ...approval, premiumCents: 2500, adjustmentCents: 125 } });
  expect(screen.getByText(/Previous fixed extra pay: \$25.00/)).toBeVisible();
  expect(screen.getByText(/Saved pay adjustment: \$1.25/)).toBeVisible();
  expect(screen.queryByLabelText('Hours at selected rate for ' + date)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(saved).toHaveBeenLastCalledWith({ premiumCents: 2500 });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Replace previous fixed extra pay with a rate decision for ' + date }));
  choose('2'); review(); fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(saved).toHaveBeenLastCalledWith({ rateMillis: 2 * hour, multiplierHundredths: 150, replaceLegacyPremium: true });
});

test('saved result summaries explain the selected rate and keep genuine prior adjustments visible', () => {
  render(<PayRateSummary approval={{ ...approval, rateMillis: 2 * hour, multiplierHundredths: 150, adjustmentCents: 125 }} rate={rate} />);
  expect(screen.getByText(/2 hr at \$30.00 per hour \(1.5×\) \+ 7 hr at \$20.00 per hour \(1×\) = \$200.00/)).toBeVisible();
  expect(screen.getByText('Saved pay adjustment: $1.25. Retained unchanged.')).toBeVisible();
});

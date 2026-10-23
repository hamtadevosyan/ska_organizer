import { render, screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import ClockSessions from './ClockSessions';
import type { RecordedSession } from './types';

const zone = 'America/Los_Angeles', date = '2026-10-22';
test('independent sessions are chronological and every punch includes its actual calendar date', () => {
  const sessions: RecordedSession[] = [
    { id: 'late', start: '2026-10-22T16:06:00Z', end: '2026-10-23T15:30:00Z', dayStart: '2026-10-22T16:06:00Z', dayEnd: '2026-10-23T07:00:00Z' },
    { id: 'early', start: '2026-10-22T14:00:00Z', end: '2026-10-22T15:00:00Z', dayStart: '2026-10-22T14:00:00Z', dayEnd: '2026-10-22T15:00:00Z' },
  ];
  render(<ClockSessions sessions={sessions} date={date} timeZone={zone} />);
  const rows = within(screen.getByRole('list', { name: 'Recorded sessions for ' + date })).getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent('Oct 22, 2026, 7:00:00 AM');
  expect(rows[1]).toHaveTextContent('Oct 22, 2026, 9:06:00 AM');
  expect(rows[1]).toHaveTextContent('Oct 23, 2026, 8:30:00 AM');
  expect(rows[1]).toHaveTextContent('Time counted on 2026-10-22');
  expect(rows[1]).toHaveTextContent('These boundaries are part of this session, not new clock punches.');
  expect(sessions[0].id).toBe('late');
});

test('the same ISO instant in different formats does not invent a daily clipping warning', () => {
  render(<ClockSessions date={date} timeZone={zone} sessions={[{ id: 'same', start: '2026-10-22T08:00:00-07:00', end: '2026-10-22T16:00:00-07:00', dayStart: '2026-10-22T15:00:00.000Z', dayEnd: '2026-10-22T23:00:00.000Z' }]} />);
  expect(screen.queryByText(/Time counted on/)).not.toBeInTheDocument();
});

test('an open session keeps its missing checkout even when an earlier day has a completed portion', () => {
  render(<ClockSessions date={date} timeZone={zone} sessions={[{ id: 'open', start: '2026-10-22T23:00:00Z', end: null, dayStart: '2026-10-22T23:00:00Z', dayEnd: '2026-10-23T07:00:00Z', dayMillis: 8 * 3600000 }]} />);
  expect(screen.getByText('Checkout missing')).toBeVisible();
  expect(screen.getByText(/Time counted on/)).toHaveTextContent('8 hr');
  expect(screen.getByText(/Time counted on/)).toHaveTextContent('not new clock punches');
});

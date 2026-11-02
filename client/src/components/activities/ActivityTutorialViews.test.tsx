import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { Activity, Entry } from '../../api/activities';
import { ActivityDay } from './ActivityDay';
import { ActivityPrint } from './ActivityPrint';

const tutorial = { title: 'Saved paper city example', publisher: 'Synthetic teaching source', url: 'https://example.com/videos/saved-paper-city' };
const saved: Activity = { id: 'paper-city', name: 'Build a paper city', description: 'Prepare paper.\n\n1. Fold.\n2. Build.', durationMinutes: 20,
  ageMinMonths: null, ageMaxMonths: null, roomId: null, materials: [], tutorialLinks: [tutorial], version: 1 };
const entry: Entry = { id: 'saved-entry', date: '2026-10-12', startTime: '09:00', endTime: '09:20', timeBlock: null, activityId: saved.id, activity: saved };

test('a saved day shows its saved video and instructions rather than a newer library version', () => {
  render(<ActivityDay date={entry.date} entries={[entry]} catalog={[{ ...saved, version: 2, tutorialLinks: [] }]} disabledReason="" editable={false}
    editEntry={vi.fn()} moveEntry={vi.fn()} removeEntry={vi.fn()} chooseActivity={vi.fn()} />);
  fireEvent.click(screen.getByText('Instructions & materials'));
  expect(screen.getByRole('link', { name: 'Saved paper city example (opens in a new tab)' })).toHaveAttribute('href', tutorial.url);
  expect(screen.getByText(/Prepare paper/)).toHaveTextContent('1. Fold. 2. Build.');
  expect(screen.queryByRole('button', { name: /remove video/i })).not.toBeInTheDocument();
});

test('the printed weekly plan includes the video title and complete URL from its saved activity', () => {
  const { container } = render(<ActivityPrint roomName="Sunflower" weekStart={entry.date} dates={[entry.date]} entries={[entry]} draft={false} />);
  const printed = container.querySelector('.activity-print')! as HTMLElement;
  expect(within(printed).getByText(tutorial.title)).toBeInTheDocument();
  expect(within(printed).getByText(tutorial.url)).toHaveClass('print:block');
  expect(within(printed).getByText(/Prepare paper/)).toHaveClass('whitespace-pre-wrap');
});

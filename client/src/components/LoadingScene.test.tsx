import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { LoadingScene } from './LoadingScene';

afterEach(() => { vi.unstubAllGlobals(); });

test('announces the real task and detail once while its decorative artwork stays hidden', () => {
  const { container } = render(<LoadingScene label="Creating activity ideas…" detail="You can stop this request at any time." />);
  const status = screen.getByRole('status');
  expect(status).toHaveAttribute('aria-live', 'polite');
  expect(status).toHaveAttribute('aria-atomic', 'true');
  expect(status).toHaveTextContent('Creating activity ideas…');
  expect(status).toHaveTextContent('You can stop this request at any time.');
  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(container.querySelector('svg.ska-loading-scene__art')).toHaveAttribute('aria-hidden', 'true');
  expect(within(status).queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
});

test('pausing and resuming decorative motion preserves the ongoing task and progress', () => {
  const { container } = render(<LoadingScene label="Creating step pictures…" progress={{ completed: 2, total: 6 }} />);
  const bar = screen.getByRole('progressbar', { name: 'Task progress' });
  expect(bar).toHaveAttribute('value', '2'); expect(bar).toHaveAttribute('max', '6');
  fireEvent.click(screen.getByRole('button', { name: 'Pause animation' }));
  expect(screen.getByRole('button', { name: 'Resume animation' })).toBeEnabled();
  expect(container.firstElementChild).toHaveClass('is-paused');
  expect(screen.getByRole('status')).toHaveTextContent('Creating step pictures…');
  expect(bar).toHaveAttribute('value', '2');
  fireEvent.click(screen.getByRole('button', { name: 'Resume animation' }));
  expect(screen.getByRole('button', { name: 'Pause animation' })).toBeEnabled();
  expect(container.firstElementChild).not.toHaveClass('is-paused');
});

test('progress reflects only supplied counts and remains bounded when those counts change', () => {
  const { rerender } = render(<LoadingScene label="Drawing pictures…" progress={{ completed: -1, total: 4 }} />);
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '0');
  expect(screen.getByText('0 of 4 complete')).toBeInTheDocument();
  rerender(<LoadingScene label="Drawing pictures…" progress={{ completed: 9, total: 4 }} />);
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '4');
  expect(screen.getByText('4 of 4 complete')).toBeInTheDocument();
  for (const progress of [{ completed: NaN, total: 4 }, { completed: 1, total: 0 }, { completed: 1.5, total: 4 }, { completed: 1, total: Infinity }]) {
    rerender(<LoadingScene label="Drawing pictures…" progress={progress} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  }
});

test('compact connection checks retain readable status without animation controls', () => {
  const { container } = render(<LoadingScene label="Checking the picture connection…" compact />);
  expect(screen.getByRole('status')).toHaveTextContent('Checking the picture connection…');
  expect(container.firstElementChild).toHaveClass('is-compact');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});


test('reduced motion stays still by default and permits an explicit animation opt-in', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const { container } = render(<LoadingScene label="Creating pictures…" progress={{ completed: 1, total: 4 }} />);
  expect(container.firstElementChild).toHaveClass('is-paused');
  expect(screen.getByText('Reduced motion is on. You can play this animation if you choose.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Play animation' }));
  expect(container.firstElementChild).toHaveClass('is-motion-enabled');
  expect(screen.getByRole('button', { name: 'Pause animation' })).toBeVisible();
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '1');
  expect(screen.getByRole('status')).toHaveTextContent('Creating pictures…');
  fireEvent.click(screen.getByRole('button', { name: 'Pause animation' }));
  expect(container.firstElementChild).toHaveClass('is-paused');
  fireEvent.click(screen.getByRole('button', { name: 'Resume animation' }));
  expect(container.firstElementChild).toHaveClass('is-motion-enabled');
});

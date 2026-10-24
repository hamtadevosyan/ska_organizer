import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import { createMemoryRouter, Link, RouterProvider, useLocation } from 'react-router-dom';
import AuthGate from '../auth/AuthGate';
import UnsavedChangesProvider from '../components/UnsavedChangesProvider';
import { SignedIn } from '../tests/authFixture';
import { testAccount } from '../tests/authAccount';
import type { ActivityPlan } from '../api/activities';
import type { Room } from '../api/rooms';
import Activities from './Activities';

const { transferableAbortController } = await vi.importActual<{ transferableAbortController: () => AbortController }>('node:util');
vi.mock('axios');
const room: Room = { id: 'ai-planning-room', name: 'Sunflower', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12,
  active: true, needsConfiguration: false, assignedChildCount: 0, availablePlaces: 12, overCapacity: false };
const response = (data: unknown) => ({ data: { data } });

// Route changes unmount the real planner, just as the signed-in application does.
function PlannerRoute() {
  return useLocation().pathname === '/activities' ? <Activities /> : <h1>Destination</h1>;
}
function app(role: 'admin' | 'viewer' = 'admin') {
  const router = createMemoryRouter([{ path: '*', element:
    <SignedIn account={{ ...testAccount, role }}><AuthGate><UnsavedChangesProvider>
      <Link to="/home">Home</Link><PlannerRoute />
    </UnsavedChangesProvider></AuthGate></SignedIn>,
  }], { initialEntries: ['/activities'] });
  render(<RouterProvider router={router} />);
}
async function chooseRoom() {
  await screen.findByRole('option', { name: /^Sunflower/ });
  fireEvent.change(screen.getByRole('combobox', { name: 'Room' }), { target: { value: room.id } });
  await screen.findByRole('region', { name: 'Monday' });
  await waitFor(() => expect(screen.queryByText('Loading activities…')).not.toBeInTheDocument());
}

beforeEach(() => {
  vi.resetAllMocks();
  // Router navigation uses Node fetch, whose AbortSignal is in a different realm.
  vi.stubGlobal('AbortController', class { constructor() { return transferableAbortController(); } });
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.setAttribute('open', ''); } },
    close: { configurable: true, value() { this.removeAttribute('open'); } },
  });
  vi.mocked(axios.get).mockImplementation(async (url, config) => {
    if (url.endsWith('/rooms')) return response([room]);
    if (url.endsWith('/activity')) return response([]);
    if (url.endsWith('/activity-ai/status')) return response({ enabled: true, available: true, model: 'local-model', sourceCount: 1, message: 'Ready' });
    if (url.endsWith('/plan')) {
      const { roomId, weekStart } = config!.params as Pick<ActivityPlan, 'roomId' | 'weekStart'>;
      return response({ roomId, weekStart, version: 0, savedAt: null, entries: [], materials: [] });
    }
    throw new Error('Unexpected fixture GET: ' + url);
  });
  vi.mocked(axios.post).mockImplementation(async url => {
    if (url.endsWith('/preview')) return response({ materials: [] });
    throw new Error('Unexpected fixture write: ' + url);
  });
});
afterEach(() => vi.unstubAllGlobals());

test('viewers cannot open AI ideas or week generation', async () => {
  app('viewer'); await chooseRoom();
  expect(screen.queryByRole('button', { name: 'AI activity ideas' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Generate week' })).not.toBeInTheDocument();
  expect(vi.mocked(axios.get).mock.calls.some(([url]) => url.endsWith('/activity-ai/status'))).toBe(false);
});

test('an empty library still offers AI ideas and guards unsaved settings without changing the week', async () => {
  app(); await chooseRoom();
  fireEvent.click(screen.getByRole('button', { name: 'AI activity ideas' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create AI ideas' })).toBeEnabled());
  expect(screen.getByRole('combobox', { name: 'Room' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Theme (optional)'), { target: { value: 'Autumn colors' } });
  fireEvent.click(screen.getByRole('link', { name: 'Home' }));
  await screen.findByRole('dialog', { name: 'Leave your unsaved work?' });
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(screen.getByLabelText('Theme (optional)')).toHaveValue('Autumn colors');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard AI ideas' }));
  expect(screen.queryByRole('dialog', { name: 'AI activity ideas' })).not.toBeInTheDocument();
  expect(screen.getByText('Nothing scheduled for this day.')).toBeVisible();
  fireEvent.click(screen.getByRole('link', { name: 'Home' }));
  await screen.findByRole('heading', { name: 'Destination' });
  expect(vi.mocked(axios.post).mock.calls.some(([url]) => url.endsWith('/plan') || url.endsWith('/activity') || url.endsWith('/draft'))).toBe(false);
});

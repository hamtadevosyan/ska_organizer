import axios from 'axios';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Activity, ActivityDetails, Entry, Illustration } from '../../api/activities';
import type { ActivityAiResult } from '../../api/activityAi';
import { ActivityAiIdeas } from './ActivityAiIdeas';
import { ActivityIllustrations } from './ActivityIllustrations';
import { ActivityPrint } from './ActivityPrint';
import { useActivityPicturePrint } from './useActivityPicturePrint';
import { SignedIn } from '../../tests/authFixture';
import { testAccount } from '../../tests/authAccount';

vi.mock('axios');
const room = { id: 'room-images', name: 'Preschool', ageMinMonths: 36, ageMaxMonths: 60, capacity: 12,
  active: true, needsConfiguration: false, assignedChildCount: 0, availablePlaces: 12, overCapacity: false };
const images: Illustration[] = [
  { id: 'image-one', step: 1, caption: 'Set the large blocks on the table.', width: 1024, height: 1024 },
  { id: 'image-two', step: 2, caption: 'Sort the blocks into matching pairs.', width: 1024, height: 1024 },
];
const result: ActivityAiResult = { model: 'local-model', generatedAt: '2026-11-04T00:00:00Z', sources: [], warnings: [], drafts: [{
  name: 'Block matching', description: 'Prepare six large blocks.\n\n1. Set them on the table.\n2. Sort by color.',
  durationMinutes: 20, ageMinMonths: 36, ageMaxMonths: 60, roomId: room.id, materials: [], sourceIds: [],
  visualSteps: images.map(image => image.caption),
}] };
const reviewedDetails: ActivityDetails = { ...result.drafts[0],
  description: result.drafts[0].description + '\n\nAI-assisted educational draft. Review safety and suitability before use.' };
const response = <T,>(data: T) => ({ data: { data } });
const callbacks = () => ({ room, onSaved: vi.fn(), onCancel: vi.fn(), onDirtyChange: vi.fn(), onBusyChange: vi.fn() });
const imagePostCalls = () => vi.mocked(axios.post).mock.calls.filter(([url]) => url.endsWith('/images/jobs'));
const activityPostCalls = () => vi.mocked(axios.post).mock.calls.filter(([url]) => url.endsWith('/activity'));
const complete = { id: 'job-images', status: 'complete', completed: 2, total: 2, images };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function createIdeas() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create AI ideas' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Create AI ideas' }));
  return screen.findByRole('article', { name: 'AI idea 1' });
}
beforeEach(() => {
  vi.resetAllMocks();
  let sequence = 0;
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: vi.fn(() => 'blob:protected-picture-' + ++sequence) },
    revokeObjectURL: { configurable: true, value: vi.fn() },
  });
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.setAttribute('open', ''); } },
    close: { configurable: true, value() { this.removeAttribute('open'); } },
  });
  vi.mocked(axios.get).mockImplementation(async url => {
    if (url.endsWith('/images/status')) return response({ enabled: true, available: true, busy: false, model: 'sd_xl_base_1.0.safetensors', message: 'Ready' });
    if (url.endsWith('/activity-ai/status')) return response({ enabled: true, available: true, model: 'local-model', sourceCount: 0, message: 'Ready' });
    if (url.includes('/images/jobs/')) return response(complete);
    if (url.includes('/images/') || url.includes('/activity-images/')) return { data: new Blob(['synthetic-png'], { type: 'image/png' }) };
    return { data: { items: [], total: 0 } };
  });
  vi.mocked(axios.post).mockImplementation(async (url, payload) => {
    if (url.endsWith('/draft')) return response(result);
    if (url.endsWith('/images/jobs')) return response(complete);
    return response({ ...(payload as ActivityDetails), id: 'saved-images', version: 1 });
  });
  vi.mocked(axios.delete).mockResolvedValue(response({ ...complete, status: 'cancelled', images: [] }));
});
afterEach(() => { vi.unstubAllGlobals(); });

test('pictures are explicitly requested for real steps, reviewed and saved only as owned IDs', async () => {
  const props = callbacks(); render(<ActivityAiIdeas {...props} />);
  const card = await createIdeas();
  expect(imagePostCalls()).toHaveLength(0);
  fireEvent.click(within(card).getByRole('button', { name: 'Create step pictures' }));
  await within(card).findByRole('img', { name: 'Step 1: ' + images[0].caption });
  const details = reviewedDetails;
  expect(imagePostCalls()[0][1]).toEqual({ name: details.name, description: details.description, steps: result.drafts[0].visualSteps });
  expect(within(card).getByText(/An adult must check/)).toBeVisible();
  fireEvent.click(within(card).getByRole('button', { name: 'Review idea 1' }));
  const form = screen.getByRole('form', { name: 'New activity' });
  await within(form).findByRole('img', { name: 'Step 2: ' + images[1].caption });
  fireEvent.click(within(form).getByRole('button', { name: 'Save activity' }));
  await waitFor(() => expect(activityPostCalls()).toHaveLength(1));
  expect(activityPostCalls()[0][1]).toMatchObject({ name: details.name, description: details.description, illustrations: [{ id: 'image-one' }, { id: 'image-two' }] });
  expect(props.onSaved).toHaveBeenCalledOnce();
});

test.each(['Activity name', 'Description'])('editing %s clears pictures before saving and explains why', async field => {
  render(<ActivityAiIdeas {...callbacks()} />); const card = await createIdeas();
  fireEvent.click(within(card).getByRole('button', { name: 'Create step pictures' }));
  await within(card).findByRole('img', { name: 'Step 1: ' + images[0].caption });
  fireEvent.click(within(card).getByRole('button', { name: 'Review idea 1' }));
  const form = screen.getByRole('form', { name: 'New activity' });
  fireEvent.change(within(form).getByLabelText(field), { target: { value: 'Teacher edited these instructions.' } });
  expect(within(form).getByText(/Step pictures were removed because/)).toBeVisible();
  expect(within(form).queryByRole('region', { name: 'Activity step pictures' })).not.toBeInTheDocument();
  fireEvent.click(within(form).getByRole('button', { name: 'Save activity' }));
  await waitFor(() => expect(activityPostCalls()).toHaveLength(1));
  expect(activityPostCalls()[0][1]).toMatchObject({ illustrations: [] });
});

test('one job polls progress and completes while another idea cannot start or save pictures', async () => {
  vi.mocked(axios.post).mockImplementation(async (url, payload) => {
    if (url.endsWith('/draft')) return response({ ...result, drafts: [...result.drafts, { ...result.drafts[0], name: 'Block towers' }] });
    if (url.endsWith('/images/jobs')) return response({ ...complete, status: 'running', completed: 1, images: [] });
    return response({ ...(payload as ActivityDetails), id: 'saved', version: 1 });
  });
  render(<ActivityAiIdeas {...callbacks()} />); const card = await createIdeas();
  fireEvent.click(within(card).getByRole('button', { name: 'Create step pictures' }));
  await screen.findByText('Creating step pictures: 1 of 2 complete.');
  expect(document.querySelector('.app-modal-pending')).toHaveFocus();
  expect(screen.queryByRole('article', { name: 'AI idea 1' })).not.toBeInTheDocument();
  const other = screen.getByRole('article', { name: 'AI idea 2', hidden: true });
  expect(other).not.toBeVisible();
  expect(within(other).getByRole('button', { name: 'Create step pictures', hidden: true })).toBeDisabled();
  expect(within(card).getByRole('button', { name: 'Review idea 1', hidden: true })).toBeDisabled();
  await within(card).findByRole('img', { name: 'Step 2: ' + images[1].caption }, { timeout: 3000 });
  expect(vi.mocked(axios.get).mock.calls.some(([url]) => url.endsWith('/images/jobs/job-images'))).toBe(true);
  expect(within(other).getByRole('button', { name: 'Create step pictures' })).toBeEnabled();
});

test('cancelling a running job aborts polling, cancels the owned job and permits retry', async () => {
  vi.mocked(axios.post).mockImplementation(async url => url.endsWith('/draft') ? response(result) : response({ ...complete, status: 'running', completed: 0, images: [] }));
  render(<ActivityAiIdeas {...callbacks()} />); const card = await createIdeas();
  fireEvent.click(within(card).getByRole('button', { name: 'Create step pictures' }));
  await screen.findByText('Creating step pictures: 0 of 2 complete.');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel picture generation' }));
  expect(imagePostCalls()[0][2]?.signal?.aborted).toBe(true);
  await waitFor(() => expect(axios.delete).toHaveBeenCalledWith(expect.stringMatching(/\/images\/jobs\/job-images$/)));
  expect(within(card).getByText('Picture generation cancelled. Your activity is unchanged.')).toBeVisible();
  expect(within(card).getByRole('button', { name: 'Create step pictures' })).toBeEnabled();
  expect(activityPostCalls()).toHaveLength(0);
});

test('a failed image job can be retried without losing the activity guide', async () => {
  let count = 0;
  vi.mocked(axios.post).mockImplementation(async url => url.endsWith('/draft') ? response(result) : response(++count === 1
    ? { ...complete, status: 'failed', completed: 0, images: [], message: 'The image machine is unavailable.' } : complete));
  render(<ActivityAiIdeas {...callbacks()} />); const card = await createIdeas();
  fireEvent.click(within(card).getByRole('button', { name: 'Create step pictures' }));
  expect(await within(card).findByRole('alert')).toHaveTextContent('The image machine is unavailable.');
  expect(within(card).getByText(/Prepare six large blocks\./)).toBeVisible();
  fireEvent.click(within(card).getByRole('button', { name: 'Retry step pictures' }));
  await within(card).findByRole('img', { name: 'Step 1: ' + images[0].caption });
  expect(imagePostCalls()).toHaveLength(2);
});

test('unmount aborts pending job creation and cancels a late owned job response', async () => {
  const pending = deferred<ReturnType<typeof response>>();
  vi.mocked(axios.post).mockImplementation(async url => url.endsWith('/draft') ? response(result) : pending.promise);
  const view = render(<ActivityAiIdeas {...callbacks()} />); const card = await createIdeas();
  fireEvent.click(within(card).getByRole('button', { name: 'Create step pictures' }));
  view.unmount(); expect(imagePostCalls()[0][2]?.signal?.aborted).toBe(true);
  await act(async () => pending.resolve(response({ ...complete, status: 'running', images: [] })));
  expect(axios.delete).toHaveBeenCalledWith(expect.stringMatching(/\/images\/jobs\/job-images$/));
});

test('a polling failure cancels the known server job before allowing retry', async () => {
  vi.mocked(axios.post).mockImplementation(async url => url.endsWith('/draft') ? response(result) : response({ ...complete, status: 'running', completed: 0, images: [] }));
  vi.mocked(axios.get).mockImplementation(async url => {
    if (url.includes('/images/jobs/')) throw new Error('Synthetic polling connection lost.');
    return response({ enabled: true, available: true, busy: false, model: 'local-model', sourceCount: 0, message: 'Ready' });
  });
  render(<ActivityAiIdeas {...callbacks()} />); const card = await createIdeas();
  fireEvent.click(within(card).getByRole('button', { name: 'Create step pictures' }));
  await within(card).findByRole('alert', {}, { timeout: 3000 });
  expect(axios.delete).toHaveBeenCalledWith(expect.stringMatching(/\/images\/jobs\/job-images$/));
  expect(within(card).getByRole('button', { name: 'Retry step pictures' })).toBeEnabled();
});

test('a failed replacement keeps the existing reviewed pictures available for saving', async () => {
  let generation = 0;
  vi.mocked(axios.post).mockImplementation(async (url, payload) => {
    if (url.endsWith('/draft')) return response(result);
    if (url.endsWith('/images/jobs')) return response(++generation === 1 ? complete : { ...complete, id: 'replacement-job', status: 'failed', images: [], message: 'Replacement failed.' });
    return response({ ...(payload as ActivityDetails), id: 'saved-images', version: 1 });
  });
  render(<ActivityAiIdeas {...callbacks()} />); const card = await createIdeas();
  fireEvent.click(within(card).getByRole('button', { name: 'Create step pictures' }));
  await within(card).findByRole('img', { name: 'Step 1: ' + images[0].caption });
  fireEvent.click(within(card).getByRole('button', { name: 'Create new step pictures' }));
  await within(card).findByText('Replacement failed.');
  expect(within(card).getAllByRole('img')).toHaveLength(2);
  fireEvent.click(within(card).getByRole('button', { name: 'Review idea 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save activity' }));
  await waitFor(() => expect(activityPostCalls()).toHaveLength(1));
  expect(activityPostCalls()[0][1]).toMatchObject({ illustrations: images.map(({ id }) => ({ id })) });
});

test('disabled image setup leaves complete text ideas and ordinary saving available', async () => {
  vi.mocked(axios.get).mockImplementation(async url => url.endsWith('/images/status')
    ? response({ enabled: false, available: false, busy: false, model: null, message: 'Run image setup on the AI laptop.' })
    : url.endsWith('/activity-ai/status') ? response({ enabled: true, available: true, model: 'local-model', sourceCount: 0, message: 'Ready' }) : { data: { items: [], total: 0 } });
  render(<ActivityAiIdeas {...callbacks()} />); const card = await createIdeas();
  expect(within(card).getByText('Run image setup on the AI laptop.')).toBeVisible();
  expect(within(card).getByRole('button', { name: 'Review idea 1' })).toBeEnabled();
  expect(imagePostCalls()).toHaveLength(0);
  expect(screen.queryByText('Planning sources (0)')).not.toBeInTheDocument();
});

test('saved pictures load on demand through authenticated blob transport and revoke URLs on account change', async () => {
  const pending = deferred<{ data: Blob }>(); let reads = 0;
  vi.mocked(axios.get).mockImplementation(async () => ++reads === 1 ? { data: new Blob(['png'], { type: 'image/png' }) } : pending.promise);
  const view = render(<SignedIn><ActivityIllustrations images={[images[0]]} /></SignedIn>);
  expect(axios.get).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Show step pictures' }));
  expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:protected-picture-1');
  expect(axios.get).toHaveBeenCalledWith(expect.stringMatching(/\/api\/activity-ai\/images\/image-one$/), expect.objectContaining({ responseType: 'blob', signal: expect.any(AbortSignal) }));
  view.rerender(<SignedIn account={{ ...testAccount, id: 'another-account' }}><ActivityIllustrations images={[images[0]]} /></SignedIn>);
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:protected-picture-1');
  await act(async () => pending.resolve({ data: new Blob(['another'], { type: 'image/png' }) }));
  expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:protected-picture-2');
  const lastSignal = vi.mocked(axios.get).mock.calls[1][1]?.signal;
  view.unmount(); expect(lastSignal?.aborted).toBe(true);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:protected-picture-2');
});

test('classroom picture panels use only the saved-classroom image endpoint', async () => {
  render(<ActivityIllustrations images={[images[0]]} classroom />);
  fireEvent.click(screen.getByRole('button', { name: 'Show step pictures' }));
  await screen.findByRole('img');
  expect(axios.get).toHaveBeenCalledWith(expect.stringMatching(/\/api\/classroom\/activity-images\/image-one$/), expect.objectContaining({ responseType: 'blob' }));
  expect(vi.mocked(axios.get).mock.calls.some(([url]) => url.includes('/activity-ai/'))).toBe(false);
});

test('unsafe image content is rejected without creating an object URL', async () => {
  vi.mocked(axios.get).mockResolvedValue({ data: new Blob(['<svg>unsafe</svg>'], { type: 'image/svg+xml' }) });
  render(<ActivityIllustrations images={[images[0]]} initiallyOpen />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Some step pictures could not be loaded.');
  expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

test('printing waits for authenticated picture preparation and keeps captions with uncropped images', async () => {
  const pending = deferred<{ data: Blob }>(); vi.mocked(axios.get).mockReturnValue(pending.promise);
  const print = vi.spyOn(window, 'print').mockImplementation(() => {});
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal('Image', class { onload: (() => void) | null = null; onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); } });
  const activity: Activity = { ...reviewedDetails, id: 'saved', version: 1, illustrations: [images[0]] };
  const entries: Entry[] = [{ id: 'entry', date: '2026-11-02', startTime: '09:00', endTime: '09:20', timeBlock: null, activityId: activity.id, activity }];
  function Harness() {
    const prepared = useActivityPicturePrint(entries);
    return <><button onClick={() => void prepared.print()}>Print pictures</button><ActivityPrint roomName="Preschool" weekStart="2026-11-02" dates={['2026-11-02']} entries={entries} draft={false} pictureSources={prepared.sources} /></>;
  }
  const view = render(<Harness />); fireEvent.click(screen.getByRole('button', { name: 'Print pictures' }));
  expect(print).not.toHaveBeenCalled();
  await act(async () => pending.resolve({ data: new Blob(['png'], { type: 'image/png' }) }));
  await waitFor(() => expect(print).toHaveBeenCalledOnce());
  expect(screen.getByAltText('Step 1: ' + images[0].caption)).toHaveClass('object-contain');
  view.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:protected-picture-1');
});


test('completion focuses the picture gallery for the requested later idea', async () => {
  const pending = deferred<ReturnType<typeof response>>();
  vi.mocked(axios.post).mockImplementation(async url => url.endsWith('/draft')
    ? response({ ...result, drafts: [result.drafts[0], { ...result.drafts[0], name: 'Color pairs' }, { ...result.drafts[0], name: 'Tall towers' }] }) : pending.promise);
  render(<ActivityAiIdeas {...callbacks()} />); await createIdeas();
  const third = screen.getByRole('article', { name: 'AI idea 3' });
  fireEvent.click(within(third).getByRole('button', { name: 'Create step pictures' }));
  expect(screen.getByText('Pictures for idea 3. This can take several minutes.')).toBeVisible();
  expect(document.querySelector('.app-modal-pending')).toHaveFocus();
  await act(async () => pending.resolve(response(complete)));
  await within(third).findByRole('img', { name: 'Step 1: ' + images[0].caption });
  expect(document.getElementById('activity-ai-picture-result-2')).toHaveFocus();
  expect(screen.getByRole('article', { name: 'AI idea 1' })).toBeVisible();
});

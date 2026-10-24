import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import { ActivityAiIdeas } from './ActivityAiIdeas';
import type { ActivityAiResult } from '../../api/activityAi';
import type { ActivityDetails } from '../../api/activities';
import type { Room } from '../../api/rooms';

vi.mock('axios');
const room: Room = { id: 'sunflower', name: 'Sunflower', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12,
  active: true, needsConfiguration: false, assignedChildCount: 0, availablePlaces: 12, overCapacity: false };
const result: ActivityAiResult = { model: 'local-test-model', generatedAt: '2026-10-23T10:00:00Z', warnings: ['Review supervision and materials.'],
  drafts: [{ name: 'Autumn color detectives', description: 'Invite children to sort large leaves by color.', durationMinutes: 20, ageMinMonths: 24, ageMaxMonths: 60,
    roomId: room.id, materials: [], materialsNotes: 'Large leaves and sorting trays.', sourceIds: ['education-1'] }],
  sources: [{ id: 'education-1', title: 'Synthetic classroom guide', publisher: 'Test publisher', version: '2026-01', section: 'Sorting', kind: 'education', text: 'Use safe objects to explore matching and sorting.' }] };
const response = <T,>(data: T) => ({ data: { data } });
const props = () => ({ room, onSaved: vi.fn(), onCancel: vi.fn(), onDirtyChange: vi.fn(), onBusyChange: vi.fn() });
const draftCalls = () => vi.mocked(axios.post).mock.calls.filter(([url]) => url.endsWith('/draft'));
const saveCalls = () => vi.mocked(axios.post).mock.calls.filter(([url]) => url.endsWith('/activity'));
const create = () => fireEvent.click(screen.getByRole('button', { name: 'Create AI ideas' }));
async function ready() { await waitFor(() => expect(screen.getByRole('button', { name: 'Create AI ideas' })).toBeEnabled()); }
async function draft() { await ready(); create(); return screen.findByRole('article', { name: 'AI idea 1' }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.setAttribute('open', ''); } },
    close: { configurable: true, value() { this.removeAttribute('open'); } },
  });
  vi.mocked(axios.get).mockImplementation(async url => url.endsWith('/status')
    ? response({ enabled: true, available: true, model: 'local-test-model', sourceCount: 1, message: 'Ready' })
    : { data: { items: [], total: 0 } });
  vi.mocked(axios.post).mockImplementation(async (url, data) => url.endsWith('/draft') ? response(result)
    : response({ ...(data as ActivityDetails), id: 'new-ai-activity', version: 1 }));
});

test('novel ideas are reviewed, edited and explicitly saved to the library with references, leaving the week and stock alone', async () => {
  const callbacks = props(); render(<ActivityAiIdeas {...callbacks} />);
  await ready(); fireEvent.change(screen.getByLabelText('Theme (optional)'), { target: { value: 'Autumn colors' } }); create();
  const card = await screen.findByRole('article', { name: 'AI idea 1' });
  expect(card).toHaveTextContent('Autumn color detectives'); expect(saveCalls()).toHaveLength(0); expect(callbacks.onSaved).not.toHaveBeenCalled();
  expect(draftCalls()[0][1]).toEqual({ roomId: room.id, focus: 'balanced', theme: 'Autumn colors', activityCount: 3, durationMinutes: 20 });
  fireEvent.click(within(card).getByRole('button', { name: 'Review idea 1' }));
  const form = screen.getByRole('form', { name: 'New activity' });
  expect(within(form).getByLabelText('Activity name')).toHaveValue('Autumn color detectives');
  expect((within(form).getByLabelText('Description') as HTMLTextAreaElement).value).toContain('Planning references:');
  expect(within(form).getByText('Suggested materials')).toBeVisible();
  expect(within(form).getByText(/Suggestions alone are not included in stock or purchasing/)).toBeVisible();
  fireEvent.change(within(form).getByLabelText('Activity name'), { target: { value: 'Our autumn detectives' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Save activity' }));
  await screen.findByText('Activity saved to your library. Choose Generate week to include saved ideas in your plan.');
  expect(saveCalls()[0][1]).toMatchObject({ name: 'Our autumn detectives', roomId: room.id, materials: [], materialsNotes: 'Large leaves and sorting trays.' });
  expect((saveCalls()[0][1] as ActivityDetails).description).toContain('Synthetic classroom guide');
  expect(callbacks.onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-ai-activity', version: 1 }));
  expect(vi.mocked(axios.post).mock.calls.every(([url]) => url.endsWith('/draft') || url.endsWith('/activity'))).toBe(true);
  expect(axios.put).not.toHaveBeenCalled(); expect(axios.delete).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Review idea 1' })).not.toBeInTheDocument();
  expect(screen.getByText('Saved to library')).toBeVisible();
});

test('unavailable local AI explains the next step and leaves a clean close without making draft or save requests', async () => {
  vi.mocked(axios.get).mockResolvedValue(response({ enabled: false, available: false, model: null, sourceCount: 0, message: 'Local AI is disabled. Configure a local runtime.' }));
  const callbacks = props(); render(<ActivityAiIdeas {...callbacks} />);
  await screen.findByText('Local AI is disabled. Configure a local runtime.');
  expect(screen.getByText('You can keep creating activities and planning the week manually.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Create AI ideas' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(callbacks.onCancel).toHaveBeenCalledOnce(); expect(axios.post).not.toHaveBeenCalled();
});

test('the retry button rechecks a previously unavailable connection', async () => {
  vi.mocked(axios.get).mockResolvedValueOnce(response({ enabled: true, available: false, model: 'local-model', sourceCount: 1, message: 'Start the local runtime.' }));
  render(<ActivityAiIdeas {...props()} />); await screen.findByText('Start the local runtime.');
  fireEvent.click(screen.getByRole('button', { name: 'Check AI connection' })); await ready();
  expect(axios.get).toHaveBeenCalledTimes(2);
});

test('counts and durations are bounded before sending a request', async () => {
  render(<ActivityAiIdeas {...props()} />); await ready();
  fireEvent.change(screen.getByLabelText('Number of ideas'), { target: { value: '6' } });
  expect(screen.getByRole('button', { name: 'Create AI ideas' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Number of ideas'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('Minutes per activity'), { target: { value: '0' } });
  expect(screen.getByRole('button', { name: 'Create AI ideas' })).toBeDisabled(); expect(axios.post).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Minutes per activity'), { target: { value: '30' } });
  fireEvent.change(screen.getByLabelText('Development focus'), { target: { value: 'social' } }); create();
  await screen.findByRole('article', { name: 'AI idea 1' });
  expect(draftCalls()[0][1]).toMatchObject({ activityCount: 2, durationMinutes: 30, focus: 'social' });
});

test('stopping generation aborts the request and ignores a late response', async () => {
  const pending = deferred<ReturnType<typeof response>>(); vi.mocked(axios.post).mockReturnValueOnce(pending.promise);
  const callbacks = props(); render(<ActivityAiIdeas {...callbacks} />); await ready(); create();
  const signal = draftCalls()[0][2]!.signal!;
  fireEvent.click(screen.getByRole('button', { name: 'Stop AI generation' })); expect(signal.aborted).toBe(true);
  await act(async () => pending.resolve(response(result)));
  expect(screen.queryByRole('article', { name: 'AI idea 1' })).not.toBeInTheDocument(); expect(callbacks.onSaved).not.toHaveBeenCalled();
  expect(screen.getByText('AI generation stopped. Your library and week are unchanged.')).toBeVisible();
});

test('unmounting aborts generation so protected ideas cannot return to another screen', async () => {
  const pending = deferred<ReturnType<typeof response>>(); vi.mocked(axios.post).mockReturnValueOnce(pending.promise);
  const callbacks = props(); const view = render(<ActivityAiIdeas {...callbacks} />); await ready(); create();
  const signal = draftCalls()[0][2]!.signal!; view.unmount(); expect(signal.aborted).toBe(true);
  await act(async () => pending.resolve(response(result))); expect(callbacks.onSaved).not.toHaveBeenCalled();
});

test('closing modified ideas asks before discarding and never saves them', async () => {
  const callbacks = props(); render(<ActivityAiIdeas {...callbacks} />); await draft();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  const discard = screen.getByRole('group', { name: 'Discard AI ideas' });
  expect(callbacks.onCancel).not.toHaveBeenCalled(); fireEvent.click(within(discard).getByRole('button', { name: 'Keep editing' }));
  expect(screen.getByRole('article', { name: 'AI idea 1' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard AI ideas' }));
  expect(callbacks.onCancel).toHaveBeenCalledOnce(); expect(saveCalls()).toHaveLength(0);
});

test('model output and source excerpts render as plain text without external resources', async () => {
  const hostile = '<img src="https://external.invalid/track">';
  vi.mocked(axios.post).mockResolvedValueOnce(response({ ...result, drafts: [{ ...result.drafts[0], description: hostile }],
    sources: [{ ...result.sources[0], kind: 'policy', text: '<iframe src="https://external.invalid"></iframe>' }] }));
  const view = render(<ActivityAiIdeas {...props()} />); await draft();
  expect(screen.getByText(hostile)).toBeVisible();
  const sources = screen.getByText('Planning sources (1)').closest('details')!; sources.open = true;
  expect(within(sources).getByText('Policy reference')).toBeVisible();
  expect(within(sources).getByText('<iframe src="https://external.invalid"></iframe>')).toBeVisible();
  expect(view.container.querySelectorAll('img, iframe, a[href]')).toHaveLength(0);
});

test('each remaining idea can be saved once without automatically saving the others', async () => {
  vi.mocked(axios.post).mockResolvedValueOnce(response({ ...result, drafts: [result.drafts[0], { ...result.drafts[0], name: 'Leaf story circle' }] }));
  const callbacks = props(); render(<ActivityAiIdeas {...callbacks} />); await draft();
  fireEvent.click(screen.getByRole('button', { name: 'Review idea 2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save activity' }));
  await screen.findByText('Activity saved to your library. Choose Generate week to include saved ideas in your plan.');
  expect(saveCalls()).toHaveLength(1); expect(screen.getByRole('button', { name: 'Review idea 1' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Review idea 2' })).not.toBeInTheDocument();
  expect(callbacks.onSaved).toHaveBeenCalledOnce();
});

test('long source metadata keeps complete source IDs, versions and instructions within the activity limit', async () => {
  const sources = Array.from({ length: 6 }, (_, index) => ({ ...result.sources[0], id: 'source-' + index + '-'.repeat(55),
    title: 'Title '.repeat(25), publisher: 'Publisher '.repeat(15), version: 'Version '.repeat(10), section: 'Section '.repeat(15) }));
  const description = 'Keep all of these instructions. '.repeat(79);
  vi.mocked(axios.post).mockResolvedValueOnce(response({ ...result, sources, drafts: [{ ...result.drafts[0], description, sourceIds: sources.map(source => source.id) }] }));
  render(<ActivityAiIdeas {...props()} />); await draft(); fireEvent.click(screen.getByRole('button', { name: 'Review idea 1' }));
  const value = (screen.getByLabelText('Description') as HTMLTextAreaElement).value;
  expect(value.length).toBeLessThanOrEqual(4000); expect(value).toContain(description); expect(value).toContain('AI-assisted educational draft');
  for (const source of sources) { expect(value).toContain(source.id); expect(value).toContain(source.version); }
});

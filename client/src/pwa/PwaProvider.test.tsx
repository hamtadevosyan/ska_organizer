import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import PwaProvider from './PwaProvider';
import AppHelpButton from './AppHelpButton';
import { registerStaticWorker, watchWorkerUpdates } from './register';

vi.mock('./register', () => ({ registerStaticWorker: vi.fn(), watchWorkerUpdates: vi.fn() }));
let reportWaiting: (waiting: boolean) => void;
const stop = vi.fn();
const update = vi.fn();
const originalSecure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
const originalDialog = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal'),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close'),
};
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PROD', true);
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }));
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  update.mockResolvedValue({});
  vi.mocked(registerStaticWorker).mockResolvedValue({ update } as unknown as ServiceWorkerRegistration);
  vi.mocked(watchWorkerUpdates).mockImplementation((_registration, callback) => { reportWaiting = callback; return stop; });
});
afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  if (originalSecure) Object.defineProperty(window, 'isSecureContext', originalSecure);
  else Reflect.deleteProperty(window, 'isSecureContext');
});
afterAll(() => {
  for (const name of ['showModal', 'close'] as const) {
    const descriptor = originalDialog[name];
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});
async function setup() {
  const view = render(<PwaProvider><AppHelpButton /><label>Draft<input defaultValue="" /></label></PwaProvider>);
  await act(async () => { await Promise.resolve(); });
  return view;
}
function offer(outcome: 'accepted' | 'dismissed' = 'dismissed') {
  const prompt = vi.fn().mockResolvedValue(undefined);
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt, userChoice: Promise.resolve({ outcome }),
  });
  act(() => { window.dispatchEvent(event); });
  return { event, prompt };
}
const open = () => fireEvent.click(screen.getByRole('button', { name: 'App setup' }));

test('installation needs a user click and consumes each browser offer only once', async () => {
  await setup();
  const offered = offer();
  expect(offered.event.defaultPrevented).toBe(true);
  expect(offered.prompt).not.toHaveBeenCalled();
  open();
  fireEvent.click(screen.getByRole('button', { name: 'Add to home screen' }));
  await screen.findByText('You can add the app later from your browser menu.');
  expect(offered.prompt).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Add to home screen' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close app setup' }));
  open();
  expect(offered.prompt).toHaveBeenCalledOnce();
});

test('an accepted prompt is not claimed as installed until the browser confirms it', async () => {
  await setup(); offer('accepted'); open();
  fireEvent.click(screen.getByRole('button', { name: 'Add to home screen' }));
  await screen.findByText('Follow your browser to finish adding the app.');
  act(() => { window.dispatchEvent(new Event('appinstalled')); });
  expect(screen.getByText('Smart Kids Academy is available as an app on this device.')).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Installation instructions' })).not.toBeInTheDocument();
});

test('iPhone help is reachable without a native install event', async () => {
  await setup(); open();
  fireEvent.click(screen.getByRole('button', { name: 'iPhone / iPad' }));
  expect(screen.getByText('Safari')).toBeInTheDocument();
  expect(screen.getByText('Open as Web App')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add to home screen' })).not.toBeInTheDocument();
});

test('standalone windows show installed status and do not offer installation again', async () => {
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  await setup(); const offered = offer(); open();
  expect(screen.getByText('Smart Kids Academy is available as an app on this device.')).toBeInTheDocument();
  expect(offered.prompt).not.toHaveBeenCalled();
  expect(offered.event.defaultPrevented).toBe(false);
});

test('an insecure origin shows secure-address guidance without an install button', async () => {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
  vi.mocked(registerStaticWorker).mockResolvedValue(null);
  await setup(); offer(); open();
  expect(screen.getByText(/Installation needs the academy’s secure app address/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add to home screen' })).not.toBeInTheDocument();
});

test('failed registration leaves the application usable and explains setup recovery', async () => {
  vi.mocked(registerStaticWorker).mockResolvedValue(null);
  await setup(); open();
  expect(screen.getByText(/App setup is unavailable right now/)).toBeInTheDocument();
  expect(screen.getByLabelText('Draft')).toBeInTheDocument();
});

test('waiting updates preserve the mounted draft and explain closing all app windows', async () => {
  const view = await setup();
  const input = screen.getByLabelText('Draft');
  fireEvent.change(input, { target: { value: 'Synthetic unsaved work' } });
  act(() => reportWaiting(true));
  expect(screen.getByText('New version ready')).toBeInTheDocument();
  expect(screen.getByLabelText('Draft')).toBe(input);
  expect(input).toHaveValue('Synthetic unsaved work');
  fireEvent.click(screen.getByRole('button', { name: 'Update help' }));
  expect(screen.getByText(/Close all academy browser tabs and app windows/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close app setup' }));
  expect(input).toHaveValue('Synthetic unsaved work');
  view.unmount(); expect(stop).toHaveBeenCalledOnce();
});

test('a failed manual update check can be retried without reloading the application', async () => {
  update.mockRejectedValueOnce(new Error('Synthetic offline'));
  await setup(); open();
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  await screen.findByText(/Could not check right now/);
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  await screen.findByText(/Check finished/);
  expect(update).toHaveBeenCalledTimes(2);
});

test('a rejected native install prompt returns to useful manual instructions', async () => {
  await setup(); const offered = offer();
  offered.prompt.mockRejectedValueOnce(new Error('Synthetic browser refusal'));
  open(); fireEvent.click(screen.getByRole('button', { name: 'Add to home screen' }));
  await waitFor(() => expect(screen.getByText(/Use your browser menu to add the app/)).toBeInTheDocument());
  expect(screen.getByRole('group', { name: 'Installation instructions' })).toBeInTheDocument();
});

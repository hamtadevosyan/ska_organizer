import { afterEach, expect, test, vi } from 'vitest';
import { registerStaticWorker, watchWorkerUpdates } from './register';

const originalWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
const originalSecure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (originalWorker) Object.defineProperty(navigator, 'serviceWorker', originalWorker);
  else Reflect.deleteProperty(navigator, 'serviceWorker');
  if (originalSecure) Object.defineProperty(window, 'isSecureContext', originalSecure);
  else Reflect.deleteProperty(window, 'isSecureContext');
});

function updateFixture(controlled = true) {
  const installing = Object.assign(new EventTarget(), { state: 'installing' });
  const registration = Object.assign(new EventTarget(), { installing,
    waiting: null as EventTarget | null, update: vi.fn().mockResolvedValue({}) });
  const serviceWorker = Object.assign(new EventTarget(), { controller: controlled ? {} : null });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
  return { installing, registration, serviceWorker };
}

test('a waiting update is reported without forcing activation or reloading clients', () => {
  const { registration, installing, serviceWorker } = updateFixture();
  const report = vi.fn();
  const stop = watchWorkerUpdates(registration as unknown as ServiceWorkerRegistration, report);
  expect(report).toHaveBeenLastCalledWith(false);
  installing.state = 'installed'; registration.waiting = installing;
  installing.dispatchEvent(new Event('statechange'));
  expect(report).toHaveBeenLastCalledWith(true);
  registration.waiting = null; installing.state = 'activated';
  serviceWorker.dispatchEvent(new Event('controllerchange'));
  expect(report).toHaveBeenLastCalledWith(false);
  stop();
  const count = report.mock.calls.length;
  registration.dispatchEvent(new Event('updatefound'));
  installing.dispatchEvent(new Event('statechange'));
  serviceWorker.dispatchEvent(new Event('controllerchange'));
  expect(report).toHaveBeenCalledTimes(count);
});

test('first installation does not incorrectly show an update notice', () => {
  const { registration, installing } = updateFixture(false);
  registration.waiting = installing; installing.state = 'installed';
  const report = vi.fn();
  const stop = watchWorkerUpdates(registration as unknown as ServiceWorkerRegistration, report);
  expect(report).toHaveBeenLastCalledWith(false);
  stop();
});

test('an already waiting worker is found when reopening update help', () => {
  const { registration, installing } = updateFixture();
  registration.waiting = installing;
  const report = vi.fn();
  const stop = watchWorkerUpdates(registration as unknown as ServiceWorkerRegistration, report);
  expect(report).toHaveBeenLastCalledWith(true);
  stop();
});

test('long-lived apps recheck on focus and hourly, throttle repeated hints, and stop on cleanup', async () => {
  vi.useFakeTimers();
  const { registration } = updateFixture();
  const stop = watchWorkerUpdates(registration as unknown as ServiceWorkerRegistration, vi.fn());
  window.dispatchEvent(new Event('focus'));
  expect(registration.update).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('online'));
  expect(registration.update).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(55 * 60_000);
  expect(registration.update).toHaveBeenCalledTimes(2);
  stop();
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  window.dispatchEvent(new Event('focus'));
  expect(registration.update).toHaveBeenCalledTimes(2);
});
function browser(production: boolean, secure: boolean) {
  vi.stubEnv('PROD', production);
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: secure });
  const register = vi.fn().mockResolvedValue({});
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register } });
  return register;
}
test('registers only the same-origin static worker in a secure production build', () => {
  const register = browser(true, true);
  registerStaticWorker();
  expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' });
});
test.each([[false, true], [true, false]])('does not register in development or an insecure context (%s, %s)', (production, secure) => {
  const register = browser(production, secure);
  registerStaticWorker();
  expect(register).not.toHaveBeenCalled();
});
test('unsupported browsers and refused registrations can still use the online app', async () => {
  const register = browser(true, true);
  register.mockRejectedValueOnce(new Error('Synthetic registration failure'));
  expect(() => registerStaticWorker()).not.toThrow();
  await Promise.resolve();
  Reflect.deleteProperty(navigator, 'serviceWorker');
  expect(() => registerStaticWorker()).not.toThrow();
});

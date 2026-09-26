import { afterEach, expect, test, vi } from 'vitest';
import { registerStaticWorker } from './register';

const originalWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
const originalSecure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
afterEach(() => {
  vi.unstubAllEnvs();
  if (originalWorker) Object.defineProperty(navigator, 'serviceWorker', originalWorker);
  else Reflect.deleteProperty(navigator, 'serviceWorker');
  if (originalSecure) Object.defineProperty(window, 'isSecureContext', originalSecure);
  else Reflect.deleteProperty(window, 'isSecureContext');
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

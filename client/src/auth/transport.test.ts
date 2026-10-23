import { afterEach, expect, test } from 'vitest';
import axios, { AxiosError, AxiosHeaders } from 'axios';
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { API_BASE_URL } from '../lib/api';
import { onServerUnavailable, onSessionExpired, onWorkAccessRequired, replaceSession } from './transport';
const original = axios.defaults.adapter;
afterEach(() => { axios.defaults.adapter = original; replaceSession(); });
const response = (config: InternalAxiosRequestConfig): AxiosResponse => ({ config, status: 200, statusText: 'OK', headers: {}, data: {} });

test('sends cookies and CSRF only to this application API', async () => {
  const seen: InternalAxiosRequestConfig[] = [];
  axios.defaults.adapter = async (config) => { seen.push(config); return response(config); };
  replaceSession('test-security-token');
  await axios.post(`${API_BASE_URL}/api/meals`, {});
  await axios.get(`${API_BASE_URL}/api/meals`);
  await axios.post('https://unrelated.example/api/meals', {});
  expect(seen[0].withCredentials).toBe(true);
  expect(seen[0].headers.get('X-CSRF-Token')).toBe('test-security-token');
  expect(seen[1].headers.get('X-CSRF-Token')).toBeUndefined();
  expect(seen[2].withCredentials).toBeUndefined();
  expect(seen[2].headers.get('X-CSRF-Token')).toBeUndefined();
});

test('an expired API session notifies the gate but incorrect login credentials do not', async () => {
  let notifications = 0;
  const dispose = onSessionExpired(() => notifications++);
  axios.defaults.adapter = async (config) => { throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, { ...response(config), status: 401 }); };
  try {
    await expect(axios.post(`${API_BASE_URL}/api/auth/login`, {})).rejects.toBeDefined();
    expect(notifications).toBe(0);
    await expect(axios.get(`${API_BASE_URL}/api/meals`)).rejects.toBeDefined();
    expect(notifications).toBe(1);
  } finally { dispose(); }
});

test('late responses from an old session cannot update a new session or sign it out', async () => {
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  axios.defaults.adapter = (config) => new Promise((resolve) => { started(); release = () => resolve({ ...response(config), headers: new AxiosHeaders() }); });
  const pending = axios.get(`${API_BASE_URL}/api/meals`);
  await running;
  replaceSession('another-account-token');
  release();
  await expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
});

test('an API outage reports once, does not retry a write, and keeps its CSRF session', async () => {
  let calls = 0, notices = 0;
  const dispose = onServerUnavailable(() => notices++);
  replaceSession('retained-csrf');
  axios.defaults.adapter = async config => {
    calls++;
    expect(config.headers.get('X-CSRF-Token')).toBe('retained-csrf');
    throw new AxiosError('Unavailable', 'ERR_BAD_RESPONSE', config, undefined, { ...response(config), status: 503 });
  };
  try {
    await expect(axios.post(`${API_BASE_URL}/api/attendance/checkin`, { childId: 'synthetic' })).rejects.toBeDefined();
    expect(calls).toBe(1);
    expect(notices).toBe(1);
    axios.defaults.adapter = async config => {
      expect(config.headers.get('X-CSRF-Token')).toBe('retained-csrf');
      return response(config);
    };
    await axios.post(`${API_BASE_URL}/api/meals`, {});
  } finally { dispose(); }
});

test('network failures report an outage but cancelled and unrelated requests do not', async () => {
  let notices = 0;
  const dispose = onServerUnavailable(() => notices++);
  try {
    axios.defaults.adapter = async config => { throw new AxiosError('Network error', 'ERR_NETWORK', config); };
    await expect(axios.get(`${API_BASE_URL}/api/meals`)).rejects.toBeDefined();
    expect(notices).toBe(1);
    await expect(axios.get('https://unrelated.example/data')).rejects.toBeDefined();
    expect(notices).toBe(1);
    axios.defaults.adapter = async config => {
      const cancelled = new axios.CanceledError('Cancelled');
      cancelled.config = config;
      throw cancelled;
    };
    await expect(axios.get(`${API_BASE_URL}/api/meals`)).rejects.toBeDefined();
    expect(notices).toBe(1);
  } finally { dispose(); }
});

test('a late network failure from an earlier session cannot mark the new session unavailable', async () => {
  let release!: () => void, started!: () => void, notices = 0;
  const running = new Promise<void>(resolve => { started = resolve; });
  const dispose = onServerUnavailable(() => notices++);
  axios.defaults.adapter = config => new Promise((_resolve, reject) => {
    started(); release = () => reject(new AxiosError('Network error', 'ERR_NETWORK', config));
  });
  try {
    const pending = axios.get(`${API_BASE_URL}/api/meals`);
    await running;
    replaceSession('new-account');
    release();
    await expect(pending).rejects.toBeDefined();
    expect(notices).toBe(0);
  } finally { dispose(); }
});

const workAccessError = (config: InternalAxiosRequestConfig, status = 403, code = 'WORK_CHECK_IN_REQUIRED') => new AxiosError(
  'Work check-in is required', 'ERR_BAD_REQUEST', config, undefined,
  { ...response(config), status, data: { error: { code, message: 'Check in at the academy clock station.' } } },
);

test('a current work-check-in rejection notifies its gate without expiring the session or reporting an outage', async () => {
  let workNotices = 0, expiredNotices = 0, unavailableNotices = 0, calls = 0;
  const disposeWork = onWorkAccessRequired(() => workNotices++);
  const disposeExpired = onSessionExpired(() => expiredNotices++);
  const disposeUnavailable = onServerUnavailable(() => unavailableNotices++);
  replaceSession('retained-work-gate-csrf');
  axios.defaults.adapter = async config => { calls++; throw workAccessError(config); };
  try {
    await expect(axios.post(`${API_BASE_URL}/api/attendance/checkin`, { childId: 'synthetic' })).rejects.toMatchObject({ response: { status: 403 } });
    expect(calls).toBe(1);
    expect(workNotices).toBe(1);
    expect(expiredNotices).toBe(0); expect(unavailableNotices).toBe(0);
    axios.defaults.adapter = async config => {
      expect(config.headers.get('X-CSRF-Token')).toBe('retained-work-gate-csrf');
      expect(config.signal?.aborted).toBe(false);
      return response(config);
    };
    await axios.post(`${API_BASE_URL}/api/auth/logout`, {});
    expect(workNotices).toBe(1);
  } finally { disposeWork(); disposeExpired(); disposeUnavailable(); }
});

test('unrelated responses and ordinary forbidden errors cannot open the work-check-in gate', async () => {
  let notices = 0;
  const dispose = onWorkAccessRequired(() => notices++);
  replaceSession('current-csrf');
  try {
    axios.defaults.adapter = async config => { throw workAccessError(config); };
    await expect(axios.get('https://unrelated.example/api/children')).rejects.toBeDefined();
    expect(notices).toBe(0);
    axios.defaults.adapter = async config => { throw workAccessError(config, 403, 'FORBIDDEN'); };
    await expect(axios.get(`${API_BASE_URL}/api/children`)).rejects.toBeDefined();
    expect(notices).toBe(0);
    axios.defaults.adapter = async config => { throw workAccessError(config, 409); };
    await expect(axios.get(`${API_BASE_URL}/api/children`)).rejects.toBeDefined();
    expect(notices).toBe(0);
    axios.defaults.adapter = async config => { throw workAccessError(config); };
    dispose();
    await expect(axios.get(`${API_BASE_URL}/api/children`)).rejects.toBeDefined();
    expect(notices).toBe(0);
  } finally { dispose(); }
});

test('a work gate aborts pending protected requests and rejects their late results without canceling unrelated requests', async () => {
  const configs: InternalAxiosRequestConfig[] = [];
  let releaseProtected!: () => void, releaseUnrelated!: () => void;
  let protectedStarted!: () => void, unrelatedStarted!: () => void;
  const protectedRunning = new Promise<void>(resolve => { protectedStarted = resolve; });
  const unrelatedRunning = new Promise<void>(resolve => { unrelatedStarted = resolve; });
  let notices = 0;
  const dispose = onWorkAccessRequired(() => notices++);
  replaceSession('still-signed-in-csrf');
  axios.defaults.adapter = config => {
    configs.push(config);
    if (config.url === `${API_BASE_URL}/api/children`) return new Promise(resolve => { protectedStarted(); releaseProtected = () => resolve({ ...response(config), data: { children: ['stale private result'] } }); });
    if (config.url === 'https://unrelated.example/public') return new Promise(resolve => { unrelatedStarted(); releaseUnrelated = () => resolve(response(config)); });
    return Promise.reject(workAccessError(config));
  };
  try {
    const pendingProtected = axios.get(`${API_BASE_URL}/api/children`);
    const pendingUnrelated = axios.get('https://unrelated.example/public');
    await Promise.all([protectedRunning, unrelatedRunning]);
    const protectedConfig = configs.find(config => config.url === `${API_BASE_URL}/api/children`)!;
    const unrelatedConfig = configs.find(config => config.url === 'https://unrelated.example/public')!;
    expect(protectedConfig.signal?.aborted).toBe(false);
    await expect(axios.get(`${API_BASE_URL}/api/meals`)).rejects.toMatchObject({ response: { status: 403 } });
    expect(notices).toBe(1);
    expect(protectedConfig.signal?.aborted).toBe(true);
    expect(unrelatedConfig.signal?.aborted).not.toBe(true);
    releaseProtected(); releaseUnrelated();
    await expect(pendingProtected).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    await expect(pendingUnrelated).resolves.toMatchObject({ status: 200 });
    axios.defaults.adapter = async config => {
      expect(config.headers.get('X-CSRF-Token')).toBe('still-signed-in-csrf');
      expect(config.signal?.aborted).toBe(false);
      return response(config);
    };
    await axios.post(`${API_BASE_URL}/api/auth/logout`, {});
  } finally { dispose(); }
});

test('a late work-check-in error from an earlier session cannot gate or sign out the current account', async () => {
  let release!: () => void, started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  let workNotices = 0, expiredNotices = 0;
  const disposeWork = onWorkAccessRequired(() => workNotices++);
  const disposeExpired = onSessionExpired(() => expiredNotices++);
  replaceSession('previous-account-csrf');
  axios.defaults.adapter = config => new Promise((_resolve, reject) => { started(); release = () => reject(workAccessError(config)); });
  try {
    const pending = axios.get(`${API_BASE_URL}/api/children`);
    await running;
    replaceSession('new-account-csrf');
    release();
    await expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    expect(workNotices).toBe(0); expect(expiredNotices).toBe(0);
    axios.defaults.adapter = async config => {
      expect(config.headers.get('X-CSRF-Token')).toBe('new-account-csrf');
      return response(config);
    };
    await axios.post(`${API_BASE_URL}/api/meals`, {});
  } finally { disposeWork(); disposeExpired(); }
});

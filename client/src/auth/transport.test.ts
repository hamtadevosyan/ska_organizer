import { afterEach, expect, test } from 'vitest';
import axios, { AxiosError, AxiosHeaders } from 'axios';
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { API_BASE_URL } from '../lib/api';
import { onSessionExpired, replaceSession } from './transport';
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

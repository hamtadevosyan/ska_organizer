import axios from 'axios';
import { API_BASE_URL } from '../lib/api';

declare module 'axios' {
  interface AxiosRequestConfig { skaoEpoch?: number }
}
let csrf = '';
let epoch = 0;
let pending = new AbortController();
const expired = new Set<() => void>();
const isApi = (url?: string) => !!url && (url === `${API_BASE_URL}/api` || url.startsWith(`${API_BASE_URL}/api/`));
export function replaceSession(token = '') {
  pending.abort();
  pending = new AbortController();
  csrf = token;
  epoch++;
}
export function onSessionExpired(callback: () => void) {
  expired.add(callback);
  return () => { expired.delete(callback); };
}
axios.interceptors.request.use((config) => {
  if (isApi(config.url)) {
    config.withCredentials = true;
    config.skaoEpoch = epoch;
    config.signal = config.signal ? AbortSignal.any([config.signal as AbortSignal, pending.signal]) : pending.signal;
    if (!['get', 'head', 'options'].includes(config.method || 'get') && csrf) config.headers.set('X-CSRF-Token', csrf);
  }
  return config;
});
axios.interceptors.response.use((response) => {
  if (response.config.skaoEpoch !== undefined && response.config.skaoEpoch !== epoch) throw new axios.CanceledError('Session changed.');
  return response;
}, (error: unknown) => {
  if (axios.isAxiosError(error) && error.config?.skaoEpoch === epoch && error.response?.status === 401 &&
      !error.config.url?.endsWith('/auth/login')) {
    replaceSession();
    expired.forEach((callback) => callback());
  }
  return Promise.reject(error);
});
export function authError(error: unknown, fallback: string) {
  if (axios.isAxiosError(error)) {
    const message = error.response?.data?.error?.message;
    if (typeof message === 'string') return message;
    if (!error.response) return 'Cannot reach the server. Check the connection and try again.';
  }
  return fallback;
}

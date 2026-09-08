// Windows Chrome must reach the backend on the Ubuntu VM, not Windows localhost.
// An explicit deployment URL takes precedence over the development host fallback.
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || `${window.location.protocol}//${window.location.hostname}:3001`).replace(/\/$/, '');

export async function registerStaticWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!import.meta.env.PROD || !window.isSecureContext || !('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }); }
  catch { return null; /* Optional shell caching must not prevent normal online use. */ }
}

export function watchWorkerUpdates(registration: ServiceWorkerRegistration, onWaiting: (waiting: boolean) => void) {
  let installing: ServiceWorker | null = null;
  let lastCheck = Date.now();
  let checking = false;
  const changed = () => onWaiting(!!navigator.serviceWorker.controller &&
    (!!registration.waiting || installing?.state === 'installed'));
  const found = () => {
    installing?.removeEventListener('statechange', changed);
    installing = registration.installing;
    installing?.addEventListener('statechange', changed);
    changed();
  };
  // Recheck long-lived installed apps, including a return from background/offline.
  // The browser's internet hint is not a reason to skip a reachable LAN server.
  const check = () => {
    if (document.visibilityState !== 'visible' || checking || Date.now() - lastCheck < 5 * 60_000) return;
    lastCheck = Date.now(); checking = true;
    void registration.update().catch(() => { /* Try again on the next check. */ }).finally(() => { checking = false; });
  };
  registration.addEventListener('updatefound', found);
  navigator.serviceWorker.addEventListener('controllerchange', changed);
  window.addEventListener('focus', check);
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', check);
  const timer = window.setInterval(check, 60 * 60_000);
  found();
  return () => {
    installing?.removeEventListener('statechange', changed);
    registration.removeEventListener('updatefound', found);
    navigator.serviceWorker.removeEventListener('controllerchange', changed);
    window.removeEventListener('focus', check);
    window.removeEventListener('online', check);
    document.removeEventListener('visibilitychange', check);
    clearInterval(timer);
  };
}

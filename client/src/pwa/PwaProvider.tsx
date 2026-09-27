import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CheckCircle2, Download, RefreshCw, Share, Smartphone } from 'lucide-react';
import AppModal from '../components/AppModal';
import { AppHelpContext } from './context';
import { registerStaticWorker, watchWorkerUpdates } from './register';
import './pwa.css';

type InstallEvent = Event & {
  prompt: () => Promise<unknown>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
const appleDevice = () => /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export default function PwaProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [installed, setInstalled] = useState(standalone);
  const [canInstall, setCanInstall] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installMessage, setInstallMessage] = useState('');
  const [device, setDevice] = useState<'android' | 'apple'>(() => appleDevice() ? 'apple' : 'android');
  const prompt = useRef<InstallEvent | null>(null);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [setupFinished, setSetupFinished] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [updateMessage, setUpdateMessage] = useState('');
  const secure = window.isSecureContext;

  useEffect(() => {
    const media = window.matchMedia?.('(display-mode: standalone)');
    const added = () => { prompt.current = null; setCanInstall(false); setInstalled(true); setInstallMessage(''); };
    const mode = () => { if (standalone()) added(); };
    const offered = (event: Event) => {
      if (!import.meta.env.PROD || !window.isSecureContext || standalone()) return;
      event.preventDefault();
      prompt.current = event as InstallEvent;
      setCanInstall(true);
    };
    window.addEventListener('beforeinstallprompt', offered);
    window.addEventListener('appinstalled', added);
    media?.addEventListener('change', mode);
    return () => {
      window.removeEventListener('beforeinstallprompt', offered);
      window.removeEventListener('appinstalled', added);
      media?.removeEventListener('change', mode);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let stop = () => {};
    void registerStaticWorker().then(value => {
      if (disposed) return;
      setRegistration(value); setSetupFinished(true);
      if (value) stop = watchWorkerUpdates(value, setWaiting);
    });
    return () => { disposed = true; stop(); };
  }, []);

  async function install() {
    const offer = prompt.current;
    if (!offer || installing) return;
    prompt.current = null; setCanInstall(false); setInstalling(true); setInstallMessage('');
    try {
      // Call synchronously from the click; this browser event is single-use.
      await offer.prompt();
      const choice = await offer.userChoice;
      setInstallMessage(choice.outcome === 'accepted' ? 'Follow your browser to finish adding the app.' :
        'You can add the app later from your browser menu.');
    } catch { setInstallMessage('Use your browser menu to add the app, or try again on your next visit.'); }
    finally { setInstalling(false); }
  }
  async function checkUpdates() {
    if (!registration || checking) return;
    setChecking(true); setUpdateMessage('');
    try {
      await registration.update();
      setUpdateMessage('Check finished. A new version will appear here when ready.');
    } catch { setUpdateMessage('Could not check right now. Connect to the academy Wi-Fi and try again.'); }
    finally { setChecking(false); }
  }

  return <AppHelpContext.Provider value={() => setOpen(true)}>
    {waiting && <aside className="pwa-update-notice print:hidden" role="status">
      <RefreshCw size={23} aria-hidden="true" />
      <div><strong>New version ready</strong><p>Save your work, then close all academy app windows and tabs. Reopen the app to update.</p></div>
      <button type="button" className="ska-button" onClick={() => setOpen(true)}>Update help</button>
    </aside>}
    {children}
    {open && <AppModal id="app-setup" title="App setup" onDismiss={() => setOpen(false)}>
      <div className="pwa-help">
        <div className="pwa-intro">
          <img src="/assets/icons/academy-192.png" width="68" height="68" alt="Smart Kids Academy app icon" />
          <div><h3>Your academy, one tap away</h3><p>Open Smart Kids Academy from your home screen.</p></div>
        </div>
        <p className="pwa-local-note">Use the academy Wi-Fi and keep the academy computer on. Records need a live connection.</p>
        {!secure ? <p role="status" className="pwa-local-note">Installation needs the academy’s secure app address. Ask your administrator for that link and device setup.</p> :
          !import.meta.env.PROD ? <p role="status">Installation is available in the released app. Open the academy app link to add it.</p> :
          installed ? <p role="status" className="pwa-installed"><CheckCircle2 size={22} aria-hidden="true" />Smart Kids Academy is available as an app on this device.</p> : <>
            {device === 'android' && <p className="pwa-small">On Android, installation may send the app’s address, name and icon to your browser provider. Keep using the browser if this device must stay fully isolated.</p>}
            {canInstall && <button type="button" className="ska-button is-primary pwa-install" disabled={installing} onClick={() => { void install(); }}>
              <Download size={19} aria-hidden="true" />Add to home screen
            </button>}
            {installing && <p role="status">Finish in your browser’s installation window.</p>}
            {installMessage && <p role="status">{installMessage}</p>}
            <div role="group" aria-label="Installation instructions" className="pwa-device-buttons">
              <button type="button" aria-pressed={device === 'android'} onClick={() => setDevice('android')}><Smartphone size={18} aria-hidden="true" />Android</button>
              <button type="button" aria-pressed={device === 'apple'} onClick={() => setDevice('apple')}><Share size={18} aria-hidden="true" />iPhone / iPad</button>
            </div>
            {device === 'apple' ? <ol className="pwa-steps">
              <li>Open the academy app link in <strong>Safari</strong>.</li>
              <li>Tap <strong>Share</strong> (it may be in the page menu), then <strong>Add to Home Screen</strong>.</li>
              <li>If shown, turn on <strong>Open as Web App</strong>. Tap <strong>Add</strong>.</li>
            </ol> : <ol className="pwa-steps">
              <li>Open the academy app link in <strong>Chrome</strong>.</li>
              <li>Tap <strong>Add to home screen</strong> above if available, or open Chrome’s menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>
              <li>Confirm, then find the academy icon on your home screen or app list.</li>
            </ol>}
            <p className="pwa-small">Menu names vary by device. If installation is unavailable, you can keep using the browser. On a computer, look for Install in the browser’s address bar or menu.</p>
          </>}
        <section className="pwa-update-help" aria-label="App updates">
          <h3><RefreshCw size={18} aria-hidden="true" />{waiting ? 'Your update is ready' : 'Keeping your app up to date'}</h3>
          <p>Updates never reload an open form automatically.</p>
          {waiting && <ol className="pwa-steps">
            <li>Finish and save your work in every academy window.</li>
            <li>Close all academy browser tabs and app windows. On a phone, also close the academy app from the app switcher.</li>
            <li>Reopen the academy app while connected to its Wi-Fi.</li>
          </ol>}
          {registration && <button type="button" className="ska-button" disabled={checking} onClick={() => { void checkUpdates(); }}>
            <RefreshCw size={17} aria-hidden="true" />{checking ? 'Checking…' : 'Check for updates'}
          </button>}
          {!registration && setupFinished && secure && import.meta.env.PROD && <p role="status">App setup is unavailable right now. Reopen this page while connected and try again.</p>}
          {updateMessage && !waiting && <p role="status">{updateMessage}</p>}
        </section>
      </div>
    </AppModal>}
  </AppHelpContext.Provider>;
}

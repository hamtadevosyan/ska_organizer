import { useState } from 'react';
import { RefreshCw, WifiOff } from 'lucide-react';
import AcademyBrand from './AcademyBrand';
import './server-connection.css';

export default function ServerConnection({ retry, standalone = false }: {
  retry: () => Promise<void>; standalone?: boolean;
}) {
  const [checking, setChecking] = useState(false);
  const content = <>
    <WifiOff className="server-connection-icon" size={28} aria-hidden="true" />
    <div>
      {standalone ? <h1>We can’t reach the academy computer</h1> : <h2>Connection interrupted</h2>}
      <p>Connect to the academy Wi-Fi and make sure the academy computer is on.</p>
      {standalone ? <p>Records need a live connection. Try again when you’re connected.</p> :
        <p>Your open edits are still here. Records may be out of date. Check any save that failed before trying again.</p>}
    </div>
    <button type="button" disabled={checking} className="ska-button is-primary" onClick={() => {
      setChecking(true); void retry().finally(() => setChecking(false));
    }}><RefreshCw size={17} aria-hidden="true" />{checking ? 'Checking…' : 'Try again'}</button>
  </>;
  if (standalone) return <main className="auth-screen"><section className="auth-card server-connection-card">
    <AcademyBrand /><div role="alert" className="server-connection-content">{content}</div>
  </section></main>;
  return <aside role="alert" className="server-connection-banner print:hidden">{content}</aside>;
}

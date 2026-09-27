import { useContext } from 'react';
import { Smartphone } from 'lucide-react';
import { AppHelpContext } from './context';

export default function AppHelpButton({ onOpen }: { onOpen?: () => void }) {
  const open = useContext(AppHelpContext);
  if (!open) return null;
  return <button type="button" className="ska-link pwa-help-button" onClick={() => { onOpen?.(); open(); }}>
    <Smartphone size={18} aria-hidden="true" />App setup
  </button>;
}

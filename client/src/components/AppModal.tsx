import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

type Props = { id: string; title: string; sheet?: boolean; onDismiss: () => void; children: ReactNode };

export default function AppModal({ id, title, sheet = false, onDismiss, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current!;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    // A native modal keeps background controls inert and contains keyboard focus.
    dialog.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return <dialog ref={ref} id={id} aria-labelledby={`${id}-title`}
    className={`app-modal${sheet ? ' app-modal-sheet' : ''}`}
    onCancel={(event) => { event.preventDefault(); onDismiss(); }}
    onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      // Wrap explicitly; native dialog makes the page inert but some browsers
      // still tab from the last control into browser chrome instead of cycling.
      const targets = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.getClientRects().length > 0);
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onDismiss();
    }}>
    <div className="app-modal-header flex items-center justify-between gap-3">
      <h2 id={`${id}-title`} className="text-xl font-bold text-slate-950">{title}</h2>
      <button type="button" aria-label={`Close ${title.toLowerCase()}`} onClick={onDismiss}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-700 hover:bg-slate-100">
        <X size={22} aria-hidden="true" />
      </button>
    </div>
    {children}
  </dialog>;
}

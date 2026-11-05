import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

type Props = { id: string; title: string; sheet?: boolean; initialFocusId?: string; onDismiss: () => void; children: ReactNode;
  pendingContent?: ReactNode; pendingKey?: string; attentionKey?: string; attentionId?: string };

export default function AppModal({ id, title, sheet = false, initialFocusId, onDismiss, children, pendingContent, pendingKey, attentionKey, attentionId }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef<HTMLDivElement>(null);
  const previousPending = useRef(false);
  const previousPendingKey = useRef(pendingKey);
  const returnFocusId = useRef('');
  const hasPending = pendingContent !== undefined && pendingContent !== null && pendingContent !== false;

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (hasPending) {
      if (!previousPending.current) returnFocusId.current = document.activeElement?.id || '';
      if (!previousPending.current || pendingKey !== previousPendingKey.current) {
        dialog.scrollTop = 0;
        pendingRef.current?.focus({ preventScroll: true });
      }
    } else if (previousPending.current || attentionKey) {
      dialog.scrollTop = 0;
      const requested = attentionId ? document.getElementById(attentionId) : null;
      const attention = dialog.querySelector<HTMLElement>('[data-modal-error]')
        || (requested instanceof HTMLElement && dialog.contains(requested) ? requested : null)
        || dialog.querySelector<HTMLElement>('[data-modal-notice], [role="alert"], [data-modal-result]');
      const previous = returnFocusId.current ? document.getElementById(returnFocusId.current) : null;
      const target = attention || (previous instanceof HTMLElement && dialog.contains(previous) ? previous : null);
      if (target) {
        if (attention && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
        // Completion and failure may have a result below the restored settings.
        // Move the outcome into view rather than leaving it below a long form.
        if (attention) target.scrollIntoView?.({ block: 'start' });
      }
    }
    previousPending.current = hasPending;
    previousPendingKey.current = pendingKey;
  }, [hasPending, pendingKey, attentionKey, attentionId]);

  useEffect(() => {
    const dialog = ref.current!;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    // A native modal keeps background controls inert and contains keyboard focus.
    dialog.showModal();
    // React autofocus runs before the native dialog opens. Focus the requested
    // action after showModal makes its controls available.
    const initialFocus = pendingRef.current || (initialFocusId ? document.getElementById(initialFocusId) : null);
    if (initialFocus instanceof HTMLElement && dialog.contains(initialFocus)) initialFocus.focus({ preventScroll: true });
    document.body.style.overflow = 'hidden';
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [initialFocusId]);

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
    <div className="app-modal-content" hidden={hasPending}>{children}</div>
    {hasPending && <div className="app-modal-pending" ref={pendingRef} tabIndex={-1}>{pendingContent}</div>}
  </dialog>;
}

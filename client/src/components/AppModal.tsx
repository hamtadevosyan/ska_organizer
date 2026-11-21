import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

type Props = { id: string; title: string; sheet?: boolean; initialFocusId?: string; onDismiss: () => void; children: ReactNode;
  pendingContent?: ReactNode; pendingKey?: string; attentionKey?: string; attentionId?: string;
  confirmationContent?: ReactNode; confirmationFocusId?: string; dismissDisabled?: boolean };

export default function AppModal({ id, title, sheet = false, initialFocusId, onDismiss, children, pendingContent, pendingKey, attentionKey, attentionId,
  confirmationContent, confirmationFocusId, dismissDisabled = false }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef<HTMLDivElement>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const confirmationFocusIdRef = useRef(confirmationFocusId); confirmationFocusIdRef.current = confirmationFocusId;
  const previousConfirmation = useRef(false);
  const confirmationReturn = useRef<{ focus: HTMLElement | null; scrollTop: number } | null>(null);
  const reviewPosition = useRef<{ focus: HTMLElement | null; scrollTop: number } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousPending = useRef(false);
  const previousPendingKey = useRef(pendingKey);
  const returnFocusId = useRef('');
  const hasPending = pendingContent !== undefined && pendingContent !== null && pendingContent !== false;
  const hasConfirmation = confirmationContent !== undefined && confirmationContent !== null && confirmationContent !== false;

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const wasConfirmation = previousConfirmation.current;
    previousConfirmation.current = hasConfirmation;
    if (hasConfirmation) {
      if (!wasConfirmation) {
        const active = document.activeElement;
        // Keep the pre-commit position: hiding a long body can clamp the native
        // dialog's scrollTop before this layout effect reads it.
        confirmationReturn.current = reviewPosition.current || { focus: active instanceof HTMLElement && dialog.contains(active) ? active : closeRef.current, scrollTop: dialog.scrollTop };
        dialog.scrollTop = 0;
        const requested = confirmationFocusId ? document.getElementById(confirmationFocusId) : null;
        const target = requested instanceof HTMLElement && confirmationRef.current?.contains(requested) ? requested : confirmationRef.current;
        target?.focus({ preventScroll: true });
      }
      previousPending.current = hasPending;
      previousPendingKey.current = pendingKey;
      return;
    }
    if (wasConfirmation) {
      const previous = confirmationReturn.current;
      const target = previous?.focus?.isConnected && dialog.contains(previous.focus) && !previous.focus.closest('[hidden]') && !previous.focus.matches(':disabled')
        ? previous.focus : closeRef.current;
      target?.focus({ preventScroll: true });
      dialog.scrollTop = previous?.scrollTop ?? 0;
      reviewPosition.current = { focus: target, scrollTop: dialog.scrollTop };
      confirmationReturn.current = null;
      previousPending.current = hasPending;
      previousPendingKey.current = pendingKey;
      // A preserved save notice or error must not steal focus/scroll after
      // Keep editing returns to the exact place the user was reviewing.
      return;
    }
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
  }, [hasPending, pendingKey, attentionKey, attentionId, hasConfirmation, confirmationFocusId]);

  useEffect(() => {
    const dialog = ref.current!;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    // A native modal keeps background controls inert and contains keyboard focus.
    dialog.showModal();
    // React autofocus runs before the native dialog opens. Focus the requested
    // action after showModal makes its controls available.
    const requestedConfirmation = confirmationFocusIdRef.current ? document.getElementById(confirmationFocusIdRef.current) : null;
    const initialFocus = confirmationRef.current
      ? requestedConfirmation instanceof HTMLElement && confirmationRef.current.contains(requestedConfirmation) ? requestedConfirmation : confirmationRef.current
      : pendingRef.current || (initialFocusId ? document.getElementById(initialFocusId) : null);
    if (initialFocus instanceof HTMLElement && dialog.contains(initialFocus)) initialFocus.focus({ preventScroll: true });
    document.body.style.overflow = 'hidden';
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [initialFocusId]);

  function rememberReviewPosition() {
    const dialog = ref.current;
    if (!dialog || hasConfirmation) return;
    const active = document.activeElement;
    reviewPosition.current = { focus: active instanceof HTMLElement && dialog.contains(active) ? active : closeRef.current, scrollTop: dialog.scrollTop };
  }

  function dismiss() {
    if (dismissDisabled) return;
    rememberReviewPosition();
    onDismiss();
  }

  return <dialog ref={ref} id={id} aria-labelledby={`${id}-title`}
    className={`app-modal${sheet ? ' app-modal-sheet' : ''}`}
    onScroll={rememberReviewPosition} onFocusCapture={rememberReviewPosition} onClickCapture={rememberReviewPosition} onKeyDownCapture={rememberReviewPosition}
    onCancel={(event) => { event.preventDefault(); dismiss(); }}
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
      if (dismissDisabled || event.target !== event.currentTarget) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dismiss();
    }}>
    <div className="app-modal-header flex items-center justify-between gap-3">
      <h2 id={`${id}-title`} className="text-xl font-bold text-slate-950">{title}</h2>
      <button ref={closeRef} type="button" aria-label={`Close ${title.toLowerCase()}`} onClick={dismiss} disabled={dismissDisabled}
        title={dismissDisabled ? 'Please wait for the current action to finish.' : undefined}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-700 hover:bg-slate-100 disabled:cursor-wait disabled:opacity-50">
        <X size={22} aria-hidden="true" />
      </button>
    </div>
    <div className="app-modal-content" hidden={hasPending || hasConfirmation}>{children}</div>
    {!hasConfirmation && hasPending && <div className="app-modal-pending" ref={pendingRef} tabIndex={-1}>{pendingContent}</div>}
    {hasConfirmation && <div className="app-modal-pending app-modal-confirmation" ref={confirmationRef} tabIndex={-1}>{confirmationContent}</div>}
  </dialog>;
}

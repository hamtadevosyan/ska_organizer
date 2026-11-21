import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import AppModal from './AppModal';

beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); }) },
    close: { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.removeAttribute('open'); }) },
  });
});

test('a task view keeps the native modal open and preserves its existing form while moving focus', () => {
  const dismiss = vi.fn();
  const form = <><label htmlFor="draft-name">Draft name</label><input id="draft-name" defaultValue="First draft" /><button id="create-draft">Create draft</button></>;
  const view = render(<AppModal id="task-example" title="Example" initialFocusId="draft-name" onDismiss={dismiss}>{form}</AppModal>);
  const dialog = screen.getByRole('dialog');
  const input = screen.getByLabelText('Draft name');
  fireEvent.change(input, { target: { value: 'Edited draft' } });
  screen.getByRole('button', { name: 'Create draft' }).focus();
  dialog.scrollTop = 800;
  view.rerender(<AppModal id="task-example" title="Example" initialFocusId="draft-name" onDismiss={dismiss}
    pendingKey="draft" pendingContent={<><p role="status">Creating draft…</p><button>Stop</button></>}>{form}</AppModal>);
  expect(dialog.scrollTop).toBe(0);
  expect(document.querySelector('.app-modal-pending')).toHaveFocus();
  expect(input).not.toBeVisible();
  expect(screen.queryByRole('button', { name: 'Create draft' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible();
  expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
  expect(HTMLDialogElement.prototype.close).not.toHaveBeenCalled();
  expect(document.body.style.overflow).toBe('hidden');
  view.rerender(<AppModal id="task-example" title="Example" initialFocusId="draft-name" onDismiss={dismiss}>{form}</AppModal>);
  expect(input).toHaveValue('Edited draft');
  expect(input).toBeVisible();
  expect(screen.getByRole('button', { name: 'Create draft' })).toHaveFocus();
  expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
  view.unmount();
  expect(HTMLDialogElement.prototype.close).toHaveBeenCalledOnce();
});

test('confirmation supersedes old notices, preserves the form, and returns to the original review position', () => {
  const dismiss = vi.fn();
  const confirmation = <div role="group" aria-label="Discard draft"><p>Discard this unsaved draft?</p><button id="discard-draft">Discard</button><button id="keep-draft">Keep editing</button></div>;
  const content = <><p data-modal-notice>Activity saved.</p><p data-modal-error role="alert">An earlier request failed.</p>
    <label htmlFor="review-name">Draft name</label><input id="review-name" defaultValue="Saved name" /></>;
  const panel = (confirm = false, attentionKey = 'saved') => <AppModal id="review-example" title="Review" initialFocusId="review-name" onDismiss={dismiss}
    attentionKey={attentionKey} confirmationContent={confirm ? confirmation : undefined} confirmationFocusId="keep-draft">{content}</AppModal>;
  const view = render(panel());
  const dialog = screen.getByRole('dialog');
  const input = screen.getByLabelText('Draft name');
  fireEvent.change(input, { target: { value: 'Unsaved review name' } }); input.focus();
  dialog.scrollTop = 900; fireEvent.scroll(dialog);
  fireEvent.click(screen.getByRole('button', { name: 'Close review' }));
  // A real browser may clamp this as the long content is hidden on commit.
  dialog.scrollTop = 0;
  view.rerender(panel(true));
  expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
  expect(screen.getByRole('group', { name: 'Discard draft' })).toBeVisible();
  expect(input).not.toBeVisible(); expect(input).toHaveValue('Unsaved review name');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(dialog.scrollTop).toBe(0);
  expect(document.body.style.overflow).toBe('hidden');

  screen.getByRole('button', { name: 'Discard' }).focus(); dialog.scrollTop = 12;
  view.rerender(panel(true, 'new failure while confirmation is open'));
  expect(screen.getByRole('button', { name: 'Discard' })).toHaveFocus();
  expect(dialog.scrollTop).toBe(12);

  view.rerender(panel(false, 'new failure while confirmation is open'));
  expect(input).toBeVisible(); expect(input).toHaveValue('Unsaved review name'); expect(input).toHaveFocus();
  expect(dialog.scrollTop).toBe(900);
  expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
  expect(HTMLDialogElement.prototype.close).not.toHaveBeenCalled();
  view.unmount(); expect(HTMLDialogElement.prototype.close).toHaveBeenCalledOnce();
});

test('an initial confirmation takes priority over the task view and focuses its safe action', () => {
  render(<AppModal id="initial-confirmation" title="Confirmation" onDismiss={vi.fn()}
    pendingContent={<p role="status">Generating a draft…</p>}
    confirmationContent={<div><p>Discard this draft?</p><button id="initial-keep">Keep editing</button></div>}
    confirmationFocusId="initial-keep"><input aria-label="Hidden draft" defaultValue="Preserved" /></AppModal>);
  expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Hidden draft')).not.toBeVisible();
  expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
});

test('noncancellable work disables X and blocks Escape and backdrop dismissal until it finishes', () => {
  const dismiss = vi.fn();
  const panel = (disabled: boolean) => <AppModal id="saving-example" title="Saving" onDismiss={dismiss} dismissDisabled={disabled}><p>Saving activity…</p></AppModal>;
  const view = render(panel(true)); const dialog = screen.getByRole('dialog');
  const close = screen.getByRole('button', { name: 'Close saving' });
  expect(close).toBeDisabled(); expect(close).toHaveAttribute('title', 'Please wait for the current action to finish.');
  fireEvent.click(close);
  const escape = new Event('cancel', { cancelable: true }); fireEvent(dialog, escape); expect(escape.defaultPrevented).toBe(true);
  vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({ left: 10, right: 110, top: 10, bottom: 110, width: 100, height: 100, x: 10, y: 10, toJSON: () => ({}) });
  fireEvent.click(dialog, { clientX: 0, clientY: 0 }); expect(dismiss).not.toHaveBeenCalled();
  view.rerender(panel(false)); expect(close).toBeEnabled(); expect(close).not.toHaveAttribute('title');
  fireEvent.click(close); expect(dismiss).toHaveBeenCalledOnce();
  fireEvent(dialog, new Event('cancel', { cancelable: true })); expect(dismiss).toHaveBeenCalledTimes(2);
  fireEvent.click(dialog, { clientX: 0, clientY: 0 }); expect(dismiss).toHaveBeenCalledTimes(3);
});

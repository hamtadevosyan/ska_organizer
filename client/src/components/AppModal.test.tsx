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

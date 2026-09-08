import { useEffect, useId, useRef } from 'react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  pending = false,
  onCancel,
  onConfirm
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [open]);

  const close = () => {
    onCancel();
    window.setTimeout(() => openerRef.current?.focus(), 0);
  };

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) close();
      }}
    >
      <div className="confirm-dialog-body">
        <h2 id={titleId}>{title}</h2>
        <div className="confirm-dialog-copy">{children}</div>
      </div>
      <div className="confirm-dialog-actions">
        <button type="button" className="button button-quiet" onClick={close} disabled={pending}>Cancel</button>
        <button type="button" className="button button-destructive" onClick={onConfirm} disabled={pending}>
          {pending ? 'Working…' : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

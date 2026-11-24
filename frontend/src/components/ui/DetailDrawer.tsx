import { pickLanguage } from '../../core/i18n/i18n';
import { PropsWithChildren, ReactNode, useEffect, useId, useRef } from 'react';
import { Button } from './Button';
import { useWorkspace } from '../../core/workspace/workspace';

export function DetailDrawer({ open, onClose, title, eyebrow, footer, children }: PropsWithChildren<{ open: boolean; onClose: () => void; title: string; eyebrow?: string; footer?: ReactNode }>) {
  const { language } = useWorkspace();
  const closeLabel = pickLanguage(language, { cs: 'Zavřít', en: 'Close', ua: 'Закрити' });
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="detail-drawer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="detail-drawer__panel">
        <header className="detail-drawer__header">
          <div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2 id={titleId}>{title}</h2></div>
          <Button size="sm" tone="ghost" onClick={onClose}>{closeLabel}</Button>
        </header>
        <div className="detail-drawer__body">{children}</div>
        {footer && <footer className="detail-drawer__footer">{footer}</footer>}
      </div>
    </dialog>
  );
}

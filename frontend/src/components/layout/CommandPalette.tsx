import { pickLanguage } from '../../core/i18n/i18n';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getNavigationForMode, RouteKey } from '../../app/navigation';
import { useWorkspace } from '../../core/workspace/workspace';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (route: RouteKey) => void;
}

export function CommandPalette({ open, onClose, onNavigate }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { can, language, roleProfile, workspaceMode } = useWorkspace();
  const commandCopy = pickLanguage(language, {
    cs: {
      open: 'Otevřít', role: 'Moje role', dialog: 'Vyhledávání v systému',
      input: 'Hledat v systému', close: 'Zavřít', empty: 'Žádné výsledky',
    },
    en: {
      open: 'Open', role: 'My role', dialog: 'System search',
      input: 'Search the system', close: 'Close', empty: 'No results',
    },
    ua: {
      open: 'Відкрити', role: 'Моя роль', dialog: 'Пошук у системі',
      input: 'Шукати в системі', close: 'Закрити', empty: 'Результатів немає',
    },
  });
  const commands = useMemo(() => {
    const routeCommands = getNavigationForMode(workspaceMode, language)
      .filter((item) => can(item.permission))
      .map((item) => ({ label: `${commandCopy.open} ${item.label}`, meta: item.eyebrow, action: () => onNavigate(item.key) }));
    const base = [
      { label: `${commandCopy.role}: ${roleProfile.label}`, meta: roleProfile.description, action: () => onNavigate(roleProfile.homeRoute) },
      ...routeCommands,
    ];
    const q = searchText(query.trim());
    return q ? base.filter((item) => searchText(`${item.label} ${item.meta}`).includes(q)).slice(0, 8) : base.slice(0, 8);
  }, [query, onNavigate, can, language, roleProfile, workspaceMode, commandCopy.open, commandCopy.role]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      inputRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const dismiss = () => {
    setQuery('');
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="command"
      aria-label={commandCopy.dialog}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <form
        className="command__input"
        onSubmit={(event) => {
          event.preventDefault();
          const first = commands[0];
          if (!first || !query.trim()) return;
          first.action();
          dismiss();
        }}
      >
        <span aria-hidden="true">⌕</span>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={commandCopy.input}
          aria-label={commandCopy.input}
        />
        <button type="button" aria-label={commandCopy.close} onClick={dismiss}>Esc</button>
      </form>
      <div className="command__list">
        {commands.length === 0 && <p role="status">{commandCopy.empty}</p>}
        {commands.map((command, index) => (
          <button
            key={`${command.label}-${index}`}
            type="button"
            onClick={() => {
              command.action();
              dismiss();
            }}
          >
            <span>{command.label}</span>
            <small>{command.meta}</small>
          </button>
        ))}
      </div>
    </dialog>
  );
}

function searchText(value: string) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

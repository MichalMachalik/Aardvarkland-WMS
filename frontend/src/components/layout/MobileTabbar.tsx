import { pickLanguage } from '../../core/i18n/i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { getNavigationForMode, getNavigationSections, RouteKey } from '../../app/navigation';
import { cx } from '../../core/utils/format';
import { useWorkspace } from '../../core/workspace/workspace';

export function MobileTabbar({ route, onNavigate }: { route: RouteKey; onNavigate: (route: RouteKey) => void }) {
  const { can, language, workspaceMode } = useWorkspace();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const visibleItems = getNavigationForMode(workspaceMode, language).filter((item) => can(item.permission));
  const itemsByRoute = new Map(visibleItems.map((item) => [item.key, item]));
  const sections = getNavigationSections(workspaceMode, language).map((section) => ({
    label: section.label,
    items: section.routes.flatMap((key) => itemsByRoute.get(key) ?? []),
  }));
  const primaryItems = sections.flatMap((section) => section.items).slice(0, 4);
  const primaryRoutes = new Set(primaryItems.map((item) => item.key));
  const moreSections = sections.map((section) => ({
    ...section,
    items: section.items.filter((item) => !primaryRoutes.has(item.key)),
  })).filter((section) => section.items.length > 0);
  const moreActive = moreSections.some((section) => section.items.some((item) => item.key === route));
  const labels = pickLanguage(language, { cs: { nav: 'Mobilní navigace', more: 'Další', close: 'Zavřít nabídku' }, en: { nav: 'Mobile navigation', more: 'More', close: 'Close menu' }, ua: { nav: 'Мобільна навігація', more: 'Ще', close: 'Закрити меню' } });

  useEffect(() => {
    if (!moreOpen) return;
    menu.current?.querySelector('button')?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMoreOpen(false);
      moreButton.current?.focus();
    };
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !moreButton.current?.contains(target)) setMoreOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('pointerdown', closeOnOutsidePress);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('pointerdown', closeOnOutsidePress);
    };
  }, [moreOpen]);

  const navigate = (nextRoute: RouteKey) => {
    setMoreOpen(false);
    onNavigate(nextRoute);
  };

  return (
    <nav className="mobile-tabbar" aria-label={labels.nav}>
      {moreOpen && moreSections.length > 0 && (
        <div ref={menu} id={menuId} className="mobile-tabbar__more">
          {moreSections.map((section) => (
            <section className="mobile-tabbar__section" key={section.label} aria-label={section.label}>
              <p>{section.label}</p>
              <div className="mobile-tabbar__section-items">
                {section.items.map((item) => (
                  <button
                    type="button"
                    key={item.key}
                    className={cx(route === item.key && 'is-active')}
                    onClick={() => { moreButton.current?.focus(); navigate(item.key); }}
                    aria-current={route === item.key ? 'page' : undefined}
                  >
                    <span aria-hidden="true">{item.icon}</span>
                    <small>{item.label}</small>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {primaryItems.map((item) => (
        <button
          type="button"
          key={item.key}
          className={cx(route === item.key && 'is-active')}
          onClick={() => navigate(item.key)}
          aria-current={route === item.key ? 'page' : undefined}
        >
          <span aria-hidden="true">{item.icon}</span>
          <small>{item.label}</small>
        </button>
      ))}
      {moreSections.length > 0 && (
        <button
          ref={moreButton}
          type="button"
          className={cx((moreActive || moreOpen) && 'is-active')}
          onClick={() => setMoreOpen((open) => !open)}
          aria-expanded={moreOpen}
          aria-controls={moreOpen ? menuId : undefined}
          aria-label={moreOpen ? labels.close : labels.more}
        >
          <span aria-hidden="true">...</span>
          <small>{labels.more}</small>
        </button>
      )}
    </nav>
  );
}

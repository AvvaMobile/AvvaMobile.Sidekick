import { useEffect, type ReactNode } from 'react';

/** Full-page settings frame (same look as the Projects start page): title, Close button, Esc closes. */
export function SettingsPage({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="start-page settings-page">
      <div className="start-inner settings-inner">
        <header className="settings-head">
          <button className="btn ghost settings-back" onClick={onClose} aria-label="Close settings" title="Close (Esc)">
            ‹ Back
          </button>
          <h1>{title}</h1>
        </header>
        {children}
      </div>
    </div>
  );
}

export function Section({ title, danger, children }: { title: string; danger?: boolean; children: ReactNode }) {
  return (
    <section className={`settings-section ${danger ? 'danger' : ''}`} aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/** One form row: label (+ hint) on the left, control on the right, inline error below the control. */
export function Row({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="set-control">
        {children}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

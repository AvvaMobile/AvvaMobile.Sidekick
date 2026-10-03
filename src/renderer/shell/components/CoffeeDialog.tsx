interface Props {
  onBuy(): void;
  onClose(): void;
}

/** One-time support popup (shown once ever, on first launch). */
export function CoffeeDialog({ onBuy, onClose }: Props) {
  return (
    <div className="modal-backdrop" onKeyDown={(e) => e.key === 'Escape' && onClose()} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal coffee-modal" role="dialog" aria-label="Buy me a coffee">
        <div className="coffee-cup" aria-hidden="true">☕</div>
        <h2>Enjoying Avva Mobile Sidekick?</h2>
        <p className="muted">If it saves you time, you can support its development with a coffee.</p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Maybe later
          </button>
          <button
            className="btn primary"
            autoFocus
            onClick={() => {
              onBuy();
              onClose();
            }}
          >
            Buy me a coffee
          </button>
        </div>
      </div>
    </div>
  );
}

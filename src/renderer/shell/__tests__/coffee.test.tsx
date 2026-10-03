// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { CoffeeDialog } from '../components/CoffeeDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('coffee popup', () => {
  it('opens the support page and closes, or just closes on Maybe later', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onBuy = vi.fn();
    const onClose = vi.fn();
    act(() => root.render(<CoffeeDialog onBuy={onBuy} onClose={onClose} />));
    const btn = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label)!;
    act(() => btn('Maybe later').click());
    expect(onBuy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => btn('Buy me a coffee').click());
    expect(onBuy).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
    host.remove();
  });
});

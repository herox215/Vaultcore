import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { get } from 'svelte/store';
import ToastContainer from '../src/components/Toast/ToastContainer.svelte';
import { toastStore } from '../src/store/toastStore';

beforeEach(() => {
  toastStore._reset();
});

describe('UI-04: Toast component variants', () => {
  it('UI-04: renders error variant with ✕ icon and data-variant=error', async () => {
    render(ToastContainer);
    toastStore.push({ variant: 'error', message: 'Vault not found.' });
    const toast = await screen.findByTestId('toast');
    expect(toast.getAttribute('data-variant')).toBe('error');
    expect(toast.textContent).toContain('✕');
    expect(toast.textContent).toContain('Vault not found.');
  });

  it('UI-04: renders conflict variant with ⚠ icon and data-variant=conflict', async () => {
    render(ToastContainer);
    toastStore.push({
      variant: 'conflict',
      message: 'Conflict in note.md — local version kept.',
    });
    const toast = await screen.findByTestId('toast');
    expect(toast.getAttribute('data-variant')).toBe('conflict');
    expect(toast.textContent).toContain('⚠');
  });

  it('UI-04: renders clean-merge variant with ✓ icon and data-variant=clean-merge', async () => {
    render(ToastContainer);
    toastStore.push({
      variant: 'clean-merge',
      message: 'External changes merged into note.md.',
    });
    const toast = await screen.findByTestId('toast');
    expect(toast.getAttribute('data-variant')).toBe('clean-merge');
    expect(toast.textContent).toContain('✓');
  });

  it('UI-04: dismiss button removes the toast from the DOM', async () => {
    render(ToastContainer);
    toastStore.push({ variant: 'error', message: 'click me' });
    const dismiss = await screen.findByLabelText('Dismiss notification');
    await fireEvent.click(dismiss);
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('UI-04: auto-dismiss after 5000 ms removes the toast', () => {
    vi.useFakeTimers();
    try {
      render(ToastContainer);
      toastStore.push({ variant: 'error', message: 'fleeting' });
      expect(get(toastStore)).toHaveLength(1);
      vi.advanceTimersByTime(5001);
      expect(get(toastStore)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('UI-04: stacking past 3 toasts drops the oldest from the DOM', async () => {
    render(ToastContainer);
    toastStore.push({ variant: 'error', message: 'a' });
    toastStore.push({ variant: 'error', message: 'b' });
    toastStore.push({ variant: 'error', message: 'c' });
    toastStore.push({ variant: 'error', message: 'd' });
    const toasts = await screen.findAllByTestId('toast');
    expect(toasts).toHaveLength(3);
    const texts = toasts.map((t) => t.textContent ?? '');
    expect(texts.some((t) => t.includes('a'))).toBe(false);
    expect(texts.some((t) => t.includes('d'))).toBe(true);
  });
});

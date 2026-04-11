import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { vaultStore } from '../src/store/vaultStore';
import { toastStore } from '../src/store/toastStore';

beforeEach(() => {
  vaultStore.reset();
  toastStore._reset();
});

describe('VAULT-02 / VAULT-04 / VAULT-05 vaultStore logic', () => {
  it('VAULT-02: vaultStore starts idle with empty fileList and null currentPath', () => {
    const s = get(vaultStore);
    expect(s.status).toBe('idle');
    expect(s.fileList).toEqual([]);
    expect(s.currentPath).toBeNull();
    expect(s.errorMessage).toBeNull();
    expect(s.fileCount).toBe(0);
  });

  it('VAULT-05: setError transitions to error status and records the message', () => {
    vaultStore.setError('Vault unavailable. Check that the folder is still mounted.');
    const s = get(vaultStore);
    expect(s.status).toBe('error');
    expect(s.errorMessage).toContain('Vault unavailable');
  });

  it('VAULT-05: reset returns the store to idle with cleared state', () => {
    vaultStore.setError('boom');
    vaultStore.reset();
    const s = get(vaultStore);
    expect(s.status).toBe('idle');
    expect(s.errorMessage).toBeNull();
    expect(s.currentPath).toBeNull();
  });

  it('VAULT-04: setReady populates currentPath, fileList and switches to ready', () => {
    vaultStore.setReady({
      currentPath: '/tmp/v',
      fileList: ['a.md', 'b.md'],
      fileCount: 2,
    });
    const s = get(vaultStore);
    expect(s.status).toBe('ready');
    expect(s.currentPath).toBe('/tmp/v');
    expect(s.fileList).toEqual(['a.md', 'b.md']);
    expect(s.fileCount).toBe(2);
  });

  it('VAULT-04: status transitions opening → ready via setOpening → setReady', () => {
    vaultStore.setOpening('/tmp/v');
    expect(get(vaultStore).status).toBe('opening');
    vaultStore.setReady({ currentPath: '/tmp/v', fileList: [], fileCount: 0 });
    expect(get(vaultStore).status).toBe('ready');
  });
});

describe('UI-04: toastStore queue behaviour', () => {
  it('UI-04: push returns a positive id and adds one toast', () => {
    const id = toastStore.push({ variant: 'error', message: 'test' });
    expect(id).toBeGreaterThan(0);
    const toasts = get(toastStore);
    expect(toasts).toHaveLength(1);
    const first = toasts[0];
    expect(first).toBeDefined();
    expect(first?.variant).toBe('error');
    expect(first?.message).toBe('test');
  });

  it('UI-04: auto-dismiss after 5000 ms', () => {
    vi.useFakeTimers();
    try {
      toastStore.push({ variant: 'error', message: 'test' });
      expect(get(toastStore)).toHaveLength(1);
      vi.advanceTimersByTime(4999);
      expect(get(toastStore)).toHaveLength(1);
      vi.advanceTimersByTime(2);
      expect(get(toastStore)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('UI-04: caps at 3 — a 4th push drops the oldest toast', () => {
    toastStore.push({ variant: 'error', message: 'a' });
    toastStore.push({ variant: 'error', message: 'b' });
    toastStore.push({ variant: 'error', message: 'c' });
    toastStore.push({ variant: 'error', message: 'd' });
    const toasts = get(toastStore);
    expect(toasts).toHaveLength(3);
    expect(toasts.map((t) => t.message)).toEqual(['b', 'c', 'd']);
  });

  it('UI-04: dismiss removes a toast by id', () => {
    const id = toastStore.push({ variant: 'error', message: 'x' });
    toastStore.dismiss(id);
    expect(get(toastStore)).toHaveLength(0);
  });
});

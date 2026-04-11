import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import WelcomeScreen from '../src/components/Welcome/WelcomeScreen.svelte';

describe('VAULT-04 / VAULT-01: Welcome screen render and interaction', () => {
  it('VAULT-04: renders VaultCore heading and Open vault button', () => {
    render(WelcomeScreen, {
      recent: [],
      onOpenVault: () => {},
      onPickVault: () => {},
    });
    expect(screen.getByRole('heading', { name: 'VaultCore' })).toBeInTheDocument();
    expect(screen.getByTestId('open-vault-button')).toHaveTextContent('Open vault');
  });

  it('VAULT-04: renders the UI-SPEC tagline', () => {
    render(WelcomeScreen, {
      recent: [],
      onOpenVault: () => {},
      onPickVault: () => {},
    });
    expect(
      screen.getByText('A faster Markdown workspace for large vaults.'),
    ).toBeInTheDocument();
  });

  it('VAULT-04: renders empty state with both copy lines when recent list is empty', () => {
    render(WelcomeScreen, {
      recent: [],
      onOpenVault: () => {},
      onPickVault: () => {},
    });
    const empty = screen.getByTestId('recent-empty');
    expect(empty.textContent).toContain('No recent vaults');
    expect(empty.textContent).toContain('Open a folder to get started.');
  });

  it('VAULT-04: renders recent vault rows when the list has entries', () => {
    render(WelcomeScreen, {
      recent: [
        { path: '/Users/alice/notes', last_opened: '2026-04-10T12:00:00Z' },
        { path: '/Users/alice/work', last_opened: '2026-04-09T08:30:00Z' },
      ],
      onOpenVault: () => {},
      onPickVault: () => {},
    });
    const rows = screen.getAllByTestId('recent-row');
    expect(rows).toHaveLength(2);
    const first = rows[0];
    expect(first).toBeDefined();
    expect(first?.textContent).toContain('/Users/alice/notes');
  });

  it('VAULT-01: clicking Open vault invokes the onPickVault handler', async () => {
    const handler = vi.fn();
    render(WelcomeScreen, {
      recent: [],
      onOpenVault: () => {},
      onPickVault: handler,
    });
    await fireEvent.click(screen.getByTestId('open-vault-button'));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('VAULT-04: clicking a recent row invokes onOpenVault with that path', async () => {
    const handler = vi.fn();
    render(WelcomeScreen, {
      recent: [{ path: '/a/b', last_opened: '2026-04-11T00:00:00Z' }],
      onOpenVault: handler,
      onPickVault: () => {},
    });
    const row = screen.getByTestId('recent-row');
    await fireEvent.click(row);
    expect(handler).toHaveBeenCalledWith('/a/b');
  });
});

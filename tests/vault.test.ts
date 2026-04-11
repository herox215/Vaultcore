import { describe, it } from 'vitest';

describe('VAULT-01: open vault via folder picker', () => {
  it.todo('VAULT-01: invokes native dialog open({ directory: true }) and returns picked path');
});

describe('VAULT-02: recent-vaults.json persistence', () => {
  it.todo('VAULT-02: round-trips { vaults: [...] } through appDataDir/recent-vaults.json');
  it.todo('VAULT-02: reads empty array when file does not exist');
});

describe('VAULT-04: recent vault list eviction (FIFO at 10)', () => {
  it.todo('VAULT-04: caps at 10 entries and evicts the oldest when a new vault is added');
  it.todo('VAULT-04: deduplicates by path (moves existing entry to the front instead of adding a duplicate)');
});

describe('VAULT-05: unreachable vault fallback', () => {
  it.todo('VAULT-05: when recent-vaults.json points at a missing path, vaultStore resets to idle and emits an error message');
});

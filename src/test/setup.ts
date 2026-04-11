import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Fake timers helper used by autoSave.test.ts — opt-in per test
export function withFakeTimers() {
  vi.useFakeTimers();
  return () => vi.useRealTimers();
}

import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Fake timers helper used by autoSave.test.ts — opt-in per test
export function withFakeTimers() {
  vi.useFakeTimers();
  return () => vi.useRealTimers();
}

// jsdom does not implement matchMedia. Provide a controllable stub so tests
// that touch viewport-aware code (viewportStore, tabMorph's
// prefers-reduced-motion check, etc.) don't crash. Suites that need specific
// matches/listener behavior override via vi.stubGlobal("matchMedia", ...).
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList,
  });
}

# E2E Tests

End-to-end tests using [WebdriverIO](https://webdriver.io/) and [tauri-driver](https://crates.io/crates/tauri-driver). Tests run against the compiled Tauri app and interact with the real UI.

## Prerequisites

1. **tauri-driver** must be installed:
   ```bash
   cargo install tauri-driver
   ```

2. A **release build** of the app is required:
   ```bash
   pnpm tauri build
   ```

## Running tests

```bash
# Run e2e tests (requires existing release build)
pnpm test:e2e

# Build + run e2e tests
pnpm test:e2e:build
```

## How it works

- `tauri-driver` starts automatically and bridges the WebDriver protocol to the Tauri webview.
- Each test suite creates a temporary vault (`e2e-vault-<uuid>`) in the OS temp directory and opens it via Tauri IPC — bypassing the native file picker dialog.
- The test vault is cleaned up after each suite, even on failure.

## Structure

```
e2e/
├── helpers/
│   ├── vault.ts          # Test vault creation & cleanup
│   └── open-vault.ts     # Opens a vault in the app via IPC
├── specs/
│   ├── vault.spec.ts     # Vault open, note open, edit, tabs
│   ├── navigation.spec.ts    # Wiki-link click, quick switcher
│   └── error-handling.spec.ts # #90 regression (no spurious toasts)
├── tsconfig.json
└── README.md
```

## Writing new tests

1. Create a new `.spec.ts` file in `e2e/specs/`.
2. Use `createTestVault()` + `openVaultInApp()` in the `before` hook.
3. Call `vault.cleanup()` in `after`.
4. Add fixture files in `e2e/helpers/vault.ts` if the test needs specific content.

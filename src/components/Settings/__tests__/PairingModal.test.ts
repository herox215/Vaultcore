// UI-3 — PairingModal.svelte unit tests.
//
// Drives the 4-step state machine through a mocked syncStore so the
// modal can be exercised without a real Tauri peer transport. Bridge
// engineer note (UI-1): `pairing_step` returns `awaiting_peer` until
// the engine drives raw_keys into the session and `pairing_confirm`
// errors when raw_keys are absent — both surface to UI as a generic
// "still verifying" state and never as a security-relevant error.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { tick } from "svelte";
import type {
  PairingStartInitiator,
  PairingStartResponder,
  PairingStep,
  VaultRef,
} from "../../../ipc/commands";
import type { PendingPairingSession } from "../../../store/syncStore";

// ── Mocks ────────────────────────────────────────────────────────────
//
// The store is mocked as a small fake whose `pendingPairingSession`
// readable can be driven by the test. Action functions are spies so
// each test can assert call ordering without involving Tauri.
//
// `vi.mock` factories are hoisted, so we build everything inside the
// factory and re-import via `vi.importMock` after `import`s settle.

vi.mock("../../../store/syncStore", () => {
  // `writable` import inside the factory — vi hoists the factory above
  // top-level imports, so a plain reference would be uninitialized.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { writable } = require("svelte/store") as typeof import("svelte/store");
  const pending = writable<PendingPairingSession | null>(null);
  return {
    pendingPairingSession: { subscribe: pending.subscribe },
    __pendingPairingSessionStore: pending,
    startInitiator: vi.fn<() => Promise<PairingStartInitiator>>(),
    startResponder: vi.fn<(pin: string) => Promise<PairingStartResponder>>(),
    stepPairing: vi.fn<(payload?: string) => Promise<PairingStep>>(),
    confirmPairing: vi.fn<() => Promise<void>>(),
    cancelPairing: vi.fn<() => Promise<void>>(),
    grantVault: vi.fn<
      (peerDeviceId: string, vaultId: string, scope: "read" | "read+write") => Promise<void>
    >(),
  };
});

// `qrcode` is dynamically imported by the component (smaller bundle on
// the role-selection step). Stub the toDataURL surface so jsdom doesn't
// choke on canvas APIs.
vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn(async () => "data:image/png;base64,FAKEQR"),
  },
  toDataURL: vi.fn(async () => "data:image/png;base64,FAKEQR"),
}));

import * as syncStoreMock from "../../../store/syncStore";
import PairingModal from "../PairingModal.svelte";

const pendingPairingSessionStore = (syncStoreMock as unknown as {
  __pendingPairingSessionStore: import("svelte/store").Writable<PendingPairingSession | null>;
}).__pendingPairingSessionStore;
const startInitiator = syncStoreMock.startInitiator as unknown as ReturnType<
  typeof vi.fn<() => Promise<PairingStartInitiator>>
>;
const startResponder = syncStoreMock.startResponder as unknown as ReturnType<
  typeof vi.fn<(pin: string) => Promise<PairingStartResponder>>
>;
const stepPairing = syncStoreMock.stepPairing as unknown as ReturnType<
  typeof vi.fn<(payload?: string) => Promise<PairingStep>>
>;
const confirmPairing = syncStoreMock.confirmPairing as unknown as ReturnType<
  typeof vi.fn<() => Promise<void>>
>;
const cancelPairing = syncStoreMock.cancelPairing as unknown as ReturnType<
  typeof vi.fn<() => Promise<void>>
>;
const grantVault = syncStoreMock.grantVault as unknown as ReturnType<
  typeof vi.fn<
    (peerDeviceId: string, vaultId: string, scope: "read" | "read+write") => Promise<void>
  >
>;

const SAMPLE_VAULTS: VaultRef[] = [
  { id: "v-alpha", name: "Alpha" },
  { id: "v-beta", name: "Beta" },
];

const SAMPLE_INITIATOR: PairingStartInitiator = {
  session_id: "sess-A",
  pin: "123456",
  expires_at_unix: Math.floor(Date.now() / 1000) + 90,
};

function pendingInitiator(): PendingPairingSession {
  return {
    session_id: SAMPLE_INITIATOR.session_id,
    role: "initiator",
    pin: SAMPLE_INITIATOR.pin,
    expires_at_unix: SAMPLE_INITIATOR.expires_at_unix,
    last_step: null,
  };
}

function pendingResponder(): PendingPairingSession {
  return {
    session_id: "sess-R",
    role: "responder",
    pin: null,
    expires_at_unix: null,
    last_step: null,
  };
}

function awaitingConfirmation(fingerprint: string): PairingStep {
  return {
    kind: "awaiting_confirmation",
    peer_fingerprint: fingerprint,
    attempts_remaining: 3,
  };
}

function failedStep(remaining: number): PairingStep {
  return { kind: "failed", peer_fingerprint: null, attempts_remaining: remaining };
}

beforeEach(() => {
  pendingPairingSessionStore.set(null);
  startInitiator.mockReset();
  startResponder.mockReset();
  stepPairing.mockReset();
  confirmPairing.mockReset();
  cancelPairing.mockReset();
  grantVault.mockReset();

  startInitiator.mockResolvedValue(SAMPLE_INITIATOR);
  startResponder.mockResolvedValue({ session_id: "sess-R" });
  stepPairing.mockResolvedValue({
    kind: "awaiting_peer",
    peer_fingerprint: null,
    attempts_remaining: 3,
  });
  confirmPairing.mockResolvedValue();
  cancelPairing.mockResolvedValue();
  grantVault.mockResolvedValue();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function open(props: Partial<{
  open: boolean;
  vaults: VaultRef[];
  triggerEl: HTMLElement | null;
  selfDeviceName: string;
  onClose: () => void;
}> = {}) {
  return render(PairingModal, {
    props: {
      open: true,
      vaults: SAMPLE_VAULTS,
      triggerEl: null,
      selfDeviceName: "MacBook",
      onClose: vi.fn(),
      ...props,
    },
  });
}

describe("PairingModal — open + focus", () => {
  it("opens_with_focus_on_first_interactive_element", async () => {
    const { container } = open();
    await tick();
    await tick();
    // Step 1 is role selection — first interactive is the initiator radio.
    const firstRadio = container.querySelector<HTMLInputElement>(
      'input[type="radio"][name="vc-pairing-role"]',
    );
    expect(firstRadio).toBeTruthy();
    expect(document.activeElement).toBe(firstRadio);
  });
});

describe("PairingModal — initiator step 2 PIN display", () => {
  it("initiator_displays_6_digit_pin_with_dash_separator", async () => {
    const { container } = open();
    await tick();
    pendingPairingSessionStore.set(pendingInitiator());
    await tick();
    await tick();
    const pinDisplay = container.querySelector('[data-testid="pairing-initiator-pin"]');
    expect(pinDisplay).toBeTruthy();
    // Visible text must group XXX–XXX with an en-dash (U+2013) so the
    // user reads two triplets, not one stretched run.
    expect(pinDisplay!.textContent).toContain("123–456");
  });
});

describe("PairingModal — responder step 2 PIN input", () => {
  function setupResponder() {
    const r = open();
    // Click the responder radio and continue to step 2.
    return r;
  }

  async function selectResponderAndAdvance(container: HTMLElement) {
    const responderRadio = container.querySelector<HTMLInputElement>(
      'input[type="radio"][value="responder"]',
    )!;
    await fireEvent.click(responderRadio);
    await tick();
    const next = container.querySelector<HTMLButtonElement>(
      '[data-testid="pairing-next"]',
    )!;
    await fireEvent.click(next);
    await tick();
  }

  it("responder_paste_6_digits_distributes_to_six_fields", async () => {
    const { container } = setupResponder();
    await tick();
    await selectResponderAndAdvance(container);

    const fields = container.querySelectorAll<HTMLInputElement>(
      '[data-testid^="pairing-pin-field-"]',
    );
    expect(fields.length).toBe(6);
    const first = fields[0]!;
    first.focus();
    // Simulate a real paste: clipboardData with the full PIN. The
    // component intercepts `paste` before the native single-char
    // distribution and writes one digit into each field. jsdom doesn't
    // implement `DataTransfer`, so we synthesize the minimal surface
    // (`getData`) the component reads.
    const clipboardData = {
      getData: (type: string) => (type === "text" ? "246813" : ""),
    } as unknown as DataTransfer;
    await fireEvent.paste(first, { clipboardData });
    await tick();
    expect(Array.from(fields).map((f) => f.value)).toEqual([
      "2",
      "4",
      "6",
      "8",
      "1",
      "3",
    ]);
  });

  it("responder_auto_advances_on_digit_entry", async () => {
    const { container } = setupResponder();
    await tick();
    await selectResponderAndAdvance(container);
    const fields = container.querySelectorAll<HTMLInputElement>(
      '[data-testid^="pairing-pin-field-"]',
    );
    fields[0]!.focus();
    await fireEvent.input(fields[0]!, { target: { value: "7" } });
    await tick();
    expect(document.activeElement).toBe(fields[1]);
    await fireEvent.input(fields[1]!, { target: { value: "3" } });
    await tick();
    expect(document.activeElement).toBe(fields[2]);
  });

  it("responder_backspace_moves_to_previous_field", async () => {
    const { container } = setupResponder();
    await tick();
    await selectResponderAndAdvance(container);
    const fields = container.querySelectorAll<HTMLInputElement>(
      '[data-testid^="pairing-pin-field-"]',
    );
    // Type into first two so cursor is on field index 2 (third box).
    fields[0]!.focus();
    await fireEvent.input(fields[0]!, { target: { value: "9" } });
    await tick();
    await fireEvent.input(fields[1]!, { target: { value: "9" } });
    await tick();
    // Now on fields[2], empty. Backspace on empty must move back.
    expect(document.activeElement).toBe(fields[2]);
    await fireEvent.keyDown(fields[2]!, { key: "Backspace" });
    await tick();
    expect(document.activeElement).toBe(fields[1]);
  });
});

describe("PairingModal — failure / lockout", () => {
  it("failed_attempt_shows_remaining_count_with_role_alert", async () => {
    stepPairing.mockResolvedValueOnce(failedStep(2));
    // Simulate startResponder populating the store after the user
    // submits the PIN — the test's store fake doesn't auto-do this.
    startResponder.mockImplementation(async () => {
      pendingPairingSessionStore.set(pendingResponder());
      return { session_id: "sess-R" };
    });
    const { container } = open();
    await tick();
    const responderRadio = container.querySelector<HTMLInputElement>(
      'input[type="radio"][value="responder"]',
    )!;
    await fireEvent.click(responderRadio);
    await tick();
    await fireEvent.click(
      container.querySelector<HTMLButtonElement>('[data-testid="pairing-next"]')!,
    );
    await tick();
    const fields = container.querySelectorAll<HTMLInputElement>(
      '[data-testid^="pairing-pin-field-"]',
    );
    fields[0]!.focus();
    const digits = ["1", "1", "1", "1", "1", "1"];
    for (let i = 0; i < 6; i++) {
      await fireEvent.input(fields[i]!, { target: { value: digits[i] } });
      await tick();
    }
    // Final input completes the PIN — the component dispatches step()
    // with the joined value. Awaiting the spy's promise lets the
    // component apply the failed result.
    await stepPairing.mock.results[0]?.value;
    await tick();
    await tick();
    const err = container.querySelector('[data-testid="pairing-pin-error"]');
    expect(err).toBeTruthy();
    expect(err!.getAttribute("role")).toBe("alert");
    expect(err!.textContent).toMatch(/2 Versuche verbleibend/);
  });

  it("error_message_does_not_disclose_which_side_typed_wrong", async () => {
    stepPairing.mockResolvedValueOnce(failedStep(2));
    startResponder.mockImplementation(async () => {
      pendingPairingSessionStore.set(pendingResponder());
      return { session_id: "sess-R" };
    });
    const { container } = open();
    await tick();
    const responderRadio = container.querySelector<HTMLInputElement>(
      'input[type="radio"][value="responder"]',
    )!;
    await fireEvent.click(responderRadio);
    await tick();
    await fireEvent.click(
      container.querySelector<HTMLButtonElement>('[data-testid="pairing-next"]')!,
    );
    await tick();
    const fields = container.querySelectorAll<HTMLInputElement>(
      '[data-testid^="pairing-pin-field-"]',
    );
    fields[0]!.focus();
    for (let i = 0; i < 6; i++) {
      await fireEvent.input(fields[i]!, { target: { value: "1" } });
      await tick();
    }
    await stepPairing.mock.results[0]?.value;
    await tick();
    const err = container.querySelector('[data-testid="pairing-pin-error"]');
    expect(err).toBeTruthy();
    const text = err!.textContent?.toLowerCase() ?? "";
    // Must not mention either side of the exchange.
    expect(text).not.toMatch(/du|dein|peer|gegenstelle|sender|empfänger|other|their/);
  });

  it("lockout_replaces_input_after_3_failures", async () => {
    stepPairing.mockResolvedValue(failedStep(0));
    startResponder.mockImplementation(async () => {
      pendingPairingSessionStore.set(pendingResponder());
      return { session_id: "sess-R" };
    });
    const { container } = open();
    await tick();
    const responderRadio = container.querySelector<HTMLInputElement>(
      'input[type="radio"][value="responder"]',
    )!;
    await fireEvent.click(responderRadio);
    await tick();
    await fireEvent.click(
      container.querySelector<HTMLButtonElement>('[data-testid="pairing-next"]')!,
    );
    await tick();
    const fields = container.querySelectorAll<HTMLInputElement>(
      '[data-testid^="pairing-pin-field-"]',
    );
    fields[0]!.focus();
    for (let i = 0; i < 6; i++) {
      await fireEvent.input(fields[i]!, { target: { value: "1" } });
      await tick();
    }
    // Wait for the step() promise the component fired.
    await stepPairing.mock.results[stepPairing.mock.results.length - 1]?.value;
    await tick();
    await tick();
    const lockout = container.querySelector('[data-testid="pairing-lockout"]');
    expect(lockout).toBeTruthy();
    expect(lockout!.getAttribute("role")).toBe("alert");
    expect(lockout!.textContent).toMatch(/Gesperrt/);
    // Input fields are gone.
    expect(
      container.querySelectorAll('[data-testid^="pairing-pin-field-"]').length,
    ).toBe(0);
  });
});

describe("PairingModal — countdown a11y", () => {
  it("countdown_announces_at_10_second_intervals_only", async () => {
    vi.useFakeTimers();
    // Pin expires 90 s in the future relative to a fixed clock.
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const { container } = open();
    await tick();
    pendingPairingSessionStore.set({
      session_id: "sess-A",
      role: "initiator",
      pin: "123456",
      expires_at_unix: Math.floor(now / 1000) + 90,
      last_step: null,
    });
    await tick();
    await tick();

    const live = container.querySelector('[data-testid="pairing-countdown-live"]');
    expect(live).toBeTruthy();
    expect(live!.getAttribute("aria-live")).toBe("polite");

    // First snap: 90 → "90".
    expect(live!.textContent?.trim()).toBe("90");

    // Tick 5 s — under the 10-second snap, announcement must NOT change.
    vi.advanceTimersByTime(5_000);
    await tick();
    expect(live!.textContent?.trim()).toBe("90");

    // Tick another 5 s (10 s total) — snap to 80.
    vi.advanceTimersByTime(5_000);
    await tick();
    expect(live!.textContent?.trim()).toBe("80");

    // Inner per-second readout, if rendered, must have aria-live=off so
    // it doesn't double-announce.
    const inner = container.querySelector('[data-testid="pairing-countdown-inner"]');
    if (inner) {
      expect(inner.getAttribute("aria-live")).toBe("off");
    }
  });
});

describe("PairingModal — escape", () => {
  it("escape_cancels_pairing", async () => {
    const onClose = vi.fn();
    open({ onClose });
    await tick();
    pendingPairingSessionStore.set(pendingInitiator());
    await tick();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await tick();
    await tick();
    expect(cancelPairing).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("PairingModal — step 4 vault grant", () => {
  it("vault_grant_step_disables_done_until_at_least_one_checked", async () => {
    const { container } = open();
    await tick();
    // Drive into step 4 by placing the session in awaiting_confirmation
    // and confirming the keys, then waiting for the synthetic step-4
    // transition.
    pendingPairingSessionStore.set({
      ...pendingInitiator(),
      last_step: awaitingConfirmation("ABCDEF1234567890"),
    });
    await tick();
    await tick();
    const confirmBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="pairing-key-confirm"]',
    )!;
    expect(confirmBtn).toBeTruthy();
    await fireEvent.click(confirmBtn);
    await tick();
    await tick();

    const done = container.querySelector<HTMLButtonElement>(
      '[data-testid="pairing-done"]',
    );
    expect(done).toBeTruthy();
    expect(done!.disabled).toBe(true);

    const checkbox = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"][data-vault-id="v-alpha"]',
    )!;
    await fireEvent.click(checkbox);
    await tick();
    expect(done!.disabled).toBe(false);
  });
});

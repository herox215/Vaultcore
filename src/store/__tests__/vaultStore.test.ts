// Unit tests for `vaultStore.applyFileChange` (#307) — the incremental
// updater that keeps `fileList` in sync with FS events from the Rust watcher.

import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";

import { vaultStore } from "../vaultStore";
import type { FileChangePayload } from "../../ipc/events";

const VAULT_ROOT = "/tmp/test-vault";

function openVault(fileList: string[]): void {
  vaultStore.setOpening(VAULT_ROOT);
  vaultStore.setReady({
    currentPath: VAULT_ROOT,
    fileList,
    fileCount: fileList.length,
  });
}

function abs(rel: string): string {
  return `${VAULT_ROOT}/${rel}`;
}

describe("vaultStore.applyFileChange (#307)", () => {
  beforeEach(() => {
    vaultStore.reset();
  });

  describe("create", () => {
    it("appends a new .md file relative path and keeps the list sorted", () => {
      openVault(["a.md", "c.md"]);
      vaultStore.applyFileChange({ path: abs("b.md"), kind: "create" });
      const s = get(vaultStore);
      expect(s.fileList).toEqual(["a.md", "b.md", "c.md"]);
      expect(s.fileCount).toBe(3);
    });

    it("ignores non-.md files", () => {
      openVault(["a.md"]);
      vaultStore.applyFileChange({ path: abs("image.png"), kind: "create" });
      expect(get(vaultStore).fileList).toEqual(["a.md"]);
    });

    it("is idempotent for duplicate create events", () => {
      openVault(["a.md"]);
      vaultStore.applyFileChange({ path: abs("b.md"), kind: "create" });
      vaultStore.applyFileChange({ path: abs("b.md"), kind: "create" });
      expect(get(vaultStore).fileList).toEqual(["a.md", "b.md"]);
    });

    it("ignores paths outside the vault root", () => {
      openVault(["a.md"]);
      vaultStore.applyFileChange({
        path: "/some/other/place/x.md",
        kind: "create",
      });
      expect(get(vaultStore).fileList).toEqual(["a.md"]);
    });

    it("normalizes backslashes in nested Windows-style paths", () => {
      openVault([]);
      vaultStore.applyFileChange({
        path: `${VAULT_ROOT}\\notes\\daily.md`,
        kind: "create",
      });
      expect(get(vaultStore).fileList).toEqual(["notes/daily.md"]);
    });
  });

  describe("delete", () => {
    it("removes the file from fileList", () => {
      openVault(["a.md", "b.md", "c.md"]);
      vaultStore.applyFileChange({ path: abs("b.md"), kind: "delete" });
      const s = get(vaultStore);
      expect(s.fileList).toEqual(["a.md", "c.md"]);
      expect(s.fileCount).toBe(2);
    });

    it("is a no-op when the path is not in the list", () => {
      openVault(["a.md"]);
      vaultStore.applyFileChange({ path: abs("ghost.md"), kind: "delete" });
      expect(get(vaultStore).fileList).toEqual(["a.md"]);
    });
  });

  describe("rename", () => {
    it("swaps old for new and keeps the list sorted", () => {
      openVault(["a.md", "b.md"]);
      vaultStore.applyFileChange({
        path: abs("a.md"),
        new_path: abs("z.md"),
        kind: "rename",
      });
      expect(get(vaultStore).fileList).toEqual(["b.md", "z.md"]);
    });

    it("treats rename out of .md scope as delete", () => {
      openVault(["a.md"]);
      vaultStore.applyFileChange({
        path: abs("a.md"),
        new_path: abs("a.txt"),
        kind: "rename",
      });
      expect(get(vaultStore).fileList).toEqual([]);
    });

    it("treats rename into .md scope as create", () => {
      openVault([]);
      vaultStore.applyFileChange({
        path: abs("note.txt"),
        new_path: abs("note.md"),
        kind: "rename",
      });
      expect(get(vaultStore).fileList).toEqual(["note.md"]);
    });

    it("is a no-op without new_path", () => {
      openVault(["a.md"]);
      vaultStore.applyFileChange({ path: abs("a.md"), kind: "rename" });
      expect(get(vaultStore).fileList).toEqual(["a.md"]);
    });
  });

  describe("modify", () => {
    it("is a no-op (content change, list unchanged)", () => {
      openVault(["a.md"]);
      vaultStore.applyFileChange({ path: abs("a.md"), kind: "modify" });
      expect(get(vaultStore).fileList).toEqual(["a.md"]);
    });
  });

  describe("guards", () => {
    it("is a no-op when no vault is open", () => {
      vaultStore.applyFileChange({ path: "/anywhere/a.md", kind: "create" });
      expect(get(vaultStore).fileList).toEqual([]);
      expect(get(vaultStore).currentPath).toBeNull();
    });
  });

  describe("subscribers", () => {
    it("notifies subscribers when fileList actually changes", () => {
      openVault(["a.md"]);
      let notifications = 0;
      const unsub = vaultStore.subscribe(() => {
        notifications += 1;
      });
      notifications = 0; // skip the initial synchronous call

      vaultStore.applyFileChange({ path: abs("b.md"), kind: "create" });
      expect(notifications).toBeGreaterThan(0);

      unsub();
    });
  });
});

// Type-only check: FileChangePayload is importable; helps catch drift.
const _sanity: FileChangePayload = { path: "x", kind: "create" };
void _sanity;

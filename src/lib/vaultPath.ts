// Tiny path helpers shared by the embed plugin and the note-content cache.
// Kept in their own module so two callers don't go out of sync on the
// slash-normalisation rules (forward slashes, trim trailing separator).
//
// `vaultPath` is always the absolute filesystem path to the vault root —
// possibly using backslashes on Windows. Relative paths are always
// forward-slash, no leading slash, as stored in `vaultStore.fileList`.

export function toVaultRel(absPath: string, vaultPath: string | null): string | null {
  if (!vaultPath) return null;
  const absFwd = absPath.replace(/\\/g, "/");
  const vaultFwd = vaultPath.replace(/\\/g, "/").replace(/\/$/, "");
  if (absFwd === vaultFwd) return "";
  if (!absFwd.startsWith(vaultFwd + "/")) return null;
  return absFwd.slice(vaultFwd.length + 1);
}

export function absFromRel(rel: string, vaultPath: string | null): string | null {
  if (!vaultPath) return null;
  const v = vaultPath.replace(/\\/g, "/").replace(/\/$/, "");
  return `${v}/${rel}`;
}

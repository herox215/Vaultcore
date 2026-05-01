// #392 PR-B — testable correctness boundary for the SAF permission
// check. Lives outside the cfg(target_os = "android") gate so the
// `&&` decision can be unit-tested from the host build.
//
// Aristotle iter-1 finding #1: the Kotlin side originally returned a
// single `granted` boolean computed as
// `it.isReadPermission || it.isWritePermission`. Read-only grants
// (write revoked via Settings) silently passed → first save failed
// with a generic Io error → user saw a confusing toast instead of
// the dedicated re-pick UX. The fix moved the
// `read AND write` decision into Rust where this test file exercises
// it directly.

use serde::Deserialize;

/// Response from PickerPlugin's `hasPersistedPermission` command.
/// Kotlin returns the per-flag breakdown rather than a single boolean
/// because the &&-of-read-and-write decision is correctness-critical:
/// a partial grant produces silent failures on the first
/// opposite-direction operation.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
pub struct PermissionFlags {
    #[serde(rename = "hasRead")]
    pub has_read: bool,
    #[serde(rename = "hasWrite")]
    pub has_write: bool,
}

impl PermissionFlags {
    /// True iff BOTH read and write are granted. The vault needs to
    /// support edits as the dominant interaction; a read-only grant
    /// would let the user open files but every save would fail.
    /// Surface the partial grant as "no grant" so `open_vault` routes
    /// through the re-pick UX instead of returning a vault that
    /// crashes on first save.
    pub fn is_fully_granted(&self) -> bool {
        self.has_read && self.has_write
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_grant_is_not_fully_granted() {
        let p = PermissionFlags {
            has_read: true,
            has_write: false,
        };
        assert!(!p.is_fully_granted());
    }

    #[test]
    fn write_only_grant_is_not_fully_granted() {
        // Hypothetical — SAF doesn't typically vend a write-only
        // grant — but the &&-decision must still classify it as
        // not-usable.
        let p = PermissionFlags {
            has_read: false,
            has_write: true,
        };
        assert!(!p.is_fully_granted());
    }

    #[test]
    fn both_flags_grant_is_fully_granted() {
        let p = PermissionFlags {
            has_read: true,
            has_write: true,
        };
        assert!(p.is_fully_granted());
    }

    #[test]
    fn no_grant_is_not_fully_granted() {
        let p = PermissionFlags {
            has_read: false,
            has_write: false,
        };
        assert!(!p.is_fully_granted());
    }

    #[test]
    fn deserializes_from_kotlin_payload_shape() {
        // Pin the JSON contract with the Kotlin `hasPersistedPermission`
        // command. If either side renames the fields without updating
        // the other, this test catches it before runtime.
        let json = serde_json::json!({ "hasRead": true, "hasWrite": false });
        let p: PermissionFlags = serde_json::from_value(json).unwrap();
        assert!(p.has_read);
        assert!(!p.has_write);
        assert!(!p.is_fully_granted());
    }
}

// Wave 0 placeholder — full implementation lands in plan 01-01.
// Kept minimal so cargo build succeeds without committing to the enum layout.

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("placeholder")]
    Placeholder,
}

impl serde::Serialize for VaultError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str("placeholder")
    }
}

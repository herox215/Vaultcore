//! Smoke test for the embeddings stack (#190).
//!
//! Skipped silently when the runtime dylib (#191) or the bundled model (#192)
//! is not yet present; runs end-to-end once both ship.

#[cfg(feature = "embeddings")]
#[test]
fn embedding_smoke_test() {
    use crate::embeddings;

    // Best-effort discovery via the same paths the runtime would use in dev
    // (`CARGO_MANIFEST_DIR/resources/...`). No AppHandle in unit tests.
    let runtime = embeddings::runtime_path(None);
    let model = embeddings::model_dir(None);
    if runtime.is_err() || model.is_err() {
        eprintln!(
            "SKIP embedding_smoke_test: runtime={:?} model={:?}",
            runtime.is_ok(),
            model.is_ok()
        );
        return;
    }

    let v = embeddings::smoke_test(None).expect("smoke test failed");
    assert_eq!(v.len(), 384, "MiniLM-L6-v2 must yield 384-dim vectors");
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    assert!(
        (norm - 1.0).abs() < 0.01,
        "expected L2-normalized embedding, got norm {norm}"
    );
}

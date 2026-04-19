//! ORT session plumbing for #205 — owns the two session-level tunings the
//! fastembed wrapper didn't expose:
//!
//! - `SessionBuilder::with_memory_pattern(false)` — ORT's memory-pattern
//!   planner pre-allocates a worst-case activation arena on first run. For
//!   MiniLM's dynamic batch dim that arena sticks around for the process's
//!   lifetime. Disabling it lets activations re-use allocations across runs
//!   without the up-front spike.
//!
//! - `arena_extend_strategy = kSameAsRequested` on the CPU allocator. The
//!   default `kNextPowerOfTwo` doubles the arena each time it grows, which
//!   overshoots wildly for our fixed `[batch × seq × hidden]` workload.
//!   `kSameAsRequested` grows by exactly the amount asked for.
//!
//! The arena strategy isn't exposed on ORT's Rust SessionBuilder for CPU
//! (only on CUDA/ROCm/CANN builders), so we register a custom allocator at
//! the process-global environment via `CreateAndRegisterAllocator` and have
//! every session opt into it with `with_env_allocators()`.

use std::sync::OnceLock;

use ort::environment::get_environment;
use ort::error::status_to_result;
use ort::session::Session;
use ort::session::builder::{GraphOptimizationLevel, SessionBuilder};
use ort::{AsPointer, api};

use super::EmbeddingError;

/// `kSameAsRequested` per `include/onnxruntime_c_api.h`:
/// ```c
/// enum ArenaExtendStrategy { kNextPowerOfTwo = 0, kSameAsRequested = 1 };
/// ```
const ARENA_EXTEND_SAME_AS_REQUESTED: std::os::raw::c_int = 1;

/// Registered once per process; subsequent calls are no-ops. Wraps unsafe
/// FFI so callers stay in safe Rust.
static ARENA_REGISTERED: OnceLock<()> = OnceLock::new();

fn status(status: ort_sys::OrtStatusPtr, label: &str) -> Result<(), EmbeddingError> {
    // SAFETY: `status` is either null (success) or a pointer owned by ORT
    // that `status_to_result` consumes.
    unsafe { status_to_result(status) }
        .map_err(|e| EmbeddingError::OrtInit(format!("{label}: {e}")))
}

/// Register a CPU arena allocator on the global ORT environment with
/// `arena_extend_strategy=kSameAsRequested`. Must be called after
/// `ort::init_from(...).commit()` but before any session is committed. A
/// session then uses this allocator by calling `with_env_allocators()` on
/// its builder (see `build_minilm_session`).
///
/// Errors propagate as `EmbeddingError::OrtInit` with the ORT status
/// string so bootstrap failures remain visible in logs.
pub(super) fn register_cpu_arena_if_needed() -> Result<(), EmbeddingError> {
    if ARENA_REGISTERED.get().is_some() {
        return Ok(());
    }

    let env = get_environment().map_err(|e| EmbeddingError::OrtInit(e.to_string()))?;
    let env_ptr = env.ptr().cast_mut();
    let a = api();

    // SAFETY: each FFI call has its pointer-out param inspected before use.
    // Both `mem_info` and `arena_cfg` are released on every exit path —
    // ORT copies their contents into the env during registration, so
    // releasing after the call is correct per the C API docs.
    unsafe {
        let mut mem_info: *mut ort_sys::OrtMemoryInfo = std::ptr::null_mut();
        status(
            (a.CreateCpuMemoryInfo)(
                ort_sys::OrtAllocatorType::OrtArenaAllocator,
                ort_sys::OrtMemType::OrtMemTypeDefault,
                &mut mem_info,
            ),
            "CreateCpuMemoryInfo",
        )?;

        // CreateArenaCfg(max_mem=0, arena_extend_strategy=1, initial_chunk_size_bytes=-1, max_dead_bytes_per_chunk=-1)
        //   max_mem=0 → no arena size cap (default heuristic)
        //   initial_chunk_size_bytes=-1 / max_dead_bytes_per_chunk=-1 → defaults
        let mut arena_cfg: *mut ort_sys::OrtArenaCfg = std::ptr::null_mut();
        let cfg_status = (a.CreateArenaCfg)(
            0,
            ARENA_EXTEND_SAME_AS_REQUESTED,
            -1,
            -1,
            &mut arena_cfg,
        );
        if let Err(e) = status(cfg_status, "CreateArenaCfg") {
            (a.ReleaseMemoryInfo)(mem_info);
            return Err(e);
        }

        let register_status =
            (a.CreateAndRegisterAllocator)(env_ptr, mem_info, arena_cfg);

        // Release builders regardless of outcome.
        (a.ReleaseArenaCfg)(arena_cfg);
        (a.ReleaseMemoryInfo)(mem_info);

        status(register_status, "CreateAndRegisterAllocator")?;
    }

    let _ = ARENA_REGISTERED.set(());
    Ok(())
}

/// Commit a MiniLM-L6-v2 session from raw ONNX bytes, applying the #205
/// memory tunings. `register_cpu_arena_if_needed` must have been called
/// first (idempotent — `ensure_runtime_initialized` does this).
pub(super) fn build_minilm_session(onnx_bytes: &[u8]) -> Result<Session, EmbeddingError> {
    let builder: SessionBuilder = Session::builder()
        .map_err(|e| EmbeddingError::OrtInit(e.to_string()))?;
    // Level3 = every available graph optimization, matching fastembed's
    // previous default so accepted perf characteristics carry over.
    let builder = builder
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| EmbeddingError::OrtInit(e.to_string()))?
        .with_memory_pattern(false)
        .map_err(|e| EmbeddingError::OrtInit(e.to_string()))?
        .with_env_allocators()
        .map_err(|e| EmbeddingError::OrtInit(e.to_string()))?;
    // No per-session thread config: #197 installs a global thread pool on
    // the env, which makes ORT call `DisablePerSessionThreads` in the
    // commit path. Any `with_intra_threads` here would be silently ignored.
    builder
        .commit_from_memory(onnx_bytes)
        .map_err(|e| EmbeddingError::OrtInit(e.to_string()))
}

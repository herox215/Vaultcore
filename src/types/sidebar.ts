// Cascade-state shapes shared between Sidebar (the owner — survives the
// watcher-driven tree re-flatten) and TreeRow (which detects the cascade
// trigger but hands it up synchronously). See issue #378 for why this
// state lives on Sidebar rather than TreeRow.

export interface RenameCascadeRequest {
  oldPath: string;
  newPath: string;
  oldRelPath: string;
  newRelPath: string;
  linkCount: number;
}

/**
 * A drop request passed from TreeRow to Sidebar. TreeRow detects the drop
 * and hands the bare endpoints up immediately — Sidebar then runs all
 * post-detection work (getBacklinks, cascade-or-direct dispatch, moveFile,
 * updateLinksAfterRename) on its always-mounted lifetime.
 */
export interface MoveDropRequest {
  sourcePath: string;
  targetDirPath: string;
}

export interface PendingRename extends RenameCascadeRequest {
  fileCount: number;
}

export interface PendingMove {
  sourcePath: string;
  targetDirPath: string;
  sourceRelPath: string;
  newRelPath: string;
  linkCount: number;
  fileCount: number;
}

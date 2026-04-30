// Cascade-state shapes shared between Sidebar (the owner — survives the
// watcher-driven tree re-flatten) and TreeRow (which detects the cascade
// trigger but hands it up). See issue #378 for why this state lives on
// Sidebar rather than TreeRow.

export interface RenameCascadeRequest {
  oldPath: string;
  newPath: string;
  oldRelPath: string;
  newRelPath: string;
  linkCount: number;
}

export interface MoveCascadeRequest {
  sourcePath: string;
  targetDirPath: string;
  sourceRelPath: string;
  newRelPath: string;
  linkCount: number;
  fileCount: number;
}

export interface PendingRename extends RenameCascadeRequest {
  fileCount: number;
}

export type PendingMove = MoveCascadeRequest;

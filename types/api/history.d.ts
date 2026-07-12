/**
 * Describes methods available on editor.history for undo/redo
 */
export interface History {
  /**
   * Undo the last change
   */
  undo(): Promise<void>;

  /**
   * Redo the last undone change
   */
  redo(): Promise<void>;

  /**
   * Returns true if there are entries to undo
   */
  canUndo(): boolean;

  /**
   * Returns true if there are entries to redo
   */
  canRedo(): boolean;

  /**
   * Clear the history stack and re-seed baseline state
   */
  clear(): Promise<void>;
}

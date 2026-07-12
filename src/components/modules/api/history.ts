import type { History as HistoryInterface } from '../../../../types/api';
import Module from '../../__module';

/**
 * @class HistoryAPI
 * @classdesc Public API for undo/redo operations
 */
export default class HistoryAPI extends Module {
  /**
   * Available methods exposed on editor.history
   */
  public get methods(): HistoryInterface {
    return {
      undo: (): Promise<void> => this.undo(),
      redo: (): Promise<void> => this.redo(),
      canUndo: (): boolean => this.canUndo(),
      canRedo: (): boolean => this.canRedo(),
      clear: (): Promise<void> => this.clear(),
    };
  }

  /**
   * Undo the last change
   */
  public undo(): Promise<void> {
    return this.Editor.History.undo();
  }

  /**
   * Redo the last undone change
   */
  public redo(): Promise<void> {
    return this.Editor.History.redo();
  }

  /**
   * Returns true if undo is possible
   */
  public canUndo(): boolean {
    return this.Editor.History.canUndo();
  }

  /**
   * Returns true if redo is possible
   */
  public canRedo(): boolean {
    return this.Editor.History.canRedo();
  }

  /**
   * Clear the history stack
   */
  public async clear(): Promise<void> {
    await this.Editor.History.clear();
  }
}

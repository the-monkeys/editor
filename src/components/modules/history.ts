import Module from '../__module';
import type { BlockToolData } from '../../../types';
import type { BlockMutationEvent, BlockMutationType } from '../../../types/events/block';
import { BlockChangedMutationType } from '../../../types/events/block/BlockChanged';
import { BlockAddedMutationType } from '../../../types/events/block/BlockAdded';
import { BlockRemovedMutationType } from '../../../types/events/block/BlockRemoved';
import type { BlockRemovedEvent } from '../../../types/events/block/BlockRemoved';
import { BlockMovedMutationType } from '../../../types/events/block/BlockMoved';
import type { BlockMovedEvent } from '../../../types/events/block/BlockMoved';
import { BlockChanged } from '../events';
import type { BlockChangedPayload } from '../events/BlockChanged';
import VanillaCaret from 'vanilla-caret-js';

// eslint-disable-next-line jsdoc/require-jsdoc
const requestIdleCallbackPolyfill = typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function'
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  ? window.requestIdleCallback.bind(window)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  : ((cb: () => void) => setTimeout(cb, 0)) as any;

// eslint-disable-next-line jsdoc/require-jsdoc
const cancelIdleCallbackPolyfill = typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function'
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  ? window.cancelIdleCallback.bind(window)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  : ((handle: number) => clearTimeout(handle)) as any;

/**
 * Cached data for a block: its tool name and its data.
 */
interface BlockCache {
  /**
   * The tool name (e.g. "paragraph", "header")
   */
  tool: string;

  /**
   * The block's data
   */
  data: BlockToolData;
}

/**
 * Describes a single entry in the history stack
 */
interface HistoryEntry {
  /**
   * What kind of mutation occurred
   */
  operation: BlockMutationType;

  /**
   * Block index at the time of the mutation
   */
  blockIndex: number;

  /**
   * ID of the affected block
   */
  blockId: string;

  /**
   * Tool name of the affected block (e.g. "paragraph", "header")
   */
  blockTool: string;

  /**
   * Data snapshot of the block at the time of the mutation.
   * For 'block-removed', this stores the data that was removed so we can re-insert.
   * For 'block-added', this stores the data that was added.
   * For 'block-changed', this stores the new data.
   */
  blockData: BlockToolData;

  /**
   * For 'block-changed': the data before the change. Used to restore on undo.
   */
  previousBlockData?: BlockToolData;

  /**
   * For 'block-moved': the original index before the move
   */
  sourceIndex?: number;

  /**
   * For 'block-moved': the destination index after the move
   */
  destinationIndex?: number;

  /**
   * Snapshot of caret position at the time of entry creation.
   * Captured using text-content offsets (not innerHTML) so it works
   * correctly with getNodeByOffset.
   *
   * For undo of block-changed: used to restore caret (clamps to restored text length).
   * For redo of block-changed/block-moved: used to restore caret.
   */
  caretSnapshot: CaretSnapshot | null;
}

/**
 * Stores enough info to restore caret position
 */
interface CaretSnapshot {
  /**
   * Block index
   */
  blockIndex: number;

  /**
   * Offset within the block's first input element
   */
  textOffset: number;
}

/**
 * Pending debounced change for a single block.
 * Captures the pre-change data and tracks the latest post-change data.
 */
interface PendingBlockChange {
  /**
   * The data before the mutation burst started (from knownBlockData at first event)
   */
  previousData: BlockToolData;

  /**
   * Tool name of the block
   */
  tool: string;

  /**
   * Timer handle for the debounce
   */
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Delay in milliseconds before restoring the caret after a DOM change.
 * Lets the browser finish layout after BlockManager.update / insert / remove.
 * Same pattern as editorjs-undo uses (50ms there, 20ms here since our DOM
 * changes are more targeted).
 */
const CARET_RESTORE_DELAY_MS = 0;

/**
 * Maximum number of entries to keep in the history stack
 */
const DEFAULT_STACK_LIMIT = 100;

/**
 * Debounce window in milliseconds. Rapid mutations within this window
 * are collapsed into a single history entry.
 */
const DEBOUNCE_MS = 300;

/**
 * Polling interval in milliseconds for waiting on the mutation queue to drain
 */
const QUEUE_POLL_MS = 10;

/**
 * Module that manages undo/redo history for the editor.
 *
 * Listens to block mutation events and records each operation so it can be replayed
 * in reverse (undo) or forward (redo).
 *
 * Uses debouncing for block-changed events: rapid mutations (e.g. keystrokes)
 * within a short window are collapsed into a single history entry so that one
 * undo restores the entire editing burst.
 */
export default class History extends Module {
  /**
   * The stack of recorded operations
   */
  private stack: HistoryEntry[] = [];

  /**
   * Current position within the stack. Points to the latest applied entry.
   * Starts at -1 (no undoable entries after initial baseline).
   */
  private pointer = -1;

  /**
   * Guard flag to prevent recording changes that we ourselves are making during undo/redo
   */
  private applying = false;

  /**
   * Maximum number of entries allowed in the stack
   */
  private stackLimit = DEFAULT_STACK_LIMIT;

  /**
   * Cache of the last known data and tool name for each block, keyed by block ID.
   * Used to detect whether a block-changed event actually has different data
   * and to populate `previousBlockData`.
   */
  private readonly knownBlockData = new Map<string, BlockCache>();

  /**
   * Pending debounced changes keyed by block ID.
   * When a block-changed event fires, we start/reset a timer. When the timer
   * fires, we push a single entry if the data actually changed.
   */
  private readonly pendingChanges = new Map<string, PendingBlockChange>();

  /**
   * Reference to the bound keydown handler so we can remove it on destroy
   */
  private keydownHandler: ((event: KeyboardEvent) => void) | null = null;

  /**
   * Ordered async queue for serializing mutation handlers.
   * Ensures pushEntry calls occur in the same order as mutation events arrive,
   * even when handlers involve async work like block.save().
   */
  private mutationQueue: Array<() => Promise<void>> = [];

  /**
   * Whether the mutation queue is currently being drained
   */
  private mutationQueueDraining = false;

  /**
   * Handle returned by requestIdleCallback (or setTimeout fallback) in prepare().
   * Stored so destroy() can cancel it.
   */
  private initIdleHandle: number | null = null;

  /**
   * Whether the requestIdleCallback polyfill fallback (setTimeout) was used
   */
  private isUsingIdleFallback = false;

  /**
   * Whether captureInitialState has completed.
   * Used to prevent initial-render block-added events from being recorded in the stack.
   */
  private initialRenderComplete = false;

  /**
   * Prepare the module: subscribe to events and register shortcuts
   */
  public async prepare(): Promise<void> {
    this.stackLimit = this.config.history?.stackLimit ?? DEFAULT_STACK_LIMIT;

    this.eventsDispatcher.on(BlockChanged, (payload) => {
      this.onBlockMutation(payload);
    });

    this.registerShortcuts();

    /**
     * Defer captureInitialState to after blocks are rendered.
     * prepare() is called before Renderer.render(), so BlockManager.blocks is empty.
     * Using requestIdleCallback ensures we capture initial state after blocks are in the DOM.
     */
    this.isUsingIdleFallback = typeof window === 'undefined' || typeof window.requestIdleCallback !== 'function';
    this.initIdleHandle = requestIdleCallbackPolyfill(() => {
      this.initIdleHandle = null;
      void this.captureInitialState();
    }, { timeout: 2000 });
  }

  /**
   * Undo the last operation.
   * Flushes any pending debounced changes before proceeding.
   *
   * Caret is always restored AFTER the operation. The target position depends
   * on the operation type — we use a small setTimeout to let the browser
   * finish layout after DOM changes (same pattern as editorjs-undo).
   */
  public async undo(): Promise<void> {
    /**
     * Set the applying guard BEFORE the async flush to prevent a second
     * rapid undo() call from passing the guard while the first is still flushing.
     */
    if (this.applying) {
      return;
    }

    this.applying = true;

    await this.flushPendingChanges();

    if (!this.canUndo()) {
      this.applying = false;

      return;
    }

    this.Editor.ModificationsObserver.disable();

    const entry = this.stack[this.pointer];

    try {
      await this.applyOperation(entry, 'backward');
      this.pointer--;
      this.restoreCaretForOperation(entry, 'backward');
    } catch (err) {
      console.error('[History] Failed to undo:', err);
    } finally {
      this.Editor.ModificationsObserver.enable();
      this.applying = false;
    }
  }

  /**
   * Redo the next operation.
   * Cancel pending debounced changes rather than flushing them.
   */
  public async redo(): Promise<void> {
    if (this.applying) {
      return;
    }

    this.applying = true;
    this.cancelPendingChanges();

    if (!this.canRedo()) {
      this.applying = false;

      return;
    }

    this.Editor.ModificationsObserver.disable();

    this.pointer++;

    const entry = this.stack[this.pointer];

    try {
      await this.applyOperation(entry, 'forward');
      this.pointer++;
      this.restoreCaretForOperation(entry, 'forward');
    } catch (err) {
      console.error('[History] Failed to redo:', err);
    } finally {
      this.Editor.ModificationsObserver.enable();
      this.applying = false;
    }
  }

  /**
   * Returns true if there are entries to undo.
   * Also returns true if there are pending debounced changes that haven't been
   * finalized yet (i.e. the user just typed something).
   */
  public canUndo(): boolean {
    if (this.Editor.ReadOnly.isEnabled) {
      return false;
    }

    return this.pointer >= 0 || this.pendingChanges.size > 0;
  }

  /**
   * Returns true if there are entries to redo
   */
  public canRedo(): boolean {
    return !this.Editor.ReadOnly.isEnabled && this.pointer < this.stack.length - 1;
  }

  /**
   * Reset the history stack.
   * Re-seeds the baseline state after clearing.
   */
  public async clear(): Promise<void> {
    this.cancelPendingChanges();
    this.stack = [];
    this.pointer = -1;
    this.knownBlockData.clear();
    this.initialRenderComplete = false;
    await this.captureInitialState();
  }

  /**
   * Clean up keyboard shortcuts, pending timers, and idle callbacks on destroy
   */
  public destroy(): void {
    this.cancelPendingChanges();

    if (this.keydownHandler !== null) {
      const holder = this.Editor.UI.nodes.redactor;

      holder.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }

    if (this.initIdleHandle !== null) {
      if (this.isUsingIdleFallback) {
        clearTimeout(this.initIdleHandle);
      } else {
        cancelIdleCallbackPolyfill(this.initIdleHandle);
      }
      this.initIdleHandle = null;
    }

    this.mutationQueue = [];
    this.knownBlockData.clear();
  }

  /**
   * Enqueue an async task to be executed in order.
   * Tasks are drained one at a time so pushEntry calls maintain mutation order.
   *
   * @param task - Async function to enqueue
   */
  private enqueueMutation(task: () => Promise<void>): void {
    this.mutationQueue.push(task);
    void this.drainMutationQueue();
  }

  /**
   * Drain the mutation queue sequentially
   */
  private async drainMutationQueue(): Promise<void> {
    if (this.mutationQueueDraining) {
      return;
    }

    this.mutationQueueDraining = true;

    while (this.mutationQueue.length > 0) {
      const task = this.mutationQueue.shift();

      if (task !== undefined) {
        try {
          await task();
        } catch (err) {
          console.error('[History] Mutation queue task failed:', err);
        }
      }
    }

    this.mutationQueueDraining = false;
  }

  /**
   * Handle a block mutation event from the editor
   *
   * @param payload - The block change event payload
   */
  private onBlockMutation(payload: BlockChangedPayload): void {
    if (this.applying) {
      return;
    }

    const event = payload.event as BlockMutationEvent;
    const detail = event.detail;
    const mutationType = event.type as BlockMutationType;

    const blockId = detail.target.id;

    if (mutationType === BlockChangedMutationType) {
      if (!this.knownBlockData.has(blockId)) {
        const block = this.Editor.BlockManager.getBlockById(blockId);

        if (block) {
          const data = this.captureBlockDataSync(block);

          if (data !== null) {
            this.knownBlockData.set(blockId, {
              tool: block.name,
              data,
            });
          }
        }

        return;
      }

      this.scheduleBlockChanged(blockId);

      return;
    }

    if (mutationType === BlockAddedMutationType) {
      /**
       * handleBlockAdded is async (does block.save()) but onBlockMutation is
       * synchronous (called from EventsDispatcher.emit). We enqueue the work
       * so pushEntry calls maintain the order mutations arrive.
       */
      this.enqueueMutation(() => this.handleBlockAdded(blockId));

      return;
    }

    if (mutationType === BlockRemovedMutationType) {
      this.cancelPendingChangeForBlock(blockId);
      this.handleBlockRemoved(blockId, event as BlockRemovedEvent);

      return;
    }

    if (mutationType === BlockMovedMutationType) {
      this.handleBlockMoved(event as BlockMovedEvent);
    }
  }

  /**
   * Synchronously capture a block's current data by reading from its DOM.
   * Used to seed knownBlockData on the first block-changed event for a block
   * before captureInitialState completes.
   *
   * Supports: paragraph, header. Other tools return null to indicate
   * that synchronous capture is not possible — these blocks will be
   * seeded by captureInitialState instead.
   *
   * @param block - The block to capture data from
   */
  private captureBlockDataSync(block: { name: string; holder: HTMLElement }): BlockToolData | null {
    if (block.name === 'paragraph') {
      const editable = block.holder.querySelector('[contenteditable="true"]');

      return { text: editable?.innerHTML ?? '' };
    }

    if (block.name === 'header') {
      const editable = block.holder.querySelector('[contenteditable="true"]') as HTMLElement | null;

      if (editable) {
        const tag = editable.tagName.toLowerCase();
        const levelMatch = tag.match(/^h(\d)$/);
        const level = levelMatch ? parseInt(levelMatch[1], 10) : 1;

        return {
          text: editable.innerHTML,
          level,
        };
      }
    }

    return null;
  }

  /**
   * Schedule a debounced recording for a block-changed event.
   *
   * On the first call for a given blockId, captures the pre-change data from
   * knownBlockData and starts a debounce timer. Subsequent calls for the same
   * blockId reset the timer but keep the original pre-change data.
   * When the timer fires, pushes a single entry if data actually changed.
   *
   * @param blockId - ID of the changed block
   */
  private scheduleBlockChanged(blockId: string): void {
    const existing = this.pendingChanges.get(blockId);

    if (existing !== undefined) {
      clearTimeout(existing.timer);

      existing.timer = setTimeout(() => {
        this.finalizeBlockChanged(blockId);
      }, DEBOUNCE_MS);

      return;
    }

    const cached = this.knownBlockData.get(blockId);
    const block = this.Editor.BlockManager.getBlockById(blockId);

    if (!block || cached === undefined) {
      return;
    }

    const timer = setTimeout(() => {
      this.finalizeBlockChanged(blockId);
    }, DEBOUNCE_MS);

    this.pendingChanges.set(blockId, {
      previousData: cached.data,
      tool: block.name,
      timer,
    });
  }

  /**
   * Finalize a debounced block-changed event.
   * Enqueues the async work (block.save + pushEntry) so it maintains
   * ordering with other mutation handlers.
   *
   * @param blockId - ID of the changed block
   */
  private finalizeBlockChanged(blockId: string): void {
    const pending = this.pendingChanges.get(blockId);

    this.pendingChanges.delete(blockId);

    if (pending === undefined) {
      return;
    }

    clearTimeout(pending.timer);

    this.enqueueMutation(() => this.doFinalizeBlockChanged(blockId, pending));
  }

  /**
   * Perform the actual async finalization: read block data, compare, and push entry.
   *
   * @param blockId - ID of the changed block
   * @param pending - The pending change data captured at scheduling time
   */
  private async doFinalizeBlockChanged(blockId: string, pending: PendingBlockChange): Promise<void> {
    const block = this.Editor.BlockManager.getBlockById(blockId);

    if (!block) {
      return;
    }

    const saved = await block.save();

    if (!saved) {
      return;
    }

    const currentData = saved.data;

    if (JSON.stringify(currentData) === JSON.stringify(pending.previousData)) {
      return;
    }

    const blockIndex = this.Editor.BlockManager.getBlockIndex(block);

    this.pushEntry({
      operation: BlockChangedMutationType,
      blockIndex,
      blockId,
      blockTool: pending.tool,
      blockData: currentData,
      previousBlockData: pending.previousData,
      caretSnapshot: this.captureCaret(),
    });

    this.knownBlockData.set(blockId, {
      tool: pending.tool,
      data: currentData,
    });
  }

  /**
   * Flush all pending debounced changes immediately.
   * Called before undo/redo operations. Enqueues all pending finalizations
   * and waits for the mutation queue to drain so ordering is preserved.
   */
  private async flushPendingChanges(): Promise<void> {
    const entries = Array.from(this.pendingChanges.keys());

    for (const blockId of entries) {
      this.finalizeBlockChanged(blockId);
    }

    await this.waitForMutationQueue();
  }

  /**
   * Wait for the mutation queue to fully drain
   */
  private waitForMutationQueue(): Promise<void> {
    if (this.mutationQueue.length === 0 && !this.mutationQueueDraining) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const check = (): void => {
        if (this.mutationQueue.length === 0 && !this.mutationQueueDraining) {
          resolve();
        } else {
          setTimeout(check, QUEUE_POLL_MS);
        }
      };

      void check();
    });
  }

  /**
   * Synchronously cancel a pending change for a specific block.
   * Used before block-removed events where we don't need to record a
   * block-changed entry since the block is being removed.
   *
   * @param blockId - The block ID whose pending change to cancel
   */
  private cancelPendingChangeForBlock(blockId: string): void {
    const pending = this.pendingChanges.get(blockId);

    if (pending === undefined) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingChanges.delete(blockId);
  }

  /**
   * Cancel all pending debounced changes without recording entries.
   */
  private cancelPendingChanges(): void {
    for (const [, pending] of this.pendingChanges) {
      clearTimeout(pending.timer);
    }

    this.pendingChanges.clear();
  }

  /**
   * Handle a block-added mutation.
   * Records a new entry for blocks that appear after the initial render.
   *
   * @param blockId - ID of the added block
   */
  private async handleBlockAdded(blockId: string): Promise<void> {
    const block = this.Editor.BlockManager.getBlockById(blockId);

    if (!block) {
      return;
    }

    /**
     * Capture initial state synchronously from the DOM.
     * This runs immediately when the block is inserted, before the user
     * can type into it. Using block.save() (async) would risk capturing
     * user-typed content if the save resolves after keystrokes.
     */
    const initialData = this.captureBlockDataSync(block) ?? {};

    if (!this.knownBlockData.has(blockId)) {
      this.knownBlockData.set(blockId, {
        tool: block.name,
        data: initialData,
      });
    }

    if (!this.initialRenderComplete) {
      return;
    }

    const blockIndex = this.Editor.BlockManager.getBlockIndex(block);

    /**
     * Finalize any pending debounced change for the previous block before
     * pushing this block-added entry. Without this, block-added entries
     * (which fire immediately) appear at the end of the stack BEFORE
     * block-changed entries (which are debounced 300ms), so undo of the
     * last entry undoes a text change instead of the expected line removal.
     */
    if (blockIndex > 0) {
      const prevBlock = this.Editor.BlockManager.getBlockByIndex(blockIndex - 1);

      if (prevBlock) {
        const pending = this.pendingChanges.get(prevBlock.id);

        if (pending !== undefined) {
          this.pendingChanges.delete(prevBlock.id);
          clearTimeout(pending.timer);
          await this.doFinalizeBlockChanged(prevBlock.id, pending);
        }
      }
    }

    this.pushEntry({
      operation: BlockAddedMutationType,
      blockIndex,
      blockId,
      blockTool: block.name,
      blockData: initialData,
      caretSnapshot: this.captureCaret(),
    });
  }

  /**
   * Handle a block-removed mutation
   *
   * @param blockId - ID of the removed block
   * @param event - The typed BlockRemoved event containing detail.index
   */
  private handleBlockRemoved(blockId: string, event: BlockRemovedEvent): void {
    const cached = this.knownBlockData.get(blockId);

    if (cached === undefined) {
      return;
    }

    const block = this.Editor.BlockManager.getBlockById(blockId);
    const blockIndex = block ? this.Editor.BlockManager.getBlockIndex(block) : event.detail.index;

    this.pushEntry({
      operation: BlockRemovedMutationType,
      blockIndex,
      blockId,
      blockTool: cached.tool,
      blockData: cached.data,
      caretSnapshot: this.captureCaret(),
    });

    this.knownBlockData.delete(blockId);
  }

  /**
   * Handle a block-moved mutation
   *
   * @param movedEvent - The typed BlockMoved event
   */
  private handleBlockMoved(movedEvent: BlockMovedEvent): void {
    const { fromIndex, toIndex } = movedEvent.detail;
    const blockId = movedEvent.detail.target.id;

    this.pushEntry({
      operation: BlockMovedMutationType,
      blockIndex: toIndex,
      blockId,
      blockTool: '',
      blockData: {},
      sourceIndex: fromIndex,
      destinationIndex: toIndex,
      caretSnapshot: this.captureCaret(),
    });
  }

  /**
   * Push an entry onto the stack, discarding any redo entries ahead of the pointer
   *
   * @param entry - The history entry to push
   */
  private pushEntry(entry: HistoryEntry): void {
    this.stack = this.stack.slice(0, this.pointer + 1);
    this.stack.push(entry);
    this.pointer = this.stack.length - 1;

    while (this.stack.length > this.stackLimit) {
      this.stack.shift();
      this.pointer--;
    }
  }

  /**
   * Apply an operation in the given direction
   *
   * @param entry - The history entry to apply
   * @param direction - Whether to apply forward (redo) or backward (undo)
   */
  private async applyOperation(entry: HistoryEntry, direction: 'forward' | 'backward'): Promise<void> {
    const { operation } = entry;

    switch (operation) {
      case BlockAddedMutationType:
        if (direction === 'backward') {
          await this.removeBlockFromEditor(entry);
        } else {
          await this.insertBlockToEditor(entry);
        }
        break;

      case BlockRemovedMutationType:
        if (direction === 'backward') {
          await this.insertBlockToEditor(entry);
        } else {
          await this.removeBlockFromEditor(entry);
        }
        break;

      case BlockChangedMutationType:
        if (direction === 'backward') {
          await this.restoreBlockData(entry, entry.previousBlockData);
        } else {
          await this.restoreBlockData(entry, entry.blockData);
        }
        break;

      case BlockMovedMutationType:
        if (direction === 'backward' && entry.sourceIndex !== undefined && entry.destinationIndex !== undefined) {
          this.Editor.BlockManager.move(entry.sourceIndex, entry.destinationIndex);
        } else if (direction === 'forward' && entry.sourceIndex !== undefined && entry.destinationIndex !== undefined) {
          this.Editor.BlockManager.move(entry.destinationIndex, entry.sourceIndex);
        }
        break;
    }
  }

  /**
   * Insert a block into the editor from a history entry
   *
   * @param entry - The entry containing block data to insert
   */
  private async insertBlockToEditor(entry: HistoryEntry): Promise<void> {
    this.Editor.BlockManager.insert({
      id: entry.blockId,
      tool: entry.blockTool,
      data: entry.blockData,
      index: entry.blockIndex,
      needToFocus: false,
    });

    this.knownBlockData.set(entry.blockId, {
      tool: entry.blockTool,
      data: entry.blockData,
    });
  }

  /**
   * Remove a block from the editor by its entry's block ID
   *
   * @param entry - The entry identifying the block to remove
   */
  private async removeBlockFromEditor(entry: HistoryEntry): Promise<void> {
    const block = this.Editor.BlockManager.getBlockById(entry.blockId);

    if (block) {
      await this.Editor.BlockManager.removeBlock(block, false);
      this.knownBlockData.delete(entry.blockId);
    }
  }

  /**
   * Restore block data (used for both undo and redo of block-changed).
   *
   * For tools with a `text` property (paragraph, header), we update the
   * contenteditable's innerHTML directly to avoid creating a new Block
   * instance. This prevents the visual "blink" caused by DOM element
   * replacement during BlockManager.update().
   *
   * For other tools, falls back to BlockManager.update().
   *
   * @param entry - The history entry containing the block to restore
   * @param data - The data to restore the block to
   */
  private async restoreBlockData(entry: HistoryEntry, data: BlockToolData | undefined): Promise<void> {
    if (data === undefined) {
      return;
    }

    const block = this.Editor.BlockManager.getBlockById(entry.blockId);

    if (!block) {
      return;
    }

    const hasTextProperty = data !== null && typeof data === 'object' && 'text' in data;

    if (hasTextProperty) {
      const input = block.currentInput ?? block.firstInput;

      if (input) {
        const html = (data as { text: string }).text ?? '';

        input.innerHTML = html;

        this.knownBlockData.set(entry.blockId, {
          tool: entry.blockTool,
          data,
        });

        return;
      }
    }

    await this.Editor.BlockManager.update(block, data);
    this.knownBlockData.set(entry.blockId, {
      tool: entry.blockTool,
      data,
    });
  }

  /**
   * Capture the current editor state as a non-undoable baseline.
   * Seeds the knownBlockData cache without pushing entries to the stack,
   * so undo is unavailable immediately after load and only becomes available
   * after a user edit.
   */
  private async captureInitialState(): Promise<void> {
    if (this.Editor?.BlockManager === undefined) {
      return;
    }

    const blocks = this.Editor.BlockManager.blocks;

    if (blocks.length === 0) {
      return;
    }

    const blockSnapshots = await Promise.all(
      blocks.map(async (block) => {
        const saved = await block.save();

        return {
          id: block.id,
          tool: block.name,
          data: saved?.data ?? {},
        };
      })
    );

    blockSnapshots.forEach((snapshot) => {
      this.knownBlockData.set(snapshot.id, {
        tool: snapshot.tool,
        data: snapshot.data,
      });
    });

    this.initialRenderComplete = true;
  }

  /**
   * Capture the current caret position using text-content offsets.
   * Uses range.toString().length which naturally gives plain-text character count,
   * avoiding the innerHTML vs textContent mismatch.
   */
  /**
   * Capture the current caret position using vanilla-caret-js.
   * Returns a plain-text character offset via VanillaCaret.getPos(),
   * which uses range.toString().length internally.
   */
  private captureCaret(): CaretSnapshot | null {
    const { BlockManager } = this.Editor;

    if (!BlockManager.currentBlock) {
      return null;
    }

    const blockIndex = BlockManager.currentBlockIndex;
    const input = BlockManager.currentBlock.currentInput;

    if (!input) {
      return {
        blockIndex,
        textOffset: 0,
      };
    }

    const caret = new VanillaCaret(input);
    const pos = caret.getPos();

    return {
      blockIndex,
      textOffset: pos === -1 ? 0 : pos,
    };
  }

  /**
   * Compute the caret snapshot for undo of a block-added entry.
   * The undo removes the new block, so the caret goes to the end of the block before it.
   *
   * @param blockIndex - Index of the block that was added
   */
  private caretSnapshotForUndoOfBlockAdded(blockIndex: number): CaretSnapshot {
    const prevIndex = blockIndex - 1;

    if (prevIndex < 0) {
      return { blockIndex: 0,
        textOffset: 0 };
    }

    const block = this.Editor.BlockManager.getBlockByIndex(prevIndex);

    if (!block) {
      return { blockIndex: prevIndex,
        textOffset: 0 };
    }

    const input = block.currentInput ?? block.firstInput;

    if (!input) {
      return { blockIndex: prevIndex,
        textOffset: 0 };
    }

    return { blockIndex: prevIndex,
      textOffset: (input.textContent ?? '').length };
  }

  /**
   * Restore the caret to a previously captured position.
   * Uses a small setTimeout to let the browser finish layout after
   * DOM changes (BlockManager.update / insert / remove).
   */
  /**
   * Restore the caret to a previously captured position using vanilla-caret-js.
   * Uses a 50ms setTimeout (same as editorjs-undo) to let the browser finish
   * layout after DOM changes (BlockManager.update / insert / remove).
   *
   * @param snapshot - The caret position snapshot to restore, or null to skip
   */
  private restoreCaret(snapshot: CaretSnapshot | null): void {
    if (!snapshot) {
      return;
    }

    const { BlockManager } = this.Editor;

    setTimeout(() => {
      const block = BlockManager.getBlockByIndex(snapshot.blockIndex);

      if (block === undefined || !block.focusable) {
        return;
      }

      const input = block.currentInput ?? block.firstInput;

      if (!input) {
        return;
      }

      const caret = new VanillaCaret(input);

      /**
       * Clamp textOffset to the actual text length.
       * VanillaCaret.setPos() does NOT clamp — it walks the DOM tree and
       * places the caret at a browser-dependent offset when the position
       * exceeds the available text nodes. This causes the caret to land
       * at random positions after undo (e.g., position 2 on an empty block
       * when the captured offset was 22).
       */
      const maxOffset = (input.textContent ?? '').length;

      /**
       * Set the selection range BEFORE focusing to avoid a microsecond
       * caret flash at position 0. With the range pre-set, the browser
       * renders the caret at the correct position on the first paint
       * when focus() fires.
       */
      caret.setPos(Math.min(snapshot.textOffset, maxOffset));
      input.focus();
    }, CARET_RESTORE_DELAY_MS);
  }

  /**
   * Determine the correct caret position after an undo or redo operation
   * and restore it.
   *
   * @param entry - The history entry that was just applied
   * @param direction - 'backward' for undo, 'forward' for redo
   */
  private restoreCaretForOperation(entry: HistoryEntry, direction: 'forward' | 'backward'): void {
    const { operation } = entry;

    if (direction === 'backward') {
      switch (operation) {
        case BlockChangedMutationType:
          /**
           * Undo restores previousBlockData. The recorded caretSnapshot was captured
           * at the time of the change (after typing). Caret.setToBlock clamps the offset
           * to the text length, so the caret lands at the end of the restored text.
           */
          this.restoreCaret(entry.caretSnapshot);
          break;

        case BlockAddedMutationType:
          /**
           * Undo removes the newly added block. The caret should be at the end
           * of the block that precedes it.
           */
          this.restoreCaret(this.caretSnapshotForUndoOfBlockAdded(entry.blockIndex));
          break;

        case BlockRemovedMutationType:
          /**
           * Undo re-inserts the removed block. The caret should be at the
           * start of the re-inserted block.
           */
          this.restoreCaret({ blockIndex: entry.blockIndex,
            textOffset: 0 });
          break;

        case BlockMovedMutationType:
          this.restoreCaret(entry.caretSnapshot);
          break;

        default:
          this.restoreCaret(entry.caretSnapshot);
          break;
      }
    } else {
      switch (operation) {
        case BlockChangedMutationType:
          this.restoreCaret(entry.caretSnapshot);
          break;

        case BlockAddedMutationType:
          /**
           * Redo re-inserts the added block. The caret should be at the
           * start of the re-inserted block.
           */
          this.restoreCaret({ blockIndex: entry.blockIndex,
            textOffset: 0 });
          break;

        case BlockRemovedMutationType:
          /**
           * Redo removes the block. The caret should be at the end of the
           * block that precedes it.
           */
          this.restoreCaret(this.caretSnapshotForUndoOfBlockAdded(entry.blockIndex));
          break;

        case BlockMovedMutationType:
          this.restoreCaret(entry.caretSnapshot);
          break;

        default:
          this.restoreCaret(entry.caretSnapshot);
          break;
      }
    }
  }

  /**
   * Register Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z keyboard shortcuts
   */
  private registerShortcuts(): void {
    const redactor = this.Editor.UI.nodes.redactor;

    this.keydownHandler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }

      const key = event.key.toLowerCase();

      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        this.undo();

        return;
      }

      if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        this.redo();
      }
    };

    redactor.addEventListener('keydown', this.keydownHandler);
  }
}

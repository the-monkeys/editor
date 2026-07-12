/**
 * Check if passed mutation belongs to a passed element
 *
 * @param mutationRecord - mutation to check
 * @param element - element that is expected to contain mutation
 */
export function isMutationBelongsToElement(mutationRecord: MutationRecord, element: Element): boolean {
  const { type, target, addedNodes, removedNodes } = mutationRecord;

  /**
   * Skip own technical mutations, for example, data-empty attribute changes
   */
  if (mutationRecord.type === 'attributes' && mutationRecord.attributeName === 'data-empty') {
    return false;
  }

  /**
   * For characterData mutations, use block-boundary check to prevent cross-block matching.
   * This handles the case where toolRenderedElement may reference a parent/shared element.
   */
  if (type === 'characterData') {
    const targetParent = target.parentElement as HTMLElement | null;

    if (targetParent !== null) {
      const targetBlock = targetParent.closest('.ce-block');
      const elementBlock = element.closest('.ce-block');

      if (targetBlock !== null && elementBlock !== null) {
        return targetBlock === elementBlock;
      }
    }
  }

  const containsResult = element.contains(target);

  /**
   * Covers all types of mutations happened to the element or it's descendants with the only one exception - removing/adding the element itself;
   */
  if (containsResult) {
    return true;
  }

  /**
   * In case of removing/adding the element itself, mutation type will be 'childList' and 'removedNodes'/'addedNodes' will contain the element.
   */
  if (type === 'childList') {
    const elementAddedItself = Array.from(addedNodes).some(node => node === element);

    if (elementAddedItself) {
      return true;
    }

    const elementRemovedItself = Array.from(removedNodes).some(node => node === element);

    if (elementRemovedItself) {
      return true;
    }
  }

  return false;
}

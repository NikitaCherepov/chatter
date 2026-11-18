import { useLayoutEffect, type RefObject } from 'react';

/**
 * Let Chromium skip offscreen prose layout and painting while retaining the DOM,
 * selection, find-in-page and stateful Markdown components.
 */
export function useDeferredMarkdown(ref: RefObject<HTMLDivElement>, enabled: boolean, content: string) {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!enabled || !root || !CSS.supports('content-visibility', 'auto')) return;

    // Keep custom layouts and interactive previews outside paint containment.
    const blocks = Array.from(root.children).filter((element): element is HTMLElement =>
      element instanceof HTMLElement
      && (['P', 'UL', 'OL', 'BLOCKQUOTE'].includes(element.tagName)
        || element.tagName === 'DIV' && element.firstElementChild?.tagName === 'TABLE')
      && !element.querySelector('img,iframe,canvas,svg,video,input,textarea,[data-message-layout]'));
    blocks.push(...Array.from(root.querySelectorAll<HTMLElement>('pre'))
      .filter(block => !block.closest('[data-message-layout]')));

    const measure = () => {
      // Clear all containment before reading sizes, then write in one batch.
      // This also refreshes remembered heights after a width change.
      for (const block of blocks) {
        block.style.removeProperty('content-visibility');
        block.style.removeProperty('contain-intrinsic-block-size');
      }
      const sizes = blocks.map(block => {
        const style = getComputedStyle(block);
        return Math.max(0, block.getBoundingClientRect().height
          - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
          - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth));
      });
      blocks.forEach((block, index) => {
        if (sizes[index] === 0) return;
        block.style.containIntrinsicBlockSize = 'auto ' + sizes[index] + 'px';
        block.style.contentVisibility = 'auto';
      });
    };

    measure();
    let width = root.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = root.getBoundingClientRect().width;
      if (Math.abs(nextWidth - width) < 0.5) return;
      width = nextWidth;
      measure();
    });
    observer.observe(root);
    // Formatting/highlighting and loaded fonts may change completed blocks later.
    let pendingMeasure = 0;
    const scheduleMeasure = () => {
      if (pendingMeasure) return;
      pendingMeasure = requestAnimationFrame(() => {
        pendingMeasure = 0;
        measure();
      });
    };
    const mutations = new MutationObserver(scheduleMeasure);
    mutations.observe(root, { childList: true, subtree: true, characterData: true });
    document.fonts.addEventListener('loadingdone', scheduleMeasure);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      document.fonts.removeEventListener('loadingdone', scheduleMeasure);
      cancelAnimationFrame(pendingMeasure);
      for (const block of blocks) {
        block.style.removeProperty('content-visibility');
        block.style.removeProperty('contain-intrinsic-block-size');
      }
    };
  }, [ref, enabled, content]);
}

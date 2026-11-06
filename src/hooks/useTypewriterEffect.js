/* global NodeFilter */
import { useLayoutEffect, useRef } from 'react';
import { useTypewriter } from '../context/TypewriterContext';

export function useTypewriterEffect(containerRef, contentDependency, options = {}) {
  const { typewriterEnabled } = useTypewriter();
  const animFrameRef = useRef(null);
  const { maxDuration = 500, delay = 0 } = options;

  // Layout effect: the text has to be hidden before the first paint, or the
  // whole post flashes in full and then blanks out before typing.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const isReducedMotion = typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (!typewriterEnabled || isReducedMotion) {
      return;
    }

    // Helper: Collect all text nodes under container
    const collectTextNodes = (root) => {
      const textNodes = [];
      const filterObj = typeof NodeFilter !== 'undefined' ? NodeFilter : (typeof window !== 'undefined' ? window.NodeFilter : { SHOW_TEXT: 4, FILTER_SKIP: 3, FILTER_ACCEPT: 1 });
      const walker = document.createTreeWalker(
        root,
        filterObj?.SHOW_TEXT ?? 4,
        {
          acceptNode: (node) => {
            if (!node.nodeValue || !node.nodeValue.trim()) {
              return filterObj?.FILTER_SKIP ?? 3;
            }
            // Skip code blocks or already processed spans if any
            if (node.parentElement && (node.parentElement.tagName === 'CODE' || node.parentElement.classList.contains('tw-wrapper'))) {
              return filterObj?.FILTER_SKIP ?? 3;
            }
            return filterObj?.FILTER_ACCEPT ?? 1;
          }
        }
      );

      let currentNode;
      while ((currentNode = walker.nextNode())) {
        textNodes.push(currentNode);
      }
      return textNodes;
    };

    const textNodes = collectTextNodes(container);
    if (textNodes.length === 0) return;

    // Calculate start/end indices across all text nodes
    let totalChars = 0;
    const nodeRecords = textNodes.map(node => {
      const originalText = node.nodeValue;
      const startIdx = totalChars;
      totalChars += originalText.length;
      const endIdx = totalChars;

      // Replace text node with a wrapper span containing revealed & hidden spans
      const wrapper = document.createElement('span');
      wrapper.className = 'tw-wrapper';

      const revealedSpan = document.createElement('span');
      revealedSpan.className = 'tw-revealed';
      revealedSpan.textContent = '';

      const hiddenSpan = document.createElement('span');
      hiddenSpan.className = 'tw-hidden';
      hiddenSpan.style.visibility = 'hidden';
      hiddenSpan.style.opacity = '0';
      hiddenSpan.textContent = originalText;

      wrapper.appendChild(revealedSpan);
      wrapper.appendChild(hiddenSpan);

      if (node.parentNode) {
        node.parentNode.replaceChild(wrapper, node);
      }

      return {
        originalNode: node,
        wrapper,
        revealedSpan,
        hiddenSpan,
        originalText,
        startIdx,
        endIdx
      };
    });

    if (totalChars === 0) return;

    // Clean restore function to put original text nodes back into DOM
    const restoreOriginalDom = () => {
      nodeRecords.forEach(rec => {
        if (rec.wrapper && rec.wrapper.parentNode) {
          rec.originalNode.nodeValue = rec.originalText;
          rec.wrapper.parentNode.replaceChild(rec.originalNode, rec.wrapper);
        }
      });
    };

    const duration = totalChars <= 40
      ? Math.min(400, Math.max(160, totalChars * 10))
      : Math.min(maxDuration, Math.max(200, totalChars * 1.2));

    let startTime = null;

    const step = (timestamp) => {
      if (!startTime) startTime = timestamp;
      const elapsed = timestamp - startTime;

      if (elapsed < delay) {
        animFrameRef.current = requestAnimationFrame(step);
        return;
      }

      const activeElapsed = elapsed - delay;
      const progress = Math.min(1, activeElapsed / duration);
      const currentVisibleChars = Math.floor(progress * totalChars);

      // Update spans for each record
      nodeRecords.forEach(rec => {
        if (currentVisibleChars >= rec.endIdx) {
          rec.revealedSpan.textContent = rec.originalText;
          rec.hiddenSpan.textContent = '';
        } else if (currentVisibleChars <= rec.startIdx) {
          rec.revealedSpan.textContent = '';
          rec.hiddenSpan.textContent = rec.originalText;
        } else {
          const charOffset = currentVisibleChars - rec.startIdx;
          rec.revealedSpan.textContent = rec.originalText.slice(0, charOffset);
          rec.hiddenSpan.textContent = rec.originalText.slice(charOffset);
        }
      });

      if (progress < 1) {
        animFrameRef.current = requestAnimationFrame(step);
      } else {
        restoreOriginalDom();
      }
    };

    animFrameRef.current = requestAnimationFrame(step);

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
      restoreOriginalDom();
    };
  }, [containerRef, contentDependency, typewriterEnabled, maxDuration, delay]);
}

import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useTypewriter } from '../context/TypewriterContext';

export default function TypewriterText({
  text,
  children,
  as: Component = 'span',
  className = '',
  style = {},
  maxDuration = 450,
  delay = 0,
  onComplete
}) {
  const { typewriterEnabled } = useTypewriter();
  const content = text !== undefined && text !== null ? String(text) : (typeof children === 'string' ? children : '');

  // Starts at full length; the reveal (below) resets it to 0 in a layout
  // effect, which runs before the browser paints, so the full text is never
  // shown and then wiped (the old useEffect let one or two frames of the
  // full text paint first, then blanked it and typed it back in).
  const [visibleCount, setVisibleCount] = useState(() => content.length);
  const [isComplete, setIsComplete] = useState(false);
  const animFrameRef = useRef(null);
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  // Check prefers-reduced-motion
  const isReducedMotion = typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Types every time the text is shown while the effect is on; the admin
  // default and the header toggle are the way to turn it off.
  const shouldAnimate = typewriterEnabled && !isReducedMotion && Boolean(content);

  useLayoutEffect(() => {
    if (!shouldAnimate) {
      setVisibleCount(content.length);
      setIsComplete(true);
      return;
    }

    // Reset animation state when content or toggle changes
    setVisibleCount(0);
    setIsComplete(false);

    const N = content.length;
    if (N === 0) {
      setIsComplete(true);
      return;
    }

    // Calculate reveal duration capped at maxDuration (e.g. 450ms max)
    const duration = N <= 40
      ? Math.min(400, Math.max(160, N * 10))
      : Math.min(maxDuration, Math.max(200, N * 1.5));

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
      const currentCount = Math.floor(progress * N);

      setVisibleCount(currentCount);

      if (progress < 1) {
        animFrameRef.current = requestAnimationFrame(step);
      } else {
        setVisibleCount(N);
        setIsComplete(true);
        if (onCompleteRef.current) onCompleteRef.current();
      }
    };

    animFrameRef.current = requestAnimationFrame(step);

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [shouldAnimate, content, maxDuration, delay]);

  if (!shouldAnimate || isComplete) {
    return <Component className={className} style={style}>{content || children}</Component>;
  }

  const revealed = content.slice(0, visibleCount);
  const hidden = content.slice(visibleCount);

  return (
    <Component className={className} style={style} aria-label={content}>
      <span aria-hidden="true">{revealed}</span>
      <span aria-hidden="true" style={{ visibility: 'hidden', opacity: 0 }}>{hidden}</span>
    </Component>
  );
}

'use client';

import { forwardRef, type CSSProperties, type TextareaHTMLAttributes } from 'react';
import styles from './Textarea.module.css';

type Props = TextareaHTMLAttributes<HTMLTextAreaElement>;

/**
 * Reusable textarea. Same visual language as Input, plus:
 *
 * - `autoResize` prop — automatically grows with content up to
 *   `maxAutoHeight` (default: 320px). Useful for notes / prompts / long
 *   descriptions where a scrollbar inside a tiny textarea is painful.
 *
 * All native `<textarea>` props are supported.
 */
type TextareaProps = Props & {
  autoResize?: boolean;
  maxAutoHeight?: number;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, autoResize = false, maxAutoHeight = 320, onInput, style, ...rest },
  ref,
) {
  const handleInput: typeof onInput = (event) => {
    if (autoResize) {
      const el = event.currentTarget;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, maxAutoHeight)}px`;
    }
    onInput?.(event);
  };

  const autoStyle: CSSProperties | undefined = autoResize
    ? { overflowY: 'auto', ...style }
    : style;

  return (
    <textarea
      ref={ref}
      className={`${styles.textarea} ${className ?? ''}`}
      onInput={handleInput}
      style={autoStyle}
      {...rest}
    />
  );
});

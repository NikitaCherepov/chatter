'use client';

import { forwardRef, type InputHTMLAttributes } from 'react';
import styles from './Input.module.css';

type Props = InputHTMLAttributes<HTMLInputElement>;

/**
 * Reusable text input.
 *
 * Replaces the global `input {}` rule from globals.css with a dedicated
 * CSS-module class, so we don't depend on element selectors and can
 * freely compose inputs inside FormField / Card / Select without side
 * effects.
 *
 * All native `<input>` props are supported (type, value, onChange,
 * placeholder, autoComplete, etc.) — no abstraction layer, just
 * styling.
 */
export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={`${styles.input} ${className ?? ''}`} {...rest} />;
});

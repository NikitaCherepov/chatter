import type { ReactNode } from 'react';
import styles from './Card.module.css';

type Props = { title?: string; description?: string; aside?: ReactNode; children: ReactNode; className?: string };

export function Card({ title, description, aside, children, className = '' }: Props) {
  return <section className={`${styles.card} ${className}`}>{(title || description || aside) && <div className={styles.header}><div>{title && <h2>{title}</h2>}{description && <p>{description}</p>}</div>{aside}</div>}<div className={styles.body}>{children}</div></section>;
}

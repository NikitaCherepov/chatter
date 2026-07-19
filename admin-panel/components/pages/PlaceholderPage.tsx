import { Card } from '../ui/Card';
import styles from './PlaceholderPage.module.css';

export function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return <div className={styles.wrap}><Card><div className={styles.empty}><span>Раздел подготовлен</span><h2>{title}</h2><p>{description}</p></div></Card></div>;
}

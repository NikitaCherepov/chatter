import type { NewsListBlockData } from '../../types';
import { safeUrl } from '../../utils/media';
import s from '../../Newspaper.module.scss';

export function NewsListBlock({ news, numbered = false }: { news?: NewsListBlockData; numbered?: boolean }) {
  if (!news) return null;
  return <div className={numbered ? s.numberedNews : s.newsItems}>{news.items.map((item, index) => {
    const url = safeUrl(item.url);
    return <article key={`${item.title}-${index}`}><span className={s.newsIndex}>{String(index + 1).padStart(2, '0')}</span><div>{url ? <a href={url} target="_blank" rel="noreferrer">{item.title}</a> : <strong>{item.title}</strong>}{item.summary && <p>{item.summary}</p>}</div></article>;
  })}</div>;
}

import type { ArticleBlockData } from '../../types';
import { SourcesBlock } from '../SourcesBlock/SourcesBlock';

export function ArticleBlock({ article, className, eyebrow }: { article: ArticleBlockData; className?: string; eyebrow?: string }) {
  return <article className={className}>{eyebrow && <span>{eyebrow}</span>}<h2>{article.title}</h2><p>{article.summary}</p><SourcesBlock sources={article.sources}/></article>;
}

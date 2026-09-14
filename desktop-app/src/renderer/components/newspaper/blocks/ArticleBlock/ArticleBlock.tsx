import type { ArticleBlockData } from '../../types';
import { safeImageUrl } from '../../utils/media';
import { SourcesBlock } from '../SourcesBlock/SourcesBlock';
import s from '../../Newspaper.module.scss';

export function ArticleBlock({ article, className, eyebrow }: { article: ArticleBlockData; className?: string; eyebrow?: string }) {
  const image = safeImageUrl(article.image_url);
  return <article className={className} data-role={article.role}>{eyebrow && <span>{eyebrow}</span>}{image && <img className={s.articleImage} src={image} alt=""/>}<h2>{article.title}</h2><p>{article.text}</p><SourcesBlock sources={article.sources}/></article>;
}

export function ArticleImage({ article, className }: { article?: ArticleBlockData; className?: string }) {
  const image = safeImageUrl(article?.image_url);
  return image ? <img className={className} src={image} alt=""/> : null;
}

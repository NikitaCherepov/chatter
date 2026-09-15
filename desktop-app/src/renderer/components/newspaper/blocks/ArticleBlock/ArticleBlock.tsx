import type { ArticleBlockData } from '../../types';
import { safeImageUrl, safeUrl } from '../../utils/media';
import { SourcesBlock } from '../SourcesBlock/SourcesBlock';
import s from '../../Newspaper.module.scss';

export function ArticleBlock({
  article,
  className,
  eyebrow,
  interactive = false,
}: {
  article: ArticleBlockData;
  className?: string;
  eyebrow?: string;
  interactive?: boolean;
}) {
  const image = safeImageUrl(article.image_url);
  const source = interactive
    ? article.sources?.map((item) => safeUrl(item.url)).find(Boolean)
    : null;
  const openSource = () => {
    if (source) window.open(source, '_blank', 'noopener,noreferrer');
  };
  return (
    <article
      className={className}
      data-role={article.role}
      data-clickable={source ? 'true' : undefined}
      role={source ? 'link' : undefined}
      tabIndex={source ? 0 : undefined}
      onClick={
        source
          ? (event) => {
              if (!(event.target as HTMLElement).closest('a, button')) openSource();
            }
          : undefined
      }
      onKeyDown={
        source
          ? (event) => {
              if (
                event.target === event.currentTarget &&
                (event.key === 'Enter' || event.key === ' ')
              ) {
                event.preventDefault();
                openSource();
              }
            }
          : undefined
      }
    >
      {eyebrow && <span>{eyebrow}</span>}
      {image && <img className={s.articleImage} src={image} alt="" />}
      <h2>{article.title}</h2>
      <p>{article.text}</p>
      <SourcesBlock sources={article.sources} />
    </article>
  );
}

export function ArticleImage({
  article,
  className,
}: {
  article?: ArticleBlockData;
  className?: string;
}) {
  const image = safeImageUrl(article?.image_url);
  return image ? <img className={className} src={image} alt="" /> : null;
}

import type { ArticleBlockData } from '../../types';
import { safeImageUrl, safeUrl } from '../../utils/media';
import { SourcesBlock } from '../SourcesBlock/SourcesBlock';
import s from '../../Newspaper.module.scss';

export function ArticleBlock({
  article,
  className,
  eyebrow,
  interactive = false,
  titleLink = false,
}: {
  article: ArticleBlockData;
  className?: string;
  eyebrow?: string;
  interactive?: boolean;
  titleLink?: boolean;
}) {
  const image = safeImageUrl(article.image_url, 1200);
  const articleUrl = safeUrl(article.url);
  const panelUrl = interactive ? articleUrl : null;
  const openArticle = () => {
    if (panelUrl) window.open(panelUrl, '_blank', 'noopener,noreferrer');
  };
  return (
    <article
      className={className}
      data-role={article.role}
      data-clickable={panelUrl ? 'true' : undefined}
      role={panelUrl ? 'link' : undefined}
      tabIndex={panelUrl ? 0 : undefined}
      onClick={
        panelUrl
          ? (event) => {
              if (!(event.target as HTMLElement).closest('a, button')) openArticle();
            }
          : undefined
      }
      onKeyDown={
        panelUrl
          ? (event) => {
              if (
                event.target === event.currentTarget &&
                (event.key === 'Enter' || event.key === ' ')
              ) {
                event.preventDefault();
                openArticle();
              }
            }
          : undefined
      }
    >
      {eyebrow && <span>{eyebrow}</span>}
      {image && <img className={s.articleImage} src={image} alt="" />}
      <h2>{titleLink && articleUrl
        ? <a data-article-title-link="true" href={articleUrl} target="_blank" rel="noreferrer">{article.title}</a>
        : article.title}</h2>
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
  const image = safeImageUrl(article?.image_url, 1200);
  return image ? <img className={className} src={image} alt="" /> : null;
}

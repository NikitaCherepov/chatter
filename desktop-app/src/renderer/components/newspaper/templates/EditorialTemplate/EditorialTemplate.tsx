import { ArticleBlock } from '../../blocks/ArticleBlock/ArticleBlock';
import { HeroImage } from '../../blocks/HeroBlock/HeroBlock';
import { HumorBlock } from '../../blocks/HumorBlock/HumorBlock';
import { ImageBlock } from '../../blocks/ImageBlock/ImageBlock';
import { NewsListBlock } from '../../blocks/NewsListBlock/NewsListBlock';
import { SourcesBlock } from '../../blocks/SourcesBlock/SourcesBlock';
import { WeatherForecast } from '../../blocks/WeatherBlock/WeatherBlock';
import type { NewspaperTemplateProps } from '../../types';
import s from '../../Newspaper.module.scss';

export function EditorialTemplate({ issue, content }: NewspaperTemplateProps) {
  const { hero, weather, news, articles, images, humor } = content;
  return <article className={`${s.page} ${s.editorial}`}><header className={s.editorialHead}><div/><h1>{issue.document.title}</h1><p><span>{issue.document.subtitle}</span><span>{issue.document.date}</span></p></header><div className={s.editorialGrid}>
    <aside className={s.editorialWeather}><b>{weather?.location}</b><h2>{weather?.condition}</h2><WeatherForecast weather={weather}/><p>{weather?.details}</p></aside>
    <main className={s.editorialLead}><HeroImage hero={hero}/><h2>{hero?.title}</h2><p>{hero?.summary}</p><SourcesBlock sources={hero?.sources}/></main>
    <section className={s.editorialNews}><h2>{news?.title}</h2><NewsListBlock news={news} numbered/></section>
    <section className={s.editorialArticles}>{articles.map(article => <ArticleBlock key={article.id} article={article}/>)}</section>
    {images.map(image => <ImageBlock key={image.id} image={image} className={s.editorialImage}/>)}
    {humor && <HumorBlock humor={humor} className={s.editorialHumor} prefix="✦"/>}
  </div></article>;
}

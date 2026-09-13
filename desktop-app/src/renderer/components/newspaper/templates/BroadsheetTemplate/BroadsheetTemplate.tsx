import { ArticleBlock } from '../../blocks/ArticleBlock/ArticleBlock';
import { HeroImage } from '../../blocks/HeroBlock/HeroBlock';
import { HumorBlock } from '../../blocks/HumorBlock/HumorBlock';
import { ImageBlock } from '../../blocks/ImageBlock/ImageBlock';
import { NewsListBlock } from '../../blocks/NewsListBlock/NewsListBlock';
import { SourcesBlock } from '../../blocks/SourcesBlock/SourcesBlock';
import { WeatherForecast } from '../../blocks/WeatherBlock/WeatherBlock';
import type { NewspaperTemplateProps } from '../../types';
import s from '../../Newspaper.module.scss';

export function BroadsheetTemplate({ issue, content }: NewspaperTemplateProps) {
  const { hero, weather, news, articles, images, humor } = content;
  return <article className={`${s.page} ${s.broadsheet}`}>
    <header className={s.metroHead}><div className={s.metroEars}><span>Technology · Science · Culture</span><span>{issue.document.date}</span><span>Morning edition · No. {issue.issue_number}</span></div><h1>The Chatter Times</h1><div className={s.metroSub}><span>Independent daily journal</span><b>CHT 2026</b><span>Tomsk · Digital edition</span></div></header>
    <div className={s.metroGrid}><aside className={s.metroLeft}><section><h3>{weather?.location}</h3><h2>{weather?.condition}</h2><WeatherForecast weather={weather} compact/></section><section><h2>{news?.title}</h2><NewsListBlock news={news}/></section></aside>
      <main className={s.metroLead}><h2>{hero?.title}</h2><p className={s.metroDeck}>{hero?.summary}</p><HeroImage hero={hero}/><p className={s.metroCaption}>Главный материал выпуска, проверенный редактором.</p><SourcesBlock sources={hero?.sources}/></main>
      <aside className={s.metroRight}>{articles.map(article => <ArticleBlock key={article.id} article={article}/>)}</aside>
    </div>
    <footer className={s.metroFooter}>{images.map(image => <ImageBlock key={image.id} image={image}/>)}{humor && <HumorBlock humor={humor}/>}</footer>
  </article>;
}

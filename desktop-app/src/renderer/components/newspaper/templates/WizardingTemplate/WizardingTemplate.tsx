import { ArticleBlock } from '../../blocks/ArticleBlock/ArticleBlock';
import { HeroImage } from '../../blocks/HeroBlock/HeroBlock';
import { HumorBlock } from '../../blocks/HumorBlock/HumorBlock';
import { ImageBlock } from '../../blocks/ImageBlock/ImageBlock';
import { NewsListBlock } from '../../blocks/NewsListBlock/NewsListBlock';
import { SourcesBlock } from '../../blocks/SourcesBlock/SourcesBlock';
import { WeatherForecast } from '../../blocks/WeatherBlock/WeatherBlock';
import type { NewspaperTemplateProps } from '../../types';
import s from '../../Newspaper.module.scss';

export function WizardingTemplate({ issue, content }: NewspaperTemplateProps) {
  const { hero, weather, news, articles, images, humor } = content;
  return <article className={`${s.page} ${s.wizarding}`}>
    <header className={s.wizardHead}><div className={s.wizardMicro}>OWL POST · CELESTIAL FORECAST · ENCHANTED EDITION</div><h1><span>The</span> Chatter Prophet</h1><div className={s.wizardRule}><b>EXCLUSIVE</b><span>{issue.document.date}</span><b>№ {issue.issue_number}</b></div></header>
    <section className={s.wizardLead}>
      <aside className={s.wizardSide}><h3>ПОГОДА</h3><strong>{weather?.condition}</strong><WeatherForecast weather={weather} compact/><p>{weather?.details}</p></aside>
      <main className={s.wizardMain}><div className={s.wizardStamp}>ЭКСКЛЮЗИВ</div><h2>{hero?.title}</h2><HeroImage hero={hero}/><p>{hero?.summary}</p><SourcesBlock sources={hero?.sources}/></main>
      <aside className={s.wizardSide}><h3>{news?.title || 'СЕГОДНЯ'}</h3><NewsListBlock news={news}/></aside>
    </section>
    <section className={s.wizardBottom}>
      {articles.map(article => <ArticleBlock key={article.id} article={article}/>)}
      {images.map(image => <ImageBlock key={image.id} image={image} className={s.wizardImage}/>)}
      {humor && <HumorBlock humor={humor} className={s.wizardHumor}/>}
    </section>
  </article>;
}

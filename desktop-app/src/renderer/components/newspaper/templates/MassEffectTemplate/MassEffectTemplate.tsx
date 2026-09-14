import { ArticleBlock } from '../../blocks/ArticleBlock/ArticleBlock';
import { ArticleImage } from '../../blocks/ArticleBlock/ArticleBlock';
import { ImageBlock } from '../../blocks/ImageBlock/ImageBlock';
import { NoteBlock } from '../../blocks/NoteBlock/NoteBlock';
import { NotesListBlock } from '../../blocks/NotesListBlock/NotesListBlock';
import { SourcesBlock } from '../../blocks/SourcesBlock/SourcesBlock';
import { WeatherForecast } from '../../blocks/WeatherBlock/WeatherBlock';
import type { NewspaperTemplateProps } from '../../types';
import s from '../../Newspaper.module.scss';

export function MassEffectTemplate({ issue, content }: NewspaperTemplateProps) {
  const { hero, weather, noteLists, notes, articles, images } = content;
  return <article className={`${s.page} ${s.massEffect}`}>
    <header className={s.annHead}><span className={s.annIcon}>✦</span><div><h1>ALLIANCE NEWS NETWORK <b>// ANN FEED</b></h1><p>EARTH DATE: {issue.document.date} // EXTRANET RELAY NODE: ARCTURUS</p></div><strong>PRIORITY<br/>CLEARANCE 4</strong></header>
    <section className={s.annLead}><ArticleImage article={hero}/><div className={s.annOverlay}><span>TOP STORY // VERIFIED</span><h2>{hero?.title}</h2><p>{hero?.text}</p><SourcesBlock sources={hero?.sources}/></div></section>
    <section className={s.annModules}><article className={s.annNews}><header>LIVE BRIEFING</header>{noteLists.map(list => <NotesListBlock key={list.id} list={list} numbered/>)}</article><aside className={s.annWeather}><header>LOCAL TELEMETRY</header><h2>{weather?.location}</h2><WeatherForecast weather={weather}/><p>{weather?.details}</p></aside></section>
    <section className={s.annAnalysis}>{articles.map((article,index) => <ArticleBlock key={article.id} article={article} eyebrow={`0${index + 1} // ANALYSIS`}/>)}{images.map(image => <ImageBlock key={image.id} image={image} className={s.annMedia}/>)}</section>
    {notes.map(note => <NoteBlock key={note.id} note={note} className={s.annTicker} prefix="ANN // CULTURE"/>)}
  </article>;
}

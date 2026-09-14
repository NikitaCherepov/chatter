import { ArticleBlock } from '../../blocks/ArticleBlock/ArticleBlock';
import { ArticleImage } from '../../blocks/ArticleBlock/ArticleBlock';
import { ImageBlock } from '../../blocks/ImageBlock/ImageBlock';
import { NoteBlock } from '../../blocks/NoteBlock/NoteBlock';
import { NotesListBlock } from '../../blocks/NotesListBlock/NotesListBlock';
import { SourcesBlock } from '../../blocks/SourcesBlock/SourcesBlock';
import { WeatherForecast } from '../../blocks/WeatherBlock/WeatherBlock';
import type { NewspaperTemplateProps } from '../../types';
import s from '../../Newspaper.module.scss';

export function DeusExTemplate({ issue, content }: NewspaperTemplateProps) {
  const { hero, weather, noteLists, notes, articles, images } = content;
  return <article className={`${s.page} ${s.deusEx}`}>
    <header className={s.picusHead}><div className={s.picusCrown}><span className={s.picusMark}>CD</span><div><small>THE</small><b>CHATTER DAILY</b><em>STANDARD</em></div></div><div className={s.picusTag}>ONE NETWORK. ONE SOURCE. VERIFIED.</div></header>
    <div className={s.picusSkyline}><span>NETWORK // 318A.768B</span><strong>CONNECTION ESTABLISHED</strong><i>{issue.document.date}</i></div>
    <div className={s.picusMetrics}><span><b>72%</b> SIGNAL</span><span><b>{String(issue.blocks_count).padStart(2, '0')}</b> REPORTS</span><span><b>+13%</b> RELEVANCE</span><span><b>00:42</b> UPDATED</span></div>
    <section className={s.picusLead}><div className={s.picusPhoto}><ArticleImage article={hero}/><div><span>PRIORITY REPORT</span><h2>{hero?.title}</h2></div></div><aside><h2>{weather?.condition}</h2><WeatherForecast weather={weather} compact/><p>{weather?.details}</p></aside></section>
    <section className={s.picusStories}><article className={s.picusMainText}><h2>{hero?.title}</h2><p>{hero?.text}</p><SourcesBlock sources={hero?.sources}/></article><div className={s.picusNews}>{noteLists.map(list => <NotesListBlock key={list.id} list={list} numbered/>)}</div></section>
    <section className={s.picusLower}>{articles.map(article => <ArticleBlock key={article.id} article={article} eyebrow="ANALYSIS"/>)}{images.map(image => <ImageBlock key={image.id} image={image} className={s.picusMedia}/>)}</section>
    {notes.map(note => <NoteBlock key={note.id} note={note} className={s.picusTicker} prefix="PICUS // CULTURE"/>)}
  </article>;
}

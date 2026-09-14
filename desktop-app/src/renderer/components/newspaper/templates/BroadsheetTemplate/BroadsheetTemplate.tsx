import { ArticleBlock } from '../../blocks/ArticleBlock/ArticleBlock';
import { ArticleImage } from '../../blocks/ArticleBlock/ArticleBlock';
import { ImageBlock } from '../../blocks/ImageBlock/ImageBlock';
import { NoteBlock } from '../../blocks/NoteBlock/NoteBlock';
import { NotesListBlock } from '../../blocks/NotesListBlock/NotesListBlock';
import { SourcesBlock } from '../../blocks/SourcesBlock/SourcesBlock';
import { WeatherForecast } from '../../blocks/WeatherBlock/WeatherBlock';
import type { NewspaperTemplateProps } from '../../types';
import s from '../../Newspaper.module.scss';

export function BroadsheetTemplate({ issue, content }: NewspaperTemplateProps) {
  const { hero, weather, noteLists, notes, articles, images } = content;
  return <article className={`${s.page} ${s.broadsheet}`}>
    <header className={s.metroHead}><div className={s.metroEars}><span>Technology · Science · Culture</span><span>{issue.document.date}</span><span>Morning edition · No. {issue.issue_number}</span></div><h1>The Chatter Times</h1><div className={s.metroSub}><span>Independent daily journal</span><b>CHT 2026</b><span>Tomsk · Digital edition</span></div></header>
    <div className={s.metroGrid}><aside className={s.metroLeft}><section><h3>{weather?.location}</h3><h2>{weather?.condition}</h2><WeatherForecast weather={weather} compact/></section>{noteLists.map(list => <section key={list.id}><h2>{list.title}</h2><NotesListBlock list={list}/></section>)}</aside>
      <main className={s.metroLead}><h2>{hero?.title}</h2><p className={s.metroDeck}>{hero?.text}</p><ArticleImage article={hero}/><p className={s.metroCaption}>Главный материал выпуска, проверенный редактором.</p><SourcesBlock sources={hero?.sources}/></main>
      <aside className={s.metroRight}>{articles.map(article => <ArticleBlock key={article.id} article={article}/>)}</aside>
    </div>
    <footer className={s.metroFooter}>{images.map(image => <ImageBlock key={image.id} image={image}/>)}{notes.map(note => <NoteBlock key={note.id} note={note}/>)}</footer>
  </article>;
}

import { ArticleBlock } from '../../blocks/ArticleBlock/ArticleBlock';
import { ArticleImage } from '../../blocks/ArticleBlock/ArticleBlock';
import { ImageBlock } from '../../blocks/ImageBlock/ImageBlock';
import { NoteBlock } from '../../blocks/NoteBlock/NoteBlock';
import { NotesListBlock } from '../../blocks/NotesListBlock/NotesListBlock';
import { SourcesBlock } from '../../blocks/SourcesBlock/SourcesBlock';
import { WeatherForecast } from '../../blocks/WeatherBlock/WeatherBlock';
import type { NewspaperTemplateProps } from '../../types';
import s from '../../Newspaper.module.scss';

export function WizardingTemplate({ issue, content }: NewspaperTemplateProps) {
  const { hero, weather, noteLists, notes, articles, images } = content;
  return <article className={`${s.page} ${s.wizarding}`}>
    <header className={s.wizardHead}><div className={s.wizardMicro}>OWL POST · CELESTIAL FORECAST · ENCHANTED EDITION</div><h1><span>The</span> Chatter Prophet</h1><div className={s.wizardRule}><b>EXCLUSIVE</b><span>{issue.document.date}</span><b>№ {issue.issue_number}</b></div></header>
    <section className={s.wizardLead}>
      <aside className={s.wizardSide}><h3>ПОГОДА</h3><strong>{weather?.condition}</strong><WeatherForecast weather={weather} compact/><p>{weather?.details}</p></aside>
      <main className={s.wizardMain}><div className={s.wizardStamp}>ЭКСКЛЮЗИВ</div><h2>{hero?.title}</h2><ArticleImage article={hero}/><p>{hero?.text}</p><SourcesBlock sources={hero?.sources}/></main>
      <aside className={s.wizardSide}>{noteLists.map(list => <section key={list.id}>{list.title && <h3>{list.title}</h3>}<NotesListBlock list={list}/></section>)}</aside>
    </section>
    <section className={s.wizardBottom}>
      {articles.map(article => <ArticleBlock key={article.id} article={article}/>)}
      {images.map(image => <ImageBlock key={image.id} image={image} className={s.wizardImage}/>)}
      {notes.map(note => <NoteBlock key={note.id} note={note} className={s.wizardHumor}/>)}
    </section>
  </article>;
}

import { ArticleBlock } from '../../blocks/ArticleBlock/ArticleBlock';
import { ArticleImage } from '../../blocks/ArticleBlock/ArticleBlock';
import { ImageBlock } from '../../blocks/ImageBlock/ImageBlock';
import { NoteBlock } from '../../blocks/NoteBlock/NoteBlock';
import { NotesListBlock } from '../../blocks/NotesListBlock/NotesListBlock';
import { SourcesBlock } from '../../blocks/SourcesBlock/SourcesBlock';
import { WeatherForecast } from '../../blocks/WeatherBlock/WeatherBlock';
import { articleMaterial, useNewspaperMaterialViewer } from '../../NewspaperMaterialContext';
import type { NewspaperTemplateProps } from '../../types';
import s from '../../Newspaper.module.scss';

export function EditorialHead({ issue }: Pick<NewspaperTemplateProps, 'issue'>) {
  return <header className={s.editorialHead}><div/><h1>{issue.document.title}</h1><p><span>{issue.document.subtitle}</span><span>{issue.document.date}</span></p></header>;
}

export function EditorialTemplate({ issue, content }: NewspaperTemplateProps) {
  const openMaterial = useNewspaperMaterialViewer();
  const { hero, weather, noteLists, notes, articles, images } = content;
  return <article className={`${s.page} ${s.editorial}`}><EditorialHead issue={issue}/><div className={s.editorialGrid}>
    <aside className={s.editorialWeather}><b>{weather?.location}</b><h2>{weather?.condition}</h2><WeatherForecast weather={weather}/><p>{weather?.details}</p></aside>
    <main className={s.editorialLead}><ArticleImage article={hero}/><h2>{hero && <button type="button" className={s.materialOpenTitle} onClick={() => openMaterial?.(articleMaterial(hero))}>{hero.title}</button>}</h2><p>{hero?.text}</p><SourcesBlock sources={hero?.sources}/></main>
    <section className={s.editorialNews}>{noteLists.map(list => <section key={list.id}>{list.title && <h2>{list.title}</h2>}<NotesListBlock list={list} numbered/></section>)}</section>
    <section className={s.editorialArticles}>{articles.map(article => <ArticleBlock key={article.id} article={article}/>)}</section>
    {images.map(image => <ImageBlock key={image.id} image={image} className={s.editorialImage}/>)}
    {notes.map(note => <NoteBlock key={note.id} note={note} className={s.editorialHumor} prefix="✦"/>)}
  </div></article>;
}

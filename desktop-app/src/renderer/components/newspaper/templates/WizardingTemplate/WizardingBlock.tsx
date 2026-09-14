import { ArticleBlock } from '../../blocks/ArticleBlock/ArticleBlock';
import { ImageBlock } from '../../blocks/ImageBlock/ImageBlock';
import { NoteBlock } from '../../blocks/NoteBlock/NoteBlock';
import { NotesListBlock } from '../../blocks/NotesListBlock/NotesListBlock';
import { WeatherForecast } from '../../blocks/WeatherBlock/WeatherBlock';
import type { NewspaperBlock } from '../../types';
import s from '../../Newspaper.module.scss';
import t from './WizardingTemplate.module.scss';

export function WizardingRailBlock({ block }: { block: NewspaperBlock }) {
  if (block.type === 'weather') {
    return <aside className={s.wizardSide}><h3>ПОГОДА</h3><strong>{block.condition}</strong><WeatherForecast weather={block} compact/><p>{block.details}</p></aside>;
  }
  if (block.type === 'notes_list') {
    return <aside className={s.wizardSide}>{block.title && <h3>{block.title}</h3>}<NotesListBlock list={block}/></aside>;
  }
  if (block.type === 'note') return <NoteBlock note={block} className={`${s.wizardSide} ${t.railNote}`}/>;
  if (block.type === 'image') return <ImageBlock image={block} className={`${s.wizardSide} ${s.wizardImage} ${t.railImage}`}/>;
  return null;
}

export function WizardingBodyBlock({ block }: { block: NewspaperBlock }) {
  if (block.type === 'article') return <ArticleBlock article={block} className={t.bodyArticle}/>;
  if (block.type === 'note') return <NoteBlock note={block} className={`${s.wizardHumor} ${t.bodyNote}`} prefix="✦"/>;
  if (block.type === 'image') return <ImageBlock image={block} className={`${s.wizardImage} ${t.bodyImage}`}/>;
  if (block.type === 'notes_list') {
    return <section className={t.bodyList}>{block.title && <h2>{block.title}</h2>}<NotesListBlock list={block}/></section>;
  }
  const weekly = block.periods.length > 3;
  return <section className={`${t.bodyWeather} ${weekly ? t.weekWeather : ''}`}><b>{block.location}</b><h2>{weekly ? block.title || 'Прогноз на неделю' : block.condition}</h2>{weekly && <strong>{block.condition}</strong>}<WeatherForecast weather={block} compact={!weekly}/><p>{block.details}</p></section>;
}

import { ArticleBlock, ArticleImage } from '../../blocks/ArticleBlock/ArticleBlock';
import { ImageBlock } from '../../blocks/ImageBlock/ImageBlock';
import { NoteBlock } from '../../blocks/NoteBlock/NoteBlock';
import { NotesListBlock } from '../../blocks/NotesListBlock/NotesListBlock';
import { SourcesBlock } from '../../blocks/SourcesBlock/SourcesBlock';
import { WeatherForecast } from '../../blocks/WeatherBlock/WeatherBlock';
import type { NewspaperTemplateProps, NotesListBlockData } from '../../types';
import { composeBroadsheetPage } from './broadsheetLayout';
import s from '../../Newspaper.module.scss';
import t from './BroadsheetTemplate.module.scss';

type Layout = ReturnType<typeof composeBroadsheetPage>;

function Masthead({ issue }: Pick<NewspaperTemplateProps, 'issue'>) {
  return <header className={t.masthead}>
    <div className={t.mastheadRow}>
      <div className={t.ear}><small>Основана в 2026 году</small><strong>Факты<br/>прежде шума</strong></div>
      <h1><span>The</span> Chatter Times</h1>
      <div className={`${t.ear} ${t.earRight}`}><strong>Digital Edition</strong><span>Technology · Science<br/>Culture · People</span></div>
    </div>
    <div className={t.dateline}><span>VOL. I · NO. {issue.issue_number}</span><span>{issue.document.date}</span><span>TOMSK · OPEN ACCESS</span></div>
  </header>;
}

function BriefsSection({ list, className = '' }: { list: NotesListBlockData; className?: string }) {
  return <section className={`${t.briefsSection} ${className}`} data-item-count={list.items.length}>
    {list.title && <h2>{list.title}</h2>}
    <NotesListBlock list={list} className={t.briefItems}/>
  </section>;
}

function LeadPage({ layout }: { layout: Layout }) {
  const leftLists = layout.noteLists.slice(0, 1);
  const rightArticles = layout.articles.slice(0, 2);
  const rightList = rightArticles.length === 0 ? layout.noteLists[1] : undefined;
  const lowerArticles = layout.articles.slice(2);
  const lowerLists = layout.noteLists.slice(rightList ? 2 : 1);
  const centerList = !layout.hero?.image_url ? lowerLists[0] : undefined;
  const footerLists = lowerLists.slice(centerList ? 1 : 0);
  return <>
    <div className={t.leadGrid}>
      <aside className={t.leftRail}>
        {layout.weather && <section className={t.weather}><span className={t.sectionLabel}>{layout.weather.location}</span><h2>{layout.weather.condition}</h2><WeatherForecast weather={layout.weather} compact/></section>}
        {leftLists.map(list => <BriefsSection key={list.id} list={list}/>)}
        {layout.notes.slice(0, 1).map(note => <NoteBlock key={note.id} note={note} className={t.railNote}/>)}
      </aside>
      <main className={`${t.leadStory} ${layout.hero?.image_url ? '' : t.leadStoryTextOnly}`}>
        <span className={t.overline}>Главная история</span><h2>{layout.hero?.title}</h2><p className={t.deck}>{layout.hero?.text}</p>
        <ArticleImage article={layout.hero}/><p className={t.caption}>Главный материал выпуска · Редакционная публикация</p><SourcesBlock sources={layout.hero?.sources}/>
        {centerList && <BriefsSection list={centerList} className={t.centerBriefs}/>}
      </main>
      <aside className={t.rightRail}>{rightArticles.map(article => <ArticleBlock key={article.id} article={article} className={t.railArticle}/>)}{rightList && <BriefsSection list={rightList}/>}</aside>
    </div>
    {(lowerArticles.length > 0 || footerLists.length > 0 || layout.images.length > 0 || layout.notes.length > 1) && <div className={t.lowerGrid}>
      {lowerArticles.map(article => <ArticleBlock key={article.id} article={article} className={t.lowerArticle}/>)}
      {footerLists.map(list => <BriefsSection key={list.id} list={list} className={t.lowerBriefs}/>)}
      {layout.images.map(image => <ImageBlock key={image.id} image={image} className={t.lowerImage}/>)}
      {layout.notes.slice(1).map(note => <NoteBlock key={note.id} note={note} className={t.lowerNote}/>)}
    </div>}
  </>;
}

function SectionPage({ layout }: { layout: Layout }) {
  const [feature, ...articles] = layout.articles;
  return <>
    <div className={t.sectionBanner}><span>Внутри выпуска</span><h2>{feature?.title || layout.noteLists[0]?.title || 'Новости и наблюдения'}</h2></div>
    <div className={t.sectionGrid}>
      {feature && <ArticleBlock article={feature} className={t.sectionFeature}/>}
      {articles.length > 0 && <div className={t.storyColumns}>{articles.map(article => <ArticleBlock key={article.id} article={article} className={t.columnStory}/>)}</div>}
      {layout.weather && <section className={t.sectionWeather}><h3>{layout.weather.location}</h3><h2>{layout.weather.condition}</h2><WeatherForecast weather={layout.weather}/></section>}
      {layout.noteLists.map(list => <BriefsSection key={list.id} list={list} className={t.sectionBriefs}/>)}
      {layout.images.map(image => <ImageBlock key={image.id} image={image} className={t.sectionImage}/>)}
      {layout.notes.map(note => <NoteBlock key={note.id} note={note} className={t.sectionNote}/>)}
    </div>
  </>;
}

function BriefsPage({ layout }: { layout: Layout }) {
  return <><div className={t.sectionBanner}><span>Коротким форматом</span><h2>Сводка дня</h2></div><div className={t.briefsGrid} data-list-count={layout.noteLists.length}>{layout.noteLists.map(list => <BriefsSection key={list.id} list={list} className={t.briefsColumn}/>)}</div></>;
}

function PhotoPage({ layout }: { layout: Layout }) {
  return <><div className={t.sectionBanner}><span>Фотохроника</span><h2>В объективе</h2></div><div className={t.photoGrid} data-image-count={layout.images.length}>{layout.images.map(image => <ImageBlock key={image.id} image={image} className={t.photo}/>)}</div></>;
}

export function BroadsheetTemplate({ issue }: NewspaperTemplateProps) {
  const layout = composeBroadsheetPage(issue.document.blocks);
  return <article className={`${s.page} ${s.broadsheet} ${t.paper}`} data-recipe={layout.recipe}>
    <Masthead issue={issue}/>
    {layout.recipe === 'lead' && <LeadPage layout={layout}/>}
    {layout.recipe === 'section-page' && <SectionPage layout={layout}/>}
    {layout.recipe === 'briefs-page' && <BriefsPage layout={layout}/>}
    {layout.recipe === 'photo-page' && <PhotoPage layout={layout}/>}
    <footer className={t.folio}><span>The Chatter Times</span><span>{issue.document.subtitle}</span><span>{String(Math.abs(issue.id) % 100 + 1).padStart(2, '0')}</span></footer>
  </article>;
}

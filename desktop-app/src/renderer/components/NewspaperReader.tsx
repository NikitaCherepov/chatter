import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import type { NewspaperBlock, NewspaperIssue, NewspaperSource } from '../lib/api';
import { Select, type SelectOption } from './Select';
import s from './NewspaperReader.module.scss';

type Weather = Extract<NewspaperBlock, { type: 'weather' }>;
type Hero = Extract<NewspaperBlock, { type: 'hero' }>;
type Article = Extract<NewspaperBlock, { type: 'article' }>;
type News = Extract<NewspaperBlock, { type: 'news_list' }>;
type ImageBlock = Extract<NewspaperBlock, { type: 'image' }>;
type Humor = Extract<NewspaperBlock, { type: 'humor' }>;

export type NewspaperVisualStyle = 'wizarding' | 'editorial' | 'broadsheet' | 'deusEx' | 'massEffect';

type Props = {
  issue: NewspaperIssue | null;
  style: NewspaperVisualStyle;
  pageNumber: number;
  pageCount: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  onStyleChange: (style: NewspaperVisualStyle) => void;
  leadLabel: string;
  previousLabel: string;
  nextLabel: string;
  closeLabel: string;
};

const styleOptions: SelectOption[] = [
  { value: 'wizarding', label: 'Волшебный таблоид', hint: 'Сенсации, пергамент и огромные заголовки' },
  { value: 'editorial', label: 'Редакционная', hint: 'Спокойная современная газета' },
  { value: 'broadsheet', label: 'Большая газета', hint: 'Строгая многоколоночная первая полоса' },
  { value: 'deusEx', label: 'Deus Ex', hint: 'Picus: чёрный интерфейс и золото' },
  { value: 'massEffect', label: 'Mass Effect', hint: 'ANN: циан, оранжевый и HUD' },
];

const safeUrl = (value?: string) => {
  if (!value) return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
};

const safeImageUrl = (value?: string) => {
  if (!value) return null;
  if (value.startsWith('data:image/') || value.startsWith('blob:')) return value;
  try { const url = new URL(value, window.location.href); return ['http:', 'https:', 'file:'].includes(url.protocol) ? url.href : null; } catch { return null; }
};

function Sources({ sources }: { sources?: NewspaperSource[] }) {
  const safe = (sources || []).map(source => ({ ...source, url: safeUrl(source.url) })).filter(source => source.url);
  return safe.length ? <div className={s.sources}>{safe.map(source => <a key={`${source.title}-${source.url}`} href={source.url!} target="_blank" rel="noreferrer">{source.title}</a>)}</div> : null;
}

function pick<T extends NewspaperBlock['type']>(blocks: NewspaperBlock[], type: T): Extract<NewspaperBlock, { type: T }> | undefined {
  return blocks.find(block => block.type === type) as Extract<NewspaperBlock, { type: T }> | undefined;
}
function all<T extends NewspaperBlock['type']>(blocks: NewspaperBlock[], type: T): Array<Extract<NewspaperBlock, { type: T }>> {
  return blocks.filter(block => block.type === type) as Array<Extract<NewspaperBlock, { type: T }>>;
}

function Forecast({ weather, compact = false }: { weather?: Weather; compact?: boolean }) {
  if (!weather) return null;
  return <div className={compact ? s.forecastCompact : s.forecast}>
    {weather.periods.map(period => <div className={s.forecastPeriod} key={period.label}><span>{period.label}</span><strong>{Math.round(period.temperature)}°</strong><small>{period.condition}</small></div>)}
  </div>;
}

function NewsItems({ news, numbered = false }: { news?: News; numbered?: boolean }) {
  if (!news) return null;
  return <div className={numbered ? s.numberedNews : s.newsItems}>{news.items.map((item, index) => {
    const url = safeUrl(item.url);
    return <article key={`${item.title}-${index}`}><span className={s.newsIndex}>{String(index + 1).padStart(2, '0')}</span><div>{url ? <a href={url} target="_blank" rel="noreferrer">{item.title}</a> : <strong>{item.title}</strong>}{item.summary && <p>{item.summary}</p>}</div></article>;
  })}</div>;
}

function LeadImage({ hero }: { hero?: Hero }) {
  const image = safeImageUrl(hero?.image_url);
  return image ? <img src={image} alt="" /> : null;
}

function WizardingPage({ issue }: { issue: NewspaperIssue }) {
  const blocks = issue.document.blocks; const hero = pick(blocks, 'hero'); const weather = pick(blocks, 'weather'); const news = pick(blocks, 'news_list'); const articles = all(blocks, 'article'); const humor = pick(blocks, 'humor');
  return <article className={`${s.page} ${s.wizarding}`}>
    <header className={s.wizardHead}><div className={s.wizardMicro}>OWL POST · CELESTIAL FORECAST · ENCHANTED EDITION</div><h1><span>The</span> Chatter Prophet</h1><div className={s.wizardRule}><b>EXCLUSIVE</b><span>{issue.document.date}</span><b>№ {issue.issue_number}</b></div></header>
    <section className={s.wizardLead}>
      <aside className={s.wizardSide}><h3>ПОГОДА</h3><strong>{weather?.condition}</strong><Forecast weather={weather} compact /><p>{weather?.details}</p></aside>
      <main className={s.wizardMain}><div className={s.wizardStamp}>ЭКСКЛЮЗИВ</div><h2>{hero?.title}</h2><LeadImage hero={hero}/><p>{hero?.summary}</p><Sources sources={hero?.sources}/></main>
      <aside className={s.wizardSide}><h3>СЕГОДНЯ</h3><NewsItems news={news}/></aside>
    </section>
    <section className={s.wizardBottom}>{articles.map(article => <article key={article.id}><h2>{article.title}</h2><p>{article.summary}</p><Sources sources={article.sources}/></article>)}{humor && <article className={s.wizardHumor}><h2>{humor.title}</h2><p>{humor.text}</p></article>}</section>
  </article>;
}

function EditorialPage({ issue }: { issue: NewspaperIssue }) {
  const blocks = issue.document.blocks; const hero = pick(blocks, 'hero'); const weather = pick(blocks, 'weather'); const news = pick(blocks, 'news_list'); const articles = all(blocks, 'article'); const humor = pick(blocks, 'humor');
  return <article className={`${s.page} ${s.editorial}`}><header className={s.editorialHead}><div/><h1>{issue.document.title}</h1><p><span>{issue.document.subtitle}</span><span>{issue.document.date}</span></p></header><div className={s.editorialGrid}>
    <aside className={s.editorialWeather}><b>{weather?.location}</b><h2>{weather?.condition}</h2><Forecast weather={weather}/><p>{weather?.details}</p></aside>
    <main className={s.editorialLead}><LeadImage hero={hero}/><h2>{hero?.title}</h2><p>{hero?.summary}</p><Sources sources={hero?.sources}/></main>
    <section className={s.editorialNews}><h2>{news?.title}</h2><NewsItems news={news} numbered/></section>
    <section className={s.editorialArticles}>{articles.map(article => <article key={article.id}><h2>{article.title}</h2><p>{article.summary}</p><Sources sources={article.sources}/></article>)}</section>
    {humor && <aside className={s.editorialHumor}><b>✦</b><h2>{humor.title}</h2><p>{humor.text}</p></aside>}
  </div></article>;
}

function BroadsheetPage({ issue }: { issue: NewspaperIssue }) {
  const blocks = issue.document.blocks; const hero = pick(blocks, 'hero'); const weather = pick(blocks, 'weather'); const news = pick(blocks, 'news_list'); const articles = all(blocks, 'article'); const image = pick(blocks, 'image'); const imageUrl = safeImageUrl(image?.image_url);
  return <article className={`${s.page} ${s.broadsheet}`}>
    <header className={s.metroHead}><div className={s.metroEars}><span>Technology · Science · Culture</span><span>{issue.document.date}</span><span>Morning edition · No. {issue.issue_number}</span></div><h1>The Chatter Times</h1><div className={s.metroSub}><span>Independent daily journal</span><b>CHT 2026</b><span>Tomsk · Digital edition</span></div></header>
    <div className={s.metroGrid}><aside className={s.metroLeft}><section><h3>{weather?.location}</h3><h2>{weather?.condition}</h2><Forecast weather={weather} compact/></section><section><h2>{news?.title}</h2><NewsItems news={news}/></section></aside>
      <main className={s.metroLead}><h2>{hero?.title}</h2><p className={s.metroDeck}>{hero?.summary}</p><LeadImage hero={hero}/><p className={s.metroCaption}>Схема редакционного процесса: независимые исследователи передают проверенные материалы редактору.</p><Sources sources={hero?.sources}/></main>
      <aside className={s.metroRight}>{articles.map(article => <article key={article.id}><h2>{article.title}</h2><p>{article.summary}</p><Sources sources={article.sources}/></article>)}</aside>
    </div>{imageUrl && <footer className={s.metroFooter}><img src={imageUrl} alt=""/><div><b>{image?.title}</b><p>{image?.caption}</p></div></footer>}
  </article>;
}

function DeusPage({ issue }: { issue: NewspaperIssue }) {
  const blocks = issue.document.blocks; const hero = pick(blocks, 'hero'); const weather = pick(blocks, 'weather'); const news = pick(blocks, 'news_list'); const articles = all(blocks, 'article');
  return <article className={`${s.page} ${s.deusEx}`}>
    <header className={s.picusHead}><div className={s.picusCrown}><span className={s.picusMark}>CD</span><div><small>THE</small><b>CHATTER DAILY</b><em>STANDARD</em></div></div><div className={s.picusTag}>ONE NETWORK. ONE SOURCE. VERIFIED.</div></header>
    <div className={s.picusSkyline}><span>NETWORK // 318A.768B</span><strong>CONNECTION ESTABLISHED</strong><i>{issue.document.date}</i></div>
    <div className={s.picusMetrics}><span><b>72%</b> SIGNAL</span><span><b>06</b> REPORTS</span><span><b>+13%</b> RELEVANCE</span><span><b>00:42</b> UPDATED</span></div>
    <section className={s.picusLead}><div className={s.picusPhoto}><LeadImage hero={hero}/><div><span>PRIORITY REPORT</span><h2>{hero?.title}</h2></div></div><aside><h2>{weather?.condition}</h2><Forecast weather={weather} compact/><p>{weather?.details}</p></aside></section>
    <section className={s.picusStories}><article className={s.picusMainText}><h2>{hero?.title}</h2><p>{hero?.summary}</p><Sources sources={hero?.sources}/></article><div className={s.picusNews}><NewsItems news={news} numbered/></div></section>
    <section className={s.picusLower}>{articles.map(article => <article key={article.id}><span>ANALYSIS</span><h2>{article.title}</h2><p>{article.summary}</p><Sources sources={article.sources}/></article>)}</section>
  </article>;
}

function MassPage({ issue }: { issue: NewspaperIssue }) {
  const blocks = issue.document.blocks; const hero = pick(blocks, 'hero'); const weather = pick(blocks, 'weather'); const news = pick(blocks, 'news_list'); const articles = all(blocks, 'article'); const humor = pick(blocks, 'humor');
  return <article className={`${s.page} ${s.massEffect}`}>
    <header className={s.annHead}><span className={s.annIcon}>✦</span><div><h1>ALLIANCE NEWS NETWORK <b>// ANN FEED</b></h1><p>EARTH DATE: {issue.document.date} // EXTRANET RELAY NODE: ARCTURUS</p></div><strong>PRIORITY<br/>CLEARANCE 4</strong></header>
    <section className={s.annLead}><LeadImage hero={hero}/><div className={s.annOverlay}><span>TOP STORY // VERIFIED</span><h2>{hero?.title}</h2><p>{hero?.summary}</p><Sources sources={hero?.sources}/></div></section>
    <section className={s.annModules}><article className={s.annNews}><header>LIVE BRIEFING</header><NewsItems news={news} numbered/></article><aside className={s.annWeather}><header>LOCAL TELEMETRY</header><h2>{weather?.location}</h2><Forecast weather={weather}/><p>{weather?.details}</p></aside></section>
    <section className={s.annAnalysis}>{articles.map((article,index) => <article key={article.id}><span>0{index+1} // ANALYSIS</span><h2>{article.title}</h2><p>{article.summary}</p><Sources sources={article.sources}/></article>)}</section>
    {humor && <footer className={s.annTicker}><b>ANN // CULTURE</b><span>{humor.text}</span></footer>}
  </article>;
}

function StyledPage({ issue, style }: { issue: NewspaperIssue; style: NewspaperVisualStyle }) {
  if (style === 'wizarding') return <WizardingPage issue={issue}/>;
  if (style === 'broadsheet') return <BroadsheetPage issue={issue}/>;
  if (style === 'deusEx') return <DeusPage issue={issue}/>;
  if (style === 'massEffect') return <MassPage issue={issue}/>;
  return <EditorialPage issue={issue}/>;
}

export function NewspaperReader({ issue, style, pageNumber, pageCount, canGoPrevious, canGoNext, onPrevious, onNext, onClose, onStyleChange, previousLabel, nextLabel, closeLabel }: Props) {
  useEffect(() => { if (!issue) return; const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); if (event.key === 'ArrowLeft' && canGoPrevious) onPrevious(); if (event.key === 'ArrowRight' && canGoNext) onNext(); }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, [canGoNext, canGoPrevious, issue, onClose, onNext, onPrevious]);
  return createPortal(<AnimatePresence>{issue && <motion.div className={s.backdrop} initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} onMouseDown={onClose}><motion.div className={s.dialog} initial={{opacity:0,y:20,scale:.985}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:14,scale:.99}} onMouseDown={event=>event.stopPropagation()} role="dialog" aria-modal="true">
    <header className={s.toolbar}><div className={s.issueMeta}><strong>Выпуск №{issue.issue_number}</strong><span>{pageNumber} / {pageCount}</span></div><div className={s.styleSelect}><Select options={styleOptions} value={style} onChange={value=>onStyleChange(value as NewspaperVisualStyle)} maxVisibleItems={5}/></div><nav className={s.navigation}><button type="button" onClick={onPrevious} disabled={!canGoPrevious} aria-label={previousLabel}>‹</button><button type="button" onClick={onNext} disabled={!canGoNext} aria-label={nextLabel}>›</button><button type="button" onClick={onClose} aria-label={closeLabel}>×</button></nav></header>
    <div className={s.viewport}><motion.div key={`${issue.id}-${style}`} initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} transition={{duration:.18}}><StyledPage issue={issue} style={style}/></motion.div></div>
  </motion.div></motion.div>}</AnimatePresence>,document.body);
}

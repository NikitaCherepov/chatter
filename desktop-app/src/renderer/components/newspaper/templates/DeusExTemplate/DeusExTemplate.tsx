import { ArticleBlock, ArticleImage } from '../../blocks/ArticleBlock/ArticleBlock';
import { ImageBlock } from '../../blocks/ImageBlock/ImageBlock';
import { NoteBlock, NoteContent } from '../../blocks/NoteBlock/NoteBlock';
import { NotesListBlock } from '../../blocks/NotesListBlock/NotesListBlock';
import { SourcesBlock } from '../../blocks/SourcesBlock/SourcesBlock';
import { articleMaterial, useNewspaperMaterialViewer } from '../../NewspaperMaterialContext';
import { WeatherForecast } from '../../blocks/WeatherBlock/WeatherBlock';
import type { ArticleBlockData, NewspaperBlock, NewspaperTemplateProps } from '../../types';
import { safeImageUrl } from '../../utils/media';
import { composeDeusExPage } from './deusExLayout';
import s from '../../Newspaper.module.scss';
import t from './DeusExTemplate.module.scss';

type Layout = ReturnType<typeof composeDeusExPage>;
type MediaBlock = Extract<NewspaperBlock, { type: 'article' | 'image' }>;

function ArticleTitle({ article, as = 'h2' }: { article: ArticleBlockData; as?: 'h2' | 'strong' }) {
  const openMaterial = useNewspaperMaterialViewer();
  const content = <button type="button" className={s.materialOpenTitle} onClick={() => openMaterial?.(articleMaterial(article))}>{article.title}</button>;
  return as === 'strong' ? <strong>{content}</strong> : <h2>{content}</h2>;
}

function mediaUrl(block: MediaBlock) {
  return safeImageUrl(block.image_url);
}

function ShellHeader({ issue, layout }: { issue: NewspaperTemplateProps['issue']; layout: Layout }) {
  const reports = (layout.hero ? 1 : 0) + layout.articles.length + layout.noteLists.reduce((count, list) => count + list.items.length, 0) + layout.notes.length;
  return <>
    <header className={t.head}><div className={t.crown}><span>CD</span><div><small>THE</small><b>CHATTER DAILY</b><em>STANDARD</em></div></div><div className={t.tag}>ONE NETWORK. ONE SOURCE. VERIFIED.</div></header>
    <div className={t.skyline}><span>NETWORK // 318A.768B</span><strong>CONNECTION ESTABLISHED</strong><i>{issue.document.date}</i></div>
    <div className={t.metrics}><span><b>{layout.images.length || layout.articles.filter(article => article.image_url).length}</b> SIGNALS</span><span><b>{String(reports).padStart(2, '0')}</b> REPORTS</span><span><b>{layout.recipe === 'priority-report' ? 'HIGH' : 'LIVE'}</b> RELEVANCE</span><span><b>{String(issue.issue_number).padStart(2, '0')}:42</b> UPDATED</span></div>
  </>;
}

function SignalStrip({ blocks }: { blocks: MediaBlock[] }) {
  if (blocks.length === 0) return null;
  return <section className={t.signalStrip} aria-label="Входящие сигналы"><div className={t.signalLabel}><span>LIVE FEEDS</span><b>SIGNAL / REPORTS</b></div>{blocks.slice(0, 5).map((block, index) => {
    const url = mediaUrl(block);
    return <article key={block.id} className={t.signal}>{url && <img src={url} alt=""/>}<span>{String(index + 1).padStart(2, '0')}</span>{block.type === 'article' ? <ArticleTitle article={block} as="strong"/> : <strong>{block.title}</strong>}</article>;
  })}</section>;
}

function WeatherModule({ weather }: { weather: Layout['weather'] }) {
  if (!weather) return <aside className={t.systemModule}><span>NETWORK STATUS</span><b>ALL CHANNELS NOMINAL</b><p>Encrypted relay available. No local alerts.</p></aside>;
  return <aside className={t.weather}><span>LOCAL CONDITIONS</span><h2>{weather.condition}</h2><WeatherForecast weather={weather} compact/><p>{weather.details}</p></aside>;
}

function PriorityPage({ layout }: { layout: Layout }) {
  const [sideArticle, ...analysis] = layout.articles;
  const heroImage = safeImageUrl(layout.hero?.image_url);
  const fallbackImage = heroImage ? undefined : layout.images[0];
  const leadImage = heroImage || (fallbackImage ? mediaUrl(fallbackImage) : undefined);
  const signals: MediaBlock[] = [...layout.images, ...layout.articles.filter(article => article.image_url)];
  return <>
    <SignalStrip blocks={signals}/>
    <section className={t.priorityGrid}>
      <div className={t.priorityMedia}>{leadImage && <img src={leadImage} alt=""/>}<div><span>PRIORITY REPORT</span>{layout.hero && <ArticleTitle article={layout.hero}/>}</div></div>
      <div className={t.sideStack}><WeatherModule weather={layout.weather}/>{sideArticle && <ArticleBlock article={sideArticle} className={t.sideReport} eyebrow="SIDE INTEL" titleLink/>}</div>
      <article className={t.reportBody}><span>FULL ANALYSIS</span><h2>{layout.hero?.title}</h2><p>{layout.hero?.text}</p><SourcesBlock sources={layout.hero?.sources}/></article>
      <div className={t.dispatch}>{layout.noteLists.slice(0, 1).map(list => <section key={list.id}><h2>{list.title || 'Incoming dispatches'}</h2><NotesListBlock list={list} numbered/></section>)}</div>
    </section>
    <section className={t.analysisGrid}>{analysis.map(article => <ArticleBlock key={article.id} article={article} className={t.analysis} eyebrow="ANALYSIS" titleLink/>)}{layout.images.slice(fallbackImage ? 1 : 0).map(image => <ImageBlock key={image.id} image={image} className={t.mediaCard}/>)}</section>
    <div className={t.extraDispatches}>{layout.noteLists.slice(1).map(list => <section key={list.id}><h2>{list.title || 'Network feed'}</h2><NotesListBlock list={list} numbered/></section>)}</div>
    {layout.notes.map(note => <NoteBlock key={note.id} note={note} className={t.ticker} prefix="PICUS // CULTURE"/>)}
  </>;
}

function IntelBoard({ layout }: { layout: Layout }) {
  const [feature, ...articles] = layout.articles;
  const signals: MediaBlock[] = [...layout.images, ...layout.articles.filter(article => article.image_url)];
  return <><SignalStrip blocks={signals}/><div className={t.boardTitle}><span>INTELLIGENCE BOARD</span><h2>{feature?.title || layout.noteLists[0]?.title || 'Network situation report'}</h2></div><section className={t.intelGrid}>{feature && <ArticleBlock article={feature} className={t.intelFeature} eyebrow="LEAD ANALYSIS" titleLink/>}<WeatherModule weather={layout.weather}/>{articles.map(article => <ArticleBlock key={article.id} article={article} className={t.intelCard} eyebrow="FIELD REPORT" titleLink/>)}{layout.images.map(image => <ImageBlock key={image.id} image={image} className={t.intelMedia}/>)}</section><div className={t.extraDispatches}>{layout.noteLists.map(list => <section key={list.id}><h2>{list.title || 'Network feed'}</h2><NotesListBlock list={list} numbered/></section>)}</div>{layout.notes.map(note => <NoteBlock key={note.id} note={note} className={t.ticker} prefix="PICUS // INTEL"/>)}</>;
}

function DispatchPage({ layout }: { layout: Layout }) {
  const dispatches = layout.noteLists.flatMap(list => list.items.map((item, index) => ({ item, key: item.id || `${list.id}-${index}`, section: index === 0 ? list.title : undefined })));
  return <><div className={t.boardTitle}><span>ENCRYPTED DISPATCH</span><h2>Live intelligence feed</h2></div><section className={t.dispatchWall}>{dispatches.map((dispatch, index) => <article key={dispatch.key}>{dispatch.section && <h3>{dispatch.section}</h3>}<span>{String(index + 1).padStart(2, '0')}</span><div><NoteContent note={dispatch.item}/></div></article>)}</section><section className={t.analysisGrid}>{layout.articles.map(article => <ArticleBlock key={article.id} article={article} className={t.analysis} eyebrow="ANALYSIS" titleLink/>)}{layout.images.map(image => <ImageBlock key={image.id} image={image} className={t.mediaCard}/>)}</section>{layout.notes.map(note => <NoteBlock key={note.id} note={note} className={t.ticker} prefix="PICUS // LIVE"/>)}</>;
}

function MediaMonitor({ layout }: { layout: Layout }) {
  const media: MediaBlock[] = [...layout.images, ...layout.articles];
  return <><SignalStrip blocks={media}/><div className={t.boardTitle}><span>VISUAL INTELLIGENCE</span><h2>Media monitoring array</h2></div><section className={t.mediaWall}>{media.map(block => block.type === 'image' ? <ImageBlock key={block.id} image={block} className={t.monitorCard}/> : <article key={block.id} className={t.monitorCard}><ArticleImage article={block}/><span>FIELD REPORT</span><ArticleTitle article={block}/><p>{block.text}</p></article>)}</section></>;
}

export function DeusExTemplate({ issue }: NewspaperTemplateProps) {
  const layout = composeDeusExPage(issue.document.blocks);
  return <article className={`${s.page} ${t.page}`} data-recipe={layout.recipe}><ShellHeader issue={issue} layout={layout}/>{layout.recipe === 'priority-report' && <PriorityPage layout={layout}/>} {layout.recipe === 'intel-board' && <IntelBoard layout={layout}/>} {layout.recipe === 'dispatch-feed' && <DispatchPage layout={layout}/>} {layout.recipe === 'media-monitor' && <MediaMonitor layout={layout}/>}<footer className={t.folio}><span>PICUS COMMUNICATION NETWORK</span><span>{issue.document.subtitle}</span><span>{String(Math.abs(issue.id) % 100 + 1).padStart(2, '0')}</span></footer></article>;
}

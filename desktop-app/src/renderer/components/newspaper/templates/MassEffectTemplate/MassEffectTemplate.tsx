import { ArticleBlock, ArticleImage } from '../../blocks/ArticleBlock/ArticleBlock';
import { ImageBlock } from '../../blocks/ImageBlock/ImageBlock';
import { NoteBlock, NoteContent } from '../../blocks/NoteBlock/NoteBlock';
import { NotesListBlock } from '../../blocks/NotesListBlock/NotesListBlock';
import { SourcesBlock } from '../../blocks/SourcesBlock/SourcesBlock';
import { WeatherForecast } from '../../blocks/WeatherBlock/WeatherBlock';
import { articleMaterial, useNewspaperMaterialViewer } from '../../NewspaperMaterialContext';
import type { NewspaperBlock, NewspaperTemplateProps } from '../../types';
import { safeImageUrl } from '../../utils/media';
import { composeMassEffectPage } from './massEffectLayout';
import s from '../../Newspaper.module.scss';
import t from './MassEffectTemplate.module.scss';

type Layout = ReturnType<typeof composeMassEffectPage>;
type MediaBlock = Extract<NewspaperBlock, { type: 'article' | 'image' }>;

function mediaUrl(block: MediaBlock | undefined) {
  return safeImageUrl(block?.image_url) || undefined;
}

function ArticlePanel({ article, as: Tag = 'div', className, children }: {
  article: Extract<MediaBlock, { type: 'article' }> | undefined;
  as?: 'div' | 'section' | 'article';
  className?: string;
  children: React.ReactNode;
}) {
  const openMaterial = useNewspaperMaterialViewer();
  const interactive = Boolean(article && openMaterial);
  const open = () => article && openMaterial?.(articleMaterial(article));
  return <Tag
    className={className}
    data-clickable={interactive ? 'true' : undefined}
    role={interactive ? 'button' : undefined}
    tabIndex={interactive ? 0 : undefined}
    onClick={event => {
      if (interactive && !(event.target as HTMLElement).closest('a, button')) open();
    }}
    onKeyDown={event => {
      if (interactive && event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        open();
      }
    }}
  >{children}</Tag>;
}

function AnnHeader({ issue, layout }: { issue: NewspaperTemplateProps['issue']; layout: Layout }) {
  const reports =
    (layout.hero ? 1 : 0) +
    layout.articles.length +
    layout.noteLists.reduce((sum, list) => sum + list.items.length, 0) +
    layout.notes.length;
  return (
    <>
      <header className={t.head}>
        <span className={t.icon}>✦</span>
        <div>
          <h1>
            ALLIANCE NEWS NETWORK <b>// ANN FEED</b>
          </h1>
          <p>EARTH DATE: {issue.document.date} // EXTRANET RELAY NODE: ARCTURUS</p>
        </div>
        <strong>
          PRIORITY
          <br />
          CLEARANCE 4
        </strong>
      </header>
      <div className={t.status}>
        <span>RELAY ONLINE</span>
        <b>{String(reports).padStart(2, '0')} VERIFIED REPORTS</b>
        <span>SECTOR 47-K // LIVE</span>
      </div>
    </>
  );
}

function Telemetry({ weather }: { weather: Layout['weather'] }) {
  return (
    <aside className={t.telemetry}>
      <header>LOCAL TELEMETRY</header>
      {weather ? (
        <>
          <h2>{weather.location}</h2>
          <WeatherForecast weather={weather} />
          <p>{weather.details}</p>
        </>
      ) : (
        <div className={t.nominal}>
          <b>ALL SYSTEMS NOMINAL</b>
          <span>NO ACTIVE LOCAL ALERTS</span>
          <span>UPLINK STABLE · 99.8%</span>
        </div>
      )}
    </aside>
  );
}

function BriefingRail({ lists }: { lists: Layout['noteLists'] }) {
  if (!lists.length)
    return (
      <aside className={t.emptyRail}>
        <span>LIVE BRIEFING</span>
        <b>NO PENDING INTERRUPTS</b>
        <p>Alliance channels remain available.</p>
      </aside>
    );
  return (
    <section className={t.briefingRail}>
      <header>LIVE BRIEFING</header>
      {lists.map((list) => (
        <div key={list.id}>
          <h2>{list.title}</h2>
          <NotesListBlock list={list} numbered />
        </div>
      ))}
    </section>
  );
}

function PriorityBroadcast({ layout }: { layout: Layout }) {
  const [leadAnalysis, ...analysis] = layout.articles;
  const heroImage = safeImageUrl(layout.hero?.image_url);
  const fallbackImage = heroImage ? undefined : layout.images[0];
  const fallbackUrl = mediaUrl(fallbackImage);
  return (
    <>
      <ArticlePanel as="section" className={t.hero} article={layout.hero}>
        <ArticleImage article={layout.hero} />
        {!heroImage && fallbackUrl && <img src={fallbackUrl} alt="" />}
        <div>
          <span>TOP STORY // VERIFIED</span>
          <h2>{layout.hero?.title}</h2>
          <p>{layout.hero?.text}</p>
          <SourcesBlock sources={layout.hero?.sources} />
        </div>
      </ArticlePanel>
      <section className={t.commandDeck}>
        <BriefingRail lists={layout.noteLists.slice(0, 1)} />
        <Telemetry weather={layout.weather} />
        {leadAnalysis && (
          <ArticleBlock
            article={leadAnalysis}
            className={t.focusReport}
            eyebrow="ACTIVE ANALYSIS"
            interactive
          />
        )}
      </section>
      <section className={t.analysisMatrix}>
        {analysis.map((article, index) => (
          <ArticleBlock
            key={article.id}
            article={article}
            className={t.analysisCard}
            eyebrow={`0${index + 1} // ANALYSIS`}
            interactive
          />
        ))}
        {layout.images.slice(fallbackImage ? 1 : 0).map((image) => (
          <ImageBlock key={image.id} image={image} className={t.sensorCard} />
        ))}
      </section>
      <BriefingRail lists={layout.noteLists.slice(1)} />
      {layout.notes.map((note) => (
        <NoteBlock key={note.id} note={note} className={t.ticker} prefix="ANN // CULTURE" />
      ))}
    </>
  );
}

function OperationsGrid({ layout }: { layout: Layout }) {
  const [primary, ...articles] = layout.articles;
  return (
    <>
      <div className={t.screenTitle}>
        <span>OPERATIONS CONSOLE</span>
        <h2>{primary?.title || layout.noteLists[0]?.title || 'Alliance situation report'}</h2>
        <b>LIVE // VERIFIED</b>
      </div>
      <section className={`${t.operations} ${!primary ? t.operationsBriefing : ''}`}>
        {primary && (
          <ArticleBlock
            article={primary}
            className={t.primaryReport}
            eyebrow="PRIMARY CHANNEL"
            interactive
          />
        )}
        <Telemetry weather={layout.weather} />
        <BriefingRail lists={layout.noteLists} />
        {articles.map((article, index) => (
          <ArticleBlock
            key={article.id}
            article={article}
            className={t.operationCard}
            eyebrow={`CHANNEL ${String(index + 2).padStart(2, '0')}`}
            interactive
          />
        ))}
        {layout.images.map((image) => (
          <ImageBlock key={image.id} image={image} className={t.sensorCard} />
        ))}
      </section>
      {layout.notes.map((note) => (
        <NoteBlock key={note.id} note={note} className={t.ticker} prefix="ANN // EXTRANET" />
      ))}
    </>
  );
}

function BriefingStream({ layout }: { layout: Layout }) {
  const messages = layout.noteLists.flatMap((list) =>
    list.items.map((item, index) => ({
      item,
      id: item.id || `${list.id}-${index}`,
      section: list.title,
    })),
  );
  return (
    <>
      <div className={t.screenTitle}>
        <span>ALLIANCE BULLETIN ARRAY</span>
        <h2>Live briefing stream</h2>
        <b>{messages.length} REPORTS</b>
      </div>
      <section className={t.stream}>
        <aside>
          <b>CHANNEL MAP</b>
          <span>ARCTURUS</span>
          <span>SOL RELAY</span>
          <span>CITADEL FEED</span>
          <i>UPLINK ACTIVE</i>
        </aside>
        <div>
          {messages.map((message, index) => (
            <article key={message.id}>
              {message.section && <h3>{message.section}</h3>}
              <span>{String(index + 1).padStart(2, '0')}</span>
              <NoteContent note={message.item} />
            </article>
          ))}
        </div>
      </section>
      <section className={t.analysisMatrix}>
        {layout.articles.map((article, index) => (
          <ArticleBlock
            key={article.id}
            article={article}
            className={t.analysisCard}
            eyebrow={`SUPPLEMENT ${String(index + 1).padStart(2, '0')}`}
            interactive
          />
        ))}
        {layout.images.map((image) => (
          <ImageBlock key={image.id} image={image} className={t.sensorCard} />
        ))}
      </section>
      {layout.notes.map((note) => (
        <NoteBlock key={note.id} note={note} className={t.ticker} prefix="ANN // FLASH" />
      ))}
    </>
  );
}

function VisualRelay({ layout }: { layout: Layout }) {
  const media: MediaBlock[] = [...layout.images, ...layout.articles];
  const [primary, ...signals] = media;
  return (
    <>
      <div className={t.screenTitle}>
        <span>VISUAL RELAY</span>
        <h2>Extranet signal monitor</h2>
        <b>{media.length} CHANNELS</b>
      </div>
      <section className={t.relay}>
        <ArticlePanel className={t.relayPrimary} article={primary?.type === 'article' ? primary : undefined}>
          {primary?.type === 'image' ? (
            <ImageBlock image={primary} className={t.relayImage} />
          ) : (
            primary && <ArticleImage article={primary} className={t.relayArticleImage} />
          )}
          <span>PRIMARY VISUAL FEED</span>
          <h2>{primary?.title}</h2>
        </ArticlePanel>
        <div className={t.relayStack}>
          {signals.map((block, index) => (
            <ArticlePanel
              key={block.id}
              as="article"
              article={block.type === 'article' ? block : undefined}
            >
              {block.type === 'image' ? (
                <ImageBlock image={block} className={t.relayImage} />
              ) : (
                <ArticleImage article={block} className={t.relayArticleImage} />
              )}
              <span>CH {String(index + 2).padStart(2, '0')}</span>
              <b>{block.title}</b>
            </ArticlePanel>
          ))}
        </div>
      </section>
    </>
  );
}

export function MassEffectTemplate({ issue }: NewspaperTemplateProps) {
  const layout = composeMassEffectPage(issue.document.blocks);
  return (
    <article className={`${s.page} ${t.page}`} data-recipe={layout.recipe}>
      <AnnHeader issue={issue} layout={layout} />
      {layout.recipe === 'priority-broadcast' && <PriorityBroadcast layout={layout} />}{' '}
      {layout.recipe === 'operations-grid' && <OperationsGrid layout={layout} />}{' '}
      {layout.recipe === 'briefing-stream' && <BriefingStream layout={layout} />}{' '}
      {layout.recipe === 'visual-relay' && <VisualRelay layout={layout} />}
      <footer className={t.footer}>
        <span>ALLIANCE NEWS NETWORK</span>
        <span>{issue.document.subtitle}</span>
        <span>ANN-{String(Math.abs(issue.id) % 1000).padStart(3, '0')}</span>
      </footer>
    </article>
  );
}

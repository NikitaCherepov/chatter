import type { NewspaperIssue, NewspaperVisualStyle } from './types';
import type { NewspaperMaterial } from './NewspaperMaterialContext';
import { safeImageUrl, safeUrl } from './utils/media';
import m from './NewspaperMaterial.module.scss';

const labels: Record<NewspaperVisualStyle, { channel: string; back: string; source: string }> = {
  broadsheet: { channel: 'Продолжение материала', back: 'The Chatter Times', source: 'Открыть первоисточник' },
  editorial: { channel: 'Полный материал', back: 'The Chatter', source: 'Открыть первоисточник' },
  wizarding: { channel: 'Развёрнутая хроника', back: 'Chatter Prophet', source: 'Перейти к источнику' },
  deusEx: { channel: 'PICUS // EXPANDED FILE', back: 'CHATTER DAILY ARCHIVE', source: 'OPEN SOURCE UPLINK' },
  massEffect: { channel: 'ANN // EXPANDED REPORT', back: 'ALLIANCE NEWS NETWORK', source: 'OPEN EXTRANET SOURCE' },
};

export function NewspaperMaterialRenderer({ material, issue, style }: { material: NewspaperMaterial; issue: NewspaperIssue; style: NewspaperVisualStyle }) {
  const label = labels[style];
  const image = safeImageUrl(material.imageUrl, 1600);
  const url = safeUrl(material.url);
  const sources = material.sources?.map(source => ({ ...source, url: safeUrl(source.url) })).filter(source => source.url) || [];
  const paragraphs = material.text.split(/\n{2,}/).filter(Boolean);

  return <article className={m.page} data-style={style}>
    <header className={m.header}>
      <div><span>{label.channel}</span><strong>{label.back}</strong></div>
      <div><small>{issue.document.date}</small><b>№ {issue.issue_number}</b></div>
    </header>
    <main className={m.content}>
      <div className={m.kicker}>{material.kind === 'article' ? 'ARTICLE / REPORT' : 'BRIEF / DISPATCH'}</div>
      <h1>{material.title}</h1>
      {image && <figure className={m.hero}><img src={image} alt=""/><figcaption>{issue.document.title}</figcaption></figure>}
      <div className={m.body}>{paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
      {(url || sources.length > 0) && <footer className={m.sources}>
        <span>Источники</span>
        {url && <a href={url} target="_blank" rel="noreferrer">{label.source} ↗</a>}
        {sources.map((source, index) => <a key={`${source.url}-${index}`} href={source.url || undefined} target="_blank" rel="noreferrer">{source.title || `Источник ${index + 1}`} ↗</a>)}
      </footer>}
    </main>
    <footer className={m.folio}><span>{label.back}</span><span>{issue.document.subtitle}</span><span>FOCUS</span></footer>
  </article>;
}

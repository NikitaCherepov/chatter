import type { NewspaperIssue, NewspaperVisualStyle } from './types';
import type { NewspaperMaterial } from './NewspaperMaterialContext';
import { useNewspaperImageViewer } from './NewspaperImageViewerContext';
import { safeImageUrl, safeUrl } from './utils/media';
import m from './NewspaperMaterial.module.scss';
import n from './Newspaper.module.scss';
import { AnnHeader, MassEffectFooter } from './templates/MassEffectTemplate/MassEffectTemplate';
import me from './templates/MassEffectTemplate/MassEffectTemplate.module.scss';
import { Masthead, BroadsheetFolio } from './templates/BroadsheetTemplate/BroadsheetTemplate';
import br from './templates/BroadsheetTemplate/BroadsheetTemplate.module.scss';
import { DeusExShellHeader, DeusExFolio } from './templates/DeusExTemplate/DeusExTemplate';
import dx from './templates/DeusExTemplate/DeusExTemplate.module.scss';
import { WizardingHead } from './templates/WizardingTemplate/WizardingTemplate';
import { EditorialHead } from './templates/EditorialTemplate/EditorialTemplate';

const sourceLabels: Record<NewspaperVisualStyle, string> = {
  broadsheet: 'Открыть первоисточник',
  editorial: 'Открыть первоисточник',
  wizarding: 'Перейти к источнику',
  deusEx: 'OPEN SOURCE UPLINK',
  massEffect: 'OPEN EXTRANET SOURCE',
};

const pageClassNames: Record<NewspaperVisualStyle, string> = {
  broadsheet: `${m.page} ${n.broadsheet} ${br.paper}`,
  editorial: `${m.page} ${n.editorial}`,
  wizarding: `${m.page} ${n.wizarding}`,
  deusEx: `${m.page} ${dx.page}`,
  massEffect: `${m.page} ${me.page}`,
};

export function NewspaperMaterialRenderer({ material, issue, style }: { material: NewspaperMaterial; issue: NewspaperIssue; style: NewspaperVisualStyle }) {
  const image = safeImageUrl(material.imageUrl, 1600);
  const fullImage = safeImageUrl(material.imageUrl, 2400);
  const openImage = useNewspaperImageViewer();
  const url = safeUrl(material.url);
  const sources = material.sources?.map(source => ({ ...source, url: safeUrl(source.url) })).filter(source => source.url) || [];
  const paragraphs = (material.longText?.trim() || material.text).split(/\n{2,}/).filter(Boolean);
  const folioContext = material.title.length > 80 ? `${material.title.slice(0, 79).trimEnd()}…` : material.title;

  return <article className={pageClassNames[style]} data-style={style} data-material-kind={material.kind}>
    {style === 'massEffect' ? <AnnHeader issue={issue} reports={1}/> : style === 'deusEx' ? <DeusExShellHeader issue={issue} signals={image ? 1 : 0} reports={1} relevance="HIGH"/> : style === 'broadsheet' ? <Masthead issue={issue}/> : style === 'wizarding' ? <WizardingHead issue={issue}/> : <EditorialHead issue={issue}/>}
    <main className={m.content}>
      <h1>{material.title}</h1>
      {image && <figure className={m.hero}><button type="button" className={m.heroOpen} onClick={() => openImage?.(fullImage || image, material.title)} aria-label={`Открыть изображение: ${material.title}`}><img src={image} alt=""/></button><figcaption>{issue.document.title}</figcaption></figure>}
      <div className={m.body}>{paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
      {(url || sources.length > 0) && <footer className={m.sources}>
        <span>Источники</span>
        {url && <a href={url} target="_blank" rel="noreferrer">{sourceLabels[style]} ↗</a>}
        {sources.map((source, index) => <a key={`${source.url}-${index}`} href={source.url || undefined} target="_blank" rel="noreferrer">{source.title || `Источник ${index + 1}`} ↗</a>)}
      </footer>}
    </main>
    {style === 'massEffect' ? <MassEffectFooter issue={issue} context={folioContext}/> : style === 'deusEx' ? <DeusExFolio issue={issue} context={folioContext}/> : style === 'broadsheet' ? <BroadsheetFolio issue={issue} context={folioContext}/> : null}
  </article>;
}

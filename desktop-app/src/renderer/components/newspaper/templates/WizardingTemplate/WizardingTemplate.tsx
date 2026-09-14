import { ArticleImage } from '../../blocks/ArticleBlock/ArticleBlock';
import { SourcesBlock } from '../../blocks/SourcesBlock/SourcesBlock';
import type { NewspaperTemplateProps } from '../../types';
import s from '../../Newspaper.module.scss';
import { WizardingBodyBlock, WizardingRailBlock } from './WizardingBlock';
import { composeWizardingPage } from './wizardingLayout';
import t from './WizardingTemplate.module.scss';

export function WizardingTemplate({ issue }: NewspaperTemplateProps) {
  const layout = composeWizardingPage(issue.document.blocks, issue.id);
  const isNotesPage = layout.recipe === 'notes-page-grid' || layout.recipe === 'notes-page-columns';
  const isImagePage = layout.recipe === 'image-page';

  return <article className={`${s.page} ${s.wizarding}`}>
    <header className={s.wizardHead}><div className={s.wizardMicro}>OWL POST · CELESTIAL FORECAST · ENCHANTED EDITION</div><h1><span>The</span> Chatter Prophet</h1><div className={s.wizardRule}><b>EXCLUSIVE</b><span>{issue.document.date}</span><b>№ {issue.issue_number}</b></div></header>
    {layout.hero ? <section className={`${s.wizardLead} ${t.lead}`} data-recipe={layout.recipe}>
      {layout.leftRail && <WizardingRailBlock block={layout.leftRail}/>}
      <main className={s.wizardMain}><div className={s.wizardStamp}>ЭКСКЛЮЗИВ</div><h2>{layout.hero.title}</h2><ArticleImage article={layout.hero}/><p>{layout.hero.text}</p><SourcesBlock sources={layout.hero.sources}/></main>
      {layout.rightRail && <WizardingRailBlock block={layout.rightRail}/>}
    </section> : null}
    {layout.body.length > 0 && <section className={`${s.wizardBottom} ${t.body} ${layout.recipe === 'mosaic' ? t.mosaic : ''} ${isNotesPage ? t.notesPage : ''} ${layout.recipe === 'notes-page-columns' ? t.notesPageColumns : ''} ${isImagePage ? t.imagePage : ''}`} data-recipe={layout.recipe} data-block-count={layout.body.length}>
      {layout.body.map(block => <WizardingBodyBlock key={block.id} block={block} notesPage={isNotesPage}/>)}
    </section>}
  </article>;
}

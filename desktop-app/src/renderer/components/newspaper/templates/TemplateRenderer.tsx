import { pageContent } from '../utils/content';
import type { NewspaperIssue, NewspaperVisualStyle } from '../types';
import { BroadsheetTemplate } from './BroadsheetTemplate/BroadsheetTemplate';
import { DeusExTemplate } from './DeusExTemplate/DeusExTemplate';
import { EditorialTemplate } from './EditorialTemplate/EditorialTemplate';
import { MassEffectTemplate } from './MassEffectTemplate/MassEffectTemplate';
import { WizardingTemplate } from './WizardingTemplate/WizardingTemplate';

export function TemplateRenderer({ issue, style }: { issue: NewspaperIssue; style: NewspaperVisualStyle }) {
  const content = pageContent(issue.document.blocks);
  if (style === 'wizarding') return <WizardingTemplate issue={issue} content={content}/>;
  if (style === 'broadsheet') return <BroadsheetTemplate issue={issue} content={content}/>;
  if (style === 'deusEx') return <DeusExTemplate issue={issue} content={content}/>;
  if (style === 'massEffect') return <MassEffectTemplate issue={issue} content={content}/>;
  return <EditorialTemplate issue={issue} content={content}/>;
}

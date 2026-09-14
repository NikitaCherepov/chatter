import type { NewspaperBlock, NewspaperIssue } from '../types';
import { DEMO_WIZARDING_ISSUE } from './wizardingDemo';

const sourceList = DEMO_WIZARDING_ISSUE.document.blocks.find(
  (block): block is Extract<NewspaperBlock, { type: 'notes_list' }> => block.type === 'notes_list' && block.id === 'crowded-notes',
);

const broadsheetExtras: NewspaperBlock[] = sourceList
  ? Array.from({ length: 5 }, (_, index) => ({
      ...sourceList,
      id: `broadsheet-briefs-${index + 1}`,
      title: `Городская лента · Колонка ${index + 1}`,
      items: sourceList.items.map(item => ({ ...item })),
    }))
  : [];

/**
 * Broadsheet uses the same editor-ordered demo stream as Wizarding, plus a
 * dense run of briefs. The extra run stress-tests newspaper columns without
 * changing the production paginator or teaching it about demo page borders.
 */
export const DEMO_BROADSHEET_ISSUE: NewspaperIssue = {
  ...DEMO_WIZARDING_ISSUE,
  blocks_count: DEMO_WIZARDING_ISSUE.document.blocks.length + broadsheetExtras.length,
  document: {
    ...DEMO_WIZARDING_ISSUE.document,
    blocks: [...DEMO_WIZARDING_ISSUE.document.blocks, ...broadsheetExtras],
  },
};

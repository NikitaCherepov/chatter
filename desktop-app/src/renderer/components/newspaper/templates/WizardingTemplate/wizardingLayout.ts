import type { NewspaperBlock } from '../../types';

export type WizardingRecipe = 'hero-two-rails' | 'hero-left-rail' | 'hero-right-rail' | 'hero-full' | 'mosaic';

export type WizardingPageLayout = {
  recipe: WizardingRecipe;
  hero?: Extract<NewspaperBlock, { type: 'article' }>;
  leftRail?: NewspaperBlock;
  rightRail?: NewspaperBlock;
  body: NewspaperBlock[];
};

function canLiveInRail(block: NewspaperBlock) {
  return block.type === 'weather' || block.type === 'notes_list' || block.type === 'note' || block.type === 'image';
}

/**
 * Chooses one of the tabloid's own compositions. Block order belongs to the
 * editor; the composer only gives compact neighbours to an explicit hero.
 */
export function composeWizardingPage(blocks: NewspaperBlock[]): WizardingPageLayout {
  const heroIndex = blocks.findIndex(block => block.type === 'article' && block.role === 'hero');
  if (heroIndex < 0) return { recipe: 'mosaic', body: blocks };

  const hero = blocks[heroIndex] as Extract<NewspaperBlock, { type: 'article' }>;
  const before = blocks.slice(0, heroIndex).filter(canLiveInRail);
  const after = blocks.slice(heroIndex + 1).filter(canLiveInRail);
  let leftRail: NewspaperBlock | undefined = before.at(-1);
  let rightRail: NewspaperBlock | undefined = after[0];

  // Two blocks on the same side can frame the lead; a lone block keeps the
  // side implied by its position in the editor's array.
  if (!leftRail && after.length > 1) {
    [leftRail, rightRail] = after;
  } else if (!rightRail && before.length > 1) {
    rightRail = before.at(-2);
  }
  const reserved = new Set([hero.id, leftRail?.id, rightRail?.id]);
  const body = blocks.filter(block => !reserved.has(block.id));

  const recipe: WizardingRecipe = leftRail && rightRail
    ? 'hero-two-rails'
    : leftRail
      ? 'hero-left-rail'
      : rightRail
        ? 'hero-right-rail'
        : 'hero-full';

  return { recipe, hero, leftRail, rightRail, body };
}

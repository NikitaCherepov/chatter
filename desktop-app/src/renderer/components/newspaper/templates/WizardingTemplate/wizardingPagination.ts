import type { NewspaperIssue } from '../../types';
import { distributeIssueV2, type IssuePaginationRules } from '../../layout/distributeIssueV2';

/**
 * Concrete slot limits shared by the current Wizarding recipes. The composer
 * chooses one of its five visual recipes and collapses missing optional slots;
 * this profile only decides which blocks remain on the physical page.
 */
export const WIZARDING_PAGINATION_RULES: IssuePaginationRules = {
  limits: {
    blocks: 6,
    mainHeaders: 1,
    articles: 4,
    images: 2,
    weather: 1,
    newsItems: 10,
    notes: 4,
  },
};

export function distributeWizardingIssue(issue: NewspaperIssue): NewspaperIssue[] {
  return distributeIssueV2(issue, WIZARDING_PAGINATION_RULES);
}

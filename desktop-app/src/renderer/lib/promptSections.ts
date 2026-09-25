export const PROMPT_SECTION_KEYS = ['description', 'personality', 'scenario', 'examples', 'other'] as const;

export type PromptSectionKey = typeof PROMPT_SECTION_KEYS[number];
export type PromptSections = Record<PromptSectionKey, string>;

const SECTION_HEADINGS: Record<PromptSectionKey, string> = {
  description: 'DESCRIPTION',
  personality: 'PERSONALITY',
  scenario: 'SCENARIO',
  examples: 'EXAMPLES',
  other: 'OTHER',
};

const HEADING_TO_KEY = new Map(
  PROMPT_SECTION_KEYS.map(key => [SECTION_HEADINGS[key], key] as const),
);

export const emptyPromptSections = (): PromptSections => ({
  description: '',
  personality: '',
  scenario: '',
  examples: '',
  other: '',
});

/**
 * Split only our explicit top-level headings. Existing free-form prompts stay
 * intact in DESCRIPTION; OTHER is reserved for unclassified text in an
 * already-sectioned prompt.
 */
export const parsePromptSections = (content: string): PromptSections => {
  const result = emptyPromptSections();
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let current: PromptSectionKey | null = null;
  let foundHeading = false;
  const buffers: Record<PromptSectionKey, string[]> = {
    description: [],
    personality: [],
    scenario: [],
    examples: [],
    other: [],
  };

  for (const line of lines) {
    const match = line.match(/^#\s+(DESCRIPTION|PERSONALITY|SCENARIO|EXAMPLES|OTHER)\s*$/i);
    if (match) {
      current = HEADING_TO_KEY.get(match[1].toUpperCase()) ?? null;
      foundHeading = true;
      continue;
    }
    buffers[current ?? 'other'].push(line);
  }

  if (!foundHeading) return { ...result, description: content };
  for (const key of PROMPT_SECTION_KEYS) {
    result[key] = buffers[key].join('\n').trim();
  }
  return result;
};

export const serializePromptSections = (sections: PromptSections): string => (
  PROMPT_SECTION_KEYS
    .map(key => `# ${SECTION_HEADINGS[key]}\n\n${sections[key].trim()}`)
    .join('\n\n')
    .trim()
);

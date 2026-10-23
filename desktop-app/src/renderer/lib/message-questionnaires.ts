// Canonical, dependency-free schema. Synced into independently packaged apps.
export type Question = { id: string; label: string; type: 'single' | 'multiple' | 'text' | 'textarea'; required: boolean; options?: string[] };
export type Questionnaire = { id: string; title: string; questions: Question[] };
export type QuestionnaireAnswers = Record<string, string | string[]>;
export type QuestionnaireSubmission = { source_message_id: number; source_variant_index: number; form_id: string; schema: string; answers: QuestionnaireAnswers };
export type QuestionnaireResponse = QuestionnaireSubmission & { questionnaire: Questionnaire };

const fail = (): never => { throw new Error('questionnaire_invalid'); };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const label = (v: unknown, max: number): string => typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : fail();
const identifier = (v: unknown): string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v) ? v : fail();

export function parseQuestionnaire(value: unknown): Questionnaire {
  if (!record(value) || !Array.isArray(value.questions) || !value.questions.length || value.questions.length > 100) return fail();
  const ids = new Set<string>();
  const questions = value.questions.map((raw): Question => {
    if (!record(raw)) return fail();
    const id = identifier(raw.id);
    if (ids.has(id)) return fail();
    ids.add(id);
    const type = raw.type;
    if (type !== 'single' && type !== 'multiple' && type !== 'text' && type !== 'textarea') return fail();
    if (raw.required !== undefined && typeof raw.required !== 'boolean') return fail();
    const q: Question = { id, label: label(raw.label, 500), type, required: raw.required === true };
    if (type === 'single' || type === 'multiple') {
      if (!Array.isArray(raw.options) || !raw.options.length || raw.options.length > 32) return fail();
      q.options = raw.options.map(o => label(o, 200));
      if (new Set(q.options).size !== q.options.length) return fail();
    }
    return q;
  });
  return { id: identifier(value.id), title: label(value.title, 200), questions };
}

export function parseQuestionnaireSource(source: string): Questionnaire {
  if (source.length > 100_000) return fail();
  return parseQuestionnaire(JSON.parse(source));
}

/** Read only completed, top-level fences; do not interpret code examples nested in other fences. */
export function extractQuestionnaires(content: string): Questionnaire[] {
  const forms: Questionnaire[] = [];
  let fence: string | null = null, language = '', lines: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!fence) {
      const opening = /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(line);
      if (opening) { fence = opening[1]; language = opening[2].trim(); lines = []; }
    } else if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(line)) {
      if (language === 'questionnaire' && forms.length < 5) {
        try { forms.push(parseQuestionnaireSource(lines.join('\n'))); } catch { /* invalid forms remain code */ }
      }
      fence = null;
    } else if (language === 'questionnaire') lines.push(line);
  }
  // Duplicate ids are ambiguous: neither copy can be submitted.
  return forms.length > 4 ? [] : forms.filter(f => forms.filter(other => other.id === f.id).length === 1);
}

export const questionnaireSchema = (form: Questionnaire): string => JSON.stringify(form);

export function validateQuestionnaireAnswers(form: Questionnaire, value: unknown): QuestionnaireAnswers {
  if (!record(value) || Object.keys(value).some(key => !form.questions.some(q => q.id === key))) return fail();
  const answers: QuestionnaireAnswers = Object.create(null);
  let total = 0;
  for (const q of form.questions) {
    const raw = Object.prototype.hasOwnProperty.call(value, q.id) ? value[q.id] : undefined;
    if (q.type === 'multiple') {
      if (raw !== undefined && (!Array.isArray(raw) || raw.some(v => typeof v !== 'string' || !q.options!.includes(v)) || new Set(raw).size !== raw.length)) return fail();
      const selected = (raw ?? []) as string[];
      if (q.required && !selected.length) return fail();
      answers[q.id] = q.options!.filter(o => selected.includes(o));
    } else {
      if (raw !== undefined && typeof raw !== 'string') return fail();
      const text = ((raw ?? '') as string).trim();
      if (text.length > (q.type === 'textarea' ? 4000 : 1000) || (q.required && !text) || (q.type === 'single' && text && !q.options!.includes(text))) return fail();
      answers[q.id] = text;
    }
    total += JSON.stringify(answers[q.id]).length;
    if (total > 32_000) return fail();
  }
  return answers;
}

export function questionnaireAnswerText(form: Questionnaire, answers: QuestionnaireAnswers): string {
  return `Ответы на опрос «${form.title}»\n\n` + form.questions.map((q, i) => {
    const value = answers[q.id];
    return `${i + 1}. ${q.label}\n${Array.isArray(value) ? value.join(', ') || '—' : value || '—'}`;
  }).join('\n\n');
}

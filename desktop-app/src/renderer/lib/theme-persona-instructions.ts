import * as instructions from './player-instructions-api';
import { validateQuestionnaireAnswers, parseQuestionnaire } from './message-questionnaires';
import type { ThemeSettingsSectionAdapter } from './theme-settings-controller';

type Context = {
  requirePersona: (id: number) => void;
  validateModel: (id: unknown) => void;
  changed: (id: number, guard: () => void, signal: AbortSignal) => Promise<void>;
};
type Handler = NonNullable<ThemeSettingsSectionAdapter['request']>;

/** Uses the native instruction/survey service, including its compare-and-save and apply guards. */
export function createPersonaInstructionRequests(context: Context): Handler {
  const known = new Map<number, instructions.PlayerInstructions>();
  const target = (id: number) => ({ scope: 'persona' as const, target_id: id });
  const publicSurvey = (
    survey: instructions.PlayerSurvey,
    id: number,
  ): instructions.PlayerSurvey => {
    if (survey.scope !== 'persona' || survey.target_id !== id)
      throw new Error('settings_entity_unavailable');
    return {
      id: survey.id,
      scope: 'persona',
      target_id: id,
      questionnaire: parseQuestionnaire(survey.questionnaire),
      answers: survey.answers,
      draft: survey.draft,
      applied_text: survey.applied_text,
      created_at: survey.created_at,
      include_history: survey.include_history,
      personalize: survey.personalize,
      model_id: survey.model_id,
    };
  };
  const load = async (id: number, guard: () => void, signal: AbortSignal) => {
    const result = await instructions.getPlayerInstructions(target(id), signal);
    guard();
    const data = {
      text: result.text,
      enabled: result.enabled,
      mode: result.mode,
      surveys: result.surveys.map((s) => publicSurvey(s, id)),
    };
    known.set(id, data);
    return data;
  };
  return async (operation, params, current, signal) => {
    const guard = () => {
      if (!current()) throw new Error('settings_scope_changed');
    };
    guard();
    const id = Number(params.id);
    context.requirePersona(id);
    if (operation === 'getPersonaInstructions') return { result: await load(id, guard, signal) };
    const data = known.get(id);
    if (!data) throw new Error('settings_read_required');
    const remember = (survey: instructions.PlayerSurvey) => {
      guard();
      const safe = publicSurvey(survey, id);
      known.set(id, {
        ...data,
        surveys: [safe, ...data.surveys.filter((s) => s.id !== safe.id)].slice(0, 50),
      });
      return { result: { survey: safe } };
    };
    try {
      if (operation === 'savePersonaInstructions') {
        await instructions.savePlayerInstructions(
          target(id),
          String(params.text),
          'both',
          data.text,
        );
      } else if (operation === 'createPersonaSurvey') {
        context.validateModel(params.modelId);
        const result = await instructions.createPlayerSurvey(
          target(id),
          String(params.brief ?? ''),
          false,
          params.currentText === undefined ? data.text : String(params.currentText),
          params.modelId as string | null | undefined,
          params.personalize === true,
          params.includePrompt === true,
          Number(params.questionCount ?? 10),
        );
        return remember(result.survey);
      } else {
        const survey = data.surveys.find((s) => s.id === params.surveyId);
        if (!survey) throw new Error('settings_entity_unavailable');
        if (operation === 'answerPersonaSurvey') {
          const answers = validateQuestionnaireAnswers(survey.questionnaire, params.answers);
          return remember((await instructions.answerPlayerSurvey(survey.id, answers)).survey);
        }
        if (operation === 'regeneratePersonaSurvey')
          return remember((await instructions.regeneratePlayerSurvey(survey.id)).survey);
        if (operation === 'followUpPersonaSurvey')
          return remember(
            (await instructions.followUpPlayerSurvey(survey.id, String(params.brief ?? ''))).survey,
          );
        if (operation === 'applyPersonaSurvey')
          await instructions.applyPlayerSurvey(survey.id, String(params.text));
        else if (operation === 'deletePersonaSurvey')
          await instructions.deletePlayerSurvey(survey.id, params.removeApplied === true);
        else throw new Error('settings_bad_request');
      }
      // Writes may finish after closing the initiating editor; still refresh native consumers.
      await context.changed(id, guard, signal);
      guard();
      return { result: await load(id, guard, signal) };
    } catch (error: any) {
      if ((error?.data?.error ?? error?.message) === 'instructions_changed') known.delete(id);
      throw error;
    }
  };
}

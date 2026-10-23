import { apiFetch } from './api';
import type { Questionnaire, QuestionnaireAnswers } from './message-questionnaires';
export type InstructionTarget = { scope: 'persona' | 'chat'; target_id: number };
export type PlayerSurvey = InstructionTarget & {
  id: string;
  questionnaire: Questionnaire;
  answers: QuestionnaireAnswers | null;
  draft: string | null;
  applied_text: string | null;
  created_at: number;
  include_history: boolean;
  personalize: boolean;
  model_id: string | null;
};
export type InstructionsMode = 'both' | 'persona' | 'chat' | 'off';
export type InstructionState = { text: string; enabled: boolean; mode: InstructionsMode };
export type PlayerInstructions = InstructionState & { surveys: PlayerSurvey[] };
export const getPlayerInstructions = (target: InstructionTarget) =>
  apiFetch<PlayerInstructions>(
    `/api/v1/player-instructions?scope=${target.scope}&target_id=${target.target_id}`,
  );
export const savePlayerInstructions = (
  target: InstructionTarget,
  text: string,
  mode: InstructionsMode,
  expected: string,
) =>
  apiFetch<InstructionState>('/api/v1/player-instructions', {
    method: 'PATCH',
    body: JSON.stringify({ ...target, text, mode, expected }),
  });
export const createPlayerSurvey = (
  target: InstructionTarget,
  brief: string,
  include_history: boolean,
  current_text: string,
  model_id?: string | null,
  personalize = false,
  include_prompt = target.scope === 'chat',
  question_count = 10,
) =>
  apiFetch<{ survey: PlayerSurvey }>('/api/v1/player-instructions/surveys', {
    method: 'POST',
    body: JSON.stringify({
      ...target,
      brief,
      include_history: target.scope === 'chat' && include_history,
      include_prompt,
      personalize,
      question_count,
      current_text,
      ...(model_id === undefined ? {} : { model_id }),
    }),
  });
export const answerPlayerSurvey = (id: string, answers: QuestionnaireAnswers) =>
  apiFetch<{ survey: PlayerSurvey }>(`/api/v1/player-instructions/surveys/${id}/answers`, {
    method: 'POST',
    body: JSON.stringify({ answers }),
  });
export const regeneratePlayerSurvey = (id: string) =>
  apiFetch<{ survey: PlayerSurvey }>(`/api/v1/player-instructions/surveys/${id}/regenerate`, {
    method: 'POST',
  });
export const applyPlayerSurvey = (id: string, text: string) =>
  apiFetch<InstructionState>(`/api/v1/player-instructions/surveys/${id}/apply`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
export const deletePlayerSurvey = (id: string, remove_applied: boolean) =>
  apiFetch<InstructionState>(`/api/v1/player-instructions/surveys/${id}`, {
    method: 'DELETE',
    body: JSON.stringify({ remove_applied }),
  });

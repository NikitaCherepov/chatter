import type express from 'express';
import {
  instructionTarget,
  getPlayerInstructions,
  setPlayerInstructions,
  listPlayerSurveys,
  createPlayerSurvey,
  answerPlayerSurvey,
  regeneratePlayerSurvey,
  applyPlayerSurvey,
  deletePlayerSurvey,
} from './player-instructions.js';

export function registerPlayerInstructionRoutes(
  app: ReturnType<typeof express>,
  accountId: (req: any) => number,
) {
  const handle = (fn: (req: any) => any) => async (req: any, res: any) => {
    try {
      res.json(await fn(req));
    } catch (error: any) {
      const knownErrors = new Set([
        'bad_instruction_target',
        'bad_user_instructions',
        'bad_survey_request',
        'user_not_found',
        'user_not_approved',
        'chat_not_found',
        'persona_not_found',
        'survey_not_found',
        'survey_chat_required',
        'survey_busy',
        'survey_already_answered',
        'survey_not_answered',
        'instructions_changed',
        'questionnaire_invalid',
        'quota_exceeded',
        'model_not_available',
        'survey_context_too_large',
        'empty_survey_response',
      ]);
      // Do not expose upstream URLs, credentials or provider response bodies.
      const code = knownErrors.has(error?.message) ? error.message : 'player_instructions_failed';
      res
        .status(
          code.endsWith('_not_found')
            ? 404
            : ['instructions_changed', 'survey_busy', 'survey_already_answered'].includes(code)
              ? 409
              : code === 'quota_exceeded'
                ? 429
                : 400,
        )
        .json({ error: code });
    }
  };
  const target = (req: any) =>
    instructionTarget({ scope: req.query.scope, target_id: Number(req.query.target_id) });
  app.get(
    '/api/v1/player-instructions',
    handle((req) => ({
      ...getPlayerInstructions(accountId(req), target(req)),
      surveys: listPlayerSurveys(accountId(req), target(req)),
    })),
  );
  app.patch(
    '/api/v1/player-instructions',
    handle((req) => {
      if (req.body?.enabled !== undefined && typeof req.body.enabled !== 'boolean')
        throw new Error('bad_instruction_target');
      if (req.body?.expected !== undefined && typeof req.body.expected !== 'string')
        throw new Error('bad_instruction_target');
      return setPlayerInstructions(
        accountId(req),
        instructionTarget(req.body),
        req.body.text,
        req.body.enabled,
        req.body.expected,
        req.body.mode,
      );
    }),
  );
  app.post(
    '/api/v1/player-instructions/surveys',
    handle(async (req) => ({ survey: await createPlayerSurvey(accountId(req), req.body) })),
  );
  app.post(
    '/api/v1/player-instructions/surveys/:id/answers',
    handle(async (req) => ({
      survey: await answerPlayerSurvey(accountId(req), String(req.params.id), req.body?.answers),
    })),
  );
  app.post(
    '/api/v1/player-instructions/surveys/:id/regenerate',
    handle(async (req) => ({
      survey: await regeneratePlayerSurvey(accountId(req), String(req.params.id)),
    })),
  );
  app.post(
    '/api/v1/player-instructions/surveys/:id/apply',
    handle((req) => applyPlayerSurvey(accountId(req), String(req.params.id), req.body?.text)),
  );
  app.delete(
    '/api/v1/player-instructions/surveys/:id',
    handle((req) =>
      deletePlayerSurvey(accountId(req), String(req.params.id), req.body?.remove_applied === true),
    ),
  );
}

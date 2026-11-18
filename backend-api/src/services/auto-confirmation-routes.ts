import type express from 'express';
import { getAutoConfirmation, saveAutoConfirmation } from './auto-confirmation.js';

export function registerAutoConfirmationRoutes(
  app: ReturnType<typeof express>,
  accountId: (req: any) => number,
) {
  app.get('/api/v1/auto-confirmation', (req: any, res: any) =>
    res.json(getAutoConfirmation(accountId(req))),
  );
  app.put('/api/v1/auto-confirmation', (req: any, res: any) => {
    try {
      res.json(saveAutoConfirmation(accountId(req), req.body));
    } catch (error: any) {
      const code = ['settings_changed', 'server_not_found', 'invalid_settings'].includes(
        error?.message,
      )
        ? error.message
        : 'request_failed';
      res
        .status(code === 'settings_changed' ? 409 : code === 'server_not_found' ? 404 : 400)
        .json({ error: code });
    }
  });
}

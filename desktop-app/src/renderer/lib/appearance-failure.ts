import type { InteractiveFailure } from '../../main/interactive-types';
export type AppearanceFailureTheme = { id: string; name: string; revision: number };
export type AppearanceFailureReport = InteractiveFailure & {
  theme?: AppearanceFailureTheme;
  retained: boolean;
};

/** Explicitly selected diagnostics only; no chat, file source or account state. */
export function formatAppearanceFailure(report: AppearanceFailureReport): string {
  return JSON.stringify(
    {
      type: 'chatter_theme_error',
      message: report.detail,
      time: new Date(report.at).toISOString(),
      theme: report.theme
        ? { id: report.theme.id, name: report.theme.name, revision: report.theme.revision }
        : undefined,
      phase: report.phase,
      reason: report.reason,
      recovering: report.recovering,
      previousVersionRetained: report.retained,
      stack: report.stack,
    },
    null,
    2,
  );
}

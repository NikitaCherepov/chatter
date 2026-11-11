import { wrapUntrustedContent } from '../web-reader.js';

export function redactMcpErrorText(text: string, secrets: unknown[] = []): string {
  const values = [...new Set(secrets.filter((value): value is string =>
    typeof value === 'string' && value.length > 0,
  ))].sort((a, b) => b.length - a.length);
  for (const value of values) {
    for (const form of new Set([value, JSON.stringify(value).slice(1, -1)]))
      text = text.split(form).join('[redacted]');
  }
  return text
    .replace(/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.~-]+/gi, '$1 [redacted]')
    .replace(/(\b(?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(/(\b[\w-]*(?:token|secret|password|api[_-]?key|authorization|credential|cookie)[\w-]*["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s&;,]+)/gi,
      '$1[redacted]')
    .replace(/(--[\w-]*(?:token|secret|password|api[_-]?key|credential)[\w-]*\s+)("[^"\r\n]*"|'[^'\r\n]*'|[^\s&;,]+)/gi,
      '$1[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{20,})(?![A-Za-z0-9_-])/g, '[redacted]')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .trim();
}

export function mcpErrorDiagnostic(text: string, secrets?: unknown[]) {
  const clean = redactMcpErrorText(text, secrets);
  if (!clean) return {};
  const limit = 2000;
  return {
    diagnostic: wrapUntrustedContent(clean.slice(0, limit)),
    ...(clean.length > limit || clean.endsWith('[diagnostic truncated]') ? { truncated: true } : {}),
  };
}

export function mcpErrorResult(error: unknown, fallback = 'mcp_request_failed') {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const known = /^(mcp_[a-z_]+)$/.exec(message)?.[1];
  if (known) return { error: known };
  return {
    error: /^(mcp_[a-z_]+)(?: \(\d+\))?(?:\r?\n|$)/.exec(message)?.[1] || fallback,
    ...mcpErrorDiagnostic(message),
  };
}

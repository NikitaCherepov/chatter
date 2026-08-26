/**
 * Add stdin password support to the first regular sudo command while leaving
 * the surrounding shell expression unchanged. `sudo -n` checks are excluded:
 * authenticating them would change their intended non-interactive semantics.
 */
export const prepareCommandForSudoPassword = (
  command: string,
): { command: string; needsPassword: boolean } => {
  const sudoAtCommandBoundary = /(^|(?:&&|\|\||[;|\n(])\s*)sudo\b(?!\s+(?:-[A-Za-z]*n[A-Za-z]*|--non-interactive)(?:\s|$))/;
  if (!sudoAtCommandBoundary.test(command)) {
    return { command, needsPassword: false };
  }

  return {
    command: command.replace(sudoAtCommandBoundary, '$1sudo -S -p \'\''),
    needsPassword: true,
  };
};

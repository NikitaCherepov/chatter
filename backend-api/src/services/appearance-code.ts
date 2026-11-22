import type * as TypeScript from 'typescript';
import {
  compileAppearanceProject,
  isAppearanceFilePath,
  type AppearanceCodeDiagnostic,
} from './appearance-project.js';
import { parseAppearanceProfile, type AppearanceProfile } from './appearance-schema.js';

/** Merge edits into a copy. Only the existing explicit save path writes settings. */
export function appearanceProposalProfile(
  base: unknown,
  edits: { files?: unknown; entry?: unknown },
): AppearanceProfile {
  const profile = parseAppearanceProfile(base);
  if (edits.files === undefined && edits.entry === undefined) return profile;
  if (
    !profile.shell?.files ||
    (edits.files !== undefined &&
      (!edits.files || typeof edits.files !== 'object' || Array.isArray(edits.files)))
  )
    throw new Error('appearance_invalid');
  const files = { ...profile.shell.files };
  for (const [file, source] of Object.entries(edits.files ?? {})) {
    if (!isAppearanceFilePath(file) || (source !== null && typeof source !== 'string'))
      throw new Error('appearance_invalid');
    if (source === null) delete files[file];
    else files[file] = source;
  }
  return parseAppearanceProfile({
    ...profile,
    shell: {
      ...profile.shell,
      entry: edits.entry ?? profile.shell.entry,
      files,
    },
  });
}

export function appearanceCodeDiagnostics(profile: AppearanceProfile): AppearanceCodeDiagnostic[] {
  if (!profile.shell?.files) return [];
  const ts = require('typescript') as typeof TypeScript;
  return compileAppearanceProject({ entry: profile.shell.entry, files: profile.shell.files }, ts)
    .diagnostics;
}

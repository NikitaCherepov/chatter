import { compileAppearanceProject } from './appearance-project';
import type { AppearanceProfile } from './appearance-schema';
export async function validateAppearanceCode(profile: AppearanceProfile) {
  if (!profile.shell || profile.shell.language === 'html') return;
  const compiler = await import('typescript');
  const { diagnostics } = compileAppearanceProject(
    { entry: profile.shell.entry, files: profile.shell.files },
    compiler.default ?? compiler,
  );
  if (diagnostics.length)
    throw Object.assign(new Error('appearance_build_failed'), { diagnostics });
}

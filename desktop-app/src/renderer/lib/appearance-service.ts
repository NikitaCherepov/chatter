import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useAuth } from './auth';
import * as api from './api';
import {
  parseAppearanceSettings,
  parseAppearanceProfile,
  type AppearanceProfile,
} from './appearance-schema';
import { validateAppearanceCode } from './appearance-validation';
import { previewAppearance } from './appearance-runtime';
import type { AppearanceWorkspace, LocalAppearanceSnapshot } from '../../main/local-appearance';
export type AppearanceCommand =
  | { action: 'save'; profile: AppearanceProfile; apply: boolean }
  | { action: 'activate'; id: string | null; revision: number }
  | { action: 'delete' | 'rollback'; id: string; revision: number };

export async function localAppearance(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<any> {
  if (!window.electronAPI?.localAppearance) throw new Error('appearance_desktop_upgrade_required');
  try {
    return await window.electronAPI.localAppearance({ ...payload, action });
  } catch (error: any) {
    if (error?.data?.error) throw error;
    const message = String(error?.message ?? error).replace(
      /^Error invoking remote method '[^']+': (?:Error: )?/,
      '',
    );
    throw new Error(message);
  }
}
export async function fetchAppearance(
  fallbackLegacy?: unknown,
  migrateLegacy = true,
): Promise<LocalAppearanceSnapshot> {
  let snapshot: LocalAppearanceSnapshot = await localAppearance('load');
  if (migrateLegacy && !snapshot.workspace.migrationComplete) {
    let legacy = fallbackLegacy;
    try {
      legacy = (await api.apiFetch<{ appearance: unknown }>('/api/v1/user/appearance/legacy')).appearance;
    } catch (error: any) {
      if (error?.status === 404) {
        try { legacy = (await api.apiFetch<{ appearance: unknown }>('/api/v1/user/appearance')).appearance; }
        catch { /* A fresh login snapshot can seed migration while the server is unavailable. */ }
      } else if (!Array.isArray((fallbackLegacy as any)?.profiles) || !(fallbackLegacy as any).profiles.length) legacy = undefined;
    }
    if (legacy) {
      const images: Record<string, string> = {},
        imageErrors: string[] = [];
      const urls = [
        ...new Set(
          (Array.isArray((legacy as any).profiles) ? (legacy as any).profiles : [])
            .map((profile: any) => profile?.background?.image)
            .filter(
              (url: unknown): url is string =>
                typeof url === 'string' && /^\/api\/v1\/images\//.test(url),
            ),
        ),
      ] as string[];
      let cursor = 0;
      const worker = async () => {
        while (cursor < Math.min(urls.length, 32)) {
          const url = urls[cursor++];
          try {
            const response = await fetch(api.resolveAuthenticatedAssetUrl(url), {
              signal: AbortSignal.timeout(8000),
            });
            if (!response.ok || Number(response.headers.get('Content-Length')) > 8 * 1024 * 1024)
              throw new Error('appearance_image_invalid');
            const blob = await response.blob();
            if (blob.size > 8 * 1024 * 1024) throw new Error('appearance_image_invalid');
            const base64 = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result).split(',')[1]);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            images[url] = (await localAppearance('image', { base64 })).image;
          } catch {
            imageErrors.push(url + ': appearance_image_keeps_server_url');
          }
        }
      };
      await Promise.all([worker(), worker()]);
      snapshot = await localAppearance('migrate', { legacy, images, imageErrors });
    }
  }
  snapshot.appearance = parseAppearanceSettings(snapshot.appearance);
  return snapshot;
}
export async function updateAppearance(
  command: AppearanceCommand,
): Promise<LocalAppearanceSnapshot> {
  if (command.action === 'save' && command.apply) await validateAppearanceCode(command.profile);
  return localAppearance('change', { command });
}
export async function readLocalDraft(id: string) {
  const profile = parseAppearanceProfile(await localAppearance('read-draft', { id }));
  await validateAppearanceCode(profile);
  return profile;
}
export async function previewLocalDraft(id: string) {
  const profile = await readLocalDraft(id);
  previewAppearance(profile, id);
  return profile;
}
export function summarizeLocalAppearance(workspace: AppearanceWorkspace) {
  return { directory: workspace.directory, draftsDirectory: workspace.draftsDirectory, documentation: workspace.documentation,
    activeId: workspace.activeId, profiles: workspace.profiles.map(({ id, name }) => ({ id, name })),
    drafts: workspace.drafts.slice(0, 128).map(({ id }) => id) };
}
export async function executeAppearanceWorkspace(
  payload: any,
  onProposal?: (profile: AppearanceProfile) => void,
) {
  if (payload.action === 'docs') {
    const documentation = await localAppearance('docs');
    return { readme: documentation.readme, desktopVersion: documentation.desktopVersion,
      state: summarizeLocalAppearance(documentation.workspace) };
  }
  const profile = parseAppearanceProfile(
    await localAppearance('read-draft', { id: payload.id }),
  );
  try {
    await validateAppearanceCode(profile);
  } catch (error: any) {
    return { error: error.message, diagnostics: error.diagnostics };
  }
  if (payload.checkOnly === true) return { status: 'valid', id: profile.id, name: profile.name };
  if (!onProposal) throw new Error('appearance_desktop_not_ready');
  onProposal(profile);
  return {
    status: 'proposed',
    id: profile.id,
    name: profile.name,
    message: 'Sent for user preview and explicit application. Files remain a draft.',
  };
}
export function useAppearance() {
  const { user } = useAuth(),
    client = useQueryClient();
  const key = ['appearance'] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: () => fetchAppearance(user?.ui_settings?.appearance, Boolean(user)),
    staleTime: 60_000,
  });
  useEffect(() => {
    if (user && query.data && !query.data.workspace.migrationComplete) void query.refetch({ cancelRefetch: false });
  }, [user?.id, query.data?.workspace.migrationComplete]);
  const mutation = useMutation({
    mutationFn: (command: AppearanceCommand) => updateAppearance(command),
    onSuccess: (snapshot) => {
      client.setQueryData(key, snapshot);
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: key });
    },
  });
  return {
    ...query,
    data: query.data?.appearance,
    workspace: query.data?.workspace,
    change: mutation.mutateAsync,
    saving: mutation.isPending,
    manage: async (action: string, payload: Record<string, unknown> = {}) => {
      const result = await localAppearance(action, payload);
      await client.invalidateQueries({ queryKey: key });
      return result;
    },
    previewDraft: (id: string) => previewLocalDraft(id),
    saveDraft: async (profile: AppearanceProfile) => {
      await localAppearance('write-draft', { profile });
      await client.invalidateQueries({ queryKey: key });
    },
  };
}

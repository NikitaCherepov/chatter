import { APPEARANCE_LABEL_KEYS } from './appearance-shell-types';
import { THEME_README, THEME_GUIDES, THEME_SETTINGS_EXAMPLES } from './theme-documentation';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { zipSync, unzipSync } from 'fflate';
import {
  DEFAULT_APPEARANCE,
  APPEARANCE_CAPABILITIES,
  APPEARANCE_README_MAX_BYTES,
  newAppearance,
  parseAppearanceProfile,
  type AppearanceProfile,
  type AppearanceSettings,
} from './appearance-schema';
import { isAppearanceFilePath, APPEARANCE_PROJECT_LIMITS } from './appearance-project';

export type AppearanceWorkspace = {
  directory: string;
  draftsDirectory: string;
  documentation: string;
  activeId: string | null;
  profiles: Array<{
    id: string;
    name: string;
    directory: string;
    draftDirectory: string;
    hasPrevious: boolean;
  }>;
  drafts: Array<{ id: string; directory: string }>;
  migrationComplete: boolean;
  migrationErrors: string[];
  issues: string[];
};
export type LocalAppearanceSnapshot = {
  appearance: AppearanceSettings;
  workspace: AppearanceWorkspace;
};
type RecordEntry = { current: string; previous?: string };
type Index = {
  version: 1;
  revision: number;
  activeId: string | null;
  records: Record<string, RecordEntry>;
  migrationComplete: boolean;
  migrationErrors: string[];
  importedWorkspaces?: string[];
};
const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
function profileContent(profile: AppearanceProfile): string {
  const sort = (value: any): any => Array.isArray(value) ? value.map(sort)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
  const { revision: _revision, ...content } = profile;
  return JSON.stringify(sort(content));
}

export function openAppearanceWorkspace(userData: string) {
  const configPath = path.join(userData, 'theme-location.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : undefined;
  const directory = config?.directory ?? path.join(userData, 'themes');
  const store = new LocalAppearanceStore(directory);
  if (!config) {
    const oldConfig = path.join(userData, 'theme-locations.json');
    const locations = fs.existsSync(oldConfig) ? Object.values(JSON.parse(fs.readFileSync(oldConfig, 'utf8'))) : [];
    const oldRoot = path.join(userData, 'themes');
    const candidates = new Set<string>(locations.filter((item): item is string => typeof item === 'string').map(item => path.resolve(item)));
    for (const item of fs.readdirSync(oldRoot, { withFileTypes: true })) {
      if (item.isDirectory() && /^[a-f0-9]{24}$/.test(item.name)) candidates.add(path.join(oldRoot, item.name));
    }
    const modified = (folder: string) => {
      try { return fs.statSync(path.join(folder, '.state.json')).mtimeMs; } catch { return 0; }
    };
    for (const folder of [...candidates].filter(item => fs.existsSync(item) && path.resolve(item) !== path.resolve(directory)).sort((a, b) => modified(b) - modified(a)))
      store.importLegacyWorkspace(folder);
    saveAppearanceLocation(userData, directory);
  }
  return store;
}
export function saveAppearanceLocation(userData: string, directory: string) {
  const target = path.join(userData, 'theme-location.json');
  const temporary = target + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ directory: path.resolve(directory) }, null, 2));
  fs.renameSync(temporary, target);
}
export function appearanceImageResponse(
  request: { url: string; method: string },
  resolve: (host: string) => LocalAppearanceStore | undefined,
) {
  try {
    const url = new URL(request.url),
      store = resolve(url.hostname);
    if (!store || request.method !== 'GET' || url.search || url.hash)
      return new Response('', { status: 403 });
    const name = url.pathname.slice(1),
      data = store.readImage(name);
    const type = name.endsWith('.jpg') ? 'image/jpeg' : 'image/' + name.split('.').pop();
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': type,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch {
    return new Response('', { status: 404 });
  }
}
export function copyAppearanceWorkspace(store: LocalAppearanceStore, selected: string) {
  const target = path.resolve(selected);
  if (fs.lstatSync(target).isSymbolicLink()) throw new Error('appearance_symlink_not_allowed');
  const sourceReal = fs.realpathSync(store.directory),
    targetReal = fs.realpathSync(target);
  if (sourceReal === targetReal) return store;
  const within = (base: string, child: string) => {
    const relative = path.relative(base, child);
    return (
      relative === '' ||
      (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    );
  };
  if (within(sourceReal, targetReal) || within(targetReal, sourceReal))
    throw new Error('appearance_directory_overlap');
  if (fs.readdirSync(target).length) {
    if (!['.workspace.json', '.scope.json'].some(name => fs.existsSync(path.join(target, name))))
      throw new Error('appearance_directory_not_empty');
    const existing = new LocalAppearanceStore(target);
    existing.load();
    return existing;
  }
  fs.cpSync(store.directory, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: (source) => {
      if (fs.lstatSync(source).isSymbolicLink()) throw new Error('appearance_symlink_not_allowed');
      return !['node_modules', '.git'].includes(path.basename(source));
    },
  });
  const copy = new LocalAppearanceStore(target);
  copy.load();
  return copy;
}

/** Files are confined to a local workspace. Published snapshots are immutable. */
export class LocalAppearanceStore {
  readonly assetHost: string;
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true });
    const marker = ['.workspace.json', '.scope.json'].find(name => fs.existsSync(this.location(name)));
    this.assetHost = marker ? JSON.parse(this.read(marker)).key
      : createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0, 24);
    if (!/^[a-f0-9]{24}$/.test(this.assetHost)) throw new Error('appearance_invalid');
    if (!marker) this.write('.workspace.json', JSON.stringify({ version: 1, key: this.assetHost }));
    this.ensureDirectory('.drafts');
    this.ensureDirectory('.saved');
    this.ensureDirectory('.assets');
    this.writeDocumentation();
  }
  private location(relative: string) {
    const target = path.resolve(this.directory, relative);
    if (
      target !== path.resolve(this.directory) &&
      !target.startsWith(path.resolve(this.directory) + path.sep)
    )
      throw new Error('appearance_invalid_path');
    let current = path.resolve(this.directory);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('appearance_symlink_not_allowed');
    for (const segment of path.relative(current, target).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        if (fs.lstatSync(current).isSymbolicLink())
          throw new Error('appearance_symlink_not_allowed');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return target;
  }
  private ensureDirectory(relative: string) {
    const target = this.location(relative);
    fs.mkdirSync(target, { recursive: true });
    return target;
  }
  private write(relative: string, value: string) {
    const target = this.location(relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const descriptor = fs.openSync(target, 'w');
    try {
      fs.writeFileSync(descriptor, value, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  private read(relative: string, limit = 1_000_000) {
    const target = this.location(relative);
    if (fs.statSync(target).size > limit) throw new Error('appearance_file_too_large');
    return fs.readFileSync(target, 'utf8');
  }
  importImage(base64: string) {
    if (typeof base64 !== 'string' || base64.length > 12_000_000)
      throw new Error('appearance_image_invalid');
    return this.storeImage(Buffer.from(base64, 'base64'));
  }
  private storeImage(data: Buffer) {
    if (!data.length || data.length > 8 * 1024 * 1024) throw new Error('appearance_image_invalid');
    const extension = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'png'
      : data[0] === 255 && data[1] === 216
        ? 'jpg'
        : /^GIF8[79]a$/.test(data.subarray(0, 6).toString())
          ? 'gif'
          : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP'
            ? 'webp'
            : undefined;
    if (!extension) throw new Error('appearance_image_invalid');
    const name = createHash('sha256').update(data).digest('hex') + '.' + extension;
    const target = this.location('.assets/' + name);
    if (!fs.existsSync(target)) fs.writeFileSync(target, data);
    return 'chatter-theme://' + this.assetHost + '/' + name;
  }
  readImage(name: string) {
    if (!/^[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(name))
      throw new Error('appearance_image_invalid');
    const target = this.location('.assets/' + name);
    if (fs.statSync(target).size > 8 * 1024 * 1024) throw new Error('appearance_image_invalid');
    const data = fs.readFileSync(target);
    if (createHash('sha256').update(data).digest('hex') !== name.split('.')[0])
      throw new Error('appearance_image_invalid');
    return data;
  }
  private index(): Index {
    const target = this.location('.state.json');
    if (!fs.existsSync(target))
      return {
        version: 1,
        revision: 0,
        activeId: null,
        records: Object.create(null),
        migrationComplete: false,
        migrationErrors: [],
      };
    const value = JSON.parse(this.read('.state.json')) as Index;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      !value.records ||
      Array.isArray(value.records) ||
      Object.keys(value.records).length > 32 ||
      (value.activeId !== null && !validId(value.activeId))
    )
      throw new Error('appearance_index_invalid');
    for (const [id, record] of Object.entries(value.records)) {
      if (
        !validId(id) ||
        !record ||
        !this.isSnapshot(id, record.current) ||
        (record.previous !== undefined && !this.isSnapshot(id, record.previous))
      )
        throw new Error('appearance_index_invalid');
    }
    value.records = Object.assign(Object.create(null), value.records);
    return value;
  }
  private isSnapshot(id: string, value: unknown): value is string {
    return (
      typeof value === 'string' && new RegExp('^\\.saved/' + id + '/[a-f0-9-]{36}$').test(value)
    );
  }
  private commit(index: Index) {
    const temporary = '.state-' + randomUUID() + '.json';
    this.write(temporary, JSON.stringify(index, null, 2));
    fs.renameSync(this.location(temporary), this.location('.state.json'));
  }
  private readProject(directory: string): AppearanceProfile {
    let manifest: any;
    try {
      manifest = JSON.parse(this.read(directory + '/theme.json'));
    } catch (error) {
      throw new Error('theme.json: ' + (error as Error).message);
    }
    // README is a separate document on disk, carried in the profile only across app boundaries.
    if (Object.prototype.hasOwnProperty.call(manifest, 'readme')) throw new Error('appearance_invalid');
    if (fs.existsSync(this.location(directory + '/README.md')))
      manifest.readme = this.read(directory + '/README.md', APPEARANCE_README_MAX_BYTES);
    if (
      typeof manifest?.background?.image === 'string' &&
      manifest.background.image.startsWith('assets/')
    ) {
      const image = manifest.background.image;
      if (
        !/^assets\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(png|jpe?g|webp|gif)$/.test(
          image,
        )
      )
        throw new Error('appearance_invalid_path');
      const target = this.location(directory + '/' + image);
      if (fs.statSync(target).size > 8 * 1024 * 1024) throw new Error('appearance_image_invalid');
      const name = path.basename(image);
      if (
        directory.startsWith('.saved/') &&
        /^[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(name) &&
        fs.existsSync(this.location('.assets/' + name))
      )
        manifest.background.image = 'chatter-theme://' + this.assetHost + '/' + name;
      else manifest.background.image = this.storeImage(fs.readFileSync(target));
    }
    if (manifest.shell) {
      const shell = manifest.shell;
      if (
        Object.keys(shell).some((key) => !['version', 'language', 'scope', 'entry'].includes(key))
      )
        throw new Error('appearance_invalid');
      const files: Record<string, string> = {};
      let visited = 0,
        sourceLength = 0;
      const walk = (folder: string) => {
        for (const item of fs.readdirSync(this.location(directory + (folder ? '/' + folder : '')), {
          withFileTypes: true,
        })) {
          if (item.name.startsWith('.') || item.name === 'node_modules') continue;
          if (++visited > 2048) throw new Error('appearance_limit');
          const name = folder ? folder + '/' + item.name : item.name;
          if (item.isSymbolicLink()) throw new Error('appearance_symlink_not_allowed');
          if (item.isDirectory()) {
            if (name.split('/').length > 8) throw new Error('appearance_invalid_path');
            walk(name);
          } else if (
            name !== 'theme.json' &&
            name !== 'tsconfig.json' &&
            !name.endsWith('.d.ts') &&
            isAppearanceFilePath(name)
          ) {
            if (Object.keys(files).length >= APPEARANCE_PROJECT_LIMITS.files)
              throw Object.assign(new Error('appearance_project_limit'), {
                diagnostics: [
                  {
                    file: name,
                    line: 1,
                    column: 1,
                    message: `Theme project exceeds the limit of ${APPEARANCE_PROJECT_LIMITS.files} runtime files.`,
                  },
                ],
              });
            files[name] = this.read(
              directory + '/' + name,
              APPEARANCE_PROJECT_LIMITS.sourceLength * 4,
            );
            sourceLength += files[name].length;
            if (sourceLength > APPEARANCE_PROJECT_LIMITS.sourceLength)
              throw Object.assign(new Error('appearance_project_limit'), {
                diagnostics: [
                  {
                    file: name,
                    line: 1,
                    column: 1,
                    message: `Theme project exceeds the total limit of ${APPEARANCE_PROJECT_LIMITS.sourceLength} source characters.`,
                  },
                ],
              });
          }
        }
      };
      walk('');
      manifest.shell = { ...shell, files };
    }
    return parseAppearanceProfile(manifest);
  }
  private writeProject(directory: string, value: AppearanceProfile) {
    const profile = parseAppearanceProfile(value);
    const { readme, ...manifest }: any = structuredClone(profile);
    this.ensureDirectory(directory);
    if (readme !== undefined) this.write(directory + '/README.md', readme);
    if (profile.background.image.startsWith('chatter-theme:')) {
      const image = new URL(profile.background.image);
      if (image.hostname !== this.assetHost) throw new Error('appearance_image_not_found');
      const name = image.pathname.slice(1),
        data = this.readImage(name);
      this.ensureDirectory(directory + '/assets');
      fs.writeFileSync(this.location(directory + '/assets/' + name), data);
      manifest.background.image = 'assets/' + name;
    }
    if (profile.shell) {
      const { version, language, scope } = profile.shell;
      if (Object.prototype.hasOwnProperty.call(profile.shell.files, 'theme.json'))
        throw new Error('appearance_reserved_file');
      manifest.shell = { version, language, scope, entry: profile.shell.entry };
      for (const [file, source] of Object.entries(profile.shell.files))
        this.write(directory + '/' + file, source);
    }
    this.write(directory + '/theme.json', JSON.stringify(manifest, null, 2) + '\n');
    if (profile.shell?.language === 'tsx') {
      this.write(directory + '/chatter.d.ts', appearanceDeclarations);
      this.write(directory + '/chatter-ui.d.ts', appearanceUIDeclarations);
      this.write(
        directory + '/tsconfig.json',
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2020',
              module: 'ESNext',
              moduleResolution: 'Bundler',
              jsx: 'react',
              noEmit: true,
              allowJs: true,
              baseUrl: '.',
              paths: { '@/*': ['./*'] },
              lib: ['ES2020', 'DOM'],
            },
            include: ['**/*.ts', '**/*.tsx', '**/*.jsx'],
          },
          null,
          2,
        ),
      );
    }
  }
  private snapshot(profile: AppearanceProfile) {
    const relative = '.saved/' + profile.id + '/' + randomUUID();
    this.writeProject(relative, profile);
    // Reading back guarantees the published pointer references a complete, valid project.
    this.readProject(relative);
    return relative;
  }
  private pruneSnapshots(id: string, record: RecordEntry) {
    const parent = '.saved/' + id;
    for (const item of fs.readdirSync(this.location(parent), { withFileTypes: true })) {
      const relative = parent + '/' + item.name;
      if (
        item.isDirectory() &&
        this.isSnapshot(id, relative) &&
        relative !== record.current &&
        relative !== record.previous
      )
        fs.rmSync(this.location(relative), { recursive: true, force: true });
    }
  }
  private draft(id: string) {
    if (!validId(id)) throw new Error('appearance_invalid');
    return '.drafts/' + id;
  }
  private ensureDraft(profile: AppearanceProfile) {
    const draft = this.draft(profile.id);
    if (!fs.existsSync(this.location(draft))) this.writeProject(draft, profile);
  }
  importLegacyWorkspace(directory: string) {
    const index = this.index();
    const sourceKey = createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0, 12);
    if (index.importedWorkspaces?.includes(sourceKey)) return;
    try {
      const source = new LocalAppearanceStore(directory), old = source.index();
      const idFor = (id: string) => id.slice(0, 50) + '-' + sourceKey;
      const copyProject = (from: string, to: string, id: string) => {
        if (fs.existsSync(this.location(to))) return;
        const staging = '.importing/' + randomUUID();
        fs.cpSync(source.location(from), this.location(staging), {
          recursive: true, errorOnExist: true, force: false,
          filter: file => {
            if (fs.lstatSync(file).isSymbolicLink()) throw new Error('appearance_symlink_not_allowed');
            return !['node_modules', '.git'].includes(path.basename(file));
          },
        });
        // Preserve unfinished/invalid drafts too; they remain available for repair.
        try {
          const manifest = JSON.parse(this.read(staging + '/theme.json'));
          manifest.id = id;
          this.write(staging + '/theme.json', JSON.stringify(manifest, null, 2));
        } catch (error) { index.migrationErrors.push(to + ': ' + (error as Error).message); }
        this.ensureDirectory(path.dirname(to));
        fs.renameSync(this.location(staging), this.location(to));
      };
      for (const [oldId, record] of Object.entries(old.records)) {
        const id = idFor(oldId);
        const current = '.saved/' + id + '/' + path.basename(record.current);
        copyProject(record.current, current, id);
        const previous = record.previous ? '.saved/' + id + '/' + path.basename(record.previous) : undefined;
        if (previous) copyProject(record.previous!, previous, id);
        if (!index.records[id]) {
          if (Object.keys(index.records).length >= 32) { index.migrationErrors.push(id + ': appearance_limit'); continue; }
          index.records[id] = { current, ...(previous ? { previous } : {}) };
        }
      }
      for (const draft of fs.readdirSync(source.location('.drafts'), { withFileTypes: true }))
        if (draft.isDirectory() && validId(draft.name)) copyProject(source.draft(draft.name), this.draft(idFor(draft.name)), idFor(draft.name));
      if (index.revision === 0) index.activeId = old.activeId && index.records[idFor(old.activeId)] ? idFor(old.activeId) : null;
      index.migrationComplete ||= old.migrationComplete;
      index.migrationErrors.push(...old.migrationErrors);
      (index.importedWorkspaces ??= []).push(sourceKey);
      index.revision++;
    } catch (error) { index.migrationErrors.push(directory + ': ' + (error as Error).message); }
    this.commit(index);
  }
  migrate(
    legacy: unknown,
    images: Record<string, string> = {},
    imageErrors: string[] = [],
  ): LocalAppearanceSnapshot {
    const index = this.index();
    if (index.migrationComplete) return this.load();
    const settings = legacy as Partial<AppearanceSettings> | undefined;
    if (!settings || !Array.isArray(settings.profiles))
      throw new Error('appearance_migration_unavailable');
    if (!fs.existsSync(this.location('.migration-backup.json')))
      this.write('.migration-backup.json', JSON.stringify(legacy, null, 2));
    const wasEmpty = index.revision === 0;
    index.migrationErrors.push(
      ...imageErrors.slice(0, 32).map((error) => String(error).slice(0, 2048)),
    );
    for (const raw of settings.profiles) {
      try {
        const profile = parseAppearanceProfile(raw);
        if (Object.prototype.hasOwnProperty.call(images, profile.background.image))
          profile.background.image = images[profile.background.image];
        if (index.records[profile.id]) continue;
        if (Object.keys(index.records).length >= 32) throw new Error('appearance_limit');
        index.records[profile.id] = { current: this.snapshot(profile) };
        this.ensureDraft(profile);
      } catch (error) {
        index.migrationErrors.push(
          String((raw as any)?.id ?? 'unknown') + ': ' + (error as Error).message,
        );
      }
    }
    if (wasEmpty && settings.activeId && index.records[settings.activeId])
      index.activeId = settings.activeId;
    index.migrationComplete = true;
    index.revision++;
    this.commit(index);
    return this.load();
  }
  load(): LocalAppearanceSnapshot {
    const index = this.index();
    const profiles: AppearanceProfile[] = [];
    const issues: string[] = [];
    let recovered = false;
    for (const [id, record] of Object.entries(index.records)) {
      try {
        profiles.push(this.readProject(record.current));
      } catch (error) {
        if (!record.previous) {
          issues.push(id + ': ' + (error as Error).message);
          continue;
        }
        try {
          const fallback = this.readProject(record.previous);
          const restored = {
            ...fallback,
            revision: Math.max(fallback.revision, index.revision) + 1,
          };
          profiles.push(restored);
          record.current = this.snapshot(restored);
          issues.push(id + ': appearance_previous_restored');
          recovered = true;
        } catch {
          issues.push(id + ': appearance_snapshot_invalid');
        }
      }
    }
    if (recovered) {
      index.revision++;
      this.commit(index);
    }
    for (const profile of profiles) this.ensureDraft(profile);
    const drafts = fs
      .readdirSync(this.location('.drafts'), { withFileTypes: true })
      .filter((item) => item.isDirectory() && validId(item.name))
      .map((item) => ({ id: item.name, directory: this.location(this.draft(item.name)) }));
    return {
      appearance: {
        ...DEFAULT_APPEARANCE,
        revision: index.revision,
        activeId: profiles.some((profile) => profile.id === index.activeId) ? index.activeId : null,
        profiles,
      },
      workspace: {
        directory: this.directory,
        draftsDirectory: this.location('.drafts'),
        documentation: this.location('THEMES.md'),
        activeId: profiles.some((profile) => profile.id === index.activeId) ? index.activeId : null,
        migrationComplete: index.migrationComplete,
        migrationErrors: index.migrationErrors,
        issues,
        profiles: profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          directory: this.location(index.records[profile.id].current),
          draftDirectory: this.location(this.draft(profile.id)),
          hasPrevious: Boolean(index.records[profile.id].previous),
        })),
        drafts,
      },
    };
  }
  readDraft(id: string): AppearanceProfile {
    const profile = this.readProject(this.draft(id));
    if (profile.id !== id) throw new Error('appearance_id_mismatch');
    const current = this.index().records[id];
    // Revision is managed by the application; editing files never needs a revision bump.
    return { ...profile, revision: current ? this.readProject(current.current).revision : 0 };
  }
  writeDraft(profile: AppearanceProfile): LocalAppearanceSnapshot {
    profile = parseAppearanceProfile(profile);
    const staging = '.editing/' + randomUUID();
    this.writeProject(staging, profile);
    this.readProject(staging);
    const draft = this.draft(profile.id),
      backup = '.trash/' + profile.id + '-' + randomUUID();
    const exists = fs.existsSync(this.location(draft));
    if (exists) {
      this.ensureDirectory('.trash');
      fs.renameSync(this.location(draft), this.location(backup));
    }
    try {
      fs.renameSync(this.location(staging), this.location(draft));
    } catch (error) {
      if (exists) fs.renameSync(this.location(backup), this.location(draft));
      throw error;
    }
    return this.load();
  }
  exportBundle(id: string): Uint8Array {
    if (!validId(id)) throw new Error('appearance_invalid');
    const record = this.index().records[id];
    if (!record) throw new Error('appearance_not_found');
    const files: Record<string, Uint8Array> = {};
    let total = 0;
    const walk = (folder: string) => {
      for (const item of fs.readdirSync(this.location(record.current + '/' + folder), {
        withFileTypes: true,
      })) {
        const file = folder ? folder + '/' + item.name : item.name;
        if (item.isSymbolicLink()) throw new Error('appearance_symlink_not_allowed');
        if (item.isDirectory()) {
          walk(file);
          continue;
        }
        const target = this.location(record.current + '/' + file),
          size = fs.statSync(target).size;
        total += size;
        if (total > 12 * 1024 * 1024 || Object.keys(files).length >= 512)
          throw new Error('appearance_limit');
        files[file] = fs.readFileSync(target);
      }
    };
    walk('');
    return zipSync(files, { level: 6 });
  }
  importBundle(data: Uint8Array): AppearanceProfile {
    if (!(data instanceof Uint8Array) || data.length > 12 * 1024 * 1024)
      throw new Error('appearance_invalid');
    let total = 0,
      count = 0;
    const entries = unzipSync(data, {
      filter: (item) => {
        total += item.originalSize;
        if (
          ++count > 1024 ||
          !Number.isSafeInteger(item.originalSize) ||
          total > 12 * 1024 * 1024 ||
          item.name
            .split('/')
            .some((part) => ['__proto__', 'constructor', 'prototype'].includes(part)) ||
          !/^(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/?$/.test(item.name)
        )
          throw new Error('appearance_invalid_archive');
        return !item.name.endsWith('/');
      },
    });
    const manifests = Object.keys(entries).filter(
      (file) => file === 'theme.json' || file.endsWith('/theme.json'),
    );
    const manifest = Object.prototype.hasOwnProperty.call(entries, 'theme.json')
      ? 'theme.json'
      : manifests.length === 1
        ? manifests[0]
        : undefined;
    if (!manifest) throw new Error('appearance_invalid_archive');
    const prefix = manifest.slice(0, -'theme.json'.length),
      staging = '.imports/' + randomUUID();
    try {
      this.ensureDirectory(staging);
      for (const [file, content] of Object.entries(entries)) {
        if (!file.startsWith(prefix)) throw new Error('appearance_invalid_archive');
        const relative = file.slice(prefix.length);
        const target = this.location(staging + '/' + relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
      const profile = this.readProject(staging);
      profile.id = randomUUID();
      profile.revision = 0;
      this.writeDraft(profile);
      return profile;
    } finally {
      if (fs.existsSync(this.location(staging)))
        fs.rmSync(this.location(staging), { recursive: true, force: true });
    }
  }
  prepareDraft(id: string, project = false): LocalAppearanceSnapshot {
    const current = this.index().records[id];
    const profile = current ? this.readProject(current.current) : newAppearance(id);
    if (project && !current)
      profile.shell = structuredClone(
        APPEARANCE_CAPABILITIES.shell.project.template,
      ) as AppearanceProfile['shell'];
    this.ensureDraft(profile);
    return this.load();
  }
  save(profile: AppearanceProfile, apply: boolean): LocalAppearanceSnapshot {
    profile = parseAppearanceProfile(profile);
    const index = this.index(),
      previous = index.records[profile.id];
    const current = previous ? this.readProject(previous.current) : null;
    let draftBefore: string | undefined;
    let refreshDraft = false;
    try {
      const working = this.readDraft(profile.id);
      draftBefore = profileContent(working);
      refreshDraft = Boolean(current && draftBefore === profileContent(current) && draftBefore !== profileContent(profile));
    } catch { /* An unfinished or invalid external draft must be retained. */ }
    if ((current?.revision ?? 0) !== profile.revision) throw new Error('appearance_conflict');
    if (index.activeId === profile.id && !apply)
      throw new Error('appearance_active_requires_apply');
    if (!previous && Object.keys(index.records).length >= 32) throw new Error('appearance_limit');
    const published = { ...profile, revision: (current?.revision ?? 0) + 1 };
    const snapshot = this.snapshot(published);
    index.records[profile.id] = {
      current: snapshot,
      ...(previous ? { previous: previous.current } : {}),
    };
    if (apply) index.activeId = profile.id;
    index.revision++;
    this.commit(index);
    this.ensureDraft(published);
    if (refreshDraft) {
      try {
        if (profileContent(this.readDraft(profile.id)) === draftBefore) this.writeDraft(published);
      } catch { /* The published snapshot is committed; leave any newer draft intact. */ }
    }
    try {
      this.pruneSnapshots(profile.id, index.records[profile.id]);
    } catch {
      /* Publication already committed; cleanup may be retried later. */
    }
    return this.load();
  }
  change(command: any): LocalAppearanceSnapshot {
    if (command?.action === 'save' && typeof command.apply === 'boolean')
      return this.save(command.profile, command.apply);
    const index = this.index();
    if (command?.revision !== index.revision) throw new Error('appearance_conflict');
    if (command.action === 'activate') {
      if (command.id !== null && (!validId(command.id) || !index.records[command.id]))
        throw new Error('appearance_not_found');
      index.activeId = command.id;
    } else if (command.action === 'delete') {
      if (!validId(command.id) || !index.records[command.id])
        throw new Error('appearance_not_found');
      delete index.records[command.id];
      if (index.activeId === command.id) index.activeId = null;
      const draft = this.draft(command.id);
      if (fs.existsSync(this.location(draft))) {
        this.ensureDirectory('.trash');
        fs.renameSync(
          this.location(draft),
          this.location('.trash/' + command.id + '-' + randomUUID()),
        );
      }
    } else if (command.action === 'rollback') {
      if (!validId(command.id) || !index.records[command.id]?.previous)
        throw new Error('appearance_not_found');
      const record = index.records[command.id];
      const current = this.readProject(record.current),
        previous = this.readProject(record.previous!);
      return this.save({ ...previous, revision: current.revision }, index.activeId === command.id);
    } else throw new Error('appearance_invalid');
    index.revision++;
    this.commit(index);
    return this.load();
  }
  watch(callback: () => void) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const watcher = fs.watch(this.location('.drafts'), { recursive: true }, () => {
      clearTimeout(timeout);
      timeout = setTimeout(callback, 180);
    });
    watcher.on('error', callback);
    return () => {
      clearTimeout(timeout);
      watcher.close();
    };
  }
  readDocumentation(): string {
    return this.read('THEMES.md', 256_000);
  }
  private writeDocumentation() {
    this.write('THEMES.md', THEME_README);
    this.ensureDirectory('docs');
    for (const [name, text] of Object.entries(THEME_GUIDES)) this.write('docs/' + name, text);
    for (const [name, text] of Object.entries(THEME_SETTINGS_EXAMPLES)) this.write('examples/settings/' + name, text);
    const { shell: _shell, template: _template, paletteExample: _paletteExample, ...appearance } = APPEARANCE_CAPABILITIES;
    const { template: _materialTemplate, ...materials } = appearance.materials;
    this.write('docs/appearance.json', JSON.stringify({ ...appearance, materials }, null, 2) + '\n');
    this.writeProject('templates/component', {
      ...newAppearance('my-theme'),
      readme: '# My theme\n\nDescribe the visual idea, component structure, supported features and known limitations here.\n\nThe entry and appearance settings are in theme.json. Read the workspace THEMES.md for the app API.\n',
      shell: APPEARANCE_CAPABILITIES.shell.project.template as AppearanceProfile['shell'],
    });
    this.writeProject('templates/html', {
      ...newAppearance('my-theme'),
      readme: '# My HTML theme\n\nDescribe the visual idea, local scripts/styles, supported features and known limitations here.\n\nThe entry is declared in theme.json. Read the workspace THEMES.md for the app API.\n',
      shell: APPEARANCE_CAPABILITIES.shell.template as AppearanceProfile['shell'],
    });
    this.write('template.json', JSON.stringify(newAppearance('my-theme'), null, 2) + '\n');
    this.write('chatter.d.ts', appearanceDeclarations);
    this.write('chatter-ui.d.ts', appearanceUIDeclarations);
  }
}

const appearanceDeclarations = `export type MessageAction = 'copy'|'downloadDocx'|'sendTelegram'|'fork'|'edit'|'delete'|'regenerate'|'regenerateHint'|'speak'|'activateVariant';
export type ToolCall={id?:string;name:string;label:string;kind:'search'|'note'|'file'|'terminal'|'browser'|'clock'|'avatar'|'tool';target:string;status:'running'|'error'|'returned'|'unknown';internal:boolean;confirmed:boolean;arguments:unknown;resultPreview?:string;children:ToolCall[]};
export type WorkLogStep={type:'message'|'activity';text:string}|{type:'tool';call:ToolCall};
export type DocumentPreview={kind:'pdf'|'docx'|'spreadsheet'|'text'|'unsupported';name:string;mimeType:string;sizeBytes:number;text:string;html?:string;pageCount?:number};
export type DocumentPage={source:string;width:number;height:number;page:number;pageCount:number};
export type TokenUsage={promptTokens:number;completionTokens:number;totalTokens:number;cacheHitTokens:number;cacheMissTokens:number;reasoningTokens:number};
export type MessageInfo={modelName:string|null;providerName:string|null;tokenCount:number|null;tokenCountSource:'provider'|'estimate'|null;usage:TokenUsage|null;performance:{firstTokenLatencyMs:number;generationMs:number;totalMs:number;tokensPerSecond:number}|null};
export type Models={loading:boolean;busy:boolean;error:string|null;selectedId:string|null;automaticLabel:string;automaticSupportsVision:boolean;contextLimit:number|null;items:{id:string;name:string;description:string;supportsVision:boolean;isFree:boolean;contextLength:number|null;averageTokensPerSecond:number|null;intelligenceTier:number|null;priceTier:number|null}[]};
export type Context={showTokens:boolean;limit:number|null;tokens:number|null;cachePercent:number|null;messagesTokens:number|null;reasoningTokens:number|null;systemPromptTokens:number|null;activeMessages:number|null;archivedMessages:number|null;latest:(TokenUsage&{modelName:string|null})|null};
export type Voice={status:'idle'|'requesting'|'recording'|'transcribing';canStart:boolean;error:string|null;transcript:{id:number;text:string}|null};
export type SettingValue=string|number|boolean;
export type SettingsField={id:string;groupId:string;label:string;help:string;type:'select'|'toggle'|'number'|'time';value:SettingValue;savedValue:SettingValue;dirty:boolean;error:string|null;visible:boolean;options?:{value:string;label:string}[];min?:number;max?:number;step?:number};
export type SettingsSection={id:string;groupId:string;label:string;mode:'native'|'hybrid'|'fields'};
export type SettingsSearchResult={sectionId:string;key:string;title:string;sectionTitle:string;fieldId:string|null;native:boolean};
export type SettingsState={groups:{id:string;label:string}[];sections:SettingsSection[];query:string;results:SettingsSearchResult[];hasMoreResults:boolean;editor:{id:string;sectionId:string;loading:boolean;busy:boolean;dirty:boolean;error:string|null;fields:SettingsField[];groups:{id:string;label:string}[];links:{id:string;label:string;sectionId:string;target:string}[]}|null};
export type Message={id:number;role:string;content:string;createdAt:number;streaming:boolean;reasoningContent:string;workLog:WorkLogStep[];toolStatus:string|null;variantIndex:number;variantCount:number;actions:MessageAction[];editableContent?:string;info:MessageInfo;images:{url:string;type:'user_photo'|'generated'|'external'}[];attachments:{url:string;name:string;filename:string;mimeType:string;sizeBytes:number}[]};
export type ConfirmationNode={type:'text'|'code'|'markdown'|'json'|'email';text:string}|{type:'diff';before:string;after:string}|{type:'group';label?:string;children:ConfirmationNode[]}|{type:'field';fieldId:string}|{type:'action';actionId:string};
export type ConfirmationField={id:string;label:string;type:string;value:string|boolean;disabled:boolean;options?:{value:string;label:string}[]};
export type ConfirmationAction={id:string;label:string;disabled:boolean;group:'primary'|'review'|'permissions'|'content';comment?:boolean};
export type Confirmation={id:string;title:string;summary:string;ready:boolean;revision:number;busy:boolean;customizable:boolean;content:ConfirmationNode[];fields:ConfirmationField[];actions:ConfirmationAction[]};
export type LabelKey=${APPEARANCE_LABEL_KEYS.map(key => JSON.stringify(key)).join('|')};
export type Labels=Record<LabelKey,string>&Partial<Record<string,string>>;
export type ChatMenuAction='rename'|'downloadDocx'|'move'|'setBotHidden'|'delete'|'leave';
export type MenuItem={id:string;label:string;disabled:boolean;dangerous:boolean;requiresConfirmation:boolean};
export type ThemeState = {
  chats: {id:number;title:string;folderId:number|null;updatedAt:number;isOwner:boolean|null;botHidden:boolean;actions:ChatMenuAction[]}[];
  folders: {id:number;name:string;count:number;actions:('rename'|'delete')[]}[];
  library:{busy:boolean;operation:string|null;error:string|null;canCreateFolder:boolean;limits:{chatTitle:number;folderName:number}};
  sections: {folderId:number|null;total:number;loaded:number;hasMore:boolean;loading:boolean}[];
  view:'home'|'conversation';activeChatId:number|null;query:string;loading:boolean;
  messages:Message[];
  models:Models;context:Context;voice:Voice;
  settings:SettingsState;
  speech:{messageId:number|null;status:'idle'|'loading'|'playing'|'paused'};
  confirmations:Confirmation[];
  messagesLoading:boolean;hasOlderMessages:boolean;olderMessagesLoading:boolean;sending:boolean;canSend:boolean;attachmentCount:number;
  composer:{busy:boolean;error:string|null;items:{id:string;kind:'image'|'document';name:string;mimeType:string;sizeBytes:number}[];limits:{maxImageCount:number;maxImageBytes:number;maxDocumentBytes:number;imageFormats:string[];documentExtensions:string[]}};
  locale:string;dark:boolean;palette:{background:string;text:string;accent:string;surface:string};labels:Labels;
};
export interface ThemeAPI {
  getSettingsSections():SettingsSection[];searchSettings(query:string):boolean;openSettingsSection(sectionId:string):boolean;
  setSettingValue(sectionId:string,fieldId:string,value:SettingValue):boolean;saveSettingsSection(sectionId:string):boolean;
  discardSettingsSection(sectionId:string):boolean;reloadSettingsSection(sectionId:string):boolean;
  selectModel(id:string|null):boolean;
  startVoiceRecording():boolean;stopVoiceRecording():boolean;cancelVoiceRecording():boolean;
  getChatMenu(id:number):MenuItem[];getFolderMenu(id:number):MenuItem[];
  renameChat(id:number,title:string):boolean;downloadChatDocx(id:number):boolean;
  moveChat(id:number,folderId:number|null):boolean;setChatBotHidden(id:number,hidden:boolean):boolean;
  deleteChat(id:number,confirmed:boolean):boolean;leaveChat(id:number,confirmed:boolean):boolean;
  createFolder(name:string):boolean;renameFolder(id:number,name:string):boolean;deleteFolder(id:number,confirmed:boolean):boolean;
  imageSource(messageId:number,url:string,width?:number):string;
  fullImageSource(messageId:number,url:string):string;
  readAttachment(messageId:number,index:number):Promise<DocumentPreview>;
  renderAttachmentPage(messageId:number,index:number,page:number,width?:number):Promise<DocumentPage>;
  chooseAttachments():boolean;attachPastedFiles():boolean;removePendingAttachment(id:string):boolean;clearPendingAttachments():boolean;pendingAttachmentSource(id:string):string;
  openImage(messageId:number,url:string):boolean;downloadImage(messageId:number,url:string):boolean;
  openAttachment(messageId:number,index:number):boolean;downloadAttachment(messageId:number,index:number):boolean;
  openLink(messageId:number,url:string):boolean;copyText(messageId:number,text:string):boolean;
  subscribe(callback:(state:ThemeState)=>void,options?:{navigation?:boolean;confirmations?:boolean}):()=>void;
  openChat(id:number):void;newChat():void;showHome():void;openConversation():void;
  sendMessage(text:string):boolean;stopGeneration():void;loadOlderMessages():void;
  loadMore(folderId:number|null):void;search(query:string):void;attachFiles():boolean;openLibrary():void;openSettings(sectionId?:string,target?:string):boolean;
  copyMessage(id:number):boolean;downloadMessageDocx(id:number):boolean;sendMessageToTelegram(id:number):boolean;
  forkFromMessage(id:number):boolean;editMessage(id:number,text:string,expectedVariantIndex?:number):boolean;openMessageEditor(id:number):boolean;deleteMessage(id:number):boolean;
  regenerateMessage(id:number,hint?:string):boolean;requestRegenerationHint(id:number):boolean;
  activateMessageVariant(id:number,index:number):boolean;speakMessage(id:number):boolean;
  pauseSpeech():boolean;resumeSpeech():boolean;stopSpeech():boolean;reviewConfirmation(id:string):boolean;
  setConfirmationField(id:string,fieldId:string,value:string|boolean):boolean;
  runConfirmationAction(id:string,actionId:string,revision:number,comment?:string):boolean;
}
declare global {interface Window {chatter:ThemeAPI}}
`;

const appearanceUIDeclarations = `declare module '@chatter/ui' {
  export type ImageTarget={chatId:number;messageId:number;variantIndex:number;url:string;source:string;alt:string};
  export type AttachmentTarget={chatId:number;messageId:number;variantIndex:number;index:number;url:string;name:string;mimeType:string;sizeBytes:number};
  export type ChatterStateOptions={navigation?:boolean;confirmations?:boolean};
  export function useChatterState(options?:ChatterStateOptions):import('./chatter').ThemeState|undefined;
  export function Markdown(props:{messageId:number;content:string;className?:string;style?:import('react').CSSProperties;components?:import('react-markdown').Components;onImageClick?:(image:ImageTarget)=>void}):import('react').ReactElement;
  export function Image(props:{messageId:number;url:string;alt?:string;className?:string;style?:import('react').CSSProperties;fullSize?:boolean;onImageClick?:(image:ImageTarget)=>void}):import('react').ReactElement;
  export function MessageImages(props:{message:import('./chatter').Message;className?:string;onImageClick?:(image:ImageTarget)=>void}):import('react').ReactElement;
  export function Attachments(props:{message:import('./chatter').Message;className?:string;onAttachmentClick?:(file:AttachmentTarget)=>void}):import('react').ReactElement;
}
`;

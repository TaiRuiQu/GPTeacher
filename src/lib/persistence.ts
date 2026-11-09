import { apiJson } from './api';
import { lessonSources } from '../content/lessons';
import { parseLesson } from './lesson';
import { readLegacySettings, type ModelSettingsValue } from './settings';

export type StoredNote = {
  id: string;
  lessonId: string;
  lessonTitle: string;
  stepTitle: string;
  time: number;
  body: string;
  createdAt: string;
};
export type Workspace = { currentId: string; sources: Record<string, string>; notes: StoredNote[] };
export type ApplicationState = { workspace: Workspace; settings: ModelSettingsValue };
type ServerState = {
  workspace: Workspace | null;
  settings: ModelSettingsValue;
  hasWorkspace: boolean;
  hasSettings: boolean;
  imported?: boolean;
};
const LEGACY_KEYS = [
  'gpt-teacher:workspace:v1',
  'gpt-teacher:model-settings:v1',
  'gpt-teacher:api-keys:v1',
];
let loading: Promise<ApplicationState> | undefined;
let workspaceWrites = Promise.resolve();

function legacyWorkspace(raw: string | null): Workspace | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1) return undefined;
    const sources: Record<string, string> = {};
    for (const [id, text] of Object.entries(value.sources ?? {})) {
      if (typeof text !== 'string' || text.length > 2_000_000) continue;
      try {
        parseLesson(text);
        sources[id] = text;
      } catch {
        /* Keep usable legacy lessons. */
      }
    }
    const notes = Array.isArray(value.notes)
      ? value.notes.filter(
          (note: StoredNote) =>
            note &&
            ['id', 'lessonId', 'lessonTitle', 'stepTitle', 'body', 'createdAt'].every(
              (name) => typeof note[name as keyof StoredNote] === 'string',
            ) &&
            Number.isFinite(note.time) &&
            note.time >= 0,
        )
      : [];
    const currentId =
      typeof value.currentId === 'string' &&
      (sources[value.currentId] || lessonSources.some((item) => item.id === value.currentId))
        ? value.currentId
        : lessonSources[0].id;
    return { currentId, sources, notes };
  } catch {
    return undefined;
  }
}

async function load(): Promise<ApplicationState> {
  let state = await apiJson<ServerState>('/api/state', undefined, undefined, 'GET');
  if (!state.hasWorkspace && !state.hasSettings) {
    // Read the old browser store once. All subsequent reads and writes use the server.
    let workspace: Workspace | undefined;
    let settings: ModelSettingsValue | undefined;
    try {
      workspace = legacyWorkspace(localStorage.getItem(LEGACY_KEYS[0]));
      if (localStorage.getItem(LEGACY_KEYS[1]) || localStorage.getItem(LEGACY_KEYS[2]))
        settings = readLegacySettings();
    } catch {
      /* A browser without local storage still works with server storage. */
    }
    if (workspace || settings) {
      state = await apiJson<ServerState>('/api/import', { workspace, settings });
      if (state.imported) {
        try {
          for (const name of LEGACY_KEYS) localStorage.removeItem(name);
        } catch {
          /* Already migrated safely. */
        }
      }
    }
  }
  return {
    workspace: state.workspace ?? { currentId: lessonSources[0].id, sources: {}, notes: [] },
    settings: state.settings,
  };
}

export function loadApplicationState() {
  if (!loading)
    loading = load().catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
  return loading;
}

/** Serialize saves so a slow earlier request cannot overwrite a newer edit. */
export function saveWorkspace(workspace: Workspace): Promise<void> {
  const write = workspaceWrites
    .catch(() => {})
    .then(async () => {
      await apiJson('/api/workspace', { workspace }, undefined, 'PUT');
    });
  workspaceWrites = write;
  return write;
}

export async function saveServerSettings(settings: ModelSettingsValue, clearApiKeys = false) {
  const result = await apiJson<{ settings: ModelSettingsValue }>(
    '/api/settings',
    { settings, clearApiKeys },
    undefined,
    'PUT',
  );
  return result.settings;
}

export async function clearServerKeys() {
  const result = await apiJson<{ settings: ModelSettingsValue }>(
    '/api/settings/keys',
    undefined,
    undefined,
    'DELETE',
  );
  return result.settings;
}

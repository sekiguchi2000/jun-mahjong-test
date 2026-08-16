// desktop-settings.js — PWAのlocalStorageとWindows版の通常セーブファイルを同期する境界
import { NO_CALLS_STORAGE_KEY } from '../ui/gameplay-controls.js?v=12';
import {
  MAX_SESSION_SNAPSHOT_JSON_BYTES,
  createSessionSnapshot,
  deserializeSessionSnapshot,
  serializeSessionSnapshot,
} from '../engine/session-snapshot.js';

const RULES_STORAGE_KEY = 'mahjong-rules';
export const REVIEW_MODE_STORAGE_KEY = 'jun-review-mode-v1';
export const THOUGHT_MODE_STORAGE_KEY = 'jun-thought-mode-v1';
export const THOUGHT_DURATION_STORAGE_KEY = 'jun-thought-duration-v1';
export const COACH_MODE_STORAGE_KEY = 'jun-coach-mode-v1';
export const AUDIO_MUTED_STORAGE_KEY = 'jun-audio-muted-v1';
export const VOICE_ENABLED_STORAGE_KEY = 'jun-voice-enabled-v1';
export const MASTER_VOLUME_STORAGE_KEY = 'jun-master-volume-v1';
export const MUSIC_VOLUME_STORAGE_KEY = 'jun-music-volume-v1';
export const VOICE_VOLUME_STORAGE_KEY = 'jun-voice-volume-v1';
export const SFX_VOLUME_STORAGE_KEY = 'jun-sfx-volume-v1';
export const ACTIVE_SESSION_STORAGE_KEY = 'jun-active-session-v1';
export const THOUGHT_DURATION_OPTIONS = Object.freeze([3, 6, 10, 15, 'manual']);
export const DEFAULT_AUDIO_PREFERENCES = Object.freeze({
  audioMuted: false,
  voiceEnabled: true,
  masterVolume: 80,
  musicVolume: 55,
  voiceVolume: 85,
  sfxVolume: 80,
});
let saveQueue = Promise.resolve();
let sessionQueue = Promise.resolve();

function bridge() {
  return globalThis.junDesktop ?? null;
}

function parseRules(storage) {
  try {
    const value = JSON.parse(storage?.getItem(RULES_STORAGE_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function readBooleanPreference(storage, key) {
  try {
    const raw = storage?.getItem(key);
    return raw === '1' || raw === 'true';
  } catch {
    return false;
  }
}

function readBooleanPreferenceWithDefault(storage, key, fallback) {
  try {
    const raw = storage?.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function normalizeVolume(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 100 ? numeric : fallback;
}

function readVolumePreference(storage, key, fallback) {
  try {
    return normalizeVolume(storage?.getItem(key), fallback);
  } catch {
    return fallback;
  }
}

export function normalizeThoughtDuration(value) {
  if (value === 'manual') return 'manual';
  const numeric = typeof value === 'number' ? value : Number(value);
  return THOUGHT_DURATION_OPTIONS.includes(numeric) ? numeric : 10;
}

function readThoughtDuration(storage) {
  try {
    return normalizeThoughtDuration(storage?.getItem(THOUGHT_DURATION_STORAGE_KEY));
  } catch {
    return 10;
  }
}

/**
 * Browser/PWA側の学習モード設定を読む。キーが存在しない旧環境では
 * どちらもfalseとなり、通常対局へ安全にフォールバックする。
 */
export function readLearningModePreferences(storage = globalThis.localStorage) {
  return {
    reviewMode: readBooleanPreference(storage, REVIEW_MODE_STORAGE_KEY),
    thoughtMode: readBooleanPreference(storage, THOUGHT_MODE_STORAGE_KEY),
    thoughtDuration: readThoughtDuration(storage),
    coachMode: readBooleanPreference(storage, COACH_MODE_STORAGE_KEY),
  };
}

/**
 * Browser/PWA側の学習モード設定を書く。UIから片方だけ更新できるよう、
 * 指定された項目だけを変更する。
 */
export function writeLearningModePreferences(storage = globalThis.localStorage, preferences = {}) {
  try {
    if (Object.prototype.hasOwnProperty.call(preferences, 'reviewMode')) {
      storage?.setItem(REVIEW_MODE_STORAGE_KEY, preferences.reviewMode === true ? '1' : '0');
    }
    if (Object.prototype.hasOwnProperty.call(preferences, 'thoughtMode')) {
      storage?.setItem(THOUGHT_MODE_STORAGE_KEY, preferences.thoughtMode === true ? '1' : '0');
    }
    if (Object.prototype.hasOwnProperty.call(preferences, 'coachMode')) {
      storage?.setItem(COACH_MODE_STORAGE_KEY, preferences.coachMode === true ? '1' : '0');
    }
    if (Object.prototype.hasOwnProperty.call(preferences, 'thoughtDuration')) {
      const normalized = normalizeThoughtDuration(preferences.thoughtDuration);
      const supplied = preferences.thoughtDuration === 'manual'
        ? 'manual'
        : typeof preferences.thoughtDuration === 'number'
          ? preferences.thoughtDuration
          : Number(preferences.thoughtDuration);
      if (normalized !== supplied) return false;
      storage?.setItem(THOUGHT_DURATION_STORAGE_KEY, String(normalized));
    }
    return true;
  } catch {
    return false;
  }
}

export function readAudioPreferences(storage = globalThis.localStorage) {
  return {
    audioMuted: readBooleanPreferenceWithDefault(storage, AUDIO_MUTED_STORAGE_KEY, DEFAULT_AUDIO_PREFERENCES.audioMuted),
    voiceEnabled: readBooleanPreferenceWithDefault(storage, VOICE_ENABLED_STORAGE_KEY, DEFAULT_AUDIO_PREFERENCES.voiceEnabled),
    masterVolume: readVolumePreference(storage, MASTER_VOLUME_STORAGE_KEY, DEFAULT_AUDIO_PREFERENCES.masterVolume),
    musicVolume: readVolumePreference(storage, MUSIC_VOLUME_STORAGE_KEY, DEFAULT_AUDIO_PREFERENCES.musicVolume),
    voiceVolume: readVolumePreference(storage, VOICE_VOLUME_STORAGE_KEY, DEFAULT_AUDIO_PREFERENCES.voiceVolume),
    sfxVolume: readVolumePreference(storage, SFX_VOLUME_STORAGE_KEY, DEFAULT_AUDIO_PREFERENCES.sfxVolume),
  };
}

export function writeAudioPreferences(storage = globalThis.localStorage, preferences = {}) {
  const normalized = {};
  for (const key of ['audioMuted', 'voiceEnabled']) {
    if (Object.prototype.hasOwnProperty.call(preferences, key)) {
      if (typeof preferences[key] !== 'boolean') return false;
      normalized[key] = preferences[key];
    }
  }
  for (const key of ['masterVolume', 'musicVolume', 'voiceVolume', 'sfxVolume']) {
    if (Object.prototype.hasOwnProperty.call(preferences, key)) {
      const value = normalizeVolume(preferences[key], null);
      if (value === null) return false;
      normalized[key] = value;
    }
  }
  try {
    const storageKeys = {
      audioMuted: AUDIO_MUTED_STORAGE_KEY,
      voiceEnabled: VOICE_ENABLED_STORAGE_KEY,
      masterVolume: MASTER_VOLUME_STORAGE_KEY,
      musicVolume: MUSIC_VOLUME_STORAGE_KEY,
      voiceVolume: VOICE_VOLUME_STORAGE_KEY,
      sfxVolume: SFX_VOLUME_STORAGE_KEY,
    };
    for (const [key, value] of Object.entries(normalized)) {
      storage?.setItem(storageKeys[key], typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
    }
    return true;
  } catch {
    return false;
  }
}

export function readDesktopSettings(storage = globalThis.localStorage) {
  let noCalls = false;
  try {
    const raw = storage?.getItem(NO_CALLS_STORAGE_KEY);
    noCalls = raw === '1' || raw === 'true';
  } catch {
    // localStorageが利用できない場合も既定値で起動する。
  }
  return {
    rules: parseRules(storage),
    preferences: { noCalls, ...readLearningModePreferences(storage), ...readAudioPreferences(storage) },
  };
}

function applyDesktopSettings(storage, settings) {
  try {
    storage?.setItem(RULES_STORAGE_KEY, JSON.stringify(settings.rules ?? {}));
    storage?.setItem(NO_CALLS_STORAGE_KEY, settings.preferences?.noCalls ? '1' : '0');
    const learningApplied = writeLearningModePreferences(storage, {
      reviewMode: settings.preferences?.reviewMode === true,
      thoughtMode: settings.preferences?.thoughtMode === true,
      thoughtDuration: normalizeThoughtDuration(settings.preferences?.thoughtDuration),
      coachMode: settings.preferences?.coachMode === true,
    });
    const audioApplied = writeAudioPreferences(storage, {
      audioMuted: settings.preferences?.audioMuted === true,
      voiceEnabled: settings.preferences?.voiceEnabled !== false,
      masterVolume: normalizeVolume(settings.preferences?.masterVolume, DEFAULT_AUDIO_PREFERENCES.masterVolume),
      musicVolume: normalizeVolume(settings.preferences?.musicVolume, DEFAULT_AUDIO_PREFERENCES.musicVolume),
      voiceVolume: normalizeVolume(settings.preferences?.voiceVolume, DEFAULT_AUDIO_PREFERENCES.voiceVolume),
      sfxVolume: normalizeVolume(settings.preferences?.sfxVolume, DEFAULT_AUDIO_PREFERENCES.sfxVolume),
    });
    return learningApplied && audioApplied;
  } catch {
    return false;
  }
}

export async function hydrateDesktopSettings(storage = globalThis.localStorage) {
  const api = bridge();
  if (!api) return { desktop: false, hydrated: false };
  try {
    const loaded = await api.loadSettings();
    if (!loaded?.ok) return { desktop: true, hydrated: false, error: loaded?.error };
    if (loaded.exists) {
      return { desktop: true, hydrated: applyDesktopSettings(storage, loaded.data.settings) };
    }
    const saved = await api.saveSettings(readDesktopSettings(storage));
    return { desktop: true, hydrated: Boolean(saved?.ok), migrated: Boolean(saved?.ok) };
  } catch (error) {
    console.warn('Desktop settings could not be loaded.', error);
    return { desktop: true, hydrated: false, error: 'DESKTOP_BRIDGE_ERROR' };
  }
}

export function persistDesktopSettings(storage = globalThis.localStorage) {
  const api = bridge();
  if (!api) return Promise.resolve({ desktop: false, saved: false });
  const settings = readDesktopSettings(storage);
  const operation = saveQueue.then(async () => {
    const result = await api.saveSettings(settings);
    if (!result?.ok) throw new Error(result?.error || 'DESKTOP_SAVE_FAILED');
    return { desktop: true, saved: true, revision: result.data.revision };
  });
  saveQueue = operation.catch(error => {
    console.warn('Desktop settings could not be saved.', error);
  });
  return operation;
}

function sessionError(error, fallback) {
  return typeof error?.code === 'string' ? error.code : fallback;
}

/**
 * Load and validate the private in-progress match. Electron uses its dedicated,
 * atomic save file; Browser/PWA uses one versioned localStorage slot.
 */
export async function loadActiveSession(storage = globalThis.localStorage) {
  const api = bridge();
  try {
    if (typeof api?.loadSession === 'function') {
      const loaded = await api.loadSession();
      if (!loaded?.ok) {
        return { desktop: true, ok: false, exists: false, error: loaded?.error || 'DESKTOP_SESSION_LOAD_FAILED' };
      }
      if (!loaded.exists) return { desktop: true, ok: true, exists: false, data: null };
      return { desktop: true, ok: true, exists: true, data: createSessionSnapshot(loaded.data) };
    }
    const raw = storage?.getItem(ACTIVE_SESSION_STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return { desktop: false, ok: true, exists: false, data: null };
    }
    return { desktop: false, ok: true, exists: true, data: deserializeSessionSnapshot(raw) };
  } catch (error) {
    return {
      desktop: typeof api?.loadSession === 'function',
      ok: false,
      exists: false,
      error: sessionError(error, 'CORRUPT_SESSION_SNAPSHOT'),
    };
  }
}

/** Save a validated snapshot, serialized behind a queue so Save/Clear ordering is deterministic. */
export function persistActiveSession(snapshot, storage = globalThis.localStorage) {
  const operation = sessionQueue.then(async () => {
    const normalized = createSessionSnapshot(snapshot);
    const api = bridge();
    if (typeof api?.saveSession === 'function') {
      const result = await api.saveSession(normalized);
      if (!result?.ok) throw Object.assign(new Error('Desktop session could not be saved.'), {
        code: result?.error || 'DESKTOP_SESSION_SAVE_FAILED',
      });
      return { desktop: true, ok: true, saved: true, byteLength: result.byteLength };
    }
    const serialized = serializeSessionSnapshot(normalized);
    const byteLength = new TextEncoder().encode(serialized).byteLength;
    if (byteLength > MAX_SESSION_SNAPSHOT_JSON_BYTES) {
      throw Object.assign(new Error('Browser session is too large.'), {
        code: 'SESSION_SNAPSHOT_TOO_LARGE',
      });
    }
    if (typeof storage?.setItem !== 'function') {
      throw Object.assign(new Error('Browser session storage is unavailable.'), {
        code: 'SESSION_STORAGE_UNAVAILABLE',
      });
    }
    storage.setItem(ACTIVE_SESSION_STORAGE_KEY, serialized);
    return { desktop: false, ok: true, saved: true, byteLength };
  });
  sessionQueue = operation.catch(() => {});
  return operation;
}

/** Clear only the resumable match; settings and completed review records are untouched. */
export function clearActiveSession(storage = globalThis.localStorage) {
  const operation = sessionQueue.then(async () => {
    const api = bridge();
    if (typeof api?.clearSession === 'function') {
      const result = await api.clearSession();
      if (!result?.ok) throw Object.assign(new Error('Desktop session could not be cleared.'), {
        code: result?.error || 'DESKTOP_SESSION_CLEAR_FAILED',
      });
      return { desktop: true, ok: true, cleared: result.cleared === true };
    }
    if (typeof storage?.getItem !== 'function' || typeof storage?.removeItem !== 'function') {
      throw Object.assign(new Error('Browser session storage is unavailable.'), {
        code: 'SESSION_STORAGE_UNAVAILABLE',
      });
    }
    const existed = storage.getItem(ACTIVE_SESSION_STORAGE_KEY) !== null;
    storage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    return { desktop: false, ok: true, cleared: existed };
  });
  sessionQueue = operation.catch(() => {});
  return operation;
}

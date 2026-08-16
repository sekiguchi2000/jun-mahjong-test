// audio-director.js — offline音源だけを扱うUI音響境界
//
// ゲーム状態は音声の成否に依存しない。音源のdecode/playが失敗しても
// すべての公開APIは失敗結果へ縮退し、対局進行へ例外を漏らさない。

export const AUDIO_BUSES = Object.freeze(['master', 'music', 'voice', 'sfx']);

export const DEFAULT_AUDIO_SETTINGS = Object.freeze({
  audioMuted: false,
  voiceEnabled: true,
  masterVolume: 80,
  musicVolume: 55,
  voiceVolume: 85,
  sfxVolume: 80,
});

const MANIFEST_SECTIONS = Object.freeze({ music: 'bgm', voice: 'voice', sfx: 'sfx' });
const REMOTE_SOURCE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function volumeValue(value, fallback = 100) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(clamp(numeric, 0, 100)) : fallback;
}

function gainValue(value, fallback = 1) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? clamp(numeric, 0, 1) : fallback;
}

function result(ok, fields = {}) {
  return Object.freeze({ ok, ...fields });
}

function asError(error, message = 'Audio backend failed') {
  if (error instanceof Error) return error;
  return new Error(error == null ? message : String(error));
}

function normalizeManifest(manifest) {
  const source = manifest && typeof manifest === 'object' ? manifest : {};
  const normalized = {};
  for (const section of Object.values(MANIFEST_SECTIONS)) {
    const entries = source[section] && typeof source[section] === 'object'
      ? source[section]
      : {};
    normalized[section] = Object.freeze({ ...entries });
  }
  return Object.freeze(normalized);
}

function normalizeAsset(entry, id, bus) {
  const value = typeof entry === 'string' ? { src: entry } : entry;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new TypeError(`Audio asset ${id} is invalid`), { code: 'INVALID_AUDIO_ASSET' });
  }
  const src = value.src;
  if (typeof src !== 'string' || src.trim() === '') {
    throw Object.assign(new TypeError(`Audio asset ${id} has no local source`), { code: 'INVALID_AUDIO_SOURCE' });
  }
  const cleanSource = src.trim();
  const pathOnly = cleanSource.split(/[?#]/, 1)[0];
  if (REMOTE_SOURCE.test(cleanSource) || cleanSource.startsWith('\\\\') ||
      pathOnly.split(/[\\/]/).includes('..')) {
    throw Object.assign(new TypeError(`Audio asset ${id} must be bundled locally`), {
      code: 'EXTERNAL_AUDIO_FORBIDDEN',
    });
  }
  return Object.freeze({
    ...value,
    id,
    bus,
    src: cleanSource,
    gain: gainValue(value.gain, 1),
  });
}

/**
 * Default browser implementation. The injectable backend contract is intentionally
 * small: unlock(), createPlayback(asset, { loop, onEnded, onError }) and a playback
 * handle exposing play/pause/stop/setVolume. Tests and future native adapters can
 * implement the same boundary without DOM or network access.
 */
export class BrowserAudioBackend {
  constructor({
    AudioCtor = globalThis.Audio,
    AudioContextCtor = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  } = {}) {
    this.AudioCtor = AudioCtor;
    this.AudioContextCtor = AudioContextCtor;
    this.context = null;
  }

  async unlock() {
    if (!this.AudioContextCtor) return true;
    this.context ??= new this.AudioContextCtor();
    if (this.context.state === 'suspended') await this.context.resume();
    return this.context.state !== 'suspended';
  }

  createPlayback(asset, { loop = false, onEnded = () => {}, onError = () => {} } = {}) {
    if (typeof this.AudioCtor !== 'function') {
      throw Object.assign(new Error('HTML Audio is unavailable'), { code: 'AUDIO_UNAVAILABLE' });
    }
    const media = new this.AudioCtor();
    let stopped = false;
    const ended = () => { if (!stopped) onEnded(); };
    const failed = () => {
      if (!stopped) onError(Object.assign(new Error(`Could not decode ${asset.id}`), {
        code: 'AUDIO_DECODE_FAILED',
      }));
    };
    media.preload = 'auto';
    media.loop = Boolean(loop);
    media.src = asset.src;
    media.addEventListener?.('ended', ended);
    media.addEventListener?.('error', failed);

    return {
      play: () => Promise.resolve(media.play?.()),
      pause: () => media.pause?.(),
      stop: () => {
        stopped = true;
        media.pause?.();
        try { media.currentTime = 0; } catch { /* metadata未読でも停止は成立 */ }
        media.removeEventListener?.('ended', ended);
        media.removeEventListener?.('error', failed);
        media.removeAttribute?.('src');
        media.load?.();
      },
      setVolume: value => { media.volume = clamp(Number(value) || 0, 0, 1); },
    };
  }

  dispose() {
    const context = this.context;
    this.context = null;
    try {
      const closing = context?.close?.();
      closing?.catch?.(() => {});
    } catch { /* AudioContext終了失敗もアプリ終了を妨げない */ }
  }
}

export class AudioDirector {
  constructor({
    backend = new BrowserAudioBackend(),
    manifest = {},
    settings = {},
    duckGain = 0.35,
    onError = () => {},
    document = globalThis.document ?? null,
  } = {}) {
    this.backend = backend;
    this.manifest = normalizeManifest(manifest);
    this.volumes = {
      master: volumeValue(settings.masterVolume, DEFAULT_AUDIO_SETTINGS.masterVolume),
      music: volumeValue(settings.musicVolume, DEFAULT_AUDIO_SETTINGS.musicVolume),
      voice: volumeValue(settings.voiceVolume, DEFAULT_AUDIO_SETTINGS.voiceVolume),
      sfx: volumeValue(settings.sfxVolume, DEFAULT_AUDIO_SETTINGS.sfxVolume),
    };
    this.muted = settings.audioMuted === true;
    this.voiceEnabled = settings.voiceEnabled !== false;
    this.duckGain = gainValue(duckGain, 0.35);
    this.onError = typeof onError === 'function' ? onError : () => {};
    this.unlocked = false;
    this.unlockPromise = null;
    this.suspendReasons = new Set();
    this.musicTrack = null;
    this.voiceTrack = null;
    this.sfxTracks = new Set();
    this.voicePending = null;
    this.musicToken = 0;
    this.voiceToken = 0;
    this.epoch = 0;
    this.ducking = false;
    this.disposed = false;
    this.lastError = null;
    this.document = document;
    this.boundVisibility = () => { void this.setVisibility(Boolean(this.document?.hidden)); };
    this.document?.addEventListener?.('visibilitychange', this.boundVisibility);
    if (this.document?.hidden) this.suspendReasons.add('visibility');
  }

  setManifest(manifest) {
    this.manifest = normalizeManifest(manifest);
    return this.manifest;
  }

  getState() {
    return Object.freeze({
      volumes: Object.freeze({ ...this.volumes }),
      audioMuted: this.muted,
      voiceEnabled: this.voiceEnabled,
      unlocked: this.unlocked,
      ducking: this.ducking,
      suspended: this.suspendReasons.size > 0,
      suspendReasons: Object.freeze([...this.suspendReasons].sort()),
      active: Object.freeze({
        bgm: this.musicTrack?.id ?? null,
        voice: this.voiceTrack?.id ?? null,
        sfx: this.sfxTracks.size,
      }),
    });
  }

  getSettings() {
    return Object.freeze({
      audioMuted: this.muted,
      voiceEnabled: this.voiceEnabled,
      masterVolume: this.volumes.master,
      musicVolume: this.volumes.music,
      voiceVolume: this.volumes.voice,
      sfxVolume: this.volumes.sfx,
    });
  }

  setBusVolume(bus, value) {
    if (!AUDIO_BUSES.includes(bus)) throw new RangeError(`Unknown audio bus: ${bus}`);
    const normalized = volumeValue(value, this.volumes[bus] ?? 100);
    this.volumes[bus] = normalized;
    this._applyAllVolumes();
    return normalized;
  }

  setMuted(muted) {
    this.muted = muted === true;
    this._applyAllVolumes();
    return this.muted;
  }

  setVoiceEnabled(enabled) {
    this.voiceEnabled = enabled !== false;
    if (!this.voiceEnabled) this.stopVoice('voice-disabled');
    this._applyAllVolumes();
    return this.voiceEnabled;
  }

  async unlock() {
    if (this.disposed) return result(false, { reason: 'DISPOSED' });
    if (this.unlocked) return result(true, { alreadyUnlocked: true });
    if (this.unlockPromise) return this.unlockPromise;
    this.unlockPromise = (async () => {
      try {
        const unlocked = typeof this.backend?.unlock === 'function'
          ? await this.backend.unlock()
          : true;
        if (unlocked === false) throw Object.assign(new Error('Audio backend stayed locked'), {
          code: 'AUDIO_UNLOCK_REJECTED',
        });
        this.unlocked = true;
        await this._startEligibleTracks();
        return result(true);
      } catch (error) {
        this._report(error, { phase: 'unlock' });
        return result(false, { reason: error?.code ?? 'AUDIO_UNLOCK_FAILED' });
      } finally {
        this.unlockPromise = null;
      }
    })();
    return this.unlockPromise;
  }

  async playBgm(id, options = {}) {
    if (this.disposed) return result(false, { reason: 'DISPOSED' });
    const asset = this._asset('music', id);
    if (!asset) return result(false, { reason: 'ASSET_UNAVAILABLE', id });
    if (this.musicTrack?.id === id && options.restart !== true) {
      return result(true, { id, alreadyPlaying: true, queued: !this.musicTrack.running });
    }

    const token = ++this.musicToken;
    const epoch = this.epoch;
    this._stopTrack(this.musicTrack, 'replaced');
    let track;
    try {
      track = await this._makeTrack(asset, 'music', {
        loop: options.loop ?? asset.loop ?? true,
        token,
      });
    } catch (error) {
      this._report(error, { phase: 'create', bus: 'music', id });
      return result(false, { reason: error?.code ?? 'AUDIO_CREATE_FAILED', id });
    }
    if (this.disposed || epoch !== this.epoch || token !== this.musicToken) {
      this._disposeHandle(track.handle, 'superseded');
      return result(false, { reason: 'SUPERSEDED', id });
    }
    this.musicTrack = track;
    const started = await this._startTrack(track);
    return result(started !== false, { id, queued: started === null });
  }

  async playVoice(id, options = {}) {
    if (this.disposed) return result(false, { reason: 'DISPOSED' });
    if (!this.voiceEnabled) return result(false, { reason: 'VOICE_DISABLED', id });
    const asset = this._asset('voice', id);
    if (!asset) return result(false, { reason: 'ASSET_UNAVAILABLE', id });
    const critical = options.critical === true || asset.critical === true;
    if ((this.voiceTrack || this.voicePending) && !critical) {
      return result(false, { reason: 'VOICE_BUSY', id });
    }

    const token = ++this.voiceToken;
    const epoch = this.epoch;
    if (critical) this._stopTrack(this.voiceTrack, 'critical-preempt');
    this.voicePending = { token, critical };
    let track;
    try {
      track = await this._makeTrack(asset, 'voice', { loop: false, token, critical });
    } catch (error) {
      if (token === this.voiceToken) this.voicePending = null;
      this._report(error, { phase: 'create', bus: 'voice', id });
      return result(false, { reason: error?.code ?? 'AUDIO_CREATE_FAILED', id });
    }
    if (this.disposed || epoch !== this.epoch || token !== this.voiceToken) {
      this._disposeHandle(track.handle, 'superseded');
      return result(false, { reason: 'SUPERSEDED', id });
    }
    this.voicePending = null;
    this.voiceTrack = track;
    const started = await this._startTrack(track);
    return result(started !== false, { id, critical, queued: started === null });
  }

  async playSfx(id, options = {}) {
    if (this.disposed) return result(false, { reason: 'DISPOSED' });
    const asset = this._asset('sfx', id);
    if (!asset) return result(false, { reason: 'ASSET_UNAVAILABLE', id });
    const epoch = this.epoch;
    let track;
    try {
      track = await this._makeTrack(asset, 'sfx', {
        loop: options.loop === true,
        token: null,
      });
    } catch (error) {
      this._report(error, { phase: 'create', bus: 'sfx', id });
      return result(false, { reason: error?.code ?? 'AUDIO_CREATE_FAILED', id });
    }
    if (this.disposed || epoch !== this.epoch) {
      this._disposeHandle(track.handle, 'superseded');
      return result(false, { reason: 'SUPERSEDED', id });
    }
    this.sfxTracks.add(track);
    const started = await this._startTrack(track);
    return result(started !== false, { id, queued: started === null });
  }

  stopBgm(reason = 'user') {
    this.musicToken++;
    this._stopTrack(this.musicTrack, reason);
  }

  stopVoice(reason = 'user') {
    this.voiceToken++;
    this.voicePending = null;
    this._stopTrack(this.voiceTrack, reason);
  }

  stopAll(reason = 'user') {
    this.epoch++;
    this.stopBgm(reason);
    this.stopVoice(reason);
    for (const track of [...this.sfxTracks]) this._stopTrack(track, reason);
  }

  suspend(reason = 'pause') {
    const normalized = this._reason(reason);
    const wasSuspended = this.suspendReasons.size > 0;
    this.suspendReasons.add(normalized);
    if (!wasSuspended) {
      for (const track of this._tracks()) this._pauseTrack(track);
    }
    return this.getState();
  }

  pause(reason = 'pause') {
    return this.suspend(reason);
  }

  async resume(reason = 'pause') {
    const normalized = this._reason(reason);
    this.suspendReasons.delete(normalized);
    if (this.suspendReasons.size === 0 && this.unlocked) await this._startEligibleTracks();
    return this.getState();
  }

  setPaused(paused) {
    return paused ? Promise.resolve(this.suspend('pause')) : this.resume('pause');
  }

  setVisibility(hidden) {
    return hidden ? Promise.resolve(this.suspend('visibility')) : this.resume('visibility');
  }

  dispose() {
    if (this.disposed) return;
    this.document?.removeEventListener?.('visibilitychange', this.boundVisibility);
    this.stopAll('dispose');
    this.disposed = true;
    try { this.backend?.dispose?.(); } catch (error) { this._report(error, { phase: 'dispose' }); }
  }

  _reason(reason) {
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new TypeError('Audio suspension reason must be a non-empty string');
    }
    return reason.trim();
  }

  _asset(bus, id) {
    try {
      if (!Object.hasOwn(MANIFEST_SECTIONS, bus)) throw new RangeError(`Unknown asset bus: ${bus}`);
      if (typeof id !== 'string' || id.trim() === '') throw new TypeError('Audio asset id is required');
      const section = MANIFEST_SECTIONS[bus];
      if (!Object.hasOwn(this.manifest[section], id)) {
        throw Object.assign(new Error(`Audio asset not found: ${id}`), { code: 'AUDIO_ASSET_NOT_FOUND' });
      }
      return normalizeAsset(this.manifest[section][id], id, bus);
    } catch (error) {
      this._report(error, { phase: 'manifest', bus, id });
      return null;
    }
  }

  async _makeTrack(asset, bus, { loop, token, critical = false }) {
    if (typeof this.backend?.createPlayback !== 'function') {
      throw Object.assign(new Error('Audio backend has no createPlayback()'), { code: 'INVALID_AUDIO_BACKEND' });
    }
    let track = null;
    let earlyError = null;
    const handle = await this.backend.createPlayback(asset, {
      loop,
      onEnded: () => { if (track) this._endTrack(track); },
      onError: error => {
        if (track) this._failTrack(track, error, 'decode');
        else earlyError = error;
      },
    });
    if (!handle || typeof handle.play !== 'function') {
      throw Object.assign(new Error('Audio backend returned an invalid playback'), {
        code: 'INVALID_AUDIO_PLAYBACK',
      });
    }
    track = {
      id: asset.id,
      asset,
      bus,
      handle,
      token,
      critical,
      loop: Boolean(loop),
      running: false,
      stopped: false,
    };
    this._setTrackVolume(track);
    if (earlyError) {
      this._disposeHandle(handle, 'decode-failed');
      throw asError(earlyError, `Could not decode ${asset.id}`);
    }
    return track;
  }

  async _startTrack(track) {
    if (!track || track.stopped) return false;
    if (!this.unlocked || this.suspendReasons.size > 0) return null;
    if (track.running) return true;
    if (track.bus === 'voice') this._setDucking(true);
    this._setTrackVolume(track);
    track.running = true;
    try {
      await track.handle.play();
      return track.stopped ? false : true;
    } catch (error) {
      track.running = false;
      this._failTrack(track, error, 'play');
      return false;
    }
  }

  _pauseTrack(track) {
    if (!track || track.stopped || !track.running) return;
    track.running = false;
    try { track.handle.pause?.(); } catch (error) {
      this._report(error, { phase: 'pause', bus: track.bus, id: track.id });
    }
  }

  _stopTrack(track, reason) {
    if (!track || track.stopped) return;
    track.stopped = true;
    track.running = false;
    this._unlinkTrack(track);
    this._disposeHandle(track.handle, reason);
    if (track.bus === 'voice') this._setDucking(false);
  }

  _endTrack(track) {
    if (!track || track.stopped) return;
    track.stopped = true;
    track.running = false;
    this._unlinkTrack(track);
    if (track.bus === 'voice') this._setDucking(false);
  }

  _failTrack(track, error, phase) {
    if (!track || track.stopped) return;
    this._report(error, { phase, bus: track?.bus, id: track?.id });
    this._stopTrack(track, `${phase}-failed`);
  }

  _unlinkTrack(track) {
    if (this.musicTrack === track) this.musicTrack = null;
    if (this.voiceTrack === track) this.voiceTrack = null;
    this.sfxTracks.delete(track);
  }

  _disposeHandle(handle, reason) {
    try { handle?.stop?.(reason); } catch (error) { this._report(error, { phase: 'stop' }); }
  }

  _tracks() {
    return [this.musicTrack, this.voiceTrack, ...this.sfxTracks].filter(Boolean);
  }

  async _startEligibleTracks() {
    if (!this.unlocked || this.suspendReasons.size > 0 || this.disposed) return;
    // voiceを先に開始してduck状態を確定させ、BGMの一瞬の音量跳ねを防ぐ。
    const ordered = [this.voiceTrack, this.musicTrack, ...this.sfxTracks].filter(Boolean);
    await Promise.all(ordered.map(track => this._startTrack(track)));
  }

  _setDucking(active) {
    const next = active === true && Boolean(this.voiceTrack) && !this.voiceTrack.stopped;
    if (next === this.ducking) return;
    this.ducking = next;
    if (this.musicTrack) this._setTrackVolume(this.musicTrack);
  }

  _effectiveVolume(track) {
    if (this.muted) return 0;
    if (track.bus === 'voice' && !this.voiceEnabled) return 0;
    const master = this.volumes.master / 100;
    const bus = this.volumes[track.bus] / 100;
    const duck = track.bus === 'music' && this.ducking ? this.duckGain : 1;
    return clamp(master * bus * track.asset.gain * duck, 0, 1);
  }

  _setTrackVolume(track) {
    if (!track || track.stopped) return;
    try { track.handle.setVolume?.(this._effectiveVolume(track)); } catch (error) {
      this._report(error, { phase: 'volume', bus: track.bus, id: track.id });
    }
  }

  _applyAllVolumes() {
    for (const track of this._tracks()) this._setTrackVolume(track);
  }

  _report(error, context) {
    const normalized = asError(error);
    this.lastError = Object.freeze({
      code: typeof normalized.code === 'string' ? normalized.code : 'AUDIO_BACKEND_ERROR',
      message: normalized.message,
      ...context,
    });
    try { this.onError(normalized, this.lastError); } catch { /* 診断callbackも進行を止めない */ }
  }
}

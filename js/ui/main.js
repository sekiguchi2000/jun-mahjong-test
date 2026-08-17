// main.js — UIと人間プレイヤーの接続 (卓レイアウト版)
import { makeRules, RULE_SCHEMA } from '../engine/rules.js';
import {
  Game, GameCancelledError, availableAnkanKinds, availableKakanKinds,
} from '../engine/game.js?v=18';
import { ComActor } from '../engine/ai.js?v=18';
import { canDeclareRiichi } from '../engine/legal-actions.js';
import { createDealerCeremony } from '../engine/opening-dealer.js?v=17';
import { buildRoundReview } from '../engine/review-evaluator.js?v=18';
import { toCounts, suitOf, tileName } from '../engine/tiles.js';
import { svgFace } from './tilesvg.js?v=10';
import { concealedTileCuboid } from './tile-cuboid.js?v=2';
import { createTabletopPlacement, decorateMeldSlot } from './tabletop-projection.js?v=1';
import { WebGLTabletopRenderer } from './webgl-tabletop.js?v=4';
import { shanten } from '../engine/shanten.js';
import {
  loadNoCallsPreference, remainingCopies, saveNoCallsPreference,
  shouldSuppressClaim, waitKindsForHand,
} from './gameplay-controls.js?v=12';
import {
  clearActiveSession,
  hydrateDesktopSettings,
  loadActiveSession,
  normalizeThoughtDuration,
  persistActiveSession,
  persistDesktopSettings,
  readAudioPreferences,
  readLearningModePreferences,
  writeAudioPreferences,
  writeLearningModePreferences,
} from '../platform/desktop-settings.js?v=17';
import { presentReviewDecision, presentThought } from './decision-presenter.js?v=17';
import { buildTurnCoaching, buildClaimCoaching } from '../engine/decision-coach.js?v=4';
import { areReportCount, captureAreReport, exportAreReports } from './are-report.js?v=1';
import { StatsTracker, loadGameRecords, summarizeStats, clearGameRecords } from './stats-store.js?v=1';
import { GAMEPAD_EVENTS, installGamepadController } from './gamepad-controller.js?v=17';
import { AudioDirector } from './audio-director.js?v=17';
import { classifyWinPresentation, winCinematicCopy, winSuspenseDuration } from './win-presentation.js?v=3';
import {
  AUDIO_MANIFEST, CHARACTER_AUDIO_IDS, selectThoughtVoiceId,
} from './audio-manifest.js?v=17';

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============ ルール設定 ============
function loadRulesOverrides() {
  try { return JSON.parse(localStorage.getItem('mahjong-rules') || '{}'); } catch { return {}; }
}
function loadRules() { return makeRules(loadRulesOverrides()); }
function saveRules(overrides) {
  localStorage.setItem('mahjong-rules', JSON.stringify(overrides));
  void persistDesktopSettings(localStorage);
}

function renderRulesScreen() {
  const list = $('#rules-list');
  list.innerHTML = '';
  const current = loadRules();
  for (const item of RULE_SCHEMA) {
    const row = document.createElement('div');
    row.className = 'rule-item';
    const label = document.createElement('label');
    label.textContent = item.label;
    row.appendChild(label);
    if (item.type === 'bool') {
      const btn = document.createElement('button');
      const paint = () => {
        btn.className = 'toggle' + (current[item.key] ? ' on' : '');
        btn.textContent = current[item.key] ? 'あり' : 'なし';
      };
      paint();
      btn.onclick = () => {
        current[item.key] = !current[item.key];
        const now = loadRulesOverrides();
        now[item.key] = current[item.key];
        saveRules(now);
        paint();
      };
      row.appendChild(btn);
    } else {
      const sel = document.createElement('select');
      for (const [val, name] of item.options) {
        const opt = document.createElement('option');
        opt.value = JSON.stringify(val);
        opt.textContent = name;
        if (JSON.stringify(current[item.key]) === JSON.stringify(val)) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.onchange = () => {
        const now = loadRulesOverrides();
        now[item.key] = JSON.parse(sel.value);
        saveRules(now);
      };
      row.appendChild(sel);
    }
    list.appendChild(row);
  }
}

// ============ 牌の描画 (本格SVG牌面) ============
function tileEl(t, opts = {}) {
  const el = document.createElement('div');
  el.className = `tile ${suitOf(t.kind)}` + (t.red ? ' red' : '') + (opts.mini ? ' mini' : '');
  el.dataset.kind = String(t.kind);
  el.dataset.tile = tileName(t.kind);
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', `${t.red ? '赤' : ''}${tileName(t.kind)}`);
  el.innerHTML = svgFace(t.kind, t.red);
  if (opts.riichi) el.classList.add('riichi-tile');
  if (opts.riichiFollowup) el.classList.add('riichi-followup');
  if (opts.tsumogiri) el.classList.add('tsumogiri');
  return el;
}

const COACH_TILE_WORDS = new RegExp(
  Array.from({ length: 34 }, (_, kind) => tileName(kind))
    .concat(['赤5萬', '赤5筒', '赤5索'])
    .sort((left, right) => right.length - left.length)
    .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'g',
);

function coachActionTiles(action, view, offer) {
  if (!action) return offer?.tile ? [offer.tile] : [];
  if (action.action === 'discard' && Number.isInteger(action.index)) {
    const hand = [...(view?.hand ?? []), ...(view?.drawn ? [view.drawn] : [])];
    return hand[action.index] ? [hand[action.index]] : [];
  }
  if (Array.isArray(action.tiles) && action.tiles.length > 0) {
    return action.tiles.map(tile => Number.isInteger(tile) ? { kind: tile, red: false } : tile)
      .filter(tile => tile?.kind !== undefined);
  }
  return offer?.tile ? [offer.tile] : [];
}

function coachActionCaption(action) {
  if (action?.action === 'discard') return action.riichi ? 'この牌でリーチする' : 'この牌を切る';
  if (action?.action === 'ron') return 'ロンする';
  if (action?.action === 'tsumo') return 'ツモあがりする';
  if (action?.action === 'pon') return 'ポンする';
  if (action?.action === 'chi') return 'チーする';
  if (action?.action === 'minkan' || action?.action === 'kakan' || action?.action === 'ankan') return 'カンする';
  return '今回は見送る';
}

function coachCopy(text) {
  // v12.7まで牌名を「この牌」へ置換していたが、意図ベースの解説(伸ばしたい形・
  // 受け入れ・安全根拠)は複数の牌を名指しするため、名前をそのまま表示する
  return String(text ?? '');
}

function coachProgressSentence(metrics) {
  const shanten = metrics?.shanten;
  const ukeire = metrics?.ukeirePhysical;
  const distance = shanten === 0
    ? 'すでにテンパイです'
    : shanten === 1
      ? 'あと一つ、必要な形がそろえばテンパイです'
      : Number.isInteger(shanten)
        ? `テンパイまで、あと${shanten}回は形を進める必要があります`
        : '手の進み方を比べています';
  return Number.isFinite(ukeire)
    ? `${distance}。次に引いて手が前に進む牌は${ukeire}枚です。`
    : distance;
}
function backTileEl(mini = false) {
  const el = document.createElement('div');
  el.className = 'tile back' + (mini ? ' mini' : '');
  el.setAttribute('aria-hidden', 'true');
  return el;
}
// 副露の表示: 鳴いた牌を「誰から鳴いたか」の方向に横向きで置く
// (上家から=左端 / 対面から=2枚目 / 下家から=右端)
function meldEl(m, mini = false, owner = null) {
  const box = document.createElement('div');
  box.className = 'meld';
  box.style.display = 'flex';
  box.style.gap = '1px';
  box.style.alignItems = 'center';
  if (m.type === 'ankan') {
    box.appendChild(backTileEl(mini));
    box.appendChild(tileEl(m.tiles[1], { mini }));
    box.appendChild(tileEl(m.tiles[2], { mini }));
    box.appendChild(backTileEl(mini));
    return box;
  }
  const tiles = m.tiles.slice();
  const claimed = tiles.pop(); // 末尾が他家から鳴いた牌
  const added = m.kanOrigin === 'kakan'
    ? tiles.find(tile => tile.id === m.addedTileId) ?? null
    : null;
  const standingTiles = added ? tiles.filter(tile => tile !== added) : tiles;
  standingTiles.sort((a, b) => a.kind - b.kind);
  let pos = 0;
  if (owner !== null && m.from !== undefined) {
    const rel = (m.from - owner + 4) % 4; // 1=下家 2=対面 3=上家
    pos = rel === 3 ? 0 : rel === 2 ? 1 : tiles.length;
  }
  const seq = [...standingTiles.slice(0, pos), { ...claimed, __side: true }, ...standingTiles.slice(pos)];
  for (const t of seq) {
    const el = tileEl(t, { mini });
    if (t.__side) el.classList.add('sideways');
    if (t.__side && added) {
      const flatAdded = tileEl(added, { mini });
      flatAdded.classList.add('sideways', 'kakan-added');
      el.appendChild(flatAdded);
      el.classList.add('kakan-base');
    }
    box.appendChild(el);
  }
  return box;
}

// 卓上の副露だけは回転後の占有寸法を持つslotへ入れる。
// 左右家の副露を単にabsolute配置すると、手牌から離れて河へ浮くため禁止。
function boardMeldEl(m, mini = false, owner = null, meldIndex = 0) {
  const slot = document.createElement('div');
  slot.className = 'meld-slot';
  const seat = owner ?? 0;
  decorateMeldSlot(slot, seat, meldIndex);
  const meld = meldEl(m, mini, owner);
  const tiles = [...meld.children];
  meld.replaceChildren();
  tiles.forEach((tile, tileIndex) => {
    const tileId = tile.classList.contains('kakan-base')
      ? `seat${seat}:meld${meldIndex}:kakan-base:${m.addedTileId}`
      : m.tiles?.[tileIndex]?.id ?? `seat${seat}:meld${meldIndex}:tile${tileIndex}`;
    const placement = createTabletopPlacement(tile, {
      seat,
      zone: 'meld',
      stableKey: {
        tileId,
        discardSerial: (meldIndex * 5) + tileIndex,
        meldIndex,
      },
      sideways: tile.classList.contains('sideways'),
    });
    meld.appendChild(placement);
  });
  slot.appendChild(meld);
  return slot;
}

// ============ 人間アクター ============
class HumanActor {
  constructor(ui) { this.ui = ui; this.isHuman = true; }
  async onTurn(view, options) {
    if (view.riichi && !options.includes('tsumo') && !options.includes('ankan')) {
      // リーチ中: ツモ牌を一拍見せてからツモ切り(いきなり河に飛ばない)
      return this.ui.riichiAutoTurn(view);
    }
    return this.ui.promptTurn(view, options);
  }
  async onClaim(view, offer) {
    if (shouldSuppressClaim(this.ui.noCalls, offer)) {
      this.ui.syncWaitHint();
      return { action: 'pass', source: 'autoPreference' };
    }
    return this.ui.promptClaim(view, offer);
  }
}

class PacedCom extends ComActor {
  constructor(name, profile, ui) {
    super(name, profile);
    this.ui = ui;
  }

  // 思考間も性格の一部。半蔵は慎重、ジョーは一定、ひめ子は即断型。
  async onTurn(view, options) {
    if (location.search.includes('qa-fast')) return super.onTurn(view, options);
    const pace = {
      guardian: [1050, 520],
      analyst: [760, 360],
      striker: [470, 300],
    }[this.profile] || [760, 360];
    await (this.ui?.pauseAwareDelay(pace[0] + Math.random() * pace[1]) ?? sleep(pace[0]));
    return super.onTurn(view, options);
  }
  async onClaim(view, offer) {
    const ans = await super.onClaim(view, offer);
    if (location.search.includes('qa-fast')) return ans;
    if (ans) await (this.ui?.pauseAwareDelay(500) ?? sleep(500));
    return ans;
  }
}

// ============ UI本体 ============
const WIND_NAMES = ['東', '南', '西', '北'];
const SEAT_LABELS = ['あなた', '半蔵', 'ジョー', 'ひめ子'];
const SEAT_TAGLINES = ['あなたの手番', '守備型・危険牌を切らない', '効率型・受入枚数を最大化', '攻撃型・鳴いて速度を上げる'];
const COM_PROFILES = [null, 'guardian', 'analyst', 'striker'];

class UI {
  constructor() {
    this.myHand = [];
    this.myDrawn = null;
    this.game = null;
    this.lastDiscardPlayer = -1;
    this.lastDiscardRef = null;
    this.tabletopDrawnSeat = null;
    this.tabletopKakanPreview = null;
    this.pendingClaimPass = null;
    try { this.preferenceStorage = window.localStorage; } catch { this.preferenceStorage = null; }
    this.audio = new AudioDirector({
      manifest: AUDIO_MANIFEST,
      settings: readAudioPreferences(this.preferenceStorage),
      document,
      onError: (error, context) => console.warn('Audio fell back without stopping the match.', context, error),
    });
    this.noCalls = loadNoCallsPreference(this.preferenceStorage);
    const learningModes = readLearningModePreferences(this.preferenceStorage);
    this.reviewMode = learningModes.reviewMode;
    this.thoughtMode = learningModes.thoughtMode;
    this.coachMode = learningModes.coachMode;
    this.thoughtDuration = learningModes.thoughtDuration;
    this.thoughtSequence = 0;
    this.stats = new StatsTracker();
    this.calloutSequence = 0;
    this.riichiStickSequence = 0;
    this.winCinematicSequence = 0;
    this.roundAnalyses = new Map();
    this.reviewCursor = 0;
    this.currentReview = null;
    this.paused = false;
    this.pauseChangeListeners = new Set();
    this.cancelListeners = new Set();
    this.activeThoughtFinish = null;
    this.activeThoughtDetail = null;
    this.activeCoachDetail = null;
    this.latestCoachResult = null;
    this.latestCoachContext = { view: null, offer: null };
    this.coachCollapsed = false;
    this.finishThoughtOnResume = false;
    this.activeRiichiCancel = null;
    this.activeHandBack = null;
    this.savedSession = null;
    this.sessionLoadError = null;
    this.pauseSaving = false;
    this.runSerial = 0;
    this.webglTabletop = new WebGLTabletopRenderer({ container: $('#webgl-tabletop') });
    this.webglTabletopReady = this.webglTabletop.init().then(() => {
      const stage = $('#webgl-tabletop');
      if (stage?.dataset.ready === 'true') {
        $('#board')?.classList.add('webgl-tabletop-active');
        if (this.lastState) this.renderWebGLTabletop(this.lastState);
      }
    }).catch(error => {
      console.error('The WebGL tabletop could not be initialized; DOM fallback remains active.', error);
    });
    this.initNoCallsControl();
    this.initLearningModeControls();
    this.initAudioControls();
    this.initThoughtDetailControls();
    this.initCoachDetailControls();
    this.initCoachControls();
    this.initPauseControls();
    this.initGamepadEvents();
  }

  initNoCallsControl() {
    const control = $('#no-claims-control');
    const toggle = $('#no-claims-toggle');
    const pauseToggle = $('#pause-no-calls-toggle');
    const apply = value => {
      this.noCalls = value === true;
      saveNoCallsPreference(this.preferenceStorage, this.noCalls);
      if (toggle) toggle.checked = this.noCalls;
      if (pauseToggle) pauseToggle.checked = this.noCalls;
      if (control) control.dataset.state = this.noCalls ? 'success' : 'default';
      void persistDesktopSettings(this.preferenceStorage);
      if (this.noCalls && this.pendingClaimPass) this.pendingClaimPass();
    };
    this.applyNoCallsPreference = apply;
    if (toggle) toggle.addEventListener('change', () => apply(toggle.checked));
    if (pauseToggle) pauseToggle.addEventListener('change', () => apply(pauseToggle.checked));
    if (toggle) toggle.checked = this.noCalls;
    if (pauseToggle) pauseToggle.checked = this.noCalls;
    if (control) control.dataset.state = this.noCalls ? 'success' : 'default';
  }

  initLearningModeControls() {
    const sync = () => {
      for (const id of ['review-mode-toggle', 'pause-review-toggle']) {
        const control = $(`#${id}`);
        if (control) control.checked = this.reviewMode;
      }
      for (const id of ['thought-mode-toggle', 'pause-thought-toggle']) {
        const control = $(`#${id}`);
        if (control) control.checked = this.thoughtMode;
      }
      for (const id of ['coach-mode-toggle', 'pause-coach-toggle']) {
        const control = $(`#${id}`);
        if (control) control.checked = this.coachMode;
      }
      for (const id of ['thought-duration-select', 'pause-thought-duration']) {
        const control = $(`#${id}`);
        if (control) control.value = String(this.thoughtDuration);
      }
    };
    const commit = changes => {
      if (Object.prototype.hasOwnProperty.call(changes, 'reviewMode')) {
        this.reviewMode = changes.reviewMode === true;
      }
      if (Object.prototype.hasOwnProperty.call(changes, 'thoughtMode')) {
        this.thoughtMode = changes.thoughtMode === true;
        this.finishThoughtOnResume = !this.thoughtMode && this.paused && Boolean(this.activeThoughtFinish);
        if (!this.thoughtMode && !this.paused) this.activeThoughtFinish?.('disabled');
      }
      if (Object.prototype.hasOwnProperty.call(changes, 'coachMode')) {
        this.coachMode = changes.coachMode === true;
        if (!this.coachMode) this.hideCoach();
      }
      if (Object.prototype.hasOwnProperty.call(changes, 'thoughtDuration')) {
        this.thoughtDuration = normalizeThoughtDuration(changes.thoughtDuration);
      }
      writeLearningModePreferences(this.preferenceStorage, {
        reviewMode: this.reviewMode,
        thoughtMode: this.thoughtMode,
        coachMode: this.coachMode,
        thoughtDuration: this.thoughtDuration,
      });
      void persistDesktopSettings(this.preferenceStorage);
      sync();
    };
    for (const [id, property] of [
      ['review-mode-toggle', 'reviewMode'],
      ['pause-review-toggle', 'reviewMode'],
      ['thought-mode-toggle', 'thoughtMode'],
      ['pause-thought-toggle', 'thoughtMode'],
      ['coach-mode-toggle', 'coachMode'],
      ['pause-coach-toggle', 'coachMode'],
    ]) {
      const control = $(`#${id}`);
      control?.addEventListener('change', () => commit({ [property]: control.checked }));
    }
    for (const id of ['thought-duration-select', 'pause-thought-duration']) {
      const control = $(`#${id}`);
      control?.addEventListener('change', () => commit({ thoughtDuration: control.value }));
    }
    sync();
  }

  initAudioControls() {
    const booleanControls = {
      audioMuted: $('#pause-audio-muted'),
      voiceEnabled: $('#pause-voice-enabled'),
    };
    const volumeControls = {
      master: $('#pause-master-volume'),
      music: $('#pause-music-volume'),
      voice: $('#pause-voice-volume'),
      sfx: $('#pause-sfx-volume'),
    };
    const outputFor = bus => $(`#pause-${bus}-volume-value`);
    const sync = () => {
      const settings = this.audio.getSettings();
      if (booleanControls.audioMuted) booleanControls.audioMuted.checked = settings.audioMuted;
      if (booleanControls.voiceEnabled) booleanControls.voiceEnabled.checked = settings.voiceEnabled;
      for (const [bus, control] of Object.entries(volumeControls)) {
        if (!control) continue;
        const value = settings[`${bus}Volume`];
        control.value = String(value);
        const output = outputFor(bus);
        if (output) output.textContent = String(value);
      }
    };
    const persist = () => {
      writeAudioPreferences(this.preferenceStorage, this.audio.getSettings());
      void persistDesktopSettings(this.preferenceStorage);
    };
    booleanControls.audioMuted?.addEventListener('change', () => {
      void this.audio.unlock();
      this.audio.setMuted(booleanControls.audioMuted.checked);
      persist();
      sync();
    });
    booleanControls.voiceEnabled?.addEventListener('change', () => {
      void this.audio.unlock();
      this.audio.setVoiceEnabled(booleanControls.voiceEnabled.checked);
      persist();
      sync();
    });
    for (const [bus, control] of Object.entries(volumeControls)) {
      control?.addEventListener('input', () => {
        this.audio.setBusVolume(bus, control.value);
        const output = outputFor(bus);
        if (output) output.textContent = String(this.audio.getSettings()[`${bus}Volume`]);
      });
      control?.addEventListener('change', persist);
    }
    document.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (button && !button.disabled) void this.audio.playSfx('ui-button');
    });
    sync();
  }

  initPauseControls() {
    $('#pause-button')?.addEventListener('click', () => this.togglePause());
    $('#pause-resume')?.addEventListener('click', () => this.closePause());
    $('#are-report-button')?.addEventListener('click', () => this.recordAreReport());
    $('#pause-export-reports')?.addEventListener('click', () => this.exportAreReportsToFile());
    $('#btn-stats')?.addEventListener('click', () => this.openStatsDialog());
    $('#stats-close')?.addEventListener('click', () => $('#stats-dialog')?.close());
    $('#stats-clear')?.addEventListener('click', () => {
      if (!window.confirm('蓄積した成績をすべて削除します。よろしいですか?')) return;
      clearGameRecords();
      this.renderStatsBody();
    });
    $('#pause-save')?.addEventListener('click', () => { void this.saveCurrentSession(); });
    $('#pause-save-title')?.addEventListener('click', () => {
      void (async () => {
        if (await this.saveCurrentSession()) await this.returnToTitle({ clearSaved: false });
      })();
    });
    $('#pause-title-only')?.addEventListener('click', () => {
      void this.returnToTitle({ clearSaved: true });
    });
    const dialog = $('#pause-dialog');
    if (dialog) {
      dialog.addEventListener('cancel', event => {
        event.preventDefault();
        this.closePause();
      });
      dialog.addEventListener('close', () => this.setPaused(false));
    }
  }

  initThoughtDetailControls() {
    const dialog = $('#thought-detail-dialog');
    if (!dialog) return;
    $('#thought-detail-back')?.addEventListener('click', () => this.closeThoughtDetail());
    $('#thought-detail-next')?.addEventListener('click', () => {
      this.closeThoughtDetail({ advance: true });
    });
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      this.closeThoughtDetail();
    });
    dialog.addEventListener('close', () => this.finishThoughtDetailClose());
  }

  initCoachDetailControls() {
    const dialog = $('#coach-detail-dialog');
    if (!dialog) return;
    $('#coach-detail-close')?.addEventListener('click', () => this.closeCoachDetail());
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      this.closeCoachDetail();
    });
    dialog.addEventListener('close', () => this.finishCoachDetailClose());
  }

  initCoachControls() {
    $('#coach-collapse')?.addEventListener('click', () => this.toggleCoachPanel());
  }

  toggleCoachPanel(collapsed = !this.coachCollapsed) {
    this.coachCollapsed = Boolean(collapsed);
    const panel = $('#coach-panel');
    const button = $('#coach-collapse');
    if (panel) panel.dataset.collapsed = this.coachCollapsed ? 'true' : 'false';
    if (button) {
      button.textContent = this.coachCollapsed ? '表示' : '隠す';
      button.setAttribute('aria-expanded', String(!this.coachCollapsed));
    }
    return this.coachCollapsed;
  }

  renderCoachTiles(target, action, view, offer, { mini = false } = {}) {
    if (!target) return;
    target.replaceChildren();
    const tiles = coachActionTiles(action, view, offer);
    for (const tile of tiles) target.appendChild(tileEl(tile, { mini }));
    target.classList.toggle('is-empty', tiles.length === 0);
  }

  coachComparisonRows(result, view, offer) {
    const analysis = result?.analysis;
    const selectedId = analysis?.selected?.candidateId;
    const selected = (analysis?.candidates ?? []).find(candidate => candidate.candidateId === selectedId);
    if (!selected || selected.action?.action !== 'discard') return [];
    // 有効な候補だけを比較に載せる: 提案 + 同向聴で受け入れが拮抗する牌(差2枚以内)。
    // 向聴が悪化する牌・大差で劣る牌・同一牌の重複は省く。
    const handAll = view?.drawn ? [...(view.hand ?? []), view.drawn] : [...(view?.hand ?? [])];
    const seenTiles = new Set();
    const alternatives = [];
    const sortedCandidates = (analysis?.candidates ?? [])
      .filter(candidate => candidate.action?.action === 'discard')
      .sort((left, right) => (right === selected) - (left === selected) ||
        (right.metrics?.ukeirePhysical ?? -1) - (left.metrics?.ukeirePhysical ?? -1));
    for (const candidate of sortedCandidates) {
      const tile = Number.isInteger(candidate.action?.index) ? handAll[candidate.action.index] : null;
      const key = tile ? `${tile.kind}:${tile.red ? 1 : 0}` : candidate.candidateId;
      if (seenTiles.has(key)) continue;
      if (candidate !== selected) {
        const metrics = candidate.metrics ?? {};
        if (metrics.shanten !== selected.metrics?.shanten) continue;
        if (Number.isFinite(metrics.ukeirePhysical) &&
            Number.isFinite(selected.metrics?.ukeirePhysical) &&
            selected.metrics.ukeirePhysical - metrics.ukeirePhysical > 2) continue;
      }
      seenTiles.add(key);
      alternatives.push(candidate);
      if (alternatives.length >= 6) break;
    }
    const nameOf = action => {
      const tile = Number.isInteger(action?.index) ? handAll[action.index] : null;
      return tile ? tileName(tile.kind, tile.red) : 'この牌';
    };
    const selectedName = nameOf(selected.action);
    return alternatives.map(candidate => {
      const metrics = candidate.metrics ?? {};
      const selectedMetrics = selected.metrics ?? {};
      const name = nameOf(candidate.action);
      let explanation;
      if (candidate === selected) {
        explanation = `提案です。${coachProgressSentence(metrics)}`;
      } else if (Number.isInteger(metrics.shanten) && Number.isInteger(selectedMetrics.shanten) &&
          metrics.shanten > selectedMetrics.shanten) {
        explanation = `${coachProgressSentence(metrics)} ${selectedName}を切るほうがテンパイに近づくため、${name}は選びません。`;
      } else if (Number.isFinite(metrics.ukeirePhysical) && Number.isFinite(selectedMetrics.ukeirePhysical) &&
          selectedMetrics.ukeirePhysical > metrics.ukeirePhysical) {
        explanation = `${coachProgressSentence(metrics)} ${selectedName}を切ると${selectedMetrics.ukeirePhysical}枚になり、${selectedMetrics.ukeirePhysical - metrics.ukeirePhysical}枚多く残ります。`;
      } else if (Number.isFinite(metrics.ukeirePhysical) && Number.isFinite(selectedMetrics.ukeirePhysical) &&
          selectedMetrics.ukeirePhysical < metrics.ukeirePhysical) {
        explanation = `${coachProgressSentence(metrics)} 形の広さだけなら${name}が上ですが、見えている価値や相手の捨て牌を優先して${selectedName}を選びます。`;
      } else {
        explanation = `${coachProgressSentence(metrics)} この比較だけでは差が小さいため、役になりやすさや見えている危険を合わせて決めます。`;
      }
      return { action: candidate.action, explanation };
    });
  }

  openCoachDetail(result = this.latestCoachResult) {
    const dialog = $('#coach-detail-dialog');
    if (!dialog || dialog.open || !result) return false;
    const { view, offer } = this.latestCoachContext ?? {};
    $('#coach-detail-title').textContent = result.headline || '判断の理由';
    $('#coach-detail-recommendation').textContent = result.recommendation || coachActionCaption(result.action);
    this.renderCoachTiles($('#coach-detail-tile-visual'), result.action, view, offer);
    const body = $('#coach-detail-body');
    body.replaceChildren();
    const rows = this.coachComparisonRows(result, view, offer);
    for (const row of rows) {
      const entry = document.createElement('div');
      entry.className = 'coach-comparison-row' + (row.action?.index === result.action?.index ? ' selected' : '');
      const tile = document.createElement('div');
      tile.className = 'coach-comparison-tile';
      this.renderCoachTiles(tile, row.action, view, offer, { mini: true });
      const p = document.createElement('p');
      p.textContent = coachCopy(row.explanation);
      entry.append(tile, p);
      body.appendChild(entry);
    }
    const supplementary = rows.length > 0
      ? (result.detailParagraphs ?? []).filter(paragraph => !/を切る案|切ると/.test(paragraph))
      : (result.detailParagraphs ?? []);
    for (const paragraph of supplementary) {
      const p = document.createElement('p');
      p.className = 'coach-supplement';
      p.textContent = coachCopy(paragraph);
      body.appendChild(p);
    }
    this.activeCoachDetail = { trigger: $('#coach-more') };
    dialog.dataset.gamepadActive = 'true';
    try {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      this.setPaused(true);
      $('#coach-detail-close')?.focus({ preventScroll: true });
      return true;
    } catch (error) {
      console.error('Coach detail dialog could not be opened.', error);
      dialog.dataset.gamepadActive = 'false';
      this.activeCoachDetail = null;
      return false;
    }
  }

  closeCoachDetail() {
    const dialog = $('#coach-detail-dialog');
    if (!this.activeCoachDetail && !dialog?.open) return false;
    if (dialog?.open && typeof dialog.close === 'function') dialog.close();
    else {
      dialog?.removeAttribute('open');
      this.finishCoachDetailClose();
    }
    return true;
  }

  finishCoachDetailClose() {
    const active = this.activeCoachDetail;
    if (!active) return;
    this.activeCoachDetail = null;
    const dialog = $('#coach-detail-dialog');
    if (dialog) dialog.dataset.gamepadActive = 'false';
    this.setPaused(false);
    if (active.trigger && !active.trigger.classList.contains('hidden')) {
      active.trigger.focus({ preventScroll: true });
    }
  }

  openThoughtDetail(bubble, view, onAdvance) {
    const dialog = $('#thought-detail-dialog');
    if (!dialog || dialog.open || !bubble || !view) return false;
    $('#thought-detail-speaker').textContent = `${view.speaker || 'COM'}の思考`;
    $('#thought-detail-title').textContent = view.headline || '判断の全文';
    $('#thought-detail-summary').textContent = view.fullBody || view.body || '記録された範囲だけを表示します。';
    const details = $('#thought-detail-details');
    details.replaceChildren();
    for (const detail of view.details ?? []) {
      const term = document.createElement('dt');
      term.textContent = detail.label;
      const description = document.createElement('dd');
      description.textContent = detail.value;
      details.append(term, description);
    }
    details.classList.toggle('hidden', details.childElementCount === 0);
    this.activeThoughtDetail = {
      bubble,
      onAdvance,
      advanceOnClose: false,
      restoreBubble: true,
    };
    bubble.dataset.gamepadActive = 'false';
    try {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      this.setPaused(true);
      $('#thought-detail-next')?.focus({ preventScroll: true });
      return true;
    } catch (error) {
      console.error('Thought detail dialog could not be opened.', error);
      this.activeThoughtDetail = null;
      bubble.dataset.gamepadActive = 'true';
      return false;
    }
  }

  closeThoughtDetail({ advance = false, restoreBubble = true } = {}) {
    const active = this.activeThoughtDetail;
    if (!active) return false;
    active.advanceOnClose ||= advance === true;
    active.restoreBubble &&= restoreBubble !== false;
    const dialog = $('#thought-detail-dialog');
    if (dialog?.open && typeof dialog.close === 'function') dialog.close();
    else {
      dialog?.removeAttribute('open');
      this.finishThoughtDetailClose();
    }
    return true;
  }

  finishThoughtDetailClose() {
    const active = this.activeThoughtDetail;
    if (!active) return;
    this.activeThoughtDetail = null;
    this.setPaused(false);
    if (active.restoreBubble && !active.bubble.classList.contains('hidden')) {
      active.bubble.dataset.gamepadActive = 'true';
      active.bubble.querySelector('.seat-thought-skip')?.focus({ preventScroll: true });
    } else {
      active.bubble.dataset.gamepadActive = 'false';
    }
    if (active.advanceOnClose) active.onAdvance?.('detail');
  }

  initGamepadEvents() {
    document.addEventListener(GAMEPAD_EVENTS.menu, event => {
      event.preventDefault();
      this.togglePause();
    });
    document.addEventListener(GAMEPAD_EVENTS.back, event => {
      if (!$('#action-bar')?.classList.contains('turn-mode')) return;
      if (this.activeRiichiCancel) {
        event.preventDefault();
        this.activeRiichiCancel();
      } else if (this.activeHandBack) {
        event.preventDefault();
        this.activeHandBack();
      }
    });
    document.addEventListener(GAMEPAD_EVENTS.noCalls, event => {
      if (!this.game || this.game.isCancelled() || $('#screen-game')?.classList.contains('hidden')) return;
      event.preventDefault();
      this.applyNoCallsPreference?.(!this.noCalls);
    });
  }

  addCancelListener(listener) {
    this.cancelListeners.add(listener);
    return () => this.cancelListeners.delete(listener);
  }

  cancelActiveWaits(reason = 'cancelled') {
    const listeners = [...this.cancelListeners];
    this.cancelListeners.clear();
    for (const listener of listeners) listener(reason);
    this.pendingClaimPass = null;
    this.activeRiichiCancel = null;
    this.activeHandBack = null;
    this.activeThoughtFinish = null;
    this.pauseChangeListeners.clear();
    this.setPaused(false);
  }

  setPaused(value) {
    const next = value === true;
    if (next === this.paused) return;
    this.paused = next;
    void this.audio?.setPaused(next);
    const listeners = [...this.pauseChangeListeners];
    this.pauseChangeListeners.clear();
    for (const listener of listeners) listener();
  }

  waitWhilePaused() {
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.pauseChangeListeners.delete(changed);
        this.cancelListeners.delete(cancelled);
      };
      const changed = () => {
        if (settled) return;
        if (this.paused) {
          this.pauseChangeListeners.add(changed);
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };
      const cancelled = reason => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new GameCancelledError(reason));
      };
      this.pauseChangeListeners.add(changed);
      this.cancelListeners.add(cancelled);
    });
  }

  async pauseAwareDelay(milliseconds) {
    let remaining = Math.max(0, Number(milliseconds) || 0);
    while (remaining > 0) {
      await this.waitWhilePaused();
      const started = performance.now();
      const outcome = await new Promise((resolve, reject) => {
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.pauseChangeListeners.delete(changed);
          this.cancelListeners.delete(cancelled);
          resolve(value);
        };
        const timer = setTimeout(() => finish('elapsed'), remaining);
        const changed = () => finish('paused');
        const cancelled = reason => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.pauseChangeListeners.delete(changed);
          this.cancelListeners.delete(cancelled);
          reject(new GameCancelledError(reason));
        };
        this.pauseChangeListeners.add(changed);
        this.cancelListeners.add(cancelled);
      });
      if (outcome === 'elapsed') return;
      remaining = Math.max(0, remaining - (performance.now() - started));
    }
  }

  syncPauseSummary() {
    const rules = this.game?.rules ?? loadRules();
    const length = { tonpuu: '東風戦', tonnan: '半荘戦', issou: '一荘戦' }[rules.gameLength] ?? '四人麻雀';
    $('#pause-rules-summary').textContent = [
      length,
      `赤牌${rules.akaDora}枚`,
      `喰いタン${rules.kuitan ? 'あり' : 'なし'}`,
      `後付け${rules.atozuke ? 'あり' : 'なし'}`,
      `持点${rules.startPoints}点`,
    ].join(' ／ ');
    $('#pause-save-status').textContent = '';
  }

  // --- 成績・分析画面 (データ蓄積はstats-store.js。見た目の仕上げはCodex担当予定) ---
  openStatsDialog() {
    const dialog = $('#stats-dialog');
    if (!dialog || dialog.open) return;
    this.renderStatsBody();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  renderStatsBody() {
    const body = $('#stats-body');
    if (!body) return;
    const records = loadGameRecords();
    const summary = summarizeStats(records);
    const pct = value => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
    if (summary.games === 0) {
      body.innerHTML = '<p class="stats-empty">まだ成績がありません。半荘を最後まで打つと自動で記録されます。</p>';
      return;
    }
    const rankBars = summary.rankCounts.map((count, index) =>
      `<div class="stats-rank-row"><span class="lbl">${index + 1}位</span>` +
      `<div class="stats-bar"><i style="width:${summary.games ? (count / summary.games * 100).toFixed(1) : 0}%"></i></div>` +
      `<span class="cnt">${count}回</span></div>`).join('');
    const yakuRows = summary.yakuRanking.slice(0, 12).map(item =>
      `<tr><td>${item.name}</td><td class="cnt">${item.count}回</td></tr>`).join('');
    body.innerHTML = `
      <section class="stats-section"><h3>総合</h3>
        <dl class="stats-grid">
          <div><dt>対局数</dt><dd>${summary.games}半荘</dd></div>
          <div><dt>平均順位</dt><dd>${summary.avgRank === null ? '—' : summary.avgRank.toFixed(2)}位</dd></div>
          <div><dt>通算スコア</dt><dd>${summary.totalFinalScore >= 0 ? '+' : ''}${summary.totalFinalScore}</dd></div>
          <div><dt>直近10戦の着順</dt><dd>${summary.recentRanks.join('→') || '—'}</dd></div>
        </dl>
        <div class="stats-ranks">${rankBars}</div>
      </section>
      <section class="stats-section"><h3>攻撃</h3>
        <dl class="stats-grid">
          <div><dt>和了率</dt><dd>${pct(summary.winRate)}</dd></div>
          <div><dt>平均和了点</dt><dd>${summary.avgWinPoints === null ? '—' : `${Math.round(summary.avgWinPoints)}点`}</dd></div>
          <div><dt>ツモ和了の割合</dt><dd>${pct(summary.tsumoShare)}</dd></div>
          <div><dt>最高打点</dt><dd>${summary.maxWin > 0 ? `${summary.maxWin}点` : '—'}</dd></div>
          <div><dt>リーチ率</dt><dd>${pct(summary.riichiRate)}</dd></div>
          <div><dt>副露率</dt><dd>${pct(summary.callRate)}</dd></div>
        </dl>
      </section>
      <section class="stats-section"><h3>守備</h3>
        <dl class="stats-grid">
          <div><dt>放銃率</dt><dd>${pct(summary.dealInRate)}</dd></div>
          <div><dt>平均放銃点</dt><dd>${summary.avgDealInPoints === null ? '—' : `${Math.round(summary.avgDealInPoints)}点`}</dd></div>
          <div><dt>流局時テンパイ率</dt><dd>${pct(summary.ryukyokuTenpaiRate)}</dd></div>
        </dl>
      </section>
      <section class="stats-section"><h3>役の出現</h3>
        ${yakuRows ? `<table class="stats-yaku"><tbody>${yakuRows}</tbody></table>` : '<p class="stats-empty">まだ和了がありません。</p>'}
      </section>`;
  }

  // --- 「あれ?」レポート (テスターの違和感をワンタップでカルテ用に記録) ---
  maybeShowAreReportHint() {
    if (this.areHintShown) return;
    this.areHintShown = true;
    try {
      if (localStorage.getItem('jun-are-hint-v1')) return;
      localStorage.setItem('jun-are-hint-v1', '1');
    } catch { /* localStorage不可でも一度だけ表示 */ }
    const hint = document.createElement('div');
    hint.className = 'are-report-hint';
    hint.textContent = 'COMや打ち手ガイドの判断に「あれ?」と思ったら、その瞬間に右上の「あれ?」ボタンを押してください。あとで中断メニューの「レポートを書き出す」からまとめて送れます。(タップで閉じる)';
    document.body.appendChild(hint);
    const dismiss = () => hint.remove();
    hint.addEventListener('click', dismiss);
    setTimeout(dismiss, 12000);
  }

  recordAreReport() {
    const context = this.areReportContext;
    // ガイド表示は同じ手番のものだけ添える(古い表示の誤対応を防ぐ)
    const coachMatches = this.latestCoachContext?.view === context?.view;
    const result = captureAreReport({
      view: context?.view,
      options: context?.options,
      offer: context?.offer,
      coachShown: coachMatches && this.latestCoachResult ? {
        recommendation: $('#coach-recommendation')?.textContent ?? null,
        headline: this.latestCoachResult.headline ?? null,
        explanation: this.latestCoachResult.explanation ?? null,
      } : null,
    });
    const button = $('#are-report-button');
    if (!button) return;
    button.dataset.flash = result.ok ? '1' : '';
    button.textContent = result.ok ? `記録 ${result.count}件` : 'あなたの手番で押してください';
    clearTimeout(this.areReportFlashTimer);
    this.areReportFlashTimer = setTimeout(() => {
      button.textContent = 'あれ?';
      button.dataset.flash = '';
    }, 1800);
  }

  exportAreReportsToFile() {
    const status = $('#pause-save-status');
    const { count, filename, json } = exportAreReports();
    if (count === 0) {
      if (status) status.textContent = '「あれ?」レポートはまだありません。対局中に「あれ?」ボタンで記録できます。';
      return;
    }
    let downloaded = false;
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      downloaded = true;
    } catch {
      downloaded = false;
    }
    const clipboardPromise = navigator.clipboard?.writeText
      ? navigator.clipboard.writeText(json).then(() => true, () => false)
      : Promise.resolve(false);
    void clipboardPromise.then(copied => {
      if (!status) return;
      const how = [downloaded ? `${filename} を保存` : null, copied ? 'クリップボードへコピー' : null]
        .filter(Boolean).join('・');
      status.textContent = how
        ? `「あれ?」レポート${count}件を${how}しました。開発者へ送ってください。`
        : `書き出しに失敗しました。スクリーンショットで代用してください。`;
    });
  }

  refreshAreReportExportLabel() {
    const button = $('#pause-export-reports');
    if (!button) return;
    const count = areReportCount();
    button.textContent = count > 0 ? `「あれ?」レポートを書き出す（${count}件）` : '「あれ?」レポートを書き出す';
  }

  openPause() {
    const dialog = $('#pause-dialog');
    if (!dialog || dialog.open || !this.game || this.game.isCancelled()) return false;
    if ($('#review-dialog')?.open || $('#thought-detail-dialog')?.open || $('#coach-detail-dialog')?.open ||
        !$('#overlay')?.classList.contains('hidden')) return false;
    this.syncPauseSummary();
    this.refreshAreReportExportLabel();
    this.setPaused(true);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    $('#pause-resume')?.focus({ preventScroll: true });
    return true;
  }

  closePause() {
    if (this.pauseSaving) return false;
    const dialog = $('#pause-dialog');
    if (dialog?.open && typeof dialog.close === 'function') dialog.close();
    else dialog?.removeAttribute('open');
    this.setPaused(false);
    if (this.finishThoughtOnResume) {
      this.finishThoughtOnResume = false;
      this.activeThoughtFinish?.('disabled');
    }
    return true;
  }

  togglePause() {
    const dialog = $('#pause-dialog');
    if (dialog?.open) this.closePause();
    else this.openPause();
  }

  async saveCurrentSession() {
    const status = $('#pause-save-status');
    const controls = [...document.querySelectorAll('#pause-dialog button, #pause-dialog input, #pause-dialog select')];
    if (this.pauseSaving) return false;
    try {
      if (!this.game || this.game.isCancelled()) throw new Error('ACTIVE_GAME_REQUIRED');
      this.pauseSaving = true;
      if (status) status.textContent = '保存しています…';
      for (const control of controls) control.disabled = true;
      const snapshot = this.game.createSessionCheckpoint();
      await persistActiveSession(snapshot, this.preferenceStorage);
      this.savedSession = snapshot;
      if (status) status.textContent = 'この局面を保存しました。次回はタイトルから再開できます。';
      return true;
    } catch (error) {
      console.error('Active session could not be saved.', error);
      if (status) status.textContent = '保存できませんでした。対局へ戻ってもう一度お試しください。';
      return false;
    } finally {
      this.pauseSaving = false;
      for (const control of controls) control.disabled = false;
    }
  }

  async refreshSavedSession() {
    const loaded = await loadActiveSession(this.preferenceStorage);
    this.savedSession = loaded.ok && loaded.exists ? loaded.data : null;
    this.sessionLoadError = loaded.ok ? null : loaded.error;
    const button = $('#btn-resume-session');
    button?.classList.toggle('hidden', !this.savedSession);
    const status = $('#title-session-status');
    if (status) {
      status.textContent = this.savedSession
        ? '保存した対局があります。'
        : this.sessionLoadError ? '保存対局を読み込めませんでした。' : '';
    }
    return this.savedSession;
  }

  stopCurrentGame(reason = 'title') {
    this.game?.cancel(reason);
    this.lastDiscardPlayer = -1;
    this.lastDiscardRef = null;
    this.tabletopDrawnSeat = null;
    this.tabletopKakanPreview = null;
    this.webglTabletop?.clearWinFocus?.();
    this.cancelActiveWaits(reason);
    this.hideThought();
    this.resetActionBar();
    $('#overlay')?.classList.add('hidden');
    $('#splash')?.classList.add('hidden');
    $('#cutin')?.classList.add('hidden');
    $('#win-cinematic')?.classList.add('hidden');
    this.riichiStickSequence += 1;
    $('#riichi-stick-cinematic')?.classList.add('hidden');
    $('#screen-game')?.classList.remove('win-cinematic-shake');
    $('#callout')?.classList.add('hidden');
  }

  async returnToTitle({ clearSaved = false } = {}) {
    this.stopCurrentGame('title');
    this.closePause();
    if (clearSaved) {
      await clearActiveSession(this.preferenceStorage).catch(error => {
        console.warn('Saved session could not be cleared.', error);
      });
      this.savedSession = null;
    }
    show('title');
    await this.refreshSavedSession();
  }

  startGame(session = null) {
    this.stopCurrentGame('replace');
    const rules = session ? makeRules(session.rules) : loadRules();
    this.spectate = location.search.includes('spectate'); // 開発用: 全員COMの観戦モード
    // 成績は人間として打つ新規対局のみ蓄積(観戦・途中再開の重複開始は除外)
    if (!this.spectate && !session) this.stats.startGame();
    else this.stats.reset();
    this.human = new HumanActor(this);
    const seat0 = this.spectate ? new PacedCom('COM', 'analyst', this) : this.human;
    const dealerCeremony = session ? null : createDealerCeremony();
    const serial = ++this.runSerial;
    this.game = new Game(rules,
      [
        seat0,
        new PacedCom('半蔵', 'guardian', this),
        new PacedCom('ジョー', 'analyst', this),
        new PacedCom('ひめ子', 'striker', this),
      ],
      (type, data) => this.onEvent(type, data),
      {
        onDecisionEvent: (type, data) => this.onDecisionEvent(type, data),
        matchId: session?.matchId ?? `local-${Date.now()}`,
        resumeSession: session,
        ...(dealerCeremony ? { dealerCeremony } : {}),
      });
    show('game');
    void this.audio.playBgm('night-private-table');
    void this.game.run().catch(error => {
      if (error?.code === 'GAME_CANCELLED' || serial !== this.runSerial) return;
      this.showFatalGameError(error);
    });
  }

  showFatalGameError(error) {
    console.error('Game stopped because an unrecoverable error occurred.', error);
    this.resetActionBar();
    this.hideThought();
    const content = $('#overlay-content');
    content.replaceChildren();
    const title = document.createElement('h2');
    title.textContent = '対局を停止しました';
    const message = document.createElement('p');
    message.className = 'win-sub';
    message.textContent = '判断の整合性を守るため、この対局は続行しません。タイトルから再開してください。';
    const button = document.createElement('button');
    button.id = 'btn-fatal-return';
    button.type = 'button';
    button.className = 'btn primary big';
    button.textContent = 'タイトルへ';
    button.onclick = () => {
      $('#overlay').classList.add('hidden');
      void this.returnToTitle({ clearSaved: false });
    };
    content.append(title, message, button);
    this.pinOverlayAction('btn-fatal-return');
    $('#overlay').classList.remove('hidden');
  }

  async onDecisionEvent(type, data) {
    await this.waitWhilePaused();
    if (type === 'beforeDecision') {
      if (data.request.actor !== 0 && this.thoughtMode) {
        this.showThoughtPending(data.request.actor);
      } else if (!this.spectate && data.request.actor === 0 &&
          data.request.view?.riichi === true && data.request.view?.drawn &&
          data.request.availableCandidates?.length === 1 &&
          data.request.availableCandidates[0]?.command?.action === 'discard') {
        // 強制手はGameがHumanActorを呼ばない。判断observer側でツモ牌を見せ、
        // 演出を終えてからGameへ制御を返す。
        await this.showRiichiAutoDraw(data.request.view);
      }
      return;
    }
    if (type === 'decisionCommitted') {
      if (data.analysis) this.roundAnalyses.set(data.record.id, data.analysis);
      if (data.record.actor !== 0 && this.thoughtMode) {
        if (data.analysis) await this.showThoughtCommitted(data.record.actor, data.analysis);
        else this.hideThought();
      }
      return;
    }
    if (type === 'roundComplete') {
      this.hideThought();
      this.roundAnalyses.clear();
      if (this.reviewMode) await this.showRoundReview(buildRoundReview(data.round));
    }
  }

  showThoughtPending(actor) {
    const bubble = this.thoughtBubble(actor);
    if (!bubble) return;
    this.clearThoughtBubbles();
    this.thoughtSequence++;
    bubble.querySelector('.seat-thought-speaker').textContent = `${SEAT_LABELS[actor] ?? 'COM'}の思考`;
    bubble.querySelector('.seat-thought-headline').textContent = '公開情報を照合中';
    bubble.querySelector('.seat-thought-body').textContent = '河・点棒・受入枚数を確認しています。';
    bubble.querySelector('.seat-thought-metrics').textContent = '';
    bubble.querySelector('.seat-thought-more').classList.add('hidden');
    bubble.querySelector('.seat-thought-skip').classList.add('hidden');
    bubble.dataset.gamepadActive = 'true';
    bubble.classList.remove('hidden');
  }

  async showThoughtCommitted(actor, analysis) {
    const token = ++this.thoughtSequence;
    const bubble = this.thoughtBubble(actor);
    if (!bubble) return;
    const view = presentThought(analysis, {
      name: SEAT_LABELS[actor] ?? 'COM',
      profile: COM_PROFILES[actor] ?? analysis.profile,
    });
    bubble.querySelector('.seat-thought-speaker').textContent = `${SEAT_LABELS[actor] ?? 'COM'}の思考`;
    bubble.querySelector('.seat-thought-headline').textContent = view.headline;
    bubble.querySelector('.seat-thought-body').textContent = view.body;
    bubble.querySelector('.seat-thought-metrics').textContent = (view.metrics ?? []).slice(0, 2).join('  ·  ');
    const more = bubble.querySelector('.seat-thought-more');
    const skip = bubble.querySelector('.seat-thought-skip');
    const hasExtendedThought = view.hasMore === true ||
      (view.fullBody?.length ?? 0) > view.body.length ||
      view.body.length > 80 || (view.details ?? []).length > 0;
    more.classList.toggle('hidden', !hasExtendedThought);
    skip.classList.remove('hidden');
    bubble.dataset.gamepadActive = 'true';
    bubble.classList.remove('hidden');
    this.playThoughtVoice(actor, analysis);

    await new Promise((resolve, reject) => {
      let settled = false;
      let unregisterCancel = () => {};
      const finish = () => {
        if (settled) return;
        settled = true;
        unregisterCancel();
        more.onclick = null;
        skip.onclick = null;
        if (this.activeThoughtFinish === finish) this.activeThoughtFinish = null;
        resolve();
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        unregisterCancel();
        if (this.activeThoughtDetail?.bubble === bubble) {
          this.closeThoughtDetail({ restoreBubble: false });
        }
        more.onclick = null;
        skip.onclick = null;
        if (this.activeThoughtFinish === finish) this.activeThoughtFinish = null;
        reject(error);
      };
      unregisterCancel = this.addCancelListener(reason => fail(new GameCancelledError(reason)));
      this.activeThoughtFinish = finish;
      more.onclick = () => this.openThoughtDetail(bubble, view, finish);
      skip.onclick = finish;
      if (this.thoughtDuration !== 'manual') {
        this.pauseAwareDelay(Number(this.thoughtDuration) * 1000).then(finish, fail);
      }
    });
    if (token === this.thoughtSequence) this.hideThought();
  }

  playCharacterVoice(player, cue, { critical = false } = {}) {
    const character = CHARACTER_AUDIO_IDS[player];
    if (!character || typeof cue !== 'string' || cue === '') return;
    void this.audio.playVoice(`${character}.${cue}`, { critical });
  }

  showCoach(result, { view = null, offer = null } = {}) {
    const panel = $('#coach-panel');
    if (!panel || !result) return;
    this.latestCoachResult = result;
    this.latestCoachContext = { view, offer };
    $('#coach-title').textContent = result.phase === 'claim' ? '鳴くかどうか' : '何を選ぶか';
    $('#coach-recommendation').textContent = result.recommendation || coachActionCaption(result.action);
    $('#coach-explanation').textContent = coachCopy(result.headline || result.explanation);
    this.renderCoachTiles($('#coach-tile-visual'), result.action, view, offer);
    const more = $('#coach-more');
    if (more) {
      more.textContent = result.hasMore ? '全て表示' : '詳しく見る';
      more.classList.toggle('hidden', !result.hasMore);
      more.onclick = result.hasMore ? () => this.openCoachDetail(result) : null;
    }
    panel.dataset.phase = result.phase;
    this.toggleCoachPanel(this.coachCollapsed);
    panel.classList.remove('hidden');
  }

  showCoachTurn(view, options) {
    if (!this.coachMode) {
      this.hideCoach();
      return;
    }
    try {
      this.showCoach(buildTurnCoaching(view, options, 'analyst'), { view });
    } catch (error) {
      console.warn('Coach mode skipped an unsupported turn.', error);
      this.hideCoach();
    }
  }

  showCoachClaim(view, offer) {
    if (!this.coachMode) {
      this.hideCoach();
      return;
    }
    try {
      this.showCoach(buildClaimCoaching(view, offer, 'analyst'), { view, offer });
    } catch (error) {
      console.warn('Coach mode skipped an unsupported claim.', error);
      this.hideCoach();
    }
  }

  hideCoach() {
    if (this.activeCoachDetail) this.closeCoachDetail();
    const panel = $('#coach-panel');
    if (!panel) return;
    panel.classList.add('hidden');
    panel.removeAttribute('data-phase');
    this.latestCoachResult = null;
    this.latestCoachContext = { view: null, offer: null };
  }

  playThoughtVoice(actor, analysis) {
    const voiceId = selectThoughtVoiceId(actor, analysis);
    if (voiceId) void this.audio.playVoice(voiceId);
  }

  thoughtBubble(actor) {
    return Number.isInteger(actor) ? $(`#thought-seat-${actor}`) : null;
  }

  clearThoughtBubbles() {
    for (let actor = 1; actor <= 3; actor++) {
      const bubble = this.thoughtBubble(actor);
      if (!bubble) continue;
      bubble.classList.add('hidden');
      bubble.dataset.gamepadActive = 'false';
      const skip = bubble.querySelector('.seat-thought-skip');
      const more = bubble.querySelector('.seat-thought-more');
      if (skip) skip.onclick = null;
      if (more) {
        more.onclick = null;
        more.classList.add('hidden');
      }
    }
  }

  hideThought() {
    this.thoughtSequence++;
    this.closeThoughtDetail({ restoreBubble: false });
    this.activeThoughtFinish?.('hidden');
    this.activeThoughtFinish = null;
    this.clearThoughtBubbles();
  }

  async showRoundReview(review) {
    const dialog = $('#review-dialog');
    const entries = review?.entries ?? [];
    this.currentReview = review;
    this.reviewCursor = 0;
    const scoredCandidates = entries.flatMap(entry => entry.reviews ?? [])
      .filter(evaluation => evaluation.status !== 'forced');
    const fullyScored = scoredCandidates.length > 0 &&
      scoredCandidates.every(evaluation => evaluation.status === 'scored' && Number.isFinite(evaluation.score));
    $('#review-overall-score').textContent = fullyScored && Number.isFinite(review?.overallScore)
      ? String(Math.round(review.overallScore))
      : '—';

    const timeline = $('#review-timeline-list');
    timeline.replaceChildren();
    if (entries.length === 0) {
      $('#review-progress').textContent = '採点対象なし';
      $('#review-decision-number').textContent = 'この局の記録';
      $('#review-choice').textContent = '採点対象となる判断はありません';
      $('#review-recommendation').textContent = '強制打牌だけだった局は、推測で点数を付けず記録だけを残します。';
      $('#review-comments').replaceChildren();
      $('#review-prev').disabled = true;
      $('#review-next').disabled = true;
    } else {
      entries.forEach((entry, index) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        if (index === 0) button.dataset.gamepadDefault = '';
        const view = presentReviewDecision({
          record: entry.record,
          evaluations: entry.reviews,
          index,
          total: entries.length,
        });
        const number = document.createElement('span');
        number.textContent = String(index + 1).padStart(2, '0');
        const label = document.createElement('strong');
        label.textContent = view.actionLabel;
        const score = document.createElement('small');
        score.textContent = Number.isFinite(view.score) ? `${Math.round(view.score)}` : '—';
        button.append(number, label, score);
        button.onclick = () => {
          this.reviewCursor = index;
          this.renderReviewDecision();
        };
        button.addEventListener('focus', () => {
          if (this.reviewCursor === index) return;
          this.reviewCursor = index;
          this.renderReviewDecision({ focusTimeline: false });
        });
        item.appendChild(button);
        timeline.appendChild(item);
      });
      this.renderReviewDecision();
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let unregisterCancel = () => {};
      const close = () => {
        if (settled) return;
        settled = true;
        unregisterCancel();
        if (dialog.open) dialog.close();
        this.currentReview = null;
        resolve();
      };
      const cancel = reason => {
        if (settled) return;
        settled = true;
        unregisterCancel();
        if (dialog.open) dialog.close();
        this.currentReview = null;
        reject(new GameCancelledError(reason));
      };
      unregisterCancel = this.addCancelListener(cancel);
      $('#review-close').onclick = close;
      dialog.oncancel = event => {
        event.preventDefault();
        close();
      };
      dialog.onclose = () => {
        if (!settled) close();
      };
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    });
  }

  renderReviewDecision({ focusTimeline = true } = {}) {
    const entries = this.currentReview?.entries ?? [];
    if (entries.length === 0) return;
    const index = Math.max(0, Math.min(this.reviewCursor, entries.length - 1));
    this.reviewCursor = index;
    const entry = entries[index];
    const view = presentReviewDecision({
      record: entry.record,
      evaluations: entry.reviews,
      index,
      total: entries.length,
    });
    $('#review-progress').textContent = `${index + 1} / ${entries.length}`;
    $('#review-decision-number').textContent = `判断 ${String(index + 1).padStart(2, '0')} · ${view.scored ? '採点対象' : '参考記録'}`;
    $('#review-choice').textContent = view.actionLabel;
    $('#review-recommendation').textContent = `3人の推奨: ${view.recommendation}`;

    const comments = $('#review-comments');
    comments.replaceChildren();
    for (const comment of view.comments ?? []) {
      const article = document.createElement('article');
      article.className = 'review-comment';
      const persona = document.createElement('div');
      persona.className = 'review-comment-persona';
      const name = document.createElement('strong');
      name.textContent = comment.name;
      const role = document.createElement('small');
      role.textContent = comment.role;
      persona.append(name, role);
      const body = document.createElement('div');
      body.className = 'review-comment-body';
      const headline = document.createElement('h4');
      headline.textContent = comment.headline;
      const copy = document.createElement('p');
      copy.textContent = comment.body;
      body.append(headline, copy);
      const score = document.createElement('div');
      score.className = 'review-comment-score';
      score.textContent = Number.isFinite(comment.score) ? String(Math.round(comment.score)) : '—';
      const scoreLabel = document.createElement('small');
      scoreLabel.textContent = Number.isFinite(comment.score) ? '/ 100' : (comment.scoreLabel ?? '参考');
      score.appendChild(scoreLabel);
      article.append(persona, body, score);
      comments.appendChild(article);
    }

    const buttons = [...document.querySelectorAll('#review-timeline-list button')];
    buttons.forEach((button, buttonIndex) => button.setAttribute('aria-current', buttonIndex === index ? 'true' : 'false'));
    if (focusTimeline) buttons[index]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    $('#review-prev').disabled = index === 0;
    $('#review-next').disabled = index === entries.length - 1;
    $('#review-prev').onclick = () => {
      if (this.reviewCursor > 0) {
        this.reviewCursor--;
        this.renderReviewDecision();
      }
    };
    $('#review-next').onclick = () => {
      if (this.reviewCursor < entries.length - 1) {
        this.reviewCursor++;
        this.renderReviewDecision();
      }
    };
  }

  // Gameがawaitするので、Promiseを返せば進行が止まる
  async onEvent(type, data) {
    await this.waitWhilePaused();
    switch (type) {
      case 'dealerCeremony':
        return this.showDealerCeremony(data);
      case 'resumeReady':
        this.myHand = this.game.handOf(0);
        this.myDrawn = data.drawn ?? null;
        this.lastDiscardPlayer = this.game.st?.lastDiscard?.player ?? -1;
        this.lastDiscardRef = (() => {
          const seat = this.lastDiscardPlayer;
          const tileId = this.game.st?.lastDiscard?.tile?.id;
          if (!Number.isInteger(seat) || seat < 0 || tileId === undefined) return null;
          const discards = data.state?.players?.[seat]?.discards ?? [];
          let discardSerial = -1;
          for (let index = discards.length - 1; index >= 0; index--) {
            if (discards[index]?.tile?.id === tileId) { discardSerial = index; break; }
          }
          return discardSerial >= 0 ? { seat, tileId, discardSerial } : null;
        })();
        this.tabletopDrawnSeat = data.drawn && this.game?.st?.turn !== 0 ? this.game.st.turn : null;
        this.tabletopKakanPreview = null;
        this.resetActionBar();
        this.renderBoard(data.state);
        this.renderHand(false);
        this.syncWaitHint();
        return;
      case 'roundStart':
        this.stats.startHand();
        this.lastDiscardPlayer = -1;
        this.lastDiscardRef = null;
        this.tabletopDrawnSeat = null;
        this.tabletopKakanPreview = null;
        this.myHand = this.game.handOf(0);
        this.myDrawn = null;
        this.resetActionBar();
        this.renderBoard(data);
        this.renderHand();
        this.syncWaitHint();
        return this.showSplash(data);
      case 'discard':
        void this.audio.playSfx('tile-discard');
        if (data.riichi && data.player === 0) this.stats.onMyRiichi();
        this.lastDiscardPlayer = data.player;
        this.tabletopDrawnSeat = null;
        this.tabletopKakanPreview = null;
        this.lastDiscardRef = {
          seat: data.player,
          tileId: data.tile?.id,
          discardSerial: Math.max(0, (data.state?.players?.[data.player]?.discards?.length ?? 1) - 1),
        };
        if (!this.spectate && data.player === 0) {
          this.myHand = this.game.handOf(0);
          this.myDrawn = null;
          this.renderHand(false);
        }
        this.renderBoard(data.state);
        this.syncWaitHint();
        if (data.riichi) {
          await this.showRiichiStick(data.player);
          return this.showCallout(data.player, 'リーチ');
        }
        // リーチ済みの打ち手はツモ切り強制で思考時間が無いため、
        // 捨て牌を目で追えるようにここで一拍置く(qa-fast時は省略)
        if (data.state?.players?.[data.player]?.riichi && !location.search.includes('qa-fast')) {
          await this.pauseAwareDelay(550);
        }
        return;
      case 'claim':
        if (data.player === 0) this.stats.onMyCall();
        // 発声→間→卓に反映、の順で「何が起きたか」を見せる
        return (async () => {
          await this.showCallout(data.player, { pon: 'ポン', chi: 'チー', minkan: 'カン' }[data.action] || data.action, 1000);
          this.lastDiscardRef = null;
          this.tabletopDrawnSeat = null;
          if (!this.spectate && data.player === 0) {
            this.myHand = this.game.handOf(0);
            this.myDrawn = null;
            this.renderHand(false);
          }
          this.renderBoard(data.state);
          this.syncWaitHint();
          await this.pauseAwareDelay(450);
        })();
      case 'kanDeclared':
        // 加槓は槍槓判定より前に宣言を見せる。成立時のkanイベントでは
        // 二重発声させない。4枚目はこの時点で横牌の奥へ平置きし、槍槓なら
        // 「何を加槓した牌なのか」を認知してからロン演出へつなぐ。
        this.stageKakanAddedTile(data);
        return this.showCallout(data.player, 'カン', 1000);
      case 'kan':
        return (async () => {
          if (!data.fromClaim && data.action !== 'kakan') {
            await this.showCallout(data.player, 'カン', 1000);
          }
          if (!this.spectate && data.player === 0) {
            this.myHand = this.game.handOf(0);
            this.myDrawn = null;
            this.renderHand(false);
          }
          this.tabletopDrawnSeat = null;
          this.tabletopKakanPreview = null;
          this.renderBoard(data.state);
          this.hideWaits();
          await this.pauseAwareDelay(450);
        })();
      case 'kyuushu':
        return this.showCallout(data.player, '九種九牌');
      case 'draw':
        // ツモった本人に手番表示を移す(打牌イベントを待たない)
        if (data.state) {
          this.tabletopDrawnSeat = data.player === 0 ? null : data.player;
          if (!this.spectate && data.player === 0) {
            this.myHand = this.game.handOf(0);
            this.myDrawn = data.tile ?? null;
            this.renderHand(false);
          }
          this.renderBoard(data.state);
        }
        this.setTurnIndicator(data.player);
        $('#center .sub .rest') && ($('#center .sub .rest').textContent = `残 ${data.remaining}`);
        // リーチ済みはツモ切り強制で即打牌になるため、ツモの瞬間にも一拍置く
        if (data.state?.players?.[data.player]?.riichi && !location.search.includes('qa-fast')) {
          return this.pauseAwareDelay(350);
        }
        return;
      case 'win':
        this.stats.onWin(data);
        return this.showWin(data);
      case 'ryukyoku':
        this.stats.onRyukyoku(data);
        return this.showRyukyoku(data);
      case 'nagashi': return this.showNagashi(data);
      case 'gameEnd': return this.showGameEnd(data);
    }
  }

  // --- 仮東・サイコロによる起家決定（卓中央と牌は隠さない） ---
  async showDealerCeremony(ceremony) {
    const overlay = $('#dealer-ceremony');
    if (!overlay || !ceremony) return;
    const diceFaces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    const title = $('#dealer-ceremony-title');
    const status = $('#dealer-ceremony-status');
    const die1 = $('#dealer-die-1');
    const die2 = $('#dealer-die-2');
    const seats = [...overlay.querySelectorAll('[data-dealer-seat]')];
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    const activateSeat = (seat, count = null) => {
      for (const marker of seats) {
        const active = Number(marker.dataset.dealerSeat) === seat;
        marker.dataset.active = active ? 'true' : 'false';
        const index = marker.querySelector('span');
        if (index) index.textContent = active && count !== null ? String(count) : marker.dataset.dealerSeat;
      }
    };
    const showResult = () => {
      die1.textContent = diceFaces[ceremony.dice[0] - 1];
      die2.textContent = diceFaces[ceremony.dice[1] - 1];
      title.textContent = `起家　${SEAT_LABELS[ceremony.initialDealer]}`;
      status.textContent = `${ceremony.dice[0]} + ${ceremony.dice[1]} = ${ceremony.dice[0] + ceremony.dice[1]}　東家決定`;
      activateSeat(ceremony.initialDealer);
    };

    overlay.classList.remove('hidden');
    try {
      if (reducedMotion) {
        showResult();
        await this.pauseAwareDelay(600);
        return;
      }
      title.textContent = `仮東　${SEAT_LABELS[ceremony.provisionalEast]}`;
      status.textContent = '仮東から手番順に数えます';
      die1.textContent = '—';
      die2.textContent = '—';
      activateSeat(ceremony.provisionalEast, 0);
      await this.pauseAwareDelay(420);

      die1.textContent = diceFaces[ceremony.dice[0] - 1];
      status.textContent = `一投目　${ceremony.dice[0]}`;
      await this.pauseAwareDelay(240);
      die2.textContent = diceFaces[ceremony.dice[1] - 1];
      status.textContent = `二投目　${ceremony.dice[1]}　合計${ceremony.dice[0] + ceremony.dice[1]}`;
      await this.pauseAwareDelay(320);

      const total = ceremony.dice[0] + ceremony.dice[1];
      for (let step = 0; step < total; step++) {
        const seat = (ceremony.provisionalEast + step) % 4;
        activateSeat(seat, step + 1);
        status.textContent = `${step + 1}　${SEAT_LABELS[seat]}`;
        await this.pauseAwareDelay(105);
      }
      showResult();
      await this.pauseAwareDelay(700);
    } finally {
      overlay.classList.add('hidden');
      for (const marker of seats) marker.dataset.active = 'false';
    }
  }

  // --- 局開始スプラッシュ ---
  async showSplash(state) {
    const splash = $('#splash');
    const kyokuName = `${WIND_NAMES[state.roundWindIdx]}${state.kyoku + 1}局`;
    splash.innerHTML = `<div><div class="splash-text">${kyokuName}</div>` +
      `<div class="splash-sub">${state.honba > 0 ? state.honba + '本場　' : ''}親: ${SEAT_LABELS[state.dealer]}</div></div>`;
    splash.classList.remove('hidden');
    await this.pauseAwareDelay(1200);
    splash.classList.add('hidden');
  }

  setTurnIndicator(player) {
    for (let p = 0; p < 4; p++) $(`#chip-${p}`).classList.toggle('active', p === player);
  }

  // --- リーチ中の自動ツモ切り(演出付き) ---
  async riichiAutoTurn(view) {
    await this.showRiichiAutoDraw(view);
    return { action: 'discard', index: view.hand.length, riichi: false };
  }

  async showRiichiAutoDraw(view) {
    this.myHand = view.hand;
    this.myDrawn = view.drawn;
    this.renderHand(false);
    this.showWaits(view.hand, view.melds.length); // 待ち牌は常時表示
    await this.pauseAwareDelay(700);
    this.myHand = [...view.hand];
    this.myDrawn = null;
    this.renderHand(false);
  }

  // --- 待ち牌ヒント ---
  showWaits(hand13, meldCount) {
    const waits = waitKindsForHand(hand13, meldCount);
    const hint = $('#wait-hint');
    if (waits.length === 0) { this.hideWaits(); return; }
    hint.innerHTML = '<span class="tenpai-badge">聴牌</span><span class="lbl">待ち</span>';
    const visible = this.visibleCountsUI();
    const labels = [];
    for (const k of waits) {
      hint.appendChild(tileEl({ kind: k, red: false }, { mini: true }));
      const n = remainingCopies(k, visible);
      labels.push(`${tileName(k)}残り${n}枚`);
      const count = document.createElement('span');
      count.className = 'cnt';
      count.textContent = `残${n}`;
      hint.appendChild(count);
    }
    hint.setAttribute('aria-label', `聴牌。待ち牌は${labels.join('、')}`);
    hint.classList.remove('hidden');
  }
  hideWaits() {
    const hint = $('#wait-hint');
    hint.classList.add('hidden');
    hint.removeAttribute('aria-label');
  }

  syncWaitHint() {
    const meldCount = this.lastState?.players?.[0]?.melds?.length || 0;
    const expectedTiles = 13 - meldCount * 3;
    if (this.myDrawn || this.myHand.length !== expectedTiles) {
      this.hideWaits();
      return;
    }
    this.showWaits(this.myHand, meldCount);
  }

  // UIから見えている牌の枚数(自分の手牌+ツモ+全員の河/副露+ドラ表示牌)
  visibleCountsUI() {
    const c = {};
    const add = (t) => { c[t.kind] = (c[t.kind] || 0) + 1; };
    for (const t of this.myHand) add(t);
    if (this.myDrawn) add(this.myDrawn);
    const st = this.lastState;
    if (st) {
      for (const pl of st.players) {
        for (const d of pl.discards) if (!d.claimed) add(d.tile);
        for (const m of pl.melds) for (const t of m.tiles) add(t);
      }
      for (const t of st.doraIndicators) add(t);
    }
    return c;
  }

  // --- 吹き出し ---
  async showCallout(player, text, ms = 750) {
    const token = ++this.calloutSequence;
    const el = $('#callout');
    el.textContent = text;
    void this.audio.playSfx('call-accent');
    const voiceCue = new Map([
      ['リーチ', 'riichi'], ['ポン', 'pon'], ['チー', 'chi'], ['カン', 'kan'],
    ]).get(String(text));
    if (voiceCue) this.playCharacterVoice(player, voiceCue);
    // 席の方向に出す (0=下,1=右,2=上,3=左)
    const pos = [
      { left: '50%', top: '62%', transform: 'translate(-50%,-50%)' },
      { left: '74%', top: '42%', transform: 'translate(-50%,-50%)' },
      { left: '50%', top: '22%', transform: 'translate(-50%,-50%)' },
      { left: '26%', top: '42%', transform: 'translate(-50%,-50%)' },
    ][player];
    Object.assign(el.style, { left: pos.left, top: pos.top, transform: pos.transform });
    el.classList.remove('hidden');
    await this.pauseAwareDelay(ms);
    if (token === this.calloutSequence) el.classList.add('hidden');
  }

  // リーチ棒は置かれた直後に発声へつなぐ。WebGLに依存せず、短い演出でも卓の手番を止めない。
  async showRiichiStick(player) {
    const token = ++this.riichiStickSequence;
    const el = $('#riichi-stick-cinematic');
    if (!el) return;
    el.dataset.player = String(player);
    el.classList.remove('hidden', 'is-playing');
    void el.offsetWidth;
    el.classList.add('is-playing');
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    await this.pauseAwareDelay(reducedMotion ? 120 : 620);
    if (token !== this.riichiStickSequence) return;
    await this.pauseAwareDelay(reducedMotion ? 40 : 240);
    if (token === this.riichiStickSequence) {
      el.classList.remove('is-playing');
      el.classList.add('hidden');
    }
  }

  renderWebGLTabletop(state) {
    if (!state || !this.webglTabletop) return;
    const result = this.webglTabletop.render(state, {
      lastDiscard: this.lastDiscardRef,
      lastDiscardPlayer: this.lastDiscardPlayer,
      drawnSeat: this.tabletopDrawnSeat,
      kakanPreview: this.tabletopKakanPreview,
    });
    if (result?.catch) result.catch(error => {
      console.error('The WebGL tabletop frame could not be rendered.', error);
    });
  }

  // --- 卓の描画 ---
  renderBoard(state) {
    if (!state) return;
    this.lastState = state;
    if (this.spectate) { this.myHand = this.game.handOf(0); this.myDrawn = null; this.renderHand(); }
    this.renderWebGLTabletop(state);

    // 中央
    $('#center').innerHTML =
      `<div class="kyoku">${WIND_NAMES[state.roundWindIdx]}${state.kyoku + 1}局</div>` +
      `<div class="sub"><span class="rest">残 ${state.remaining}</span>` +
      `<span>${state.honba}本場</span>` +
      `<span class="sticks">供託 ${state.riichiSticks}本</span></div>` +
      `<div class="dora-row"><span class="label">ドラ</span></div>`;
    const doraRow = $('#center .dora-row');
    for (const t of state.doraIndicators) doraRow.appendChild(tileEl(t));
    if (state.riichiSticks > 0) {
      const pot = document.createElement('div');
      pot.className = 'riichi-pot';
      pot.dataset.count = String(state.riichiSticks);
      pot.setAttribute('aria-label', `供託 ${state.riichiSticks}本`);
      for (let i = 0; i < Math.min(state.riichiSticks, 8); i++) {
        const stick = document.createElement('span');
        stick.className = 'riichi-pot-stick';
        stick.textContent = '1000';
        pot.appendChild(stick);
      }
      $('#center').appendChild(pot);
    }

    // 各家: チップ(名前/点/リーチ棒/副露) + 河 + 裏手牌
    for (let p = 0; p < 4; p++) {
      const pl = state.players[p];
      const seatWind = WIND_NAMES[(p - state.dealer + 4) % 4];
      const chip = $(`#chip-${p}`);
      chip.className = 'chip seat-' + p + ' ' + ['bl', 'br', 'tr', 'tl'][p] + (state.turn === p ? ' active' : '');
      chip.innerHTML =
        `<div class="who"><span class="avatar ${p === 0 ? 'you' : ['hanzou', 'joe', 'himeko'][p - 1]}"></span><span><span class="wind${p === state.dealer ? ' dealer' : ''}">${seatWind}</span>${SEAT_LABELS[p]}<small>${SEAT_TAGLINES[p]}</small></span></div>` +
        `<div class="pts">${state.points[p]}</div>` +
        (pl.riichi ? '<span class="riichi-state">立直</span>' : '');

      // 副露は席札でも河でもなく、各家の手牌のすぐ内側へ置く。
      if (p !== 0) {
        const mbox = $(`#melds-${p}`);
        if (mbox) {
          mbox.replaceChildren();
          mbox.classList.toggle('is-empty', pl.melds.length === 0);
          pl.melds.forEach((m, meldIndex) => mbox.appendChild(boardMeldEl(m, true, p, meldIndex)));
        }
      }

      // 河 (鳴かれた牌は表示から除く)
      const river = $(`#river-${p}`);
      river.innerHTML = '';
      const riichiAt = pl.discards.findIndex(d => d.riichi);
      const riichiWasClaimed = riichiAt >= 0 && pl.discards[riichiAt]?.claimed === true;
      const riichiFollowup = riichiWasClaimed
        ? pl.discards.slice(riichiAt + 1).find(d => !d.claimed) ?? null
        : null;
      pl.discards.forEach((d, discardSerial) => {
        if (d.claimed) return;
        const el = tileEl(d.tile, {
          riichi: d.riichi,
          riichiFollowup: d === riichiFollowup,
          tsumogiri: d.tsumogiri,
        });
        const placement = createTabletopPlacement(el, {
          seat: p,
          zone: 'river',
          stableKey: {
            tileId: d.tile?.id ?? `seat${p}:discard${discardSerial}:${d.tile?.kind ?? 'unknown'}`,
            discardSerial,
          },
          sideways: Boolean(d.riichi || d === riichiFollowup),
        });
        if (d.tsumogiri) placement.classList.add('is-tsumogiri');
        if (p === this.lastDiscardPlayer && discardSerial === pl.discards.length - 1) {
          placement.classList.add('is-last-discard');
        }
        river.appendChild(placement);
      });
    }

    // 裏向き手牌ストリップ
    const strips = { 1: $('#strip-right'), 2: $('#strip-top'), 3: $('#strip-left') };
    for (const [p, el] of Object.entries(strips)) {
      el.innerHTML = '';
      const count = state.players[p].handCount;
      for (let i = 0; i < count; i++) el.appendChild(concealedTileCuboid(Number(p), i, count));
    }

    // 自分の副露
    const myMelds = $('#my-melds');
    myMelds.innerHTML = '';
    state.players[0].melds.forEach((m, meldIndex) => myMelds.appendChild(boardMeldEl(m, false, 0, meldIndex)));
  }

  // 打牌は二段タッチ: 1タッチ目で牌が浮き、同じ牌への2タッチ目で確定。別の牌を触ると浮きが移る
  renderHand(selectable = false, riichiFilter = null, onPick = null, onLift = null) {
    const box = $('#my-hand');
    box.innerHTML = '';
    let lifted = -1;
    let firstSelectable = true;
    const els = [];
    const all = this.myDrawn ? [...this.myHand, this.myDrawn] : [...this.myHand];
    this.activeHandBack = selectable ? () => {
      if (lifted < 0 || !els[lifted]) return;
      els[lifted].classList.remove('lifted');
      els[lifted].setAttribute('aria-pressed', 'false');
      lifted = -1;
      this.syncWaitHint();
    } : null;
    all.forEach((t, i) => {
      const el = tileEl(t);
      els.push(el);
      if (this.myDrawn && i === all.length - 1) el.classList.add('drawn');
      if (selectable) {
        const allowed = !riichiFilter || riichiFilter.includes(i);
        if (allowed) {
          el.classList.add('selectable');
          el.classList.toggle('riichi-ok', !!riichiFilter);
          el.setAttribute('role', 'button');
          el.setAttribute('aria-pressed', 'false');
          el.dataset.gamepadFocus = 'true';
          el.dataset.gamepadGroup = 'hand';
          el.tabIndex = firstSelectable ? 0 : -1;
          firstSelectable = false;
          el.onclick = () => {
            if (lifted === i) { onPick(i); return; }   // 2タッチ目 → 打牌
            if (lifted >= 0) {
              els[lifted].classList.remove('lifted');
              els[lifted].setAttribute('aria-pressed', 'false');
              els[lifted].tabIndex = -1;
            }
            lifted = i;
            el.classList.add('lifted');                 // 1タッチ目 → 浮かせる
            el.setAttribute('aria-pressed', 'true');
            el.tabIndex = 0;
            if (onLift) onLift(i);
          };
        } else {
          el.classList.add('dimmed');
        }
      }
      box.appendChild(el);
    });
  }

  // --- 手番 ---
  promptTurn(view, options) {
    this.myHand = view.hand;
    this.myDrawn = view.drawn;
    this.areReportContext = { view, options, offer: null };
    this.maybeShowAreReportHint();
    this.showCoachTurn(view, options);
    const self = this;
    return new Promise((resolve, reject) => {
      const bar = $('#action-bar');
      this.resetActionBar();
      bar.classList.add('turn-mode');
      bar.dataset.gamepadScope = 'turn';
      let riichiMode = false;
      let settled = false;
      let unregisterCancel = () => {};

      // 通常ツモ時は、直前の13枚形が聴牌ならリーチの有無に関係なく現在の待ちを示す。
      const expectedTiles = 13 - view.melds.length * 3;
      if (view.drawn && view.hand.length === expectedTiles) this.showWaits(view.hand, view.melds.length);
      else this.hideWaits();

      // 打牌確定と同時に手牌から即座に消してリー牌(ソート)する(エンジンの反映を待たない)
      const finish = (result) => {
        if (settled) return;
        settled = true;
        unregisterCancel();
        self.activeRiichiCancel = null;
        self.resetActionBar();
        self.hideWaits();
        self.hideCoach();
        if (result.action === 'discard') {
          const all = self.myDrawn ? [...self.myHand, self.myDrawn] : [...self.myHand];
          all.splice(result.index, 1);
          all.sort((a, b) => a.kind - b.kind || (a.red ? 1 : 0) - (b.red ? 1 : 0));
          self.myHand = all;
          self.myDrawn = null;
        } else if (result.action === 'ankan' || result.action === 'kakan') {
          const all = self.myDrawn ? [...self.myHand, self.myDrawn] : [...self.myHand];
          let remove = result.action === 'ankan' ? 4 : 1;
          self.myHand = all.filter(t => {
            if (t.kind === result.kind && remove > 0) { remove--; return false; }
            return true;
          }).sort((a, b) => a.kind - b.kind || (a.red ? 1 : 0) - (b.red ? 1 : 0));
          self.myDrawn = null;
        }
        self.renderHand(false);
        resolve(result);
      };
      unregisterCancel = this.addCancelListener(reason => {
        if (settled) return;
        settled = true;
        self.activeRiichiCancel = null;
        self.resetActionBar();
        self.hideWaits();
        self.hideCoach();
        reject(new GameCancelledError(reason));
      });
      // 牌を浮かせたとき: その牌を切ると聴牌なら待ち牌を表示
      const onLift = (i) => {
        const all = self.myDrawn ? [...self.myHand, self.myDrawn] : [...self.myHand];
        all.splice(i, 1);
        if (shanten(toCounts(all), view.melds.length) === 0) self.showWaits(all, view.melds.length);
        else self.hideWaits();
      };
      // リーチ中にツモ和了を見送る場合も、合法な打牌はツモ牌だけ。
      const normalIndexes = view.riichi && this.myDrawn ? [view.hand.length] : null;
      const normalPick = () => self.renderHand(true, normalIndexes, (i) => finish({ action: 'discard', index: i, riichi: false }), onLift);
      normalPick();

      if (options.includes('tsumo')) this.addBtn(bar, 'ツモ', 'danger', () => finish({ action: 'tsumo' }));
      if (options.includes('ankan')) {
        for (const k of availableAnkanKinds(this.myHand, this.myDrawn)) {
          this.addBtn(bar, `カン ${tileName(k)}`, '', () => finish({ action: 'ankan', kind: k }));
        }
      }
      if (options.includes('kakan')) {
        for (const k of availableKakanKinds(this.myHand, this.myDrawn, view.melds)) {
          const tiles = new Array(4).fill(null).map(() => ({ kind: k, red: false }));
          const button = this.addTileBtn(bar, '加槓', tiles, 3, () => finish({ action: 'kakan', kind: k }));
          button.classList.add('kan-action');
        }
      }
      if (options.includes('kyuushu')) this.addBtn(bar, '九種九牌', 'pass', () => finish({ action: 'kyuushu' }));

      if (canDeclareRiichi(view, loadRules())) {
        const all = [...this.myHand, this.myDrawn];
        const okIdx = [];
        for (let i = 0; i < all.length; i++) {
          const rest = all.slice(); rest.splice(i, 1);
          if (shanten(toCounts(rest), view.melds.length) === 0) okIdx.push(i);
        }
        if (okIdx.length > 0) {
          this.addBtn(bar, 'リーチ', 'danger', function () {
            riichiMode = !riichiMode;
            this.classList.toggle('pass', riichiMode);
            if (riichiMode) {
              self.activeRiichiCancel = () => {
                if (!riichiMode) return;
                riichiMode = false;
                this.classList.remove('pass');
                self.activeRiichiCancel = null;
                normalPick();
              };
              self.renderHand(true, okIdx, (i) => finish({ action: 'discard', index: i, riichi: true }), onLift);
            } else {
              self.activeRiichiCancel = null;
              normalPick();
            }
          });
        }
      }
    });
  }

  // --- 他家の打牌への反応 (鳴きボタンは牌の絵で示す) ---
  promptClaim(view, offer) {
    this.myHand = view.hand;
    this.myDrawn = null;
    this.areReportContext = { view, options: null, offer };
    this.showCoachClaim(view, offer);
    this.renderHand(false);
    this.hideWaits();
    return new Promise((resolve, reject) => {
      const bar = $('#action-bar');
      this.resetActionBar();
      bar.classList.add('claim-mode');
      bar.dataset.gamepadScope = 'claim';
      bar.setAttribute('role', 'group');
      const prompt = document.createElement('div');
      prompt.className = 'claim-prompt';
      const promptTitle = document.createElement('strong');
      promptTitle.textContent = offer.type === 'ron' ? '和了できます' : '鳴き選択';
      const promptSub = document.createElement('span');
      promptSub.textContent = `${tileName(offer.tile.kind)}への反応`;
      prompt.append(promptTitle, promptSub);
      const coach = this.latestCoachResult;
      if (coach?.headline) {
        const coachLine = document.createElement('strong');
        coachLine.className = 'claim-coach-line';
        coachLine.textContent = coach.headline;
        prompt.appendChild(coachLine);
        if (coach.hasMore) {
          const coachMore = document.createElement('button');
          coachMore.type = 'button';
          coachMore.className = 'claim-coach-more';
          coachMore.textContent = '理由を詳しく';
          coachMore.onclick = () => this.openCoachDetail(coach);
          prompt.appendChild(coachMore);
        }
      }
      const choices = document.createElement('div');
      choices.className = 'claim-options';
      bar.append(prompt, choices);
      bar.setAttribute('aria-label', `${promptTitle.textContent}。${promptSub.textContent}`);
      let settled = false;
      let unregisterCancel = () => {};
      const finish = (result) => {
        if (settled) return;
        settled = true;
        unregisterCancel();
        this.pendingClaimPass = null;
        this.resetActionBar();
        this.hideCoach();
        if (result) this.hideWaits();
        else this.syncWaitHint();
        resolve(result);
      };
      unregisterCancel = this.addCancelListener(reason => {
        if (settled) return;
        settled = true;
        this.pendingClaimPass = null;
        this.resetActionBar();
        this.hideWaits();
        this.hideCoach();
        reject(new GameCancelledError(reason));
      });
      this.pendingClaimPass = offer.type === 'call'
        ? () => finish({ action: 'pass', source: 'autoPreference' })
        : null;
      const t = offer.tile;
      if (offer.type === 'ron') {
        this.addBtn(choices, 'ロン', 'danger', () => finish({ action: 'ron' }));
      } else {
        if (offer.canPon) {
          this.addTileBtn(choices, 'ポン', [t, t, t], 1, () => finish({ action: 'pon' }));
        }
        if (offer.canKan) {
          this.addTileBtn(choices, 'カン', [t, t, t, t], 1, () => finish({ action: 'minkan' }));
        }
        if (offer.canChi) {
          for (const set of offer.canChi) {
            const seq = [...set.map(k => ({ kind: k, red: false })), { ...t }].sort((a, b) => a.kind - b.kind);
            const sideIdx = seq.findIndex(x => x.kind === t.kind);
            this.addTileBtn(choices, 'チー', seq, sideIdx, () => finish({ action: 'chi', tiles: set }));
          }
        }
      }
      this.addBtn(choices, 'スルー', 'pass', () => finish(null));
    });
  }

  resetActionBar() {
    const bar = $('#action-bar');
    if (!bar) return;
    bar.innerHTML = '';
    bar.className = '';
    bar.removeAttribute('data-gamepad-scope');
    bar.removeAttribute('role');
    bar.removeAttribute('aria-label');
  }

  // 牌の絵入りボタン。sideIdxの牌(=鳴く対象の牌)を強調表示
  addTileBtn(bar, label, tiles, sideIdx, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'act-btn tile-btn';
    b.setAttribute('aria-label', `${label} ${tiles.map(t => tileName(t.kind)).join('・')}`);
    const lab = document.createElement('span');
    lab.className = 'tb-label';
    lab.textContent = label;
    b.appendChild(lab);
    const row = document.createElement('span');
    row.className = 'tb-tiles';
    tiles.forEach((t, i) => {
      const el = tileEl(t, { mini: true });
      if (i === sideIdx) el.classList.add('claim-target');
      row.appendChild(el);
    });
    b.appendChild(row);
    b.onclick = () => onClick();
    bar.appendChild(b);
    return b;
  }

  addBtn(bar, label, extraClass, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'act-btn ' + extraClass;
    b.textContent = label;
    b.onclick = function () { onClick.call(this); };
    bar.appendChild(b);
    return b;
  }

  // --- 結果オーバーレイ (Promiseを返して進行を止める) ---
  pinOverlayAction(btnId) {
    const content = $('#overlay-content');
    if (!content) return null;
    const button = content.querySelector(`#${btnId}`);
    if (!button) return null;
    const scroll = document.createElement('div');
    scroll.className = 'overlay-scroll';
    while (content.firstChild) scroll.appendChild(content.firstChild);
    const footer = document.createElement('footer');
    footer.className = 'overlay-progress-actions';
    footer.setAttribute('aria-label', '進行操作');
    footer.appendChild(button);
    content.replaceChildren(scroll, footer);
    return button;
  }

  showOverlayAwait(html, btnId = 'btn-next') {
    return new Promise((resolve, reject) => {
      $('#overlay-content').innerHTML = html;
      const button = this.pinOverlayAction(btnId);
      $('#overlay').classList.remove('hidden');
      let settled = false;
      let unregisterCancel = () => {};
      const cleanup = () => {
        unregisterCancel();
        if (button) button.onclick = null;
      };
      const done = () => {
        if (settled) return;
        settled = true;
        cleanup();
        $('#overlay').classList.add('hidden');
        resolve();
      };
      const fail = reason => {
        if (settled) return;
        settled = true;
        cleanup();
        $('#overlay').classList.add('hidden');
        reject(reason instanceof Error ? reason : new GameCancelledError(reason));
      };
      unregisterCancel = this.addCancelListener(reason => fail(new GameCancelledError(reason)));
      if (button) {
        button.dataset.gamepadDefault = '';
        button.dataset.gamepadBack = '';
        button.onclick = done;
      }
      if (this.spectate) this.pauseAwareDelay(2000).then(done, fail); // 観戦モードは自動送り
    });
  }

  transferHtml(points, deltas) {
    let html = '<div class="transfer">';
    for (let p = 0; p < 4; p++) {
      const d = deltas[p];
      const cls = d > 0 ? 'plus' : d < 0 ? 'minus' : 'zero';
      const sign = d > 0 ? '+' : '';
      html += `<div class="row"><span class="name">${SEAT_LABELS[p]}</span>` +
              `<span class="diff ${cls}">${d === 0 ? '—' : sign + d}</span>` +
              `<span class="now">${points[p]}</span></div>`;
    }
    return html + '</div>';
  }

  // 和了カットイン: 結果画面の前に一呼吸の演出
  async showCutin(text, sub, cls) {
    const el = $('#cutin');
    el.innerHTML = `<div class="cutin-band ${cls}"><div class="big">${text}</div>` +
      (sub ? `<div class="who">${sub}</div>` : '') + '</div>';
    el.classList.remove('hidden');
    await this.pauseAwareDelay(1400);
    el.classList.add('hidden');
  }

  // 結果画面の前に、和了の格に応じた短いシネマティックを必ず挟む。
  // UI側だけの演出で、点数計算・対局状態は一切変えない。
  async showWinCinematic(data) {
    const scene = classifyWinPresentation(data);
    const el = $('#win-cinematic');
    if (!el) return;
    const copy = winCinematicCopy(scene, SEAT_LABELS[data.winner] ?? '和了者',
      data.loser === null ? null : (SEAT_LABELS[data.loser] ?? '放銃者'));
    const content = document.createElement('div');
    content.className = 'win-cinematic-content';
    const tier = document.createElement('div');
    tier.className = 'win-cinematic-tier';
    tier.textContent = scene.tierLabel;
    const action = document.createElement('div');
    action.className = 'win-cinematic-action';
    action.textContent = copy.action;
    const detail = document.createElement('div');
    detail.className = 'win-cinematic-detail';
    detail.textContent = copy.detail;
    const score = document.createElement('div');
    score.className = 'win-cinematic-score';
    score.textContent = `${scene.total.toLocaleString('ja-JP')} 点`;
    content.append(tier, action, detail, score);

    const aura = document.createElement('div');
    aura.className = 'win-cinematic-aura';
    const frame = document.createElement('div');
    frame.className = 'win-cinematic-frame';
    const flash = document.createElement('div');
    flash.className = 'win-cinematic-flash';
    const particles = document.createElement('div');
    particles.className = 'win-cinematic-particles';
    for (let index = 0; index < scene.particleCount; index++) {
      const particle = document.createElement('i');
      particle.className = 'win-cinematic-particle';
      particle.style.setProperty('--angle', `${(index * 137.508) % 360}deg`);
      particle.style.animationDelay = `${(index % 7) * 24}ms`;
      particles.appendChild(particle);
    }
    // 和了牌は、背景フレームの稲妻が落ちる一点へ独立して置く。
    // テキストの流れに追従させず、画面比率が変わっても雷と重なるようにする。
    const strikeTile = document.createElement('div');
    strikeTile.className = 'win-cinematic-strike-tile';
    if (data.winTile) strikeTile.appendChild(tileEl(data.winTile));
    el.replaceChildren(aura, frame, flash, particles, strikeTile, content);
    el.dataset.tier = scene.tier;
    el.dataset.kind = scene.kind;
    el.dataset.lightning = scene.lightning ? 'true' : 'false';
    el.classList.remove('hidden');
    if (scene.screenShake) $('#screen-game')?.classList.add('win-cinematic-shake');
    void this.audio.playSfx('call-accent');

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    const token = ++this.winCinematicSequence;
    await new Promise((resolve, reject) => {
      let settled = false;
      let unregisterCancel = () => {};
      const finish = () => {
        if (settled) return;
        settled = true;
        unregisterCancel();
        if (token === this.winCinematicSequence) {
          el.classList.add('hidden');
          $('#screen-game')?.classList.remove('win-cinematic-shake');
        }
        resolve();
      };
      const fail = reason => {
        if (settled) return;
        settled = true;
        unregisterCancel();
        el.classList.add('hidden');
        $('#screen-game')?.classList.remove('win-cinematic-shake');
        reject(reason instanceof Error ? reason : new GameCancelledError(reason));
      };
      unregisterCancel = this.addCancelListener(reason => fail(new GameCancelledError(reason)));
      // reduced motionでも結果を即時に飛ばさず、和了を認識できる短い静止時間だけ残す。
      this.pauseAwareDelay(reducedMotion ? 420 : scene.durationMs).then(finish, fail);
    });
  }

  // 捨て牌／ツモ牌を卓に置いたまま、和了をまだ告げない一拍。
  // ロンなら「通るか？」、ツモなら「今引いた牌は？」を認知してから結果へ進む。
  stageKakanAddedTile(data) {
    if (data?.action !== 'kakan' || !Number.isInteger(data.player) || !Number.isInteger(data.kind)) return null;
    this.tabletopDrawnSeat = null;
    this.tabletopKakanPreview = {
      seat: data.player,
      tile: data.tile ? { ...data.tile } : { id: `kakan-preview:${data.player}:${data.kind}`, kind: data.kind, red: false },
    };
    if (data.state) this.renderWebGLTabletop(data.state);
    const root = data.player === 0 ? $('#my-melds') : $(`#melds-${data.player}`);
    const melds = data.state?.players?.[data.player]?.melds ?? [];
    const meldIndex = melds.findIndex(meld => meld.type === 'pon' && meld.tiles?.[0]?.kind === data.kind);
    const slot = meldIndex >= 0 ? root?.querySelectorAll('.meld-slot')?.[meldIndex] : null;
    const base = slot?.querySelector('.tabletop-tile-mesh.is-sideways > .tile.sideways');
    if (!base || base.querySelector(':scope > .kakan-added')) return base?.querySelector(':scope > .kakan-added') ?? null;

    const knownTiles = data.player === 0
      ? [...this.myHand, ...(this.myDrawn ? [this.myDrawn] : [])]
      : [];
    const knownTileIndex = knownTiles.findIndex(tile => tile.kind === data.kind);
    const knownTile = knownTileIndex >= 0 ? knownTiles[knownTileIndex] : null;
    const added = tileEl(data.tile ?? knownTile ?? { kind: data.kind, red: false }, {
      mini: data.player !== 0,
    });
    added.classList.add('sideways', 'kakan-added', 'kakan-declared-preview');
    added.dataset.kakanPlayer = String(data.player);
    added.dataset.kakanKind = String(data.kind);
    base.classList.add('kakan-base');
    base.appendChild(added);
    // 自席だけは表向きの元牌も見えているため、同じ物理牌を二重表示しない。
    if (data.player === 0 && knownTileIndex >= 0) $('#my-hand')?.children?.[knownTileIndex]?.remove();
    return added;
  }

  clearWinSuspenseTarget() {
    const screen = $('#screen-game');
    if (!screen) return;
    this.webglTabletop?.clearWinFocus?.();
    screen.querySelectorAll('.win-suspense-tile-effect').forEach(effect => effect.remove());
    screen.querySelectorAll('[data-win-suspense-target]').forEach(target => {
      target.classList.remove(
        'win-suspense-target',
        'win-suspense-target-discard',
        'win-suspense-target-drawn',
        'win-suspense-target-kakan-added',
      );
      delete target.dataset.winSuspenseTarget;
    });
    delete screen.dataset.winSuspenseTarget;
  }

  resolveWinSuspenseTarget(data) {
    const screen = $('#screen-game');
    if (!screen) return null;
    this.clearWinSuspenseTarget();

    const isRon = data?.loser !== null;
    const isChankan = isRon && data?.score?.yaku?.some(yaku => yaku?.name === '槍槓');
    let targetType = 'drawn';
    let target = screen.querySelector('#my-hand .tile.drawn');

    const webglFocus = isChankan
      ? { type: 'chankan-added', seat: data.loser, tile: data.winTile }
      : isRon
        ? { type: 'ron-discard', seat: data.loser, tile: data.winTile,
          serial: this.lastDiscardRef?.discardSerial }
        : data?.winner !== 0
          ? { type: 'tsumo-drawn', seat: data.winner, tile: data.winTile }
          : null;
    if (webglFocus && this.webglTabletop?.focusWinTarget?.(webglFocus)) {
      targetType = webglFocus.type;
      screen.dataset.winSuspenseTarget = targetType;
      return { target: null, targetType, effect: null, webgl: true };
    }

    if (isChankan) {
      targetType = 'kakan-added';
      target = screen.querySelector(
        `.kakan-added.kakan-declared-preview[data-kakan-player="${data.loser}"]`,
      ) ?? screen.querySelector(`#melds-${data.loser} .kakan-added, #my-melds .kakan-added`);
    } else if (isRon) {
      targetType = 'discard';
      // 最終打牌の正本はtileではなく、パースと揺らぎを所有する外側placement。
      target = screen.querySelector('.tabletop-placement.is-last-discard');
    }

    screen.dataset.winSuspenseTarget = target ? targetType : 'none';
    if (!target) return null;
    target.dataset.winSuspenseTarget = targetType;
    target.classList.add('win-suspense-target', `win-suspense-target-${targetType}`);

    // placement/mesh本体のtransformは絶対に触らず、専用の内側effectだけを動かす。
    const effectHost = targetType === 'discard'
      ? target.querySelector('.tabletop-tile-mesh') ?? target
      : target;
    const effect = document.createElement('span');
    effect.className = 'win-suspense-tile-effect';
    effect.setAttribute('aria-hidden', 'true');
    effectHost.appendChild(effect);
    return { target, targetType, effect };
  }

  // リザルトの役・点数を一段ずつ「バン!」と見せる。タップで即スキップ。
  async playWinReveal() {
    const overlay = $('#overlay');
    if (!overlay) return;
    const steps = [...overlay.querySelectorAll('.reveal-step')];
    if (steps.length === 0) return;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    for (const step of steps) step.classList.add('reveal-pending');
    let skipped = reducedMotion;
    const skip = () => { skipped = true; };
    overlay.addEventListener('pointerdown', skip, { once: true });
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (const step of steps) {
      if (!skipped) {
        const beat = step.classList.contains('reveal-slam') ? 620
          : step.classList.contains('reveal-pop') ? 480
          : 180;
        await wait(beat);
      }
      if (skipped) {
        for (const rest of steps) {
          rest.classList.remove('reveal-pending');
          rest.classList.add('reveal-instant');
        }
        break;
      }
      step.classList.remove('reveal-pending');
      step.classList.add('reveal-shown');
    }
    overlay.removeEventListener('pointerdown', skip);
  }

  async showWinSuspense(data) {
    const screen = $('#screen-game');
    if (!screen) return;
    const kind = data.loser === null ? 'tsumo' : 'ron';
    this.resolveWinSuspenseTarget(data);
    screen.dataset.winSuspense = kind;
    screen.classList.add('win-suspense', `win-suspense-${kind}`);
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    try {
      await this.pauseAwareDelay(reducedMotion ? 260 : winSuspenseDuration(data));
    } finally {
      delete screen.dataset.winSuspense;
      screen.classList.remove('win-suspense', `win-suspense-${kind}`);
      this.clearWinSuspenseTarget();
    }
  }

  async showWin(data) {
    this.hideWaits();
    const { winner, loser, score, deltas } = data;
    const who = SEAT_LABELS[winner];
    const how = loser === null ? 'ツモ' : 'ロン';
    // ここで先にrenderBoardすると点数移動と和了事実を先出ししてしまう。
    // 直前のdiscard/drawイベントが描いた卓を残したまま、必ず認知の間を取る。
    await this.showWinSuspense(data);
    this.tabletopDrawnSeat = null;
    this.tabletopKakanPreview = null;
    this.renderBoard(data.state);
    this.playCharacterVoice(winner, loser === null ? 'tsumo' : 'ron', { critical: true });
    await this.showWinCinematic(data);
    let html = `<h2>${how}</h2><div class="win-sub">${who}${loser !== null ? `　←　${SEAT_LABELS[loser]}` : ''}</div>`;
    html += `<div class="win-hand" id="win-hand-box"></div>`;
    html += `<div class="dora-line" id="dora-line-box"></div>`;
    for (const y of score.yaku) {
      html += `<div class="yaku-line reveal-step reveal-pop"><span>${y.name}</span><span class="han">${y.yakuman ? (y.yakuman >= 2 ? 'ダブル役満' : '役満') : y.han + '翻'}</span></div>`;
    }
    if (score.limitName) html += `<div class="limit-name reveal-step reveal-slam">${score.limitName}</div>`;
    // 点数は「手の点 → 本場 → 供託 → 合計」を一段ずつ見せる
    const hasBonus = (score.honbaBonus || 0) > 0 || (score.stickBonus || 0) > 0;
    if (hasBonus && Number.isFinite(score.handTotal)) {
      html += `<div class="score-breakdown reveal-step reveal-pop">${score.handTotal}点</div>`;
      if (score.honbaBonus > 0) html += `<div class="score-breakdown reveal-step reveal-pop">本場 +${score.honbaBonus}点</div>`;
      if (score.stickBonus > 0) html += `<div class="score-breakdown reveal-step reveal-pop">供託 +${score.stickBonus}点</div>`;
      html += `<div class="score-total reveal-step reveal-slam">合計 ${score.total}点</div>`;
    } else {
      html += `<div class="score-total reveal-step reveal-slam">${score.total}点</div>`;
    }
    if (!score.yakumanCount) html += `<div class="fu-han reveal-step">${score.fu}符 ${score.han}翻</div>`;
    html += `<div class="reveal-step">${this.transferHtml(data.state.points, deltas)}</div>`;
    html += `<button class="btn primary big reveal-step" id="btn-next">次へ</button>`;

    const done = this.showOverlayAwait(html);
    void this.playWinReveal();
    // 手牌+和了牌
    const handBox = $('#win-hand-box');
    const tiles = [...data.hand].sort((a, b) => a.kind - b.kind);
    for (const t of tiles) handBox.appendChild(tileEl(t));
    for (const m of data.melds) { const gap = document.createElement('span'); gap.style.width = '8px'; handBox.appendChild(gap); handBox.appendChild(meldEl(m, false, data.winner)); }
    if (data.winTile) {
      const wt = document.createElement('div');
      wt.className = 'win-tile-box';
      wt.innerHTML = `<span class="lbl">${how}</span>`;
      wt.appendChild(tileEl(data.winTile));
      handBox.appendChild(wt);
    }
    // ドラ表示
    const dl = $('#dora-line-box');
    dl.insertAdjacentHTML('beforeend', '<span class="lbl">ドラ表示</span>');
    for (const t of data.doraInd || []) dl.appendChild(tileEl(t));
    if ((data.uraInd || []).length > 0) {
      dl.insertAdjacentHTML('beforeend', '<span class="lbl" style="margin-left:8px">裏</span>');
      for (const t of data.uraInd) dl.appendChild(tileEl(t));
    }
    await done;
  }

  async showRyukyoku(data) {
    this.renderBoard(data.state);
    let html = `<h2>流局</h2>`;
    if (data.tochu) html += `<div class="win-sub">途中流局</div>`;
    else if (data.tenpai.length === 0) html += `<div class="win-sub">全員ノーテン</div>`;
    else html += `<div class="win-sub">聴牌: ${data.tenpai.map(p => SEAT_LABELS[p]).join('、')}</div>`;
    if ((data.revealed || []).length > 0) {
      html += '<div class="reveal" id="reveal-box"></div>';
    }
    html += this.transferHtml(data.state.points, data.deltas);
    html += `<button class="btn primary big" id="btn-next">次へ</button>`;
    const done = this.showOverlayAwait(html);
    const rv = $('#reveal-box');
    if (rv) {
      for (const r of data.revealed) {
        const row = document.createElement('div');
        row.className = 'rv-row';
        row.innerHTML = `<span class="nm">${SEAT_LABELS[r.player]}</span>`;
        for (const t of [...r.hand].sort((a, b) => a.kind - b.kind)) row.appendChild(tileEl(t));
        for (const m of r.melds || []) row.appendChild(meldEl(m, true, r.player));
        rv.appendChild(row);
      }
    }
    await done;
  }

  async showNagashi(data) {
    let html = `<h2>流し満貫</h2><div class="win-sub">${SEAT_LABELS[data.player]}</div>`;
    html += this.transferHtml(data.state.points, data.deltas);
    html += `<button class="btn primary big" id="btn-next">次へ</button>`;
    await this.showOverlayAwait(html);
  }

  async showGameEnd(data) {
    const rules = this.game?.rules ?? loadRules();
    {
      // 成績蓄積: 自分の最終スコア(千点単位の浮き沈み)込みで半荘を確定
      const myRankIndex = data.ranking.indexOf(0);
      const uma = (rules.uma?.[myRankIndex] ?? 0) * 1000;
      const oka = myRankIndex === 0 ? (rules.returnPoints - rules.startPoints) * 4 : 0;
      const finalScore = Math.round((data.points[0] - rules.returnPoints + uma + oka) / 1000);
      this.stats.finishGame({ ranking: data.ranking, points: data.points, finalScore });
    }
    let html = `<h2>終局</h2>`;
    data.ranking.forEach((p, rank) => {
      const uma = rules.uma[rank] * 1000;
      const oka = rank === 0 ? (rules.returnPoints - rules.startPoints) * 4 : 0;
      const finalPt = data.points[p] - rules.returnPoints + uma + oka;
      html += `<div class="rank-line"><span>${rank + 1}位 ${SEAT_LABELS[p]}</span>` +
              `<span class="pt">${data.points[p]}点 (${finalPt >= 0 ? '+' : ''}${Math.round(finalPt / 1000)})</span></div>`;
    });
    html += `<button class="btn primary big" id="btn-title">タイトルへ</button>`;
    await this.showOverlayAwait(html, 'btn-title');
    await clearActiveSession(this.preferenceStorage).catch(error => {
      console.warn('Completed session could not be cleared.', error);
    });
    this.savedSession = null;
    show('title');
    await this.refreshSavedSession();
  }
}

// ============ 画面遷移 ============
function show(name) {
  for (const s of ['title', 'rules', 'game']) $(`#screen-${s}`).classList.toggle('hidden', s !== name);
  // 「あれ?」ボタンはtransform祖先の影響を避けるためbody直下へ置き、対局画面と連動して出す
  const areButton = $('#are-report-button');
  if (areButton) {
    if (areButton.parentElement !== document.body) document.body.appendChild(areButton);
    areButton.classList.toggle('hidden', name !== 'game');
  }
}

function initTitleAtmosphere() {
  const title = $('#screen-title');
  if (!title) return;
  const reset = () => {
    title.style.setProperty('--title-parallax-x', '0px');
    title.style.setProperty('--title-parallax-y', '0px');
  };
  title.addEventListener('pointermove', event => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
    const rect = title.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / Math.max(1, rect.width) - .5) * 8;
    const y = ((event.clientY - rect.top) / Math.max(1, rect.height) - .5) * 6;
    title.style.setProperty('--title-parallax-x', `${x.toFixed(2)}px`);
    title.style.setProperty('--title-parallax-y', `${y.toFixed(2)}px`);
  });
  title.addEventListener('pointerleave', reset);
}

async function bootstrap() {
  await hydrateDesktopSettings(window.localStorage);
  const uiInstance = new UI();
  initTitleAtmosphere();
  uiInstance.gamepadController = installGamepadController({ document, window });
  await uiInstance.refreshSavedSession();
  $('#btn-start').onclick = () => {
    void uiInstance.audio.unlock();
    void (async () => {
      await clearActiveSession(window.localStorage).catch(error => {
        console.warn('Previous session could not be cleared before a new match.', error);
      });
      uiInstance.savedSession = null;
      uiInstance.startGame();
    })();
  };
  $('#btn-resume-session').onclick = () => {
    void uiInstance.audio.unlock();
    if (uiInstance.savedSession) uiInstance.startGame(uiInstance.savedSession);
  };
  $('#btn-rules').onclick = () => {
    void uiInstance.audio.unlock();
    renderRulesScreen();
    show('rules');
  };
  $('#btn-rules-done').onclick = () => show('title');
  show('title');

  // 開発用: ?autostart で即対局開始(スクリーンショット検品用)
  if (location.search.includes('autostart')) uiInstance.startGame();
}

void bootstrap().catch(error => {
  console.error('Application bootstrap failed.', error);
  show('title');
});

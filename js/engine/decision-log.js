// decision-log.js — 1局内の公開履歴と全判断を順序どおり保存する台帳
//
// Game は判断の直前に beginDecision()、actor の応答確定後に
// commitDecision() を必ず1回ずつ呼ぶ。保存値は生成時に deep copy/freeze
// されるため、対局後の結果や UI 側の変更で「当時見えていた情報」が
// 書き換わることはない。

import {
  createDecisionRecord,
  createDecisionRequest,
  validateDecisionRequest,
  validatePublicHistory,
} from './decision-contract.js';

export const DECISION_LOG_VERSION = 2;
export const DEFAULT_RULES_VERSION = 'riichi-rules-v1';
export const DEFAULT_EVALUATOR_VERSION = 'jun-evaluator-v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PUBLIC_EVENT_TYPES = new Set([
  'roundStart',
  'draw',
  'discard',
  'claim',
  'kan',
  'kyuushu',
  'win',
  'ryukyoku',
  'nagashi',
]);

const PUBLIC_EVENT_FIELDS = Object.freeze({
  roundStart: ['roundWindIdx', 'kyoku', 'initialDealer', 'dealer', 'honba', 'riichiSticks', 'points', 'doraIndicators'],
  draw: ['actor', 'remaining', 'rinshan'],
  discard: ['actor', 'tile', 'riichi', 'tsumogiri'],
  claim: ['actor', 'from', 'action', 'tile'],
  kan: ['actor', 'action', 'kind', 'kanCount'],
  kyuushu: ['actor'],
  win: ['winner', 'loser', 'winTile', 'deltas'],
  ryukyoku: ['tochu', 'tenpai', 'deltas'],
  nagashi: ['actor', 'deltas'],
});

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function cloneJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('decision log accepts finite JSON numbers only');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('decision log accepts JSON values only');
  if (seen.has(value)) throw new TypeError('decision log cannot contain circular references');
  seen.add(value);
  let copy;
  if (Array.isArray(value)) {
    copy = value.map(item => cloneJson(item, seen));
  } else {
    assertPlainObject(value, 'decision log value');
    copy = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new TypeError(`unsafe decision log key: ${key}`);
      }
      copy[key] = cloneJson(item, seen);
    }
  }
  seen.delete(value);
  return copy;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshot(value) {
  return deepFreeze(cloneJson(value));
}

function assertId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError(`${label} must be a safe identifier`);
  }
}

function roundIdFor(matchId, serial, round) {
  const wind = Number.isInteger(round.roundWindIdx) ? round.roundWindIdx : 0;
  const kyoku = Number.isInteger(round.kyoku) ? round.kyoku : 0;
  const honba = Number.isInteger(round.honba) ? round.honba : 0;
  return `${matchId}:r${serial}:w${wind}:k${kyoku}:h${honba}`;
}

export class DecisionLog {
  constructor({
    matchId = 'local-match',
    rulesVersion = DEFAULT_RULES_VERSION,
    evaluatorVersion = DEFAULT_EVALUATOR_VERSION,
  } = {}) {
    assertId(matchId, 'matchId');
    assertId(rulesVersion, 'rulesVersion');
    assertId(evaluatorVersion, 'evaluatorVersion');
    this.matchId = matchId;
    this.rulesVersion = rulesVersion;
    this.evaluatorVersion = evaluatorVersion;
    this.roundSerial = 0;
    this.roundId = null;
    this.timelineSequence = 0;
    this.stateRevision = 0;
    this.stateId = null;
    this.publicHistory = [];
    this.records = [];
    this.rounds = [];
    this.pending = null;
  }

  startRound(round = {}) {
    assertPlainObject(round, 'round');
    if (this.pending) throw new Error(`cannot start a round while ${this.pending.id} is pending`);
    if (this.roundId) this.finishRound();
    this.roundSerial++;
    this.roundId = roundIdFor(this.matchId, this.roundSerial, round);
    this.timelineSequence = 0;
    this.stateRevision = 0;
    this.stateId = `${this.roundId}:s0`;
    this.publicHistory = [];
    this.records = [];
    this.roundMeta = snapshot({
      roundWindIdx: round.roundWindIdx ?? 0,
      kyoku: round.kyoku ?? 0,
      honba: round.honba ?? 0,
    });
    return this.roundId;
  }

  advanceState() {
    if (!this.roundId) throw new Error('startRound() is required before state changes');
    if (this.pending) throw new Error(`cannot mutate state while ${this.pending.id} is pending`);
    this.stateRevision++;
    this.stateId = `${this.roundId}:s${this.stateRevision}`;
    return this.stateId;
  }

  appendPublicEvent(type, data = {}) {
    if (!this.roundId) throw new Error('startRound() is required before public events');
    if (!PUBLIC_EVENT_TYPES.has(type)) throw new TypeError(`unsupported public event type: ${type}`);
    assertPlainObject(data, 'public event data');
    const allowed = new Set(PUBLIC_EVENT_FIELDS[type]);
    for (const key of Object.keys(data)) {
      if (!allowed.has(key)) throw new TypeError(`unsupported ${type} event field: ${key}`);
    }
    const event = snapshot({
      sequence: this.timelineSequence++,
      type,
      stateId: this.stateId,
      ...data,
    });
    validatePublicHistory([event]);
    this.publicHistory.push(event);
    return event;
  }

  beginDecision({
    kind,
    actor,
    options = [],
    view,
    availableCandidates,
    analysisSeed,
    evaluatorVersion = this.evaluatorVersion,
  }) {
    if (!this.roundId) throw new Error('startRound() is required before decisions');
    if (this.pending) throw new Error(`decision ${this.pending.id} is still pending`);
    if (view?.public?.stateId !== this.stateId) {
      throw new Error(`view stateId ${view?.public?.stateId ?? '(missing)'} does not match ${this.stateId}`);
    }
    const sequence = this.timelineSequence++;
    const request = createDecisionRequest({
      roundId: this.roundId,
      sequence,
      stateId: this.stateId,
      evaluatorVersion,
      rulesVersion: this.rulesVersion,
      kind,
      actor,
      options,
      view,
      publicHistory: this.publicHistory,
      availableCandidates,
      analysisSeed: analysisSeed ?? `${this.roundId}:d${sequence}`,
    });
    this.pending = request;
    return request;
  }

  commitDecision(request, choice) {
    validateDecisionRequest(request);
    if (!this.pending || request.id !== this.pending.id) {
      throw new Error(`decision ${request.id} is not the current pending decision`);
    }
    const record = createDecisionRecord(this.pending, choice);
    this.records.push(record);
    this.pending = null;
    return record;
  }

  finishRound(resultPointer = null) {
    if (!this.roundId) return null;
    if (this.pending) throw new Error(`cannot finish a round while ${this.pending.id} is pending`);
    if (resultPointer !== null && (typeof resultPointer !== 'string' || resultPointer.length === 0)) {
      throw new TypeError('resultPointer must be null or a non-empty string');
    }
    const round = snapshot({
      roundId: this.roundId,
      meta: this.roundMeta,
      publicHistory: this.publicHistory,
      decisions: this.records,
      resultPointer,
    });
    this.rounds.push(round);
    this.roundId = null;
    this.stateId = null;
    this.publicHistory = [];
    this.records = [];
    return round;
  }

  exportMatch() {
    if (this.pending) throw new Error(`cannot export while ${this.pending.id} is pending`);
    const completed = [...this.rounds];
    if (this.roundId) {
      completed.push(snapshot({
        roundId: this.roundId,
        meta: this.roundMeta,
        publicHistory: this.publicHistory,
        decisions: this.records,
        resultPointer: null,
      }));
    }
    return snapshot({
      schemaVersion: DECISION_LOG_VERSION,
      type: 'decisionLog',
      matchId: this.matchId,
      rulesVersion: this.rulesVersion,
      evaluatorVersion: this.evaluatorVersion,
      rounds: completed,
    });
  }
}

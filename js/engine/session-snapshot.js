// session-snapshot.js — 局途中セーブの決定的replay契約
//
// 非公開の初期山と、局開始時のmatch counter、確定済みactionだけを保存する。
// 復元時は同じ山で局を最初から再生し、最後のaction適用後の安全境界で止める。
// Promise、timer、DOM、未確定DecisionRequest、途中のclaim cursorは保存しない。
// この文書は全員の将来牌を含むためUI／actor view／DecisionRecordへ渡してはならない。

import {
  DECISION_SOURCES,
  validateDecisionRecord,
} from './decision-contract.js';
import { DEFAULT_RULES } from './rules.js';

export const SESSION_SNAPSHOT_VERSION = 1;
export const SESSION_SNAPSHOT_TYPE = 'privateRoundReplay';
export const SESSION_SNAPSHOT_VISIBILITY = 'private-local-save';
export const MAX_SESSION_SNAPSHOT_JSON_BYTES = 1024 * 1024;

const ROOT_KEYS = new Set([
  'schemaVersion', 'type', 'visibility', 'createdAt', 'matchId',
  'rules', 'roundStart', 'wall', 'decisions',
]);
const ROUND_START_KEYS = new Set([
  'points', 'roundWindIdx', 'kyoku', 'initialDealer', 'honba', 'riichiSticks',
]);
const ROUND_START_REQUIRED_KEYS = new Set([
  'points', 'roundWindIdx', 'kyoku', 'honba', 'riichiSticks',
]);
const TILE_KEYS = new Set(['kind', 'red', 'id']);
const DECISION_KEYS = new Set(['actor', 'kind', 'actionId', 'source']);
const RULE_KEYS = new Set(Object.keys(DEFAULT_RULES));
const BOOLEAN_RULE_KEYS = new Set(Object.entries(DEFAULT_RULES)
  .filter(([, value]) => typeof value === 'boolean')
  .map(([key]) => key));
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class SessionSnapshotError extends TypeError {
  constructor(message, code = 'INVALID_SESSION_SNAPSHOT', path = '$') {
    super(`${path}: ${message}`);
    this.name = 'SessionSnapshotError';
    this.code = code;
    this.path = path;
  }
}

function fail(path, message, code = 'INVALID_SESSION_SNAPSHOT') {
  throw new SessionSnapshotError(message, code, path);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, path) {
  if (!isPlainObject(value)) fail(path, 'must be a plain object', 'INVALID_OBJECT');
}

function rejectUnknownKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'is not supported', 'UNEXPECTED_FIELD');
  }
}

function requireKeys(value, required, path) {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(`${path}.${key}`, 'is required', 'MISSING_FIELD');
    }
  }
}

function cloneJson(value, path = '$', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'must be a finite JSON number', 'NON_JSON_VALUE');
    return value;
  }
  if (typeof value !== 'object') fail(path, 'must be JSON-safe', 'NON_JSON_VALUE');
  if (seen.has(value)) fail(path, 'must not contain circular references', 'CYCLIC_VALUE');
  seen.add(value);
  let copy;
  if (Array.isArray(value)) {
    copy = [];
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) fail(`${path}[${index}]`, 'array holes are not supported', 'NON_JSON_VALUE');
      copy.push(cloneJson(value[index], `${path}[${index}]`, seen));
    }
  } else {
    assertPlainObject(value, path);
    if (Object.getOwnPropertySymbols(value).length > 0) {
      fail(path, 'symbol keys are not supported', 'NON_JSON_VALUE');
    }
    copy = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        fail(`${path}.${key}`, 'unsafe object key', 'UNSAFE_KEY');
      }
      copy[key] = cloneJson(item, `${path}.${key}`, seen);
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

function integer(value, path, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(path, `must be an integer from ${min} to ${max}`, 'INVALID_INTEGER');
  }
  return value;
}

function boolean(value, path) {
  if (typeof value !== 'boolean') fail(path, 'must be boolean', 'INVALID_BOOLEAN');
  return value;
}

function enumString(value, allowed, path) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(path, `must be one of ${allowed.join(', ')}`, 'INVALID_ENUM');
  }
  return value;
}

function exactString(value, expected, path) {
  if (value !== expected) fail(path, `must be ${JSON.stringify(expected)}`, 'INVALID_LITERAL');
  return value;
}

function safeId(value, path, pattern = SAFE_ID) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(path, 'must be a safe identifier', 'INVALID_ID');
  }
  return value;
}

function canonicalCreatedAt(value, path) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(path, 'must be an ISO-8601 timestamp', 'INVALID_TIMESTAMP');
  }
  let canonical;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    fail(path, 'must be an ISO-8601 timestamp', 'INVALID_TIMESTAMP');
  }
  if (canonical !== value) fail(path, 'must use canonical UTC ISO-8601 form', 'INVALID_TIMESTAMP');
  return value;
}

function normalizeRules(value, path) {
  assertPlainObject(value, path);
  rejectUnknownKeys(value, RULE_KEYS, path);
  requireKeys(value, RULE_KEYS, path);
  const rules = {};
  for (const key of Object.keys(DEFAULT_RULES)) {
    const rule = value[key];
    if (BOOLEAN_RULE_KEYS.has(key)) rules[key] = boolean(rule, `${path}.${key}`);
    else if (key === 'gameLength') rules[key] = enumString(rule, ['tonpuu', 'tonnan', 'issou'], `${path}.${key}`);
    else if (key === 'akaDora') rules[key] = integer(rule, `${path}.${key}`, 0, 4);
    else if (key === 'startPoints' || key === 'returnPoints') rules[key] = integer(rule, `${path}.${key}`, 0, 100000);
    else if (key === 'uma') {
      if (!Array.isArray(rule) || rule.length !== 4) fail(`${path}.${key}`, 'must contain four values', 'INVALID_ARRAY');
      rules[key] = rule.map((item, index) => integer(item, `${path}.${key}[${index}]`, -100, 100));
    } else if (key === 'renhou') rules[key] = enumString(rule, ['none', 'mangan', 'yakuman'], `${path}.${key}`);
    else fail(`${path}.${key}`, 'has no schema validator', 'UNSUPPORTED_RULE');
  }
  if (![0, 3, 4].includes(rules.akaDora)) fail(`${path}.akaDora`, 'must be 0, 3, or 4', 'INVALID_RULE');
  return rules;
}

function normalizeRoundStart(value, path, rules) {
  assertPlainObject(value, path);
  rejectUnknownKeys(value, ROUND_START_KEYS, path);
  requireKeys(value, ROUND_START_REQUIRED_KEYS, path);
  if (!Array.isArray(value.points) || value.points.length !== 4) {
    fail(`${path}.points`, 'must contain four scores', 'INVALID_ARRAY');
  }
  const points = value.points.map((score, index) => {
    const normalized = integer(score, `${path}.points[${index}]`, -1000000, 1000000);
    if (normalized % 100 !== 0) fail(`${path}.points[${index}]`, 'must use 100-point units', 'INVALID_SCORE');
    return normalized;
  });
  const roundWindIdx = integer(value.roundWindIdx, `${path}.roundWindIdx`, 0, 3);
  const maximumWind = rules.gameLength === 'tonpuu' ? 0 : rules.gameLength === 'tonnan' ? 1 : 3;
  if (roundWindIdx > maximumWind) fail(`${path}.roundWindIdx`, 'is outside the configured game length', 'INVALID_ROUND');
  const kyoku = integer(value.kyoku, `${path}.kyoku`, 0, 3);
  // v16以前の保存は起家固定（自席0）だった。field欠落だけをその意味で移行し、
  // 新しい保存は必ず正規化結果へ initialDealer を持たせる。
  const initialDealer = value.initialDealer === undefined
    ? 0
    : integer(value.initialDealer, `${path}.initialDealer`, 0, 3);
  const honba = integer(value.honba, `${path}.honba`, 0, 999);
  const riichiSticks = integer(value.riichiSticks, `${path}.riichiSticks`, 0, 999);
  const conserved = points.reduce((sum, score) => sum + score, 0) + riichiSticks * 1000;
  if (conserved !== rules.startPoints * 4) {
    fail(path, 'points plus riichi sticks do not conserve the match total', 'POINT_TOTAL_MISMATCH');
  }
  return { points, roundWindIdx, kyoku, initialDealer, honba, riichiSticks };
}

function expectedRed(kind, id, akaDora) {
  const copy = id % 4;
  if (kind === 4 || kind === 22) return akaDora >= 3 && copy === 0;
  if (kind === 13) return (akaDora >= 3 && copy === 0) || (akaDora === 4 && copy === 1);
  return false;
}

function normalizeWall(value, path, rules) {
  if (!Array.isArray(value) || value.length !== 136) {
    fail(path, 'must contain all 136 physical tiles in initial order', 'INVALID_WALL');
  }
  const seen = new Set();
  const wall = value.map((valueTile, index) => {
    const tilePath = `${path}[${index}]`;
    assertPlainObject(valueTile, tilePath);
    rejectUnknownKeys(valueTile, TILE_KEYS, tilePath);
    requireKeys(valueTile, TILE_KEYS, tilePath);
    const id = integer(valueTile.id, `${tilePath}.id`, 0, 135);
    const kind = integer(valueTile.kind, `${tilePath}.kind`, 0, 33);
    const red = boolean(valueTile.red, `${tilePath}.red`);
    if (seen.has(id)) fail(`${tilePath}.id`, 'duplicates a physical tile', 'DUPLICATE_PHYSICAL_TILE');
    seen.add(id);
    if (Math.floor(id / 4) !== kind || red !== expectedRed(kind, id, rules.akaDora)) {
      fail(tilePath, 'kind/red does not match physical id and red-five rules', 'PHYSICAL_TILE_MISMATCH');
    }
    return { kind, red, id };
  });
  if (seen.size !== 136 || [...Array(136).keys()].some(id => !seen.has(id))) {
    fail(path, 'must contain physical ids 0 through 135 exactly once', 'INVALID_WALL');
  }
  return wall;
}

function normalizeDecision(value, path) {
  assertPlainObject(value, path);
  rejectUnknownKeys(value, DECISION_KEYS, path);
  requireKeys(value, DECISION_KEYS, path);
  return {
    actor: integer(value.actor, `${path}.actor`, 0, 3),
    kind: enumString(value.kind, ['turn', 'claim'], `${path}.kind`),
    actionId: safeId(value.actionId, `${path}.actionId`, ACTION_ID_PATTERN),
    source: enumString(value.source, DECISION_SOURCES, `${path}.source`),
  };
}

function normalizeRoot(input) {
  assertPlainObject(input, '$');
  rejectUnknownKeys(input, ROOT_KEYS, '$');
  requireKeys(input, ROOT_KEYS, '$');
  if (input.schemaVersion !== SESSION_SNAPSHOT_VERSION) {
    fail('$.schemaVersion', 'session snapshot version is unsupported', 'UNSUPPORTED_SESSION_SNAPSHOT_VERSION');
  }
  exactString(input.type, SESSION_SNAPSHOT_TYPE, '$.type');
  exactString(input.visibility, SESSION_SNAPSHOT_VISIBILITY, '$.visibility');
  const createdAt = canonicalCreatedAt(input.createdAt, '$.createdAt');
  const matchId = safeId(input.matchId, '$.matchId');
  const rules = normalizeRules(input.rules, '$.rules');
  const roundStart = normalizeRoundStart(input.roundStart, '$.roundStart', rules);
  const wall = normalizeWall(input.wall, '$.wall', rules);
  if (!Array.isArray(input.decisions) || input.decisions.length > 1000) {
    fail('$.decisions', 'must contain at most 1000 committed choices', 'INVALID_ARRAY');
  }
  const decisions = input.decisions.map((decision, index) => normalizeDecision(decision, `$.decisions[${index}]`));
  return {
    schemaVersion: SESSION_SNAPSHOT_VERSION,
    type: SESSION_SNAPSHOT_TYPE,
    visibility: SESSION_SNAPSHOT_VISIBILITY,
    createdAt, matchId, rules, roundStart, wall, decisions,
  };
}

/** Validate, clone and deeply freeze an explicit replay document. */
export function createSessionSnapshot(input) {
  return deepFreeze(normalizeRoot(cloneJson(input)));
}

/** Return true or throw SessionSnapshotError without exposing a normalized private clone. */
export function validateSessionSnapshot(input) {
  createSessionSnapshot(input);
  return true;
}

/**
 * Reduce full DecisionRecords to the only data replay needs. actor/kind are retained
 * because common IDs such as claim:pass can occur in different seats and offers.
 * Validation first prevents smuggling a private wall through a malformed record.
 */
export function replayChoicesFromDecisionRecords(records) {
  if (!Array.isArray(records) || records.length > 1000) {
    fail('records', 'must contain at most 1000 DecisionRecords', 'INVALID_ARRAY');
  }
  const choices = records.map((record, index) => {
    try {
      validateDecisionRecord(record);
    } catch (error) {
      fail(`records[${index}]`, error.message,
        error.code === 'HIDDEN_INFORMATION' ? 'HIDDEN_INFORMATION' : 'INVALID_DECISION_RECORD');
    }
    return {
      actor: record.actor,
      kind: record.kind,
      actionId: record.chosen.actionId,
      source: record.chosen.source,
    };
  });
  return deepFreeze(choices);
}

/**
 * Capture every committed decision. A committed choice is already final even if its
 * state mutation has not run yet; replay applies that exact choice and never asks the
 * COM again after its thought was shown. An uncommitted pending request is ignored and
 * will be recreated naturally after the committed prefix is replayed.
 */
export function captureSessionSnapshot({
  createdAt, rules, roundStart, wall, decisionLog,
}) {
  if (!decisionLog || typeof decisionLog !== 'object') {
    fail('decisionLog', 'is required', 'MISSING_DECISION_LOG');
  }
  if (!decisionLog.roundId || !decisionLog.roundMeta) {
    fail('decisionLog', 'must have an active round', 'MISSING_DECISION_ROUND');
  }
  if (decisionLog.roundMeta.roundWindIdx !== roundStart?.roundWindIdx ||
      decisionLog.roundMeta.kyoku !== roundStart?.kyoku ||
      decisionLog.roundMeta.honba !== roundStart?.honba) {
    fail('decisionLog.roundMeta', 'does not match roundStart', 'DECISION_ROUND_MISMATCH');
  }
  if (!Array.isArray(decisionLog.records)) {
    fail('decisionLog.records', 'must be an array', 'INVALID_ARRAY');
  }
  return createSessionSnapshot({
    schemaVersion: SESSION_SNAPSHOT_VERSION,
    type: SESSION_SNAPSHOT_TYPE,
    visibility: SESSION_SNAPSHOT_VISIBILITY,
    createdAt,
    matchId: decisionLog.matchId,
    rules,
    roundStart,
    wall,
    decisions: replayChoicesFromDecisionRecords(decisionLog.records),
  });
}

export function serializeSessionSnapshot(snapshot) {
  return JSON.stringify(createSessionSnapshot(snapshot));
}

export function deserializeSessionSnapshot(json) {
  if (typeof json !== 'string') fail('$', 'serialized snapshot must be a string', 'INVALID_SERIALIZED_SNAPSHOT');
  if (new TextEncoder().encode(json).byteLength > MAX_SESSION_SNAPSHOT_JSON_BYTES) {
    fail('$', 'serialized snapshot is too large', 'SESSION_SNAPSHOT_TOO_LARGE');
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    fail('$', 'serialized snapshot is not valid JSON', 'CORRUPT_SESSION_SNAPSHOT');
  }
  return createSessionSnapshot(parsed);
}

/**
 * Return a fresh mutable replay plan. Game supplies the wall verbatim, resolves every
 * actionId against that moment's legal candidates, and stops after decisions.length.
 */
export function restoreSessionSnapshot(snapshotOrJson) {
  const snapshot = typeof snapshotOrJson === 'string'
    ? deserializeSessionSnapshot(snapshotOrJson)
    : createSessionSnapshot(snapshotOrJson);
  return {
    matchId: snapshot.matchId,
    rules: cloneJson(snapshot.rules),
    roundStart: cloneJson(snapshot.roundStart),
    wall: cloneJson(snapshot.wall),
    decisions: cloneJson(snapshot.decisions),
  };
}

/** Resolve a persisted choice without clamp, retry, fallback, or seat/kind drift. */
export function resolveReplayChoice(choice, legalCandidates, expected) {
  const normalized = normalizeDecision(cloneJson(choice, 'choice'), 'choice');
  assertPlainObject(expected, 'expected');
  const expectedKeys = new Set(['actor', 'kind']);
  rejectUnknownKeys(expected, expectedKeys, 'expected');
  requireKeys(expected, expectedKeys, 'expected');
  const expectedActor = integer(expected.actor, 'expected.actor', 0, 3);
  const expectedKind = enumString(expected.kind, ['turn', 'claim'], 'expected.kind');
  if (normalized.actor !== expectedActor || normalized.kind !== expectedKind) {
    fail('choice', 'actor/kind does not match the current decision', 'REPLAY_DIVERGENCE');
  }
  if (!Array.isArray(legalCandidates)) fail('legalCandidates', 'must be an array', 'INVALID_ARRAY');
  const matches = legalCandidates.filter(candidate => candidate?.actionId === normalized.actionId);
  if (matches.length !== 1) {
    fail('choice.actionId', 'does not identify exactly one current legal action', 'REPLAY_DIVERGENCE');
  }
  return deepFreeze({ choice: normalized, candidate: cloneJson(matches[0], 'legalCandidates.match') });
}

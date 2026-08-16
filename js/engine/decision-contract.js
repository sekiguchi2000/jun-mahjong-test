// decision-contract.js — 感想戦と思考公開対局で共有する判断記録契約
//
// この層は評価やゲーム進行を行わない。判断時点で本人に見えていた情報と
// 合法候補を、後から結果論や隠れ情報で書き換えられない JSON snapshot にする。

export const DECISION_CONTRACT_VERSION = 2;

export const DECISION_KINDS = Object.freeze([
  'turn',
  'discard',
  'riichi',
  'claim',
  'kan',
  'win',
  'abortiveDraw',
]);

// source は選択主体／自動化理由を表す。見送りは action='pass' の候補として
// 明示し、手動見送りと「鳴きなし」による自動見送りを混同しない。
export const DECISION_SOURCES = Object.freeze([
  'human',
  'com',
  'autoPreference',
  'forced',
]);

const REQUEST_KEYS = new Set([
  'schemaVersion', 'type', 'id', 'roundId', 'sequence',
  'stateId',
  'evaluatorVersion', 'rulesVersion', 'kind', 'actor',
  'options', 'view', 'publicHistory', 'availableCandidates', 'analysisSeed',
]);

const REQUEST_INPUT_KEYS = new Set([
  'id', 'roundId', 'sequence', 'stateId', 'evaluatorVersion', 'rulesVersion',
  'kind', 'actor', 'options', 'view', 'publicHistory',
  'availableCandidates', 'analysisSeed',
]);

const RECORD_KEYS = new Set([...REQUEST_KEYS, 'chosen', 'resultPointer']);
const CHOICE_INPUT_KEYS = new Set(['actionId', 'source', 'resultPointer']);
const ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// 名前が多少変わっても、山・王牌・裏ドラ等の未公開実体を弾く。
const FORBIDDEN_SECRET_KEYS = new Set([
  'wall',
  'live',
  'livewall',
  'livetiles',
  'deadwall',
  'deadwalltiles',
  'wanpai',
  'yama',
  'mountain',
  'drawpile',
  'walltiles',
  'wallorder',
  'remainingwall',
  'replacementwall',
  'rinshanwall',
  'rinshantiles',
  'uraindicators',
  'uradoraindicators',
  'allhands',
  'hands',
  'privatehand',
  'privatehands',
  'opponenthand',
  'opponenthands',
  'concealedhand',
  'concealedhands',
  'concealedtiles',
  'handtiles',
  'tehai',
  'drawn',
  'drawntile',
]);

const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export class DecisionContractError extends TypeError {
  constructor(code, path, message) {
    super(`${message} (${path})`);
    this.name = 'DecisionContractError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new DecisionContractError(code, path, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertPlainObject(value, path) {
  if (!isPlainObject(value)) fail('INVALID_OBJECT', path, 'plain object が必要です');
}

function assertAllowedKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('UNEXPECTED_FIELD', `${path}.${key}`, '未定義のフィールドです');
  }
}

function assertNonEmptyString(value, path, maxLength = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\u0000-\u001f]/.test(value)) {
    fail('INVALID_STRING', path, `1〜${maxLength}文字の文字列が必要です`);
  }
}

function normalizeKey(key) {
  return key.replace(/[-_\s]/g, '').toLowerCase();
}

function assertJsonValue(value, path = '$', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('NON_JSON_VALUE', path, '有限の数値が必要です');
    return;
  }
  if (typeof value !== 'object') fail('NON_JSON_VALUE', path, 'JSON化できない値です');
  if (seen.has(value)) fail('CYCLIC_VALUE', path, '循環参照は保存できません');
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) fail('NON_JSON_VALUE', `${path}[${i}]`, '疎な配列は保存できません');
      assertJsonValue(value[i], `${path}[${i}]`, seen);
    }
  } else {
    assertPlainObject(value, path);
    for (const key of Object.keys(value)) {
      if (PROTOTYPE_KEYS.has(key)) fail('UNSAFE_KEY', `${path}.${key}`, '安全でないキーです');
      assertJsonValue(value[key], `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function cloneJsonValue(value, path = '$', seen = new Map()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (seen.has(value)) fail('CYCLIC_VALUE', path, '循環参照は保存できません');
  const copy = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) copy.push(cloneJsonValue(value[i], `${path}[${i}]`, seen));
  } else {
    for (const key of Object.keys(value)) {
      copy[key] = cloneJsonValue(value[key], `${path}.${key}`, seen);
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
  assertJsonValue(value);
  return deepFreeze(cloneJsonValue(value));
}

function assertNoHiddenInformation(value, path, { allowRootHand = false, allowRootDrawn = false } = {}) {
  function visit(node, currentPath, depth) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) visit(node[i], `${currentPath}[${i}]`, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      const normalized = normalizeKey(key);
      const childPath = `${currentPath}.${key}`;
      const allowedPrivateRoot = depth === 0 &&
        ((allowRootHand && key === 'hand') || (allowRootDrawn && key === 'drawn'));
      if (FORBIDDEN_SECRET_KEYS.has(normalized) && !allowedPrivateRoot) {
        fail('HIDDEN_INFORMATION', childPath, '山・王牌・他家手牌などの非公開情報は判断記録へ保存できません');
      }
      // 本人手牌は view.hand にだけ置く。public.players[n].hand 等は必ず拒否する。
      if (normalized === 'hand' && !(allowRootHand && depth === 0 && key === 'hand')) {
        fail('HIDDEN_INFORMATION', childPath, '本人以外の非公開手牌を含めることはできません');
      }
      visit(child, childPath, depth + 1);
    }
  }
  visit(value, path, 0);
}

function assertActor(actor, path) {
  if (Number.isInteger(actor) && actor >= 0 && actor <= 3) return;
  if (typeof actor === 'string' && actor.length > 0 && actor.length <= 128 && !/[\u0000-\u001f]/.test(actor)) return;
  fail('INVALID_ACTOR', path, 'actor は席番号0〜3または識別文字列である必要があります');
}

function assertAnalysisSeed(seed, path) {
  if (typeof seed === 'string') {
    assertNonEmptyString(seed, path, 256);
    return;
  }
  if (Number.isSafeInteger(seed)) return;
  fail('INVALID_ANALYSIS_SEED', path, 'analysisSeed は文字列または安全な整数である必要があります');
}

function assertActionId(actionId, path) {
  if (typeof actionId !== 'string' || !ACTION_ID_PATTERN.test(actionId)) {
    fail('INVALID_ACTION_ID', path, 'actionId は英数字で始まる128文字以内の識別子である必要があります');
  }
}

function assertCandidate(candidate, path) {
  assertPlainObject(candidate, path);
  assertAllowedKeys(candidate, new Set([
    'actionId', 'action', 'command', 'index', 'handIndexAtDecision', 'riichi',
    'tile', 'tileRef', 'tileRefs', 'kind', 'calledTile', 'calledTileRef',
    'from', 'tiles', 'offerIndex',
  ]), path);
  assertActionId(candidate.actionId, `${path}.actionId`);
  assertNonEmptyString(candidate.action, `${path}.action`, 64);
  if (candidate.command !== undefined && candidate.command !== null) {
    assertAllowedObject(candidate.command, ['action', 'index', 'riichi', 'kind', 'tiles'], `${path}.command`);
    assertNonEmptyString(candidate.command.action, `${path}.command.action`, 64);
  }
  if (candidate.tile !== undefined) assertTile(candidate.tile, `${path}.tile`);
  if (candidate.calledTile !== undefined) assertTile(candidate.calledTile, `${path}.calledTile`);
  if (candidate.tileRef !== undefined) assertTileRef(candidate.tileRef, `${path}.tileRef`);
  if (candidate.calledTileRef !== undefined) assertTileRef(candidate.calledTileRef, `${path}.calledTileRef`);
  if (candidate.tileRefs !== undefined) {
    if (!Array.isArray(candidate.tileRefs)) fail('INVALID_CANDIDATE', `${path}.tileRefs`, 'tileRefs配列が必要です');
    candidate.tileRefs.forEach((ref, index) => assertTileRef(ref, `${path}.tileRefs[${index}]`));
  }
  assertNoHiddenInformation(candidate, path);
}

function assertAllowedObject(value, allowed, path) {
  assertPlainObject(value, path);
  assertAllowedKeys(value, new Set(allowed), path);
}

function assertSeat(value, path) {
  if (!Number.isInteger(value) || value < 0 || value > 3) {
    fail('INVALID_SEAT', path, '席番号0〜3が必要です');
  }
}

function assertTile(tile, path) {
  assertAllowedObject(tile, ['id', 'kind', 'red'], path);
  if (!Number.isInteger(tile.kind) || tile.kind < 0 || tile.kind > 33) {
    fail('INVALID_TILE', `${path}.kind`, '牌種0〜33が必要です');
  }
  if (tile.red !== undefined && typeof tile.red !== 'boolean') {
    fail('INVALID_TILE', `${path}.red`, 'red は真偽値である必要があります');
  }
  if (tile.id !== undefined &&
      !(Number.isSafeInteger(tile.id) && tile.id >= 0) &&
      !(typeof tile.id === 'string' && tile.id.length > 0 && tile.id.length <= 128)) {
    fail('INVALID_TILE', `${path}.id`, '牌idは非負整数または文字列である必要があります');
  }
}

function assertTileRef(ref, path) {
  assertAllowedObject(ref, [
    'tileId', 'fallbackScheme', 'handIndexAtDecision', 'source',
    'sourceSlotAtDecision', 'kind', 'red',
  ], path);
  if (ref.tileId !== null && ref.tileId !== undefined &&
      !(Number.isSafeInteger(ref.tileId) && ref.tileId >= 0) &&
      !(typeof ref.tileId === 'string' && ref.tileId.length > 0 && ref.tileId.length <= 128)) {
    fail('INVALID_TILE_REF', `${path}.tileId`, 'tileIdが不正です');
  }
  if (!Number.isInteger(ref.kind) || ref.kind < 0 || ref.kind > 33) {
    fail('INVALID_TILE_REF', `${path}.kind`, '牌種0〜33が必要です');
  }
  if (typeof ref.red !== 'boolean') fail('INVALID_TILE_REF', `${path}.red`, 'redは真偽値が必要です');
  assertNonEmptyString(ref.fallbackScheme, `${path}.fallbackScheme`, 128);
  assertNonEmptyString(ref.source, `${path}.source`, 32);
}

function assertMeld(meld, path, { publicMeld = false } = {}) {
  assertAllowedObject(meld, publicMeld
    ? ['type', 'from', 'kanOrigin', 'addedTileId', 'tiles']
    : ['type', 'kanOrigin', 'addedTileId', 'tiles'], path);
  assertNonEmptyString(meld.type, `${path}.type`, 32);
  if (meld.from !== undefined) assertSeat(meld.from, `${path}.from`);
  if (!Array.isArray(meld.tiles)) fail('INVALID_MELD', `${path}.tiles`, '副露牌配列が必要です');
  meld.tiles.forEach((tile, index) => assertTile(tile, `${path}.tiles[${index}]`));

  if (meld.kanOrigin !== undefined && !['kakan', 'minkan', 'ankan'].includes(meld.kanOrigin)) {
    fail('INVALID_MELD', `${path}.kanOrigin`, 'kanOriginはkakan・minkan・ankanのいずれかです');
  }
  if (meld.kanOrigin !== undefined) {
    const expectedType = meld.kanOrigin === 'ankan' ? 'ankan' : 'minkan';
    if (meld.type !== expectedType) {
      fail('INVALID_MELD', `${path}.kanOrigin`, 'kanOriginと副露typeが一致していません');
    }
  }
  if (meld.kanOrigin === 'kakan') {
    if (meld.addedTileId === undefined) {
      fail('INVALID_MELD', `${path}.addedTileId`, '加槓には追加牌の物理idが必要です');
    }
    const addedTile = meld.tiles.find(tile => tile.id === meld.addedTileId);
    if (!addedTile) {
      fail('INVALID_MELD', `${path}.addedTileId`, '追加牌idが副露内の物理牌を指していません');
    }
  } else if (meld.addedTileId !== undefined) {
    fail('INVALID_MELD', `${path}.addedTileId`, 'addedTileIdは加槓にだけ指定できます');
  }
}

function assertPublicState(state, stateId, path) {
  assertAllowedObject(state, [
    'stateId', 'points', 'ranking', 'kyoku', 'roundWindIdx', 'honba',
    'initialDealer', 'dealer', 'riichiSticks', 'turn', 'remaining', 'doraIndicators', 'players',
  ], path);
  assertNonEmptyString(state.stateId, `${path}.stateId`, 256);
  if (state.stateId !== stateId) {
    fail('STATE_VIEW_MISMATCH', `${path}.stateId`, 'request と公開stateのstateIdが一致していません');
  }
  if (!Array.isArray(state.players) || state.players.length !== 4) {
    fail('INVALID_VIEW', `${path}.players`, '公開された4席の情報が必要です');
  }
  if (state.points !== undefined && (!Array.isArray(state.points) || state.points.length !== 4 ||
      state.points.some(point => !Number.isFinite(point)))) {
    fail('INVALID_PUBLIC_STATE', `${path}.points`, '4席の点棒配列が必要です');
  }
  if (state.ranking !== undefined && (!Array.isArray(state.ranking) || state.ranking.length !== 4)) {
    fail('INVALID_PUBLIC_STATE', `${path}.ranking`, '4席の順位配列が必要です');
  }
  if (state.initialDealer !== undefined) assertSeat(state.initialDealer, `${path}.initialDealer`);
  if (state.dealer !== undefined) assertSeat(state.dealer, `${path}.dealer`);
  if (state.doraIndicators !== undefined) {
    if (!Array.isArray(state.doraIndicators)) fail('INVALID_PUBLIC_STATE', `${path}.doraIndicators`, 'ドラ表示牌配列が必要です');
    state.doraIndicators.forEach((tile, index) => assertTile(tile, `${path}.doraIndicators[${index}]`));
  }
  state.players.forEach((player, seat) => {
    assertAllowedObject(player, ['seat', 'discards', 'melds', 'riichi', 'handCount'], `${path}.players[${seat}]`);
    if (player.seat !== undefined && player.seat !== seat) {
      fail('INVALID_SEAT', `${path}.players[${seat}].seat`, '配列位置とseatが一致していません');
    }
    if (!Array.isArray(player.discards) || !Array.isArray(player.melds)) {
      fail('INVALID_PUBLIC_STATE', `${path}.players[${seat}]`, '河と副露の配列が必要です');
    }
    player.discards.forEach((discard, index) => {
      const discardPath = `${path}.players[${seat}].discards[${index}]`;
      // seq = 局内の捨て牌通し番号(公開情報)。リーチ後の「通し現物」判定に使う
      assertAllowedObject(discard, ['tile', 'riichi', 'tsumogiri', 'claimed', 'seq'], discardPath);
      assertTile(discard.tile, `${discardPath}.tile`);
    });
    player.melds.forEach((meld, index) => assertMeld(meld, `${path}.players[${seat}].melds[${index}]`, { publicMeld: true }));
  });
}

function assertPayments(value, path) {
  assertAllowedObject(value, ['ron', 'total', 'dealerPay', 'othersPay'], path);
  for (const [key, amount] of Object.entries(value)) {
    if (!Number.isFinite(amount)) fail('INVALID_SCORE_PREVIEW', `${path}.${key}`, '支払点は有限数値である必要があります');
  }
}

function assertMinimumScore(value, path) {
  if (value === null) return;
  assertAllowedObject(value, [
    'alreadyReached', 'han', 'fu', 'yakumanCount', 'base', 'total', 'payments',
    'limitName', 'afterPoints', 'afterRank',
  ], path);
  if (value.payments !== undefined) assertPayments(value.payments, `${path}.payments`);
}

function assertPlacement(value, path) {
  assertAllowedObject(value, [
    'ranking', 'currentRank', 'targetRank', 'scheduledFinalHand', 'lastPlace',
    'mustPrioritizeRankUp', 'ron', 'tsumo',
  ], path);
  if (!Array.isArray(value.ron)) fail('INVALID_PLACEMENT', `${path}.ron`, 'ron条件配列が必要です');
  value.ron.forEach((entry, index) => {
    const entryPath = `${path}.ron[${index}]`;
    assertAllowedObject(entry, ['from', 'exactPoints', 'score'], entryPath);
    assertSeat(entry.from, `${entryPath}.from`);
    assertMinimumScore(entry.score, `${entryPath}.score`);
  });
  assertMinimumScore(value.tsumo, `${path}.tsumo`);
}

function assertWinPreview(value, path) {
  if (value === null) return;
  assertAllowedObject(value, [
    'winner', 'loser', 'beforeRank', 'afterRank', 'beforePoints', 'afterPoints',
    'ranking', 'matchEnds', 'continues', 'improvesRank', 'endsInLastPlace',
    'guaranteedLastPlace', 'lastPlaceCertainty', 'maximumAfterRank',
    'maximumAfterPoints', 'maximumScore', 'next', 'score',
  ], path);
  assertSeat(value.winner, `${path}.winner`);
  if (value.loser !== null && value.loser !== undefined) assertSeat(value.loser, `${path}.loser`);
  assertAllowedObject(value.next, ['roundWindIdx', 'kyoku', 'honba', 'finished'], `${path}.next`);
  assertAllowedObject(value.score, ['han', 'fu', 'yakumanCount', 'total', 'payments', 'limitName'], `${path}.score`);
  assertPayments(value.score.payments, `${path}.score.payments`);
  if (value.maximumScore !== undefined) {
    assertAllowedObject(value.maximumScore, ['han', 'fu', 'yakumanCount', 'total', 'payments', 'limitName'], `${path}.maximumScore`);
    assertPayments(value.maximumScore.payments, `${path}.maximumScore.payments`);
  }
}

const PUBLIC_HISTORY_FIELDS = Object.freeze({
  roundStart: ['sequence', 'type', 'stateId', 'roundWindIdx', 'kyoku', 'initialDealer', 'dealer', 'honba', 'riichiSticks', 'points', 'doraIndicators'],
  draw: ['sequence', 'type', 'stateId', 'actor', 'remaining', 'rinshan'],
  discard: ['sequence', 'type', 'stateId', 'actor', 'tile', 'riichi', 'tsumogiri'],
  claim: ['sequence', 'type', 'stateId', 'actor', 'from', 'action', 'tile'],
  kan: ['sequence', 'type', 'stateId', 'actor', 'action', 'kind', 'kanCount'],
  kyuushu: ['sequence', 'type', 'stateId', 'actor'],
  win: ['sequence', 'type', 'stateId', 'winner', 'loser', 'winTile', 'deltas'],
  ryukyoku: ['sequence', 'type', 'stateId', 'tochu', 'tenpai', 'deltas'],
  nagashi: ['sequence', 'type', 'stateId', 'actor', 'deltas'],
});

function assertPublicHistory(history, path) {
  let previousSequence = -1;
  history.forEach((event, index) => {
    const eventPath = `${path}[${index}]`;
    assertPlainObject(event, eventPath);
    assertNoHiddenInformation(event, eventPath);
    const allowed = PUBLIC_HISTORY_FIELDS[event.type];
    if (!allowed) fail('INVALID_PUBLIC_EVENT', `${eventPath}.type`, '未対応の公開イベントです');
    assertAllowedKeys(event, new Set(allowed), eventPath);
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= previousSequence) {
      fail('INVALID_PUBLIC_EVENT', `${eventPath}.sequence`, '公開イベントsequenceは単調増加する必要があります');
    }
    previousSequence = event.sequence;
    assertNonEmptyString(event.stateId, `${eventPath}.stateId`, 256);
    if (event.actor !== undefined) assertSeat(event.actor, `${eventPath}.actor`);
    if (event.from !== undefined) assertSeat(event.from, `${eventPath}.from`);
    if (event.winner !== undefined) assertSeat(event.winner, `${eventPath}.winner`);
    if (event.loser !== undefined && event.loser !== null) assertSeat(event.loser, `${eventPath}.loser`);
    if (event.tile !== undefined) assertTile(event.tile, `${eventPath}.tile`);
    if (event.winTile !== undefined) assertTile(event.winTile, `${eventPath}.winTile`);
    if (event.doraIndicators !== undefined) {
      if (!Array.isArray(event.doraIndicators)) fail('INVALID_PUBLIC_EVENT', `${eventPath}.doraIndicators`, '牌配列が必要です');
      event.doraIndicators.forEach((tile, tileIndex) => assertTile(tile, `${eventPath}.doraIndicators[${tileIndex}]`));
    }
  });
}

export function validatePublicHistory(history) {
  if (!Array.isArray(history)) {
    fail('INVALID_PUBLIC_HISTORY', '$', 'publicHistory は配列である必要があります');
  }
  assertJsonValue(history);
  assertPublicHistory(history, '$');
  return true;
}

function assertView(view, actor, stateId, path) {
  assertNoHiddenInformation(view, path, { allowRootHand: true, allowRootDrawn: true });
  assertAllowedObject(view, [
    'me', 'hand', 'drawn', 'melds', 'seatWind', 'roundWind', 'isDealer',
    'riichi', 'riichiAffordable', 'placement', 'winPreview', 'public',
  ], path);
  if (!Number.isInteger(view.me) || view.me < 0 || view.me > 3) {
    fail('INVALID_VIEW', `${path}.me`, 'view.me は席番号0〜3である必要があります');
  }
  if (Number.isInteger(actor) && actor !== view.me) {
    fail('ACTOR_VIEW_MISMATCH', `${path}.me`, 'actor と view.me が一致していません');
  }
  if (!Array.isArray(view.hand)) fail('INVALID_VIEW', `${path}.hand`, '本人手牌の配列が必要です');
  view.hand.forEach((tile, index) => assertTile(tile, `${path}.hand[${index}]`));
  if (view.drawn !== null && view.drawn !== undefined) assertTile(view.drawn, `${path}.drawn`);
  if (!Array.isArray(view.melds)) fail('INVALID_VIEW', `${path}.melds`, '本人副露の配列が必要です');
  view.melds.forEach((meld, index) => assertMeld(meld, `${path}.melds[${index}]`));
  if (view.riichiAffordable !== undefined && typeof view.riichiAffordable !== 'boolean') {
    fail('INVALID_VIEW', `${path}.riichiAffordable`, 'riichiAffordable は真偽値である必要があります');
  }
  if (view.placement !== undefined) assertPlacement(view.placement, `${path}.placement`);
  if (view.winPreview !== undefined) assertWinPreview(view.winPreview, `${path}.winPreview`);
  assertPublicState(view.public, stateId, `${path}.public`);
}

function assertRequestShape(value, expectedType = 'decisionRequest') {
  assertPlainObject(value, '$');
  assertAllowedKeys(value, expectedType === 'decisionRecord' ? RECORD_KEYS : REQUEST_KEYS, '$');
  if (value.schemaVersion !== DECISION_CONTRACT_VERSION) {
    fail('UNSUPPORTED_SCHEMA', '$.schemaVersion', `schemaVersion ${DECISION_CONTRACT_VERSION} が必要です`);
  }
  if (value.type !== expectedType) fail('INVALID_TYPE', '$.type', `${expectedType} が必要です`);
  assertNonEmptyString(value.id, '$.id');
  assertNonEmptyString(value.roundId, '$.roundId');
  assertNonEmptyString(value.stateId, '$.stateId');
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) {
    fail('INVALID_SEQUENCE', '$.sequence', 'sequence は0以上の安全な整数である必要があります');
  }
  assertNonEmptyString(value.evaluatorVersion, '$.evaluatorVersion', 128);
  assertNonEmptyString(value.rulesVersion, '$.rulesVersion', 128);
  if (!DECISION_KINDS.includes(value.kind)) fail('INVALID_KIND', '$.kind', '未対応の判断種別です');
  assertActor(value.actor, '$.actor');
  if (!Array.isArray(value.options) || value.options.some(option => typeof option !== 'string')) {
    fail('INVALID_OPTIONS', '$.options', 'options は文字列配列である必要があります');
  }
  assertView(value.view, value.actor, value.stateId, '$.view');
  if (!Array.isArray(value.publicHistory)) {
    fail('INVALID_PUBLIC_HISTORY', '$.publicHistory', 'publicHistory は配列である必要があります');
  }
  assertNoHiddenInformation(value.options, '$.options');
  assertPublicHistory(value.publicHistory, '$.publicHistory');
  if (!Array.isArray(value.availableCandidates) || value.availableCandidates.length === 0) {
    fail('INVALID_CANDIDATES', '$.availableCandidates', '合法候補が1件以上必要です');
  }
  const ids = new Set();
  value.availableCandidates.forEach((candidate, index) => {
    assertCandidate(candidate, `$.availableCandidates[${index}]`);
    if (ids.has(candidate.actionId)) {
      fail('DUPLICATE_ACTION_ID', `$.availableCandidates[${index}].actionId`, 'actionId は同じ判断内で一意である必要があります');
    }
    ids.add(candidate.actionId);
  });
  assertAnalysisSeed(value.analysisSeed, '$.analysisSeed');
  assertJsonValue(value);
  return ids;
}

function generatedDecisionId({ roundId, sequence, actor, kind }) {
  const actorPart = encodeURIComponent(String(actor));
  return `decision:${encodeURIComponent(roundId)}:${sequence}:${actorPart}:${kind}`;
}

function normalizeCandidates(candidates) {
  if (!Array.isArray(candidates)) {
    fail('INVALID_CANDIDATES', '$.availableCandidates', '合法候補の配列が必要です');
  }
  return candidates.map((candidate, index) => {
    assertPlainObject(candidate, `$.availableCandidates[${index}]`);
    // 深いcopyは最終snapshotで一度だけ行う。ここで非JSON値を別形へ変換して
    // validationから隠してしまわないよう、actionIdの補完だけを行う。
    return {
      ...candidate,
      actionId: candidate.actionId ?? `action-${index + 1}`,
    };
  });
}

export function validateDecisionRequest(value) {
  assertRequestShape(value, 'decisionRequest');
  return true;
}

export function createDecisionRequest(input) {
  assertPlainObject(input, '$');
  assertAllowedKeys(input, REQUEST_INPUT_KEYS, '$');
  const raw = {
    schemaVersion: DECISION_CONTRACT_VERSION,
    type: 'decisionRequest',
    id: input.id ?? generatedDecisionId(input),
    roundId: input.roundId,
    sequence: input.sequence,
    stateId: input.stateId,
    evaluatorVersion: input.evaluatorVersion,
    rulesVersion: input.rulesVersion,
    kind: input.kind,
    actor: input.actor,
    options: input.options ?? [],
    view: input.view,
    publicHistory: input.publicHistory ?? [],
    availableCandidates: normalizeCandidates(input.availableCandidates),
    analysisSeed: input.analysisSeed,
  };
  const result = snapshot(raw);
  validateDecisionRequest(result);
  return result;
}

export function validateDecisionRecord(value) {
  const candidateIds = assertRequestShape(value, 'decisionRecord');
  assertPlainObject(value.chosen, '$.chosen');
  assertAllowedKeys(value.chosen, new Set(['actionId', 'source']), '$.chosen');
  assertActionId(value.chosen.actionId, '$.chosen.actionId');
  if (!candidateIds.has(value.chosen.actionId)) {
    fail('UNKNOWN_ACTION_ID', '$.chosen.actionId', 'chosen.actionId が合法候補に存在しません');
  }
  if (!DECISION_SOURCES.includes(value.chosen.source)) {
    fail('INVALID_DECISION_SOURCE', '$.chosen.source', '未対応の選択 source です');
  }
  const selected = value.availableCandidates.find(candidate => candidate.actionId === value.chosen.actionId);
  if (value.chosen.source === 'autoPreference' && selected.action !== 'pass') {
    fail('SOURCE_ACTION_MISMATCH', '$.chosen.source', 'autoPreference は pass 候補にだけ使用できます');
  }
  if (value.chosen.source === 'forced' && value.availableCandidates.length !== 1) {
    fail('NOT_FORCED', '$.chosen.source', '複数候補がある判断を forced として記録できません');
  }
  if (value.resultPointer !== null) assertNonEmptyString(value.resultPointer, '$.resultPointer', 512);
  assertJsonValue(value);
  return true;
}

export function createDecisionRecord(request, choice) {
  validateDecisionRequest(request);
  assertPlainObject(choice, '$.choice');
  assertAllowedKeys(choice, CHOICE_INPUT_KEYS, '$.choice');
  const raw = {
    ...request,
    type: 'decisionRecord',
    chosen: {
      actionId: choice.actionId,
      source: choice.source,
    },
    resultPointer: choice.resultPointer ?? null,
  };
  const result = snapshot(raw);
  validateDecisionRecord(result);
  return result;
}

export function findDecisionCandidate(decision, actionId) {
  if (decision.type === 'decisionRecord') validateDecisionRecord(decision);
  else validateDecisionRequest(decision);
  assertActionId(actionId, '$.actionId');
  return decision.availableCandidates.find(candidate => candidate.actionId === actionId) ?? null;
}

export function serializeDecisionRequest(request) {
  validateDecisionRequest(request);
  return JSON.stringify(request);
}

export function deserializeDecisionRequest(json) {
  if (typeof json !== 'string') fail('INVALID_JSON', '$', 'JSON文字列が必要です');
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    fail('INVALID_JSON', '$', 'DecisionRequest JSONを解析できません');
  }
  validateDecisionRequest(parsed);
  return snapshot(parsed);
}

export function serializeDecisionRecord(record) {
  validateDecisionRecord(record);
  return JSON.stringify(record);
}

export function deserializeDecisionRecord(json) {
  if (typeof json !== 'string') fail('INVALID_JSON', '$', 'JSON文字列が必要です');
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    fail('INVALID_JSON', '$', 'DecisionRecord JSONを解析できません');
  }
  validateDecisionRecord(parsed);
  return snapshot(parsed);
}

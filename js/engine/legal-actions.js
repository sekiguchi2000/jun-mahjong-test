// legal-actions.js — actorへ渡す判断時点の合法候補を、公開viewだけから列挙する。
//
// 候補の action は感想戦用の意味分類（riichi / pass を独立して記録）で、
// command は現行actorがGameへ返す応答形式である。山由来の恒久IDがあれば
// actionIdにも使用し、テスト入力などIDなしの牌だけを判断時点slot+kind+redへ
// 明示的にfallbackする。

import { KIND_COUNT, toCounts } from './tiles.js';
import { shanten } from './shanten.js';

export const LEGAL_ACTIONS_VERSION = 1;
export const TILE_REF_FALLBACK = 'hand-slot-kind-red-v1';

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function fail(message) {
  throw new TypeError(`LegalAction: ${message}`);
}

function assertTile(tile, path) {
  if (!tile || typeof tile !== 'object' || Array.isArray(tile)) fail(`${path} must be a tile object`);
  if (!Number.isInteger(tile.kind) || tile.kind < 0 || tile.kind >= KIND_COUNT) {
    fail(`${path}.kind must be an integer from 0 to ${KIND_COUNT - 1}`);
  }
}

function assertView(view) {
  if (!view || typeof view !== 'object' || Array.isArray(view)) fail('view must be an object');
  if (!Array.isArray(view.hand)) fail('view.hand must be an array');
  view.hand.forEach((tile, index) => assertTile(tile, `view.hand[${index}]`));
  if (view.drawn !== null && view.drawn !== undefined) assertTile(view.drawn, 'view.drawn');
  if (!Array.isArray(view.melds)) fail('view.melds must be an array');
}

function assertOptions(options) {
  if (!Array.isArray(options) || options.some(option => typeof option !== 'string')) {
    fail('options must be an array of strings');
  }
}

function copyTile(tile) {
  return { kind: tile.kind, red: tile.red === true };
}

function copyTileId(tile) {
  if (!hasOwn(tile, 'id')) return null;
  if (typeof tile.id === 'string' && tile.id.length > 0) return tile.id;
  if (Number.isSafeInteger(tile.id) && tile.id >= 0) return tile.id;
  return null;
}

function makeHandTileRef(tile, handIndexAtDecision, handLength) {
  return {
    tileId: copyTileId(tile),
    fallbackScheme: TILE_REF_FALLBACK,
    handIndexAtDecision,
    source: handIndexAtDecision < handLength ? 'hand' : 'drawn',
    sourceSlotAtDecision: handIndexAtDecision < handLength ? handIndexAtDecision : 0,
    kind: tile.kind,
    red: tile.red === true,
  };
}

function makeCalledTileRef(tile) {
  return {
    tileId: copyTileId(tile),
    fallbackScheme: 'called-tile-kind-red-from-v1',
    handIndexAtDecision: null,
    source: 'discard',
    sourceSlotAtDecision: null,
    kind: tile.kind,
    red: tile.red === true,
  };
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function tileIdComponent(tileId) {
  if (Number.isSafeInteger(tileId) && tileId >= 0) return `n${tileId}`;
  if (typeof tileId === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(tileId)) return `s${tileId}`;
  // 文字種や長さがactionId制約外でも、同じ物理idから同じ短い識別子を作る。
  const text = String(tileId);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `h${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function tileActionId(action, ref) {
  if (ref.tileId !== null) return `turn:${action}:id:${tileIdComponent(ref.tileId)}`;
  return `turn:${action}:s${pad(ref.handIndexAtDecision)}:k${pad(ref.kind)}:r${ref.red ? 1 : 0}`;
}

function cloneJson(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneJson);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)]));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function finish(actions) {
  const ids = new Set();
  for (const candidate of actions) {
    if (ids.has(candidate.actionId)) fail(`duplicate actionId: ${candidate.actionId}`);
    ids.add(candidate.actionId);
  }
  return deepFreeze(actions);
}

function handEntries(view) {
  const entries = view.hand.map((tile, index) => ({ tile, index }));
  if (view.drawn !== null && view.drawn !== undefined) {
    entries.push({ tile: view.drawn, index: view.hand.length });
  }
  return entries;
}

function refsForKind(entries, kind, handLength, limit = Infinity) {
  return entries
    .filter(entry => entry.tile.kind === kind)
    .slice(0, limit)
    .map(entry => makeHandTileRef(entry.tile, entry.index, handLength));
}

// game.js の availableAnkanKinds / availableKakanKinds と同じ判定を、この層へ
// 循環importを作らず保持する。既存関数との一致は固定テストで監視する。
function ankanKinds(entries) {
  const counts = toCounts(entries.map(entry => entry.tile));
  const result = [];
  for (let kind = 0; kind < KIND_COUNT; kind++) if (counts[kind] === 4) result.push(kind);
  return result;
}

function kakanKinds(entries, melds) {
  const counts = toCounts(entries.map(entry => entry.tile));
  return [...new Set(melds
    .filter(meld => meld && meld.type === 'pon' && meld.tiles?.[0] && counts[meld.tiles[0].kind] >= 1)
    .map(meld => meld.tiles[0].kind))];
}

export function canAffordRiichi(view, rules = {}) {
  // Gameが判断snapshotへ確定した値を最優先する。これにより特殊ルール時も
  // COM・人間UI・合法手列挙が同じ結論を再現できる。
  if (typeof view?.riichiAffordable === 'boolean') return view.riichiAffordable;
  if (rules?.riichiBelow1000 === true) return true;
  const points = view.public?.points?.[view.me];
  return Number.isFinite(points) && points >= 1000;
}

export function canDeclareRiichi(view, rules = {}) {
  return view?.riichi !== true && view?.drawn !== null && view?.drawn !== undefined &&
    (view.melds ?? []).every(meld => meld?.type === 'ankan') &&
    canAffordRiichi(view, rules) &&
    Number.isFinite(view.public?.remaining) && view.public.remaining >= 4;
}

function discardEntries(view, entries) {
  // リーチ後に選べる打牌はツモ切りだけ。現行Game/UIの自動ツモ切りと一致させる。
  if (view.riichi === true && view.drawn !== null && view.drawn !== undefined) return entries.slice(-1);
  return entries;
}

function discardCandidate(entry, view, riichi) {
  const tileRef = makeHandTileRef(entry.tile, entry.index, view.hand.length);
  return {
    actionId: tileActionId(riichi ? 'riichi' : 'discard', tileRef),
    action: riichi ? 'riichi' : 'discard',
    command: { action: 'discard', index: entry.index, riichi },
    index: entry.index,
    handIndexAtDecision: entry.index,
    riichi,
    tile: copyTile(entry.tile),
    tileRef,
  };
}

/**
 * 通常手番の合法候補を固定順で返す。
 * 順序: 全打牌 → 全リーチ宣言打牌 → ツモ → 暗槓 → 加槓 → 九種九牌。
 * rules はGameと同じrules objectを任意で受け、1000点未満リーチだけに用いる。
 */
export function enumerateTurnLegalActions(view, options, rules = {}) {
  assertView(view);
  assertOptions(options);
  const offered = new Set(options);
  const entries = handEntries(view);
  const actions = [];

  if (offered.has('discard')) {
    for (const entry of discardEntries(view, entries)) actions.push(discardCandidate(entry, view, false));

    if (canDeclareRiichi(view, rules)) {
      for (const entry of entries) {
        const remainder = entries.filter(candidate => candidate.index !== entry.index).map(candidate => candidate.tile);
        if (shanten(toCounts(remainder), view.melds.length) === 0) {
          actions.push(discardCandidate(entry, view, true));
        }
      }
    }
  }

  if (offered.has('tsumo')) {
    actions.push({ actionId: 'turn:tsumo', action: 'tsumo', command: { action: 'tsumo' } });
  }

  if (offered.has('ankan')) {
    for (const kind of ankanKinds(entries)) {
      actions.push({
        actionId: `turn:ankan:k${pad(kind)}`,
        action: 'ankan',
        command: { action: 'ankan', kind },
        kind,
        tileRefs: refsForKind(entries, kind, view.hand.length, 4),
      });
    }
  }

  if (offered.has('kakan')) {
    for (const kind of kakanKinds(entries, view.melds)) {
      actions.push({
        actionId: `turn:kakan:k${pad(kind)}`,
        action: 'kakan',
        command: { action: 'kakan', kind },
        kind,
        tileRef: refsForKind(entries, kind, view.hand.length, 1)[0],
      });
    }
  }

  if (offered.has('kyuushu')) {
    actions.push({
      actionId: 'turn:kyuushu',
      action: 'kyuushu',
      command: { action: 'kyuushu' },
    });
  }

  return finish(actions);
}

function consumeRefsForKinds(hand, kinds) {
  const used = new Set();
  const refs = [];
  for (const kind of kinds) {
    const index = hand.findIndex((tile, candidateIndex) => tile.kind === kind && !used.has(candidateIndex));
    if (index < 0) return null;
    used.add(index);
    refs.push(makeHandTileRef(hand[index], index, hand.length));
  }
  return refs;
}

function claimBase(offer) {
  return {
    calledTile: copyTile(offer.tile),
    calledTileRef: makeCalledTileRef(offer.tile),
    from: offer.from,
  };
}

/**
 * ロン／鳴きofferの合法候補を返す。passはoffer種別を問わず必ず先頭に置く。
 * 鳴きに使う物理牌は、現行Gameと同様に手牌の先頭一致牌を決定的に選ぶ。
 */
export function enumerateClaimLegalActions(view, offer) {
  assertView(view);
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) fail('offer must be an object');
  if (offer.type !== 'ron' && offer.type !== 'call') fail('offer.type must be ron or call');
  assertTile(offer.tile, 'offer.tile');

  const base = claimBase(offer);
  const actions = [{
    actionId: 'claim:pass',
    action: 'pass',
    command: null,
    ...base,
  }];

  if (offer.type === 'ron') {
    actions.push({
      actionId: 'claim:ron',
      action: 'ron',
      command: { action: 'ron' },
      ...base,
    });
    return finish(actions);
  }

  if (offer.canPon === true) {
    const tileRefs = consumeRefsForKinds(view.hand, [offer.tile.kind, offer.tile.kind]);
    if (tileRefs) actions.push({
      actionId: `claim:pon:k${pad(offer.tile.kind)}`,
      action: 'pon',
      command: { action: 'pon' },
      kind: offer.tile.kind,
      tileRefs,
      ...base,
    });
  }

  if (offer.canKan === true) {
    const tileRefs = consumeRefsForKinds(view.hand, [offer.tile.kind, offer.tile.kind, offer.tile.kind]);
    if (tileRefs) actions.push({
      actionId: `claim:minkan:k${pad(offer.tile.kind)}`,
      action: 'minkan',
      command: { action: 'minkan' },
      kind: offer.tile.kind,
      tileRefs,
      ...base,
    });
  }

  if (offer.canChi !== undefined && !Array.isArray(offer.canChi)) fail('offer.canChi must be an array');
  for (const [offerIndex, kinds] of (offer.canChi ?? []).entries()) {
    if (!Array.isArray(kinds) || kinds.length !== 2 ||
        kinds.some(kind => !Number.isInteger(kind) || kind < 0 || kind >= KIND_COUNT)) {
      fail(`offer.canChi[${offerIndex}] must contain two tile kinds`);
    }
    const tileRefs = consumeRefsForKinds(view.hand, kinds);
    if (!tileRefs) continue;
    actions.push({
      actionId: `claim:chi:c${pad(offerIndex)}:k${pad(kinds[0])}:k${pad(kinds[1])}`,
      action: 'chi',
      command: { action: 'chi', tiles: [...kinds] },
      tiles: [...kinds],
      offerIndex,
      tileRefs,
      ...base,
    });
  }

  return finish(actions);
}

// 候補メタデータをGameへ返さず、現行actor応答だけを独立copyで取り出す。
export function legalActionToActorDecision(candidate) {
  if (!candidate || typeof candidate !== 'object' || !hasOwn(candidate, 'command')) {
    fail('candidate.command is required');
  }
  return cloneJson(candidate.command);
}

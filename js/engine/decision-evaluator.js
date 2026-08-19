// decision-evaluator.js — COM実戦・感想戦・思考公開で共有する純粋な判断評価器
//
// 入力view（本人手牌＋公開情報）だけで、牌効率・待ち形ベースの守備・
// 公開副露の色傾向を同期評価する。未実装の手役上限／順位期待値はcoverageで
// 明示し、計算済みのような台詞や信頼度Aを返さない。

import {
  toCounts,
  isHonor,
  isTerminal,
  isYaochu,
  isDragon,
  numOf,
  doraFromIndicator,
  KIND_COUNT,
} from './tiles.js';
import { shanten } from './shanten.js';
import { canDeclareRiichi } from './legal-actions.js';
import { evaluateHandPlans, tileRetentionValue, PLAN_SCALE } from './hand-plans.js';

export const DECISION_EVALUATOR_VERSION = 'v18-candidate-comparison-1';

export const AI_STYLES = Object.freeze({
  // cautionWeight: リーチ未満の「テンパイ気配」への警戒の強さ(キャラ差は重みだけ)
  guardian: Object.freeze({ foldAt: 1, riichiLiveMin: 4, ponPairMin: 4, cautionWeight: 1.3 }),
  analyst: Object.freeze({ foldAt: 2, riichiLiveMin: 2, ponPairMin: 4, cautionWeight: 1.0 }),
  striker: Object.freeze({ foldAt: 3, riichiLiveMin: 1, ponPairMin: 3, cautionWeight: 0.7 }),
});

const WIN_PREVIEW_KEYS = Object.freeze([
  'winner', 'loser', 'beforeRank', 'afterRank', 'beforePoints', 'afterPoints',
  'ranking', 'matchEnds', 'continues', 'improvesRank', 'endsInLastPlace',
  'guaranteedLastPlace', 'lastPlaceCertainty', 'maximumAfterRank',
  'maximumAfterPoints', 'maximumScore', 'next', 'score',
]);

const PLACEMENT_KEYS = Object.freeze([
  'ranking', 'currentRank', 'targetRank', 'scheduledFinalHand', 'lastPlace',
  'mustPrioritizeRankUp', 'ron', 'tsumo',
]);

function copyJson(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copyJson);
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined && typeof child !== 'function') result[key] = copyJson(child);
  }
  return result;
}

function copyKnown(value, keys) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of keys) {
    if (value[key] !== undefined) result[key] = copyJson(value[key]);
  }
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function tileCopy(tile) {
  if (!tile) return null;
  const result = { kind: tile.kind, red: tile.red === true };
  if (tile.id !== undefined) result.id = tile.id;
  return result;
}

function cachedShanten(cache, counts, meldCount) {
  const key = `${meldCount}:${counts.join('')}`;
  if (!cache.has(key)) cache.set(key, shanten(counts, meldCount));
  return cache.get(key);
}

function normalizeProfile(profile) {
  return Object.prototype.hasOwnProperty.call(AI_STYLES, profile) ? profile : 'analyst';
}

function availableKakanKinds(handAll, melds) {
  const counts = toCounts(handAll);
  return [...new Set((melds ?? [])
    .filter(meld => meld?.type === 'pon' && meld.tiles?.[0] && counts[meld.tiles[0].kind] >= 1)
    .map(meld => meld.tiles[0].kind))];
}

function baseHardConstraint(active = false, affectedAction = null) {
  return {
    code: 'LAST_PLACE_LOCK_FORBIDDEN',
    scope: 'allProfiles',
    active,
    affectedAction,
  };
}

export function isForbiddenLastPlaceWin(winPreview) {
  if (!winPreview) return false;
  if (typeof winPreview.guaranteedLastPlace === 'boolean') {
    return winPreview.guaranteedLastPlace;
  }
  const lastRank = (winPreview.afterPoints?.length ?? 4) - 1;
  return winPreview.endsInLastPlace === true ||
    (winPreview.matchEnds === true && winPreview.afterRank === lastRank);
}

// 見えている牌（本人手牌・全員の河／副露・ドラ表示牌）だけを数える。
export function visibleCounts(view) {
  const counts = new Array(KIND_COUNT).fill(0);
  for (const tile of view.hand ?? []) counts[tile.kind]++;
  if (view.drawn) counts[view.drawn.kind]++;
  for (const player of view.public?.players ?? []) {
    // 鳴かれた捨て牌は副露側にも同じ物理牌として現れるため、河と二重に数えない。
    for (const discard of player.discards ?? []) {
      if (!discard.claimed) counts[discard.tile.kind]++;
    }
    for (const meld of player.melds ?? []) {
      for (const tile of meld.tiles ?? []) counts[tile.kind]++;
    }
  }
  for (const tile of view.public?.doraIndicators ?? []) counts[tile.kind]++;
  return counts;
}

export function remainingCopies(visible, kind) {
  return Math.max(0, 4 - (visible[kind] || 0));
}

// リーチ者の宣言以降に「誰かが捨てて通った」牌は、フリテン規則によりその
// リーチ者へ現物同然に安全(通し現物)。捨て牌のseq(局内通し番号)から判定する。
// seqが無い旧形式のviewでは従来どおり本人の河だけを現物とする。
function passedKindsForThreat(view, threatPlayer) {
  const riichiSeq = (threatPlayer.discards ?? []).find(discard => discard.riichi)?.seq;
  if (!Number.isInteger(riichiSeq)) return [];
  const kinds = [];
  for (const player of view?.public?.players ?? []) {
    for (const discard of player.discards ?? []) {
      if (Number.isInteger(discard.seq) && discard.seq > riichiSeq) kinds.push(discard.tile.kind);
    }
  }
  return kinds;
}

function threatData(threats) {
  return threats.map(threat => ({
    seat: threat.i,
    kinds: new Set([
      ...(threat.pl.discards ?? []).map(discard => discard.tile.kind),
      ...(threat.passedKinds ?? []),
    ]),
    declarationKind: (threat.pl.discards ?? []).find(discard => discard.riichi)?.tile?.kind ?? null,
    player: threat.pl,
  }));
}

// リーチ宣言牌の裏筋(宣言牌±1・±4の数牌)。手なりで進めた宣言牌の周辺は
// 直前まで使っていた形の名残であることが多く、わずかに警戒を上げる。
function isDeclarationUrasuji(kind, declarationKind) {
  if (declarationKind === null || isHonor(kind) || isHonor(declarationKind)) return false;
  if (kindSuit(kind) !== kindSuit(declarationKind)) return false;
  const gap = Math.abs(numOf(kind) - numOf(declarationKind));
  return gap === 1 || gap === 4;
}

function kindSuit(kind) {
  return kind >= 0 && kind < 27 ? Math.floor(kind / 9) : null;
}

function sequenceWaitRoutes(kind, threat, visible) {
  if (isHonor(kind)) return [];
  const suitBase = Math.floor(kind / 9) * 9;
  const rank = kind % 9;
  const routes = [];
  for (let start = Math.max(0, rank - 2); start <= Math.min(6, rank); start++) {
    const companions = [start, start + 1, start + 2]
      .filter(value => value !== rank)
      .map(value => suitBase + value);
    let shape;
    let alternateKind = null;
    if (rank === start + 1) {
      shape = 'KANCHAN';
    } else if ((rank === start + 2 && start === 0) ||
        (rank === start && start === 6)) {
      shape = 'PENCHAN';
    } else {
      shape = 'RYANMEN';
      alternateKind = suitBase + (rank === start ? start + 3 : start - 1);
    }
    const companionRemaining = companions.map(companion => remainingCopies(visible, companion));
    const eliminatedBySuji = shape === 'RYANMEN' && threat.kinds.has(alternateKind);
    const eliminatedByNoChance = companionRemaining.some(remaining => remaining === 0);
    const oneChance = !eliminatedByNoChance && companionRemaining.some(remaining => remaining === 1);
    routes.push({
      shape,
      companions,
      companionRemaining,
      alternateKind,
      eliminatedBySuji,
      eliminatedByNoChance,
      oneChance,
      possible: !eliminatedBySuji && !eliminatedByNoChance,
    });
  }
  return routes;
}

function kokushiMissingWaitPossible(kind, threat, visible) {
  if (!isYaochu(kind) || (threat.player?.melds?.length ?? 0) > 0) return false;
  // 候補牌を十三面／欠け牌として待つには、他の么九牌12種を各1枚以上
  // 隠し手へ持てる余地が必要。可能性だけを残し、確率とは扱わない。
  for (let other = 0; other < KIND_COUNT; other++) {
    if (other === kind || !isYaochu(other)) continue;
    if (remainingCopies(visible, other) < 1) return false;
  }
  return true;
}

function routeWeight(route) {
  // 校正済み放銃率ではなく、候補間を決定的に比較する構造指標。
  // 比率は実戦の待ち分布(両面が約半分)に合わせる: 両面16 > 嵌張6 > 辺張4。
  // これにより「スジ(両面消し)」が「部分的な壁(ワンチャンス)」より優先され、
  // 「完全な壁(ノーチャンス)」だけがスジに勝つ。(カルテ5号)
  if (!route.possible) return 0;
  if (route.shape === 'RYANMEN') return route.oneChance ? 8 : 16;
  if (route.shape === 'KANCHAN') return route.oneChance ? 3 : 6;
  return route.oneChance ? 2 : 4;
}

function assessAgainstThreat(kind, threat, visible) {
  const genbutsu = threat.kinds.has(kind);
  if (genbutsu) {
    return {
      seat: threat.seat,
      genbutsu: true,
      risk: 0,
      category: 'GENBUTSU',
      suji: false,
      oneChance: false,
      noChance: false,
      sequenceRoutes: [],
      residualWaits: [],
    };
  }

  const sequenceRoutes = sequenceWaitRoutes(kind, threat, visible);
  const candidateRemaining = remainingCopies(visible, kind);
  const residualWaits = [];
  if (candidateRemaining >= 2) residualWaits.push('SHANPON');
  if (candidateRemaining >= 1) residualWaits.push('TANKI');
  if (kokushiMissingWaitPossible(kind, threat, visible)) residualWaits.push('KOKUSHI');
  const sujiEliminated = sequenceRoutes.filter(route => route.eliminatedBySuji).length;
  // ワンチャンス/ノーチャンス=残る当たり形の数え上げ(ユーザー定義 2026-08-19)。
  // 生きている順子ルート(両面/嵌張/辺張)+シャンポン/単騎/国士を全列挙し、
  // 残り1形だけならワンチャンス、0形なら完全安牌(ノーチャンス)。
  const aliveRoutes = sequenceRoutes.filter(route => route.possible);
  const aliveShapes = [
    ...aliveRoutes.map(route => ({ kind: 'SEQUENCE', shape: route.shape, companions: route.companions })),
    ...residualWaits.map(wait => ({ kind: wait })),
  ];
  const oneChance = aliveShapes.length === 1;
  const noChance = aliveShapes.length === 0;
  const oneChanceShape = oneChance ? aliveShapes[0] : null;
  const oneChanceRoutes = aliveRoutes.filter(route => route.oneChance).length;
  // 壁読みの用語(一般用法)は「両面待ちに対しては」と限定して使う(2026-08-19仕様)。
  // 両面ワンチャンス=生きた両面ルート全てで必要牌が残り1枚。両面ノーチャンス=
  // 両面ルートが壁(4枚見え)で全滅。スジで消えただけの場合はスジの文が担当する。
  const ryanmenRoutes = sequenceRoutes.filter(route => route.shape === 'RYANMEN');
  const aliveRyanmen = ryanmenRoutes.filter(route => route.possible);
  const ryanmenOneChance = aliveRyanmen.length > 0 && aliveRyanmen.every(route => route.oneChance);
  const ryanmenOneChanceWallKinds = ryanmenOneChance
    ? [...new Set(aliveRyanmen.flatMap(route =>
        route.companions.filter((companion, i) => route.companionRemaining[i] === 1)))]
    : [];
  // 「両面ノーチャンス」を名乗るのは全ての両面ルートが壁(4枚見え)で消えたときだけ。
  // 片側スジ+片側壁の混在は用語でなく左右の根拠を言い分ける(コーチ側)
  const ryanmenNoChance = ryanmenRoutes.length > 0 && aliveRyanmen.length === 0 &&
    ryanmenRoutes.every(route => route.eliminatedByNoChance);
  const noChanceRoutes = sequenceRoutes.filter(route => route.eliminatedByNoChance).length;
  const routeRisk = sequenceRoutes.reduce((sum, route) => sum + routeWeight(route), 0);
  const residualRisk = residualWaits.reduce((sum, wait) =>
    sum + (wait === 'SHANPON' ? 4 : (wait === 'TANKI' ? 2 : 1)), 0);
  const urasujiOfDeclaration = isDeclarationUrasuji(kind, threat.declarationKind ?? null);
  // 当たり形が1つでも残るなら床1(モデル誤差を安全側へ)。0形は牌の枚数と
  // フリテン規則から成立し得ないので、現物と同じ0(完全安牌)。
  const risk = noChance ? 0
    : Math.max(1, routeRisk + residualRisk + (urasujiOfDeclaration ? 3 : 0));
  return {
    seat: threat.seat,
    genbutsu: false,
    risk,
    urasujiOfDeclaration,
    category: sequenceRoutes.some(route => route.possible)
      ? 'NON_GENBUTSU_WAIT_ROUTE'
      : 'NON_GENBUTSU_RESIDUAL_ONLY',
    suji: sujiEliminated > 0,
    sujiEliminated,
    oneChance,
    oneChanceShape,
    oneChanceRoutes,
    ryanmenOneChance,
    ryanmenOneChanceWallKinds,
    ryanmenNoChance,
    noChance,
    noChanceRoutes,
    sequenceRoutes,
    residualWaits,
  };
}

function assessTileSafety(kind, threats, visible) {
  if (threats.length === 0) return null;
  const known = threatData(threats);
  const perThreatDetails = known.map(threat => assessAgainstThreat(kind, threat, visible));
  const perThreat = perThreatDetails.map(item => ({
    seat: item.seat,
    genbutsu: item.genbutsu,
    risk: item.risk,
  }));
  const commonGenbutsu = perThreat.every(item => item.genbutsu);
  const genbutsuCount = perThreat.filter(item => item.genbutsu).length;
  return {
    category: commonGenbutsu ? 'COMMON_GENBUTSU' : 'NON_GENBUTSU_STRUCTURAL',
    commonGenbutsu,
    genbutsuCount,
    maxRisk: Math.max(...perThreat.map(item => item.risk)),
    totalRisk: perThreat.reduce((sum, item) => sum + item.risk, 0),
    perThreat,
    perThreatDetails,
    // 現物がなくても全牌を比較し、最小危険牌を牌効率込みで選ぶ。
    defenseSelectable: true,
  };
}

function compareDefenseCandidate(left, right) {
  if (left.maxRisk !== right.maxRisk) return left.maxRisk - right.maxRisk;
  if (left.totalRisk !== right.totalRisk) return left.totalRisk - right.totalRisk;
  if (left.genbutsuCount !== right.genbutsuCount) return right.genbutsuCount - left.genbutsuCount;
  const leftMetrics = left.efficiency?.metrics ?? {};
  const rightMetrics = right.efficiency?.metrics ?? {};
  const leftShanten = Number.isFinite(leftMetrics.shanten) ? leftMetrics.shanten : Infinity;
  const rightShanten = Number.isFinite(rightMetrics.shanten) ? rightMetrics.shanten : Infinity;
  if (leftShanten !== rightShanten) return leftShanten - rightShanten;
  const leftUkeire = Number.isFinite(leftMetrics.ukeirePhysical) ? leftMetrics.ukeirePhysical : -Infinity;
  const rightUkeire = Number.isFinite(rightMetrics.ukeirePhysical) ? rightMetrics.ukeirePhysical : -Infinity;
  if (leftUkeire !== rightUkeire) return rightUkeire - leftUkeire;
  const leftAdjustment = Number.isFinite(leftMetrics.utilityAdjustment)
    ? leftMetrics.utilityAdjustment : -Infinity;
  const rightAdjustment = Number.isFinite(rightMetrics.utilityAdjustment)
    ? rightMetrics.utilityAdjustment : -Infinity;
  if (leftAdjustment !== rightAdjustment) return rightAdjustment - leftAdjustment;
  if ((left.tile?.red === true) !== (right.tile?.red === true)) return left.tile?.red ? 1 : -1;
  if (left.kind !== right.kind) return left.kind - right.kind;
  return 0;
}

export function pickSafeTileDetailed(handAll, threats, view, discardCandidates = []) {
  if (threats.length === 0) return { index: -1, assessment: null };
  const visible = visibleCounts(view);
  const known = threatData(threats);
  const commonGenbutsuKinds = [...known[0].kinds]
    .filter(kind => known.every(threat => threat.kinds.has(kind)))
    .sort((a, b) => a - b);

  let best = null;
  for (let index = 0; index < handAll.length; index++) {
    const kind = handAll[index].kind;
    const safety = assessTileSafety(kind, threats, visible);
    if (!safety?.defenseSelectable) continue;
    const candidate = {
      index,
      kind,
      tile: handAll[index],
      efficiency: discardCandidates.find(item => item.action?.index === index) ?? null,
      ...safety,
    };
    if (!best || compareDefenseCandidate(candidate, best) < 0) {
      best = candidate;
    }
  }

  if (!best) return { index: -1, assessment: null };
  return {
    index: best.index,
    assessment: {
      threatCount: threats.length,
      commonGenbutsuKinds,
      category: best.category,
      commonGenbutsu: best.commonGenbutsu,
      maxRisk: best.maxRisk,
      totalRisk: best.totalRisk,
      perThreat: best.perThreat,
      perThreatDetails: best.perThreatDetails,
    },
  };
}

export function pickSafeTile(handAll, threats, view) {
  return pickSafeTileDetailed(handAll, threats, view).index;
}

function roundPhase(view) {
  const ownDiscards = view.public?.players?.[view.me]?.discards?.length ?? 0;
  const turnNumber = ownDiscards + 1;
  if (turnNumber <= 6) return { code: 'EARLY', turnNumber, efficiencyWeight: 1 };
  if (turnNumber <= 12) return { code: 'MIDDLE', turnNumber, efficiencyWeight: 0.9 };
  return { code: 'LATE', turnNumber, efficiencyWeight: 0.75 };
}

function meldSuit(meld) {
  const suits = new Set((meld?.tiles ?? []).map(tile => kindSuit(tile.kind)));
  return suits.size === 1 && !suits.has(null) ? [...suits][0] : null;
}

function publicFlushSignals(view) {
  const signals = [];
  for (const [seat, player] of (view.public?.players ?? []).entries()) {
    if (seat === view.me) continue;
    const meldCounts = [0, 0, 0];
    for (const meld of player.melds ?? []) {
      const suit = meldSuit(meld);
      if (suit !== null) meldCounts[suit]++;
    }
    if (meldCounts.filter(count => count > 0).length !== 1) continue;
    const suit = meldCounts.indexOf(Math.max(...meldCounts));
    const sameSuitMelds = meldCounts[suit];
    if (sameSuitMelds === 0) continue;
    const suitedDiscards = (player.discards ?? [])
      .map(discard => kindSuit(discard.tile.kind))
      .filter(value => value !== null);
    const targetSuitDiscards = suitedDiscards.filter(value => value === suit).length;
    const offSuitDiscards = suitedDiscards.length - targetSuitDiscards;
    const confidence = sameSuitMelds >= 2
      ? 'B'
      : (offSuitDiscards >= 4 && targetSuitDiscards <= 1 ? 'C' : null);
    if (!confidence) continue;
    signals.push({
      code: 'OPPONENT_FLUSH_SIGNAL',
      seat,
      suit,
      confidence,
      evidence: { sameSuitMelds, targetSuitDiscards, offSuitDiscards },
    });
  }
  return signals;
}

// 捨て牌・副露からの「テンパイ気配」推定 (AI_DESIGN_V12 第3段)。
// リーチ済みの相手は既存のthreats(現物・スジ計算)が担当するため対象外。
// 公開情報のみ: 副露数、河の長さ、直近の捨て牌が中張牌に寄る変化、染めシグナル。
function opponentPressureSignals(view, flushSignals) {
  const signals = [];
  for (const [seat, player] of (view.public?.players ?? []).entries()) {
    if (seat === view.me || player.riichi) continue;
    const discards = player.discards ?? [];
    const meldCount = (player.melds ?? []).length;
    const recent = discards.slice(-3);
    const recentMiddle = recent.filter(item =>
      item?.tile && !isHonor(item.tile.kind) && !isTerminal(item.tile.kind)).length;
    let score = 0;
    const evidence = {};
    if (meldCount >= 1) {
      score += meldCount >= 3 ? 0.6 : meldCount === 2 ? 0.45 : 0.15;
      evidence.meldCount = meldCount;
    }
    if (discards.length >= 6 && recentMiddle >= 2) {
      // 字牌・端牌の整理が終わり、手の中身(中張牌)が出始めた気配
      score += 0.35;
      evidence.recentMiddleDiscards = recentMiddle;
    }
    if (discards.length >= 10) {
      score += 0.1;
      evidence.deepRiver = true;
    }
    if (flushSignals.some(signal => signal.seat === seat && signal.confidence === 'B')) {
      score += 0.25;
      evidence.flushSignal = true;
    }
    if (score < 0.5) continue;
    signals.push({
      code: 'OPPONENT_TENPAI_PRESSURE',
      seat,
      score: Math.round(score * 100) / 100,
      confidence: score >= 0.7 ? 'B' : 'C',
      evidence,
      genbutsuKinds: [...new Set(discards.map(item => item?.tile?.kind).filter(Number.isInteger))].sort((a, b) => a - b),
    });
  }
  return signals;
}

// 点棒・順位から「速度⇔打点」のバイアスを決める (AI_DESIGN_V12 第2段)。
// 公開情報(点棒)と自分のplacementだけを使う。
function placementValueBias(view) {
  const placement = view?.placement;
  const points = view?.public?.points;
  if (!placement || !Array.isArray(points) || points.length < 2) {
    return { bias: 1, code: 'NEUTRAL' };
  }
  const me = Number.isInteger(view.me) ? view.me : 0;
  const myPoints = points[me];
  const lead = myPoints - Math.max(...points.filter((_, seat) => seat !== me));
  if (placement.mustPrioritizeRankUp || (placement.lastPlace && placement.scheduledFinalHand)) {
    // 順位を上げないと終わる局面: 効率を多少捨てても打点を取りにいく
    return { bias: 1.5, code: 'CHASE_VALUE' };
  }
  if (placement.currentRank === 0 && placement.scheduledFinalHand && lead >= 12000) {
    // 大差トップの最終盤: 打点より速度・安全
    return { bias: 0.6, code: 'PROTECT_LEAD' };
  }
  return { bias: 1, code: 'NEUTRAL' };
}

function strategicContext(view) {
  const flushSignals = publicFlushSignals(view);
  const context = {
    phase: roundPhase(view),
    flushSignals,
    pressureSignals: opponentPressureSignals(view, flushSignals),
    doraKinds: (view.public?.doraIndicators ?? []).map(tile => doraFromIndicator(tile.kind)),
  };
  // hand-plans.js へ渡す文脈 (AI_DESIGN_V12 第1段)
  const valueBias = placementValueBias(view);
  context.planContext = {
    seatWind: view.seatWind,
    roundWind: view.roundWind,
    doraKinds: context.doraKinds,
    phase: context.phase.code === 'EARLY' ? 'early' : context.phase.code === 'MIDDLE' ? 'middle' : 'late',
    valueBias: valueBias.bias,
    valueBiasCode: valueBias.code,
  };
  return context;
}

function suitPressure(tile, signals) {
  const suit = kindSuit(tile.kind);
  if (suit === null) return { penalty: 0, signals: [] };
  const matched = signals.filter(signal => signal.suit === suit);
  return {
    // v12.5: プラン価値(±4)と同じ土俵で効くよう再校正。B=はっきりした染め気配、C=弱い気配
    penalty: matched.reduce((sum, signal) => sum + (signal.confidence === 'B' ? -3 : -1.5), 0),
    signals: matched,
  };
}

function discardCandidate({
  handAll, index, meldCount, visible, view, style, threats,
  shantenCache, context, calculateUkeire = true,
}) {
  const tile = handAll[index];
  const rest = handAll.slice();
  rest.splice(index, 1);
  const counts = toCounts(rest);
  const afterShanten = cachedShanten(shantenCache, counts, meldCount);
  let ukeirePhysical = calculateUkeire ? 0 : null;
  const ukeireByKind = [];
  const improvingKinds = [];
  if (calculateUkeire) {
    for (let kind = 0; kind < KIND_COUNT; kind++) {
      if (counts[kind] >= 4) continue;
      counts[kind]++;
      if (cachedShanten(shantenCache, counts, meldCount) < afterShanten) {
        improvingKinds.push(kind);
        // visibleは打牌予定牌も既知牌として含む。自牌を二重控除しない。
        const remaining = remainingCopies(visible, kind);
        if (remaining > 0) {
          ukeirePhysical += remaining;
          ukeireByKind.push({ kind, remaining });
        }
      }
      counts[kind]--;
    }
  }

  const doraMultiplicity = context.doraKinds.filter(kind => kind === tile.kind).length;
  const pressure = suitPressure(tile, context.flushSignals);
  const safety = assessTileSafety(tile.kind, threats, visible);
  // 赤切りペナルティ: 2向聴以上の浮き牌整理では赤を最後まで残す(受け入れ差より
  // 確定1翻を優先=2026-08-19実戦カルテ17号)。テンパイ・1向聴は待ちの質を優先
  const utilityAdjustments = { redDiscardPenalty: tile.red ? (afterShanten >= 2 ? -4 : -0.5) : 0 };
  if (doraMultiplicity > 0) utilityAdjustments.doraDiscardPenalty = -0.75 * doraMultiplicity;
  if (pressure.penalty !== 0) utilityAdjustments.suitPressurePenalty = pressure.penalty;
  // 回し打ち (AI_DESIGN_V12 v12.4): リーチ相手がいて撤退条件未満(=押しモード)でも、
  // 危険度を効用に算入する。テンパイに近いほど押し、遠いほど安全牌で回す。
  // 「無筋を通すチャレンジ」は見返り(テンパイ・打点必要状況)があるときに限る。
  if (threats.length > 0 && !view.riichi && safety && safety.maxRisk > 0) {
    const pushFactor = afterShanten === 0 ? 0.15 : afterShanten === 1 ? 0.3 : 0.5;
    const biasCode = context.planContext?.valueBiasCode;
    const biasAdjust = biasCode === 'CHASE_VALUE' ? 0.7 : biasCode === 'PROTECT_LEAD' ? 1.3 : 1;
    // 打点対比 (2026-08-19実戦カルテ21号): カン入り・ドラ表示増のリーチは高打点の
    // 気配(裏ドラも倍)。相手が高そうで自手が安いほど降り寄りに倒す。
    const threatScale = context.threatValue?.threatScale ?? 1;
    const cheapScale = context.threatValue?.cheapScale ?? 1;
    const penalty = -(safety.maxRisk * pushFactor * (style.cautionWeight ?? 1) * biasAdjust * threatScale * cheapScale);
    utilityAdjustments.pushRiskPenalty = Math.round(penalty * 100) / 100;
  }
  // テンパイ気配への警戒 (AI_DESIGN_V12 第3段): 気配のある相手に危険な牌ほど
  // 早めに処理せず…ではなく「同等の進み方なら通りやすい牌から切る」方向の補正。
  // 捨てる牌が危険なほどペナルティ(=残して安全牌を先に切る)。
  let pressureCaution = null;
  if ((context.pressureSignals?.length ?? 0) > 0 && !view.riichi) {
    let penalty = 0;
    const perSeat = [];
    for (const signal of context.pressureSignals) {
      let danger;
      if (signal.genbutsuKinds.includes(tile.kind)) danger = 0;
      else if (isHonor(tile.kind)) danger = 0.15;
      else if (isTerminal(tile.kind)) danger = 0.3;
      else danger = 0.6;
      const applied = -(signal.score * danger * 1.2 * (style.cautionWeight ?? 1));
      penalty += applied;
      perSeat.push({ seat: signal.seat, score: signal.score, danger, applied: Math.round(applied * 100) / 100 });
    }
    if (penalty !== 0) {
      utilityAdjustments.pressureCautionPenalty = Math.round(penalty * 100) / 100;
      pressureCaution = perSeat;
    }
  }

  // プラン評価層 (AI_DESIGN_V12): 捨てる牌の「残す価値」をペナルティとして合流させる。
  // 向聴数は utility の -shanten×1000 が支配するため、プラン価値が向聴を覆すことはない。
  let planEvaluation = null;
  if (context.plans) {
    planEvaluation = tileRetentionValue(tile, context.plans, handAll, context.planContext);
    if (planEvaluation.retention > 0) {
      // テンパイへ入る打牌では待ち質(受け入れ実枚数)を優先し、プラン価値は0.4倍に減衰。
      // 「効率が少し落ちても高め」は許すが、生き待ち3枚→1枚のような大損は許さない。
      const tenpaiAttenuation = afterShanten === 0 ? 0.3 : 1;
      // 3向聴以上の未発達な手では「切り順」(牌の価値序列と骨組み)が受け入れ枚数より
      // 支配的であるべき (カルテ9号: 雑手で暗刻や赤を切った実戦バグ群)
      const deepShantenBoost = afterShanten >= 3 ? 3 : 1;
      const valueBias = context.planContext?.valueBias ?? 1;
      planEvaluation = {
        ...planEvaluation,
        tenpaiAttenuation,
        valueBias,
        valueBiasCode: context.planContext?.valueBiasCode ?? 'NEUTRAL',
      };
      utilityAdjustments.planRetention =
        -(PLAN_SCALE * deepShantenBoost * planEvaluation.retention * tenpaiAttenuation * valueBias);
    }
  }
  const utilityAdjustment = Object.values(utilityAdjustments)
    .reduce((sum, adjustment) => sum + adjustment, 0);
  // v12.6: 向聴数が深いほど「生の受け入れ枚数」の信頼度を割り引く。
  // 3向聴の雑手では浮き牌を抱えるほど枚数が膨らみ、完成面子を崩す誘因になるため
  // (カルテ9号: 發の暗刻から切った実戦バグ)。同一向聴内の比較なので順序は保たれ、
  // 差分だけが縮んでプラン・骨組み・安全の項が相対的に強くなる。
  const shantenDamp = afterShanten <= 1 ? 1 : afterShanten === 2 ? 0.65 : afterShanten === 3 ? 0.5 : 0.35;
  const utilityScore = calculateUkeire
    ? ukeirePhysical * context.phase.efficiencyWeight * shantenDamp + utilityAdjustment
    : null;
  let riichiEvaluation = null;
  let declareRiichi = false;
  if (calculateUkeire && afterShanten === 0 && canDeclareRiichi(view)) {
    const waits = improvingKinds;
    const liveWaitsByKind = waits.map(kind => ({
      kind,
      remaining: remainingCopies(visible, kind),
    })).filter(item => item.remaining > 0);
    const liveWaits = liveWaitsByKind.reduce((sum, item) => sum + item.remaining, 0);
    riichiEvaluation = {
      waitKinds: waits,
      physicalRemaining: liveWaits,
      byKind: liveWaitsByKind,
      requiredMinimum: style.riichiLiveMin,
    };
    declareRiichi = liveWaits >= style.riichiLiveMin;
  }

  return {
    candidateId: `discard:${index}:${tile.kind}:${tile.red ? 1 : 0}`,
    action: { action: 'discard', index, riichi: declareRiichi },
    legal: true,
    utility: -afterShanten * 1000 + (utilityScore ?? 0),
    metrics: {
      shanten: afterShanten,
      ukeirePhysical,
      ukeireByKind,
      utilityAdjustment,
      utilityAdjustments,
      utilityScore,
      phase: context.phase,
      knownValue: {
        redDora: tile.red ? 1 : 0,
        visibleDora: doraMultiplicity,
        evaluatedScope: 'DISCARDED_TILE_KNOWN_BONUS_ONLY',
      },
      opponentSuitPressure: pressure.signals,
      efficiencyEvaluated: calculateUkeire,
      riichiEvaluation,
      safety,
      ...(planEvaluation ? { planEvaluation } : {}),
      ...(pressureCaution ? { pressureCaution } : {}),
    },
    reasons: planEvaluation && planEvaluation.retention > 0
      ? ['SHANTEN_UKEIRE', 'PLAN_RETENTION']
      : ['SHANTEN_UKEIRE'],
  };
}

function isValueHonor(kind, view) {
  return isHonor(kind) && (isDragon(kind) || kind === view?.seatWind || kind === view?.roundWind);
}

// 牌効率が完全に同じときだけ、単独の役にならない字牌を先に処理する。
// 数牌の小さい順で選ぶ旧tie-breakは、理由のない1筒切りを生んでいた。
function discardTiePriority(candidate, handAll, view) {
  const tile = handAll[candidate?.action?.index];
  if (!tile || !isHonor(tile.kind)) return 0;
  const copies = handAll.filter(item => item.kind === tile.kind).length;
  if (copies !== 1) return 0;
  return isValueHonor(tile.kind, view) ? -1 : 1;
}

function preferredEfficiencyDiscard(candidates, handAll, view) {
  let best = null;
  for (const candidate of candidates) {
    if (candidate.action?.action !== 'discard') continue;
    const metrics = candidate.metrics;
    const candidateKind = Number(candidate.candidateId.split(':')[2]);
    const candidateRed = Number(candidate.candidateId.split(':')[3]);
    const bestKind = best ? Number(best.candidateId.split(':')[2]) : Infinity;
    const bestRed = best ? Number(best.candidateId.split(':')[3]) : Infinity;
    const candidateTiePriority = discardTiePriority(candidate, handAll, view);
    const bestTiePriority = best ? discardTiePriority(best, handAll, view) : -Infinity;
    const sameEfficiency = best &&
      metrics.shanten === best.metrics.shanten &&
      metrics.utilityScore === best.metrics.utilityScore &&
      metrics.ukeirePhysical === best.metrics.ukeirePhysical;
    const winsTie = candidateTiePriority > bestTiePriority ||
      (candidateTiePriority === bestTiePriority && (candidateKind < bestKind ||
        (candidateKind === bestKind && candidateRed < bestRed)));
    if (!best || metrics.shanten < best.metrics.shanten ||
        (metrics.shanten === best.metrics.shanten &&
          metrics.utilityScore > best.metrics.utilityScore) ||
        (metrics.shanten === best.metrics.shanten &&
          metrics.utilityScore === best.metrics.utilityScore &&
          metrics.ukeirePhysical > best.metrics.ukeirePhysical) ||
        (sameEfficiency && winsTie)) {
      best = candidate;
    }
  }
  return best;
}

function efficiencyDecisiveFactors(selected, candidates, context) {
  const comparable = candidates.filter(candidate =>
    candidate !== selected && candidate.action?.action === 'discard' &&
    candidate.metrics.shanten === selected.metrics.shanten &&
    Number.isFinite(candidate.metrics.ukeirePhysical));
  const factors = [{ code: 'LOWEST_SHANTEN', value: selected.metrics.shanten }];
  if (comparable.length === 0) return factors;
  const widestAlternative = comparable.slice().sort((left, right) =>
    right.metrics.ukeirePhysical - left.metrics.ukeirePhysical ||
    right.metrics.utilityScore - left.metrics.utilityScore)[0];
  const selectedUkeire = selected.metrics.ukeirePhysical;
  const alternativeUkeire = widestAlternative.metrics.ukeirePhysical;
  if (selectedUkeire > alternativeUkeire) {
    factors.push({
      code: context.phase.code === 'EARLY'
        ? 'EARLY_EFFICIENCY_PRIORITY'
        : 'EFFICIENCY_EDGE',
      selectedUkeire,
      alternativeUkeire,
      delta: selectedUkeire - alternativeUkeire,
      turnNumber: context.phase.turnNumber,
    });
  } else if (selectedUkeire < alternativeUkeire) {
    // 回し打ち: 広い方の候補が危険牌で、安全側を選んで受け入れを妥協したとき (v12.4)
    const selectedPushRisk = selected.metrics.utilityAdjustments.pushRiskPenalty ?? 0;
    const alternativePushRisk = widestAlternative.metrics.utilityAdjustments.pushRiskPenalty ?? 0;
    if (selectedPushRisk - alternativePushRisk > 1) {
      factors.push({
        code: 'MAWASHI_SAFE_ADVANCE',
        selectedUkeire,
        alternativeUkeire,
        avoidedRisk: widestAlternative.metrics.safety?.maxRisk ?? null,
      });
      return factors.slice(0, 3);
    }
    const selectedPressure = selected.metrics.utilityAdjustments.suitPressurePenalty ?? 0;
    const alternativePressure = widestAlternative.metrics.utilityAdjustments.suitPressurePenalty ?? 0;
    const selectedDora = selected.metrics.utilityAdjustments.doraDiscardPenalty ?? 0;
    const alternativeDora = widestAlternative.metrics.utilityAdjustments.doraDiscardPenalty ?? 0;
    if (selectedPressure > alternativePressure) {
      factors.push({
        code: 'SUIT_PRESSURE_AVOIDED',
        selectedUkeire,
        alternativeUkeire,
        signals: widestAlternative.metrics.opponentSuitPressure,
      });
    } else if (selectedDora > alternativeDora ||
        selected.metrics.utilityAdjustments.redDiscardPenalty >
          widestAlternative.metrics.utilityAdjustments.redDiscardPenalty) {
      factors.push({
        code: 'KNOWN_VALUE_PRESERVED',
        selectedUkeire,
        alternativeUkeire,
        evaluatedScope: 'KNOWN_DORA_ONLY',
      });
    }
  } else {
    factors.push({ code: 'EQUIVALENT_UKEIRE', value: selectedUkeire });
    // 受け入れ同数の分かれ目をプラン価値が決めたときは、その根拠を残す (v12)
    const selectedRetention = selected.metrics.planEvaluation?.retention ?? 0;
    const alternativeRetention = widestAlternative.metrics.planEvaluation?.retention ?? 0;
    if (alternativeRetention - selectedRetention > 0.2) {
      factors.push({
        code: 'PLAN_VALUE_EDGE',
        topPlan: widestAlternative.metrics.planEvaluation?.topPlans?.[0]?.code ?? null,
        keptTileNotes: widestAlternative.metrics.planEvaluation?.notes ?? [],
        selectedNotes: selected.metrics.planEvaluation?.notes ?? [],
        valueBias: selected.metrics.planEvaluation?.valueBiasCode ?? 'NEUTRAL',
      });
    }
    // 回し打ちが分かれ目のとき (v12.4)
    const selectedPushRisk = selected.metrics.utilityAdjustments.pushRiskPenalty ?? 0;
    const alternativePushRisk = widestAlternative.metrics.utilityAdjustments.pushRiskPenalty ?? 0;
    if (selectedPushRisk - alternativePushRisk > 1) {
      factors.push({
        code: 'MAWASHI_SAFE_ADVANCE',
        selectedUkeire,
        alternativeUkeire,
        avoidedRisk: widestAlternative.metrics.safety?.maxRisk ?? null,
      });
    }
    // テンパイ気配警戒が分かれ目になったとき (v12第3段)
    const selectedPressure = selected.metrics.utilityAdjustments.pressureCautionPenalty ?? 0;
    const alternativePressure = widestAlternative.metrics.utilityAdjustments.pressureCautionPenalty ?? 0;
    if (selectedPressure - alternativePressure > 0.3) {
      factors.push({
        code: 'PRESSURE_CAUTION',
        seats: (selected.metrics.pressureCaution ?? []).map(item => item.seat),
      });
    }
  }
  if (selected.metrics.utilityAdjustment !== 0 && factors.length < 3) {
    factors.push({ code: 'UTILITY_ADJUSTMENT', value: selected.metrics.utilityAdjustment });
  }
  return factors.slice(0, 3);
}

function selectedSummary(candidate) {
  return {
    candidateId: candidate.candidateId,
    action: candidate.action ? copyJson(candidate.action) : null,
    reasonCodes: [...candidate.reasons],
  };
}

function finalizeAnalysis({
  profile, phase, facts, hardConstraints, candidates, selected,
  decisiveFactors, legacyTrace, estimates = [], coverage = {},
}) {
  // elapsedMs=0は「未計測」ではなく、この同期・非探索ベースラインの決定値。
  // 実時間を混ぜず、同一入力の解析JSONをバイト単位で再現可能にする。
  const evaluatedCount = candidates.filter(candidate => candidate.metrics?.evaluated !== false).length;
  const completeness = candidates.length === 0 ? 1 : evaluatedCount / candidates.length;
  const hasCoverageGap = Object.values(coverage).some(value =>
    value === 'NOT_EVALUATED' || value === 'PARTIAL_KNOWN_BONUS_ONLY' ||
    value === 'STRUCTURAL_NOT_CALIBRATED');
  return deepFreeze(copyJson({
    evaluatorVersion: DECISION_EVALUATOR_VERSION,
    profile,
    phase,
    facts,
    estimates,
    coverage,
    hardConstraints,
    candidates,
    selected: selectedSummary(selected),
    decisiveFactors: decisiveFactors.slice(0, 3),
    confidence: completeness !== 1 ? 'PARTIAL' : (hasCoverageGap ? 'B' : 'A'),
    completeness,
    elapsedMs: 0,
    legacyTrace,
  }));
}

function turnFacts(view, options, handAll, meldCount, currentShanten, threats, context) {
  return [
    { code: 'PUBLIC_VIEW_ONLY', value: true },
    { code: 'LEGAL_OPTIONS', value: [...options] },
    { code: 'HAND_TILE_COUNT', value: handAll.length },
    { code: 'MELD_COUNT', value: meldCount },
    { code: 'CURRENT_SHANTEN', value: currentShanten },
    { code: 'RIICHI_THREAT_SEATS', value: threats.map(threat => threat.i) },
    { code: 'LIVE_WALL_REMAINING', value: view.public?.remaining ?? null },
    {
      code: 'ROUND_PHASE',
      value: context.phase.code,
      turnNumber: context.phase.turnNumber,
    },
    {
      code: 'CURRENT_POINTS_AND_RANK',
      points: view.public?.points?.[view.me] ?? null,
      rank: view.placement?.currentRank ?? null,
      targetRank: view.placement?.targetRank ?? null,
    },
  ];
}

export function evaluateTurnDecision(view, options = [], profile = 'analyst') {
  const normalizedProfile = normalizeProfile(profile);
  const style = AI_STYLES[normalizedProfile];
  const optionSet = new Set(options);
  const shantenCache = new Map();
  const handAll = view.drawn ? [...view.hand, view.drawn] : [...view.hand];
  const meldCount = (view.melds ?? []).length;
  const currentShanten = cachedShanten(shantenCache, toCounts(handAll), meldCount);
  const threats = (view.public?.players ?? [])
    .map((player, i) => ({ pl: player, i }))
    .filter(threat => threat.i !== view.me && threat.pl.riichi)
    .map(threat => ({ ...threat, passedKinds: passedKindsForThreat(view, threat.pl) }));
  const context = strategicContext(view);
  // プラン列挙は手牌全体から1回だけ (各打牌候補で共有)
  context.plans = evaluateHandPlans(handAll, view.melds ?? [], context.planContext);
  // 打点対比 (カルテ21号): 公開情報から相手リーチの高さと自手の安さを見積もり、
  // 押し引きペナルティのスケールにする。カン(ドラ表示増=裏ドラも倍)は高打点の気配
  if (threats.length > 0) {
    const indicators = view.public?.doraIndicators?.length ?? 1;
    const threatKans = threats.reduce((sum, threat) =>
      sum + (threat.pl.melds ?? []).filter(meld => (meld.tiles?.length ?? 0) === 4).length, 0);
    const threatScale = Math.min(2.2, 1 + 0.35 * Math.max(0, indicators - 1) + 0.3 * threatKans);
    const ownValueTiles = handAll.filter(tile =>
      tile.red || context.doraKinds.includes(tile.kind)).length;
    const cheapScale = ownValueTiles >= 2 ? 1 : ownValueTiles === 1 ? 1.15 : 1.3;
    context.threatValue = { threatScale, cheapScale, indicators, threatKans, ownValueTiles };
  }
  const forbiddenWin = optionSet.has('tsumo') && isForbiddenLastPlaceWin(view.winPreview);
  const sanitizedWinPreview = copyKnown(view.winPreview, WIN_PREVIEW_KEYS);
  const placement = copyKnown(view.placement, PLACEMENT_KEYS);
  const facts = turnFacts(view, options, handAll, meldCount, currentShanten, threats, context);
  if (context.threatValue && (context.threatValue.threatScale > 1 || context.threatValue.cheapScale > 1)) {
    facts.push({ code: 'THREAT_VALUE_CONTRAST', ...context.threatValue });
  }
  const estimates = [...context.flushSignals, ...context.pressureSignals];
  const coverage = {
    legality: 'EXACT',
    shanten: 'EXACT',
    ukeire: 'EXACT_MIN_SHANTEN_CANDIDATES',
    handValue: 'PARTIAL_KNOWN_BONUS_ONLY',
    safety: threats.length > 0 ? 'STRUCTURAL_NOT_CALIBRATED' : 'NOT_REQUIRED',
    placementEV: 'NOT_EVALUATED',
  };
  const hardConstraints = [baseHardConstraint(forbiddenWin, forbiddenWin ? 'tsumo' : null)];
  const candidates = [];

  if (optionSet.has('tsumo')) {
    candidates.push({
      candidateId: 'tsumo',
      action: { action: 'tsumo' },
      legal: true,
      allowed: !forbiddenWin,
      utility: forbiddenWin ? -1000000 : 1000000,
      metrics: { winPreview: sanitizedWinPreview },
      reasons: [forbiddenWin ? 'LAST_PLACE_LOCK_FORBIDDEN' : 'LEGAL_WIN'],
    });
    if (!forbiddenWin) {
      const selected = candidates[0];
      return finalizeAnalysis({
        profile: normalizedProfile,
        phase: 'win', facts, hardConstraints, candidates, selected, estimates, coverage,
        decisiveFactors: [{ code: 'LEGAL_WIN', action: 'tsumo' }],
        legacyTrace: { phase: 'win', reason: 'LEGAL_WIN', winPreview: sanitizedWinPreview },
      });
    }
  }

  const rejectedWin = forbiddenWin ? {
    action: 'tsumo', reason: 'LAST_PLACE_LOCK_FORBIDDEN', winPreview: sanitizedWinPreview,
  } : null;

  if (optionSet.has('kyuushu')) {
    const selected = {
      candidateId: 'kyuushu', action: { action: 'kyuushu' }, legal: true,
      allowed: true, utility: 900000, metrics: {}, reasons: ['KYUUSHU_KYUUHAI'],
    };
    candidates.push(selected);
    return finalizeAnalysis({
      profile: normalizedProfile,
      phase: 'abortive-draw', facts, hardConstraints, candidates, selected, estimates, coverage,
      decisiveFactors: [{ code: 'KYUUSHU_KYUUHAI' }],
      legacyTrace: {
        phase: 'abortive-draw', reason: 'KYUUSHU_KYUUHAI', rejectedWin,
      },
    });
  }

  if (optionSet.has('ankan')) {
    const counts = toCounts(handAll);
    const before = cachedShanten(shantenCache, counts, meldCount);
    let selected = null;
    for (let kind = 0; kind < KIND_COUNT; kind++) {
      if (counts[kind] !== 4) continue;
      counts[kind] = 0;
      const after = cachedShanten(shantenCache, counts, meldCount + 1);
      counts[kind] = 4;
      const candidate = {
        candidateId: `ankan:${kind}`,
        action: { action: 'ankan', kind },
        legal: true,
        allowed: true,
        utility: 800000 + before - after,
        metrics: { kind, beforeShanten: before, afterShanten: after },
        reasons: [after <= before ? 'SHANTEN_NOT_WORSE' : 'SHANTEN_WORSE'],
      };
      candidates.push(candidate);
      if (!selected && after <= before) selected = candidate;
    }
    if (selected) {
      return finalizeAnalysis({
        profile: normalizedProfile,
        phase: 'kan', facts, hardConstraints, candidates, selected, estimates, coverage,
        decisiveFactors: [{
          code: 'SHANTEN_NOT_WORSE',
          beforeShanten: selected.metrics.beforeShanten,
          afterShanten: selected.metrics.afterShanten,
        }],
        legacyTrace: {
          phase: 'kan', reason: 'SHANTEN_NOT_WORSE',
          beforeShanten: selected.metrics.beforeShanten,
          afterShanten: selected.metrics.afterShanten,
          kind: selected.metrics.kind, rejectedWin,
        },
      });
    }
  }

  // 加槓は合法候補として欠落させないが、従来COMには評価則がないため選ばない。
  if (optionSet.has('kakan')) {
    for (const kind of availableKakanKinds(handAll, view.melds)) {
      candidates.push({
        candidateId: `kakan:${kind}`, action: { action: 'kakan', kind }, legal: true,
        allowed: true, utility: -100000, metrics: { kind, evaluated: false },
        reasons: ['BASELINE_KAKAN_NOT_EVALUATED'],
      });
    }
  }

  const visible = visibleCounts(view);
  const discardCandidateIndexes = [];
  for (let index = 0; index < handAll.length; index++) {
    discardCandidateIndexes.push(candidates.length);
    candidates.push(discardCandidate({
      handAll, index, meldCount, visible, view, style, threats, shantenCache,
      context,
      calculateUkeire: false,
    }));
  }

  // 全候補の向聴数は厳密に保持し、受け入れ全探索は最小向聴候補だけに限定する。
  // 悪化候補の未計算値はnullで明示し、値を捏造せず従来COMの速度を維持する。
  const bestShanten = discardCandidateIndexes.reduce((best, candidateIndex) =>
    Math.min(best, candidates[candidateIndex].metrics.shanten), Infinity);
  for (const candidateIndex of discardCandidateIndexes) {
    const candidate = candidates[candidateIndex];
    if (candidate.metrics.shanten !== bestShanten) continue;
    candidates[candidateIndex] = discardCandidate({
      handAll,
      index: candidate.action.index,
      meldCount,
      visible,
      view,
      style,
      threats,
      shantenCache,
      context,
      calculateUkeire: true,
    });
  }

  const discardCandidates = candidates.filter(candidate => candidate.action?.action === 'discard');
  let selected = null;
  let legacyTrace = null;
  let decisiveFactors = [];

  // 打点対比 (カルテ21号): 相手のリーチが高そう(カン・ドラ表示増)で自手が安いときは
  // 降りの閾値を1段早める(analystは1向聴から降り)。テンパイからは降ろさない
  const highContrast = context.threatValue &&
    context.threatValue.threatScale >= 1.3 && context.threatValue.cheapScale >= 1.15;
  const effectiveFoldAt = highContrast ? Math.max(1, style.foldAt - 1) : style.foldAt;
  if (threats.length > 0 && currentShanten >= effectiveFoldAt && !view.riichi) {
    const safeChoice = pickSafeTileDetailed(handAll, threats, view, discardCandidates);
    if (safeChoice.index >= 0) {
      selected = discardCandidates.find(candidate => candidate.action.index === safeChoice.index);
      // 守備選択ではリーチ宣言をしない。
      selected.action.riichi = false;
      selected.reasons = [safeChoice.assessment.commonGenbutsu
        ? 'RIICHI_COMMON_GENBUTSU'
        : 'RIICHI_LEAST_RISK_NON_GENBUTSU'];
      legacyTrace = {
        phase: 'defense', reason: selected.reasons[0],
        tile: tileCopy(handAll[safeChoice.index]), shanten: currentShanten,
        safety: safeChoice.assessment, rejectedWin,
      };
      decisiveFactors = [{
        code: 'FOLD_ON_RIICHI_THREAT', threatCount: threats.length,
        currentShanten,
        foldAt: style.foldAt,
        maxRisk: safeChoice.assessment.maxRisk,
      }, {
        code: selected.reasons[0],
        commonGenbutsu: safeChoice.assessment.commonGenbutsu,
        maxRisk: safeChoice.assessment.maxRisk,
      }];
    }
  }

  if (!selected && view.riichi) {
    const drawnIndex = handAll.length - 1;
    selected = discardCandidates.find(candidate => candidate.action.index === drawnIndex);
    if (!selected) {
      selected = discardCandidate({
        handAll, index: drawnIndex, meldCount, visible, view, style, threats,
        shantenCache, context,
      });
      candidates.push(selected);
    }
    selected.action.riichi = false;
    selected.reasons = [rejectedWin ? 'FORBIDDEN_WIN_THEN_TSUMOGIRI' : 'RIICHI_TSUMOGIRI'];
    legacyTrace = {
      phase: 'riichi',
      reason: rejectedWin ? 'FORBIDDEN_WIN_THEN_TSUMOGIRI' : 'RIICHI_TSUMOGIRI',
      tile: tileCopy(handAll[drawnIndex]), rejectedWin,
    };
    decisiveFactors = [{ code: selected.reasons[0] }];
  }

  if (!selected) {
    selected = preferredEfficiencyDiscard(discardCandidates, handAll, view);
    if (!selected) throw new TypeError('DecisionEvaluator: discard候補がありません');
    const metrics = selected.metrics;
    const index = selected.action.index;
    legacyTrace = {
      phase: 'discard', reason: 'SHANTEN_UKEIRE', tile: tileCopy(handAll[index]),
      shanten: metrics.shanten,
      // ukeireは後方互換名。補正前の物理残枚数で統一する。
      ukeire: metrics.ukeirePhysical,
      ukeirePhysical: metrics.ukeirePhysical,
      ukeireByKind: metrics.ukeireByKind,
      utilityAdjustment: metrics.utilityAdjustment,
      utilityAdjustments: metrics.utilityAdjustments,
      utilityScore: metrics.utilityScore,
      declareRiichi: selected.action.riichi,
      riichiEvaluation: metrics.riichiEvaluation,
      rejectedWin,
      placement,
    };
    decisiveFactors = efficiencyDecisiveFactors(selected, discardCandidates, context);
  }

  return finalizeAnalysis({
    profile: normalizedProfile,
    phase: legacyTrace.phase,
    facts, estimates, coverage,
    hardConstraints,
    candidates,
    selected,
    decisiveFactors,
    legacyTrace,
  });
}

function claimFacts(view, offer) {
  return [
    { code: 'PUBLIC_VIEW_ONLY', value: true },
    { code: 'OFFER_TYPE', value: offer.type },
    { code: 'OFFER_TILE_KIND', value: offer.tile?.kind ?? null },
    { code: 'MELD_COUNT', value: (view.melds ?? []).length },
  ];
}

export function evaluateClaimDecision(view, offer, profile = 'analyst') {
  const normalizedProfile = normalizeProfile(profile);
  const style = AI_STYLES[normalizedProfile];
  const forbiddenWin = offer.type === 'ron' && isForbiddenLastPlaceWin(offer.winPreview);
  const sanitizedWinPreview = copyKnown(offer.winPreview, WIN_PREVIEW_KEYS);
  const placement = copyKnown(view.placement, PLACEMENT_KEYS);
  const facts = claimFacts(view, offer);
  const coverage = offer.type === 'ron' ? {
    legality: 'EXACT',
    shanten: 'NOT_REQUIRED',
    ukeire: 'NOT_REQUIRED',
    handValue: 'EXACT_OFFERED_WIN',
    safety: 'NOT_REQUIRED',
    placementEV: 'EXACT_WIN_PREVIEW',
  } : {
    legality: 'EXACT',
    shanten: 'NOT_EVALUATED',
    ukeire: 'NOT_EVALUATED',
    handValue: 'NOT_EVALUATED',
    safety: 'NOT_EVALUATED',
    placementEV: 'NOT_EVALUATED',
  };
  const hardConstraints = [baseHardConstraint(forbiddenWin, forbiddenWin ? 'ron' : null)];
  const pass = {
    candidateId: 'pass', action: null, legal: true, allowed: true, utility: 0,
    metrics: {}, reasons: ['KEEP_CLOSED'],
  };
  const candidates = [pass];

  if (offer.type === 'ron') {
    const ron = {
      candidateId: 'ron', action: { action: 'ron' }, legal: true,
      allowed: !forbiddenWin, utility: forbiddenWin ? -1000000 : 1000000,
      metrics: { winPreview: sanitizedWinPreview },
      reasons: [forbiddenWin ? 'LAST_PLACE_LOCK_FORBIDDEN' : 'LEGAL_WIN'],
    };
    candidates.push(ron);
    const selected = forbiddenWin ? pass : ron;
    const reason = forbiddenWin ? 'LAST_PLACE_LOCK_FORBIDDEN' : 'LEGAL_WIN';
    return finalizeAnalysis({
      profile: normalizedProfile,
      phase: 'win', facts, hardConstraints, candidates, selected, coverage,
      decisiveFactors: [{ code: reason, action: 'ron' }],
      legacyTrace: {
        phase: 'win', reason, offered: 'ron', winPreview: sanitizedWinPreview,
      },
    });
  }

  const counts = toCounts(view.hand ?? []);
  let selected = null;
  if (offer.canPon) {
    const kind = offer.tile.kind;
    const isYakuhai = isDragon(kind) || kind === view.seatWind || kind === view.roundWind;
    const pairs = counts.filter(count => count >= 2).length;
    // ガイド用: ポンした場合の向聴数変化(鳴いた後の最善打牌まで見て比較)
    const meldCount = (view.melds ?? []).length;
    const shantenBefore = shanten(counts, meldCount);
    let shantenAfter = null;
    if (counts[kind] >= 2) {
      const afterCounts = counts.slice();
      afterCounts[kind] -= 2;
      shantenAfter = Infinity;
      for (let discardKind = 0; discardKind < KIND_COUNT; discardKind++) {
        if (afterCounts[discardKind] === 0) continue;
        afterCounts[discardKind]--;
        shantenAfter = Math.min(shantenAfter, shanten(afterCounts, meldCount + 1));
        afterCounts[discardKind]++;
      }
      if (!Number.isFinite(shantenAfter)) shantenAfter = null;
    }
    // 手中に暗刻が完成しているなら、4枚目のポンは面子を壊すだけの無意味な鳴き
    // (カルテ10号: 白白白を持って4枚目の白をポンした実戦バグ)
    const ankoComplete = counts[kind] >= 3;
    // トイトイ名目のポンは向聴が進むときだけ(カルテ18号: 123m+1mの対子をポンして
    // 「速くなりません」と言いながら勧めた実戦バグ。完成順子と重なる対子は骨を壊す)
    const speedsUp = Number.isFinite(shantenAfter) && shantenAfter !== null &&
      Number.isFinite(shantenBefore) && shantenAfter < shantenBefore;
    const toitoiRoute = !ankoComplete && pairs >= style.ponPairMin && counts[kind] >= 2 && speedsUp;
    const pon = {
      candidateId: `pon:${kind}`, action: { action: 'pon' }, legal: true,
      allowed: !ankoComplete,
      utility: ankoComplete ? -1000 : (isYakuhai ? 1000 : (toitoiRoute ? 900 : -100)),
      metrics: { kind, isYakuhai, pairs, requiredPairs: style.ponPairMin, ankoComplete, shantenBefore, shantenAfter },
      reasons: [ankoComplete ? 'ANKO_ALREADY_COMPLETE'
        : (isYakuhai ? 'YAKUHAI_PON' : (toitoiRoute ? 'TOITOI_ROUTE' : 'KEEP_CLOSED'))],
    };
    candidates.push(pon);
    if (!ankoComplete && (isYakuhai || toitoiRoute)) selected = pon;
  }

  if (offer.canKan) {
    candidates.push({
      candidateId: `minkan:${offer.tile.kind}`, action: { action: 'minkan' },
      legal: true, allowed: true, utility: -100, metrics: { evaluated: false },
      reasons: ['BASELINE_MINKAN_NOT_EVALUATED'],
    });
  }
  for (const tiles of offer.canChi ?? []) {
    candidates.push({
      candidateId: `chi:${tiles.join('-')}`, action: { action: 'chi', tiles: [...tiles] },
      legal: true, allowed: true, utility: -100, metrics: { evaluated: false },
      reasons: ['BASELINE_CHI_NOT_EVALUATED'],
    });
  }

  // 形式テンパイ (カルテ19号): 流局間際(残り8枚以下)に鳴いてテンパイへ届くなら、
  // 「門前・リーチの道」より流局時のノーテン罰符回避を優先する
  const liveRemaining = view.public?.remaining;
  if (!selected && Number.isFinite(liveRemaining) && liveRemaining <= 8) {
    const claimMeldCount = (view.melds ?? []).length;
    const shantenNow = shanten(counts, claimMeldCount);
    const bestAfterClaim = tilesOut => {
      const after = counts.slice();
      for (const outKind of tilesOut) {
        if (after[outKind] <= 0) return null;
        after[outKind]--;
      }
      let bestShanten = Infinity;
      for (let discardKind = 0; discardKind < KIND_COUNT; discardKind++) {
        if (after[discardKind] === 0) continue;
        after[discardKind]--;
        bestShanten = Math.min(bestShanten, shanten(after, claimMeldCount + 1));
        after[discardKind]++;
      }
      return Number.isFinite(bestShanten) ? bestShanten : null;
    };
    if (shantenNow > 0) {
      for (const candidate of candidates) {
        const act = candidate.action?.action;
        if ((act !== 'pon' && act !== 'chi') || candidate.allowed === false) continue;
        const tilesOut = act === 'pon' ? [offer.tile.kind, offer.tile.kind] : candidate.action.tiles;
        if (bestAfterClaim(tilesOut) === 0) {
          candidate.utility = 950;
          candidate.metrics = {
            ...candidate.metrics,
            kind: offer.tile.kind, shantenBefore: shantenNow, shantenAfter: 0,
            remaining: liveRemaining, evaluated: true,
          };
          candidate.reasons = ['FORMAL_TENPAI_RACE'];
          selected = candidate;
          break;
        }
      }
    }
  }

  selected ??= pass;
  const reason = selected.reasons[0];
  const metrics = selected.metrics;
  const legacyTrace = selected.action?.action ? {
    phase: 'claim', reason, kind: metrics.kind,
    ...(reason === 'TOITOI_ROUTE' ? { pairs: metrics.pairs } : {}),
    placement,
  } : {
    phase: 'claim', reason: 'KEEP_CLOSED', placement,
  };
  return finalizeAnalysis({
    profile: normalizedProfile,
    phase: 'claim', facts, hardConstraints, candidates, selected, coverage,
    decisiveFactors: [{ code: reason }], legacyTrace,
  });
}

export class DecisionEvaluator {
  evaluateTurn(view, options = [], profile = 'analyst') {
    return evaluateTurnDecision(view, options, profile);
  }

  evaluateClaim(view, offer, profile = 'analyst') {
    return evaluateClaimDecision(view, offer, profile);
  }

  evaluate({ phase, view, options = [], offer = null, profile = 'analyst' }) {
    if (phase === 'turn') return this.evaluateTurn(view, options, profile);
    if (phase === 'claim') return this.evaluateClaim(view, offer, profile);
    throw new TypeError(`DecisionEvaluator: 未対応phase ${phase}`);
  }
}

// win-uncertainty.js — 公開情報だけから裏ドラ込み和了点の範囲を求める純粋層
//
// 実際の裏表示牌は意思決定時点では秘密である。ここではその値を一切読まず、
// 公開済みの物理牌と自分の和了形だけから「取り得る最大点」を計算する。
// 裏表示牌ごとの裏ドラ加算は独立なため、残存枚数ぶんの候補を加算値順に
// 選ぶ貪欲法が厳密解になる（最大でも136候補、槓裏を含めても選択は5枚）。

import { scoreWin } from './score.js';
import { doraFromIndicator, KIND_COUNT } from './tiles.js';

export const LAST_PLACE_CERTAINTY = Object.freeze({
  GUARANTEED: 'guaranteed-last-place',
  UNCERTAIN: 'uncertain',
  AVOIDED: 'guaranteed-not-last-place',
});

function assertTileKind(kind, label = 'tile') {
  if (!Number.isInteger(kind) || kind < 0 || kind >= KIND_COUNT) {
    throw new RangeError(`${label}.kind must be an integer from 0 to ${KIND_COUNT - 1}`);
  }
}

function tileKind(tile, label) {
  const kind = typeof tile === 'number' ? tile : tile?.kind;
  assertTileKind(kind, label);
  return kind;
}

// 同じ物理牌が「鳴かれた河」と「副露」の両方から渡っても、idまたは参照で一枚に数える。
export function countKnownTileKinds(tiles = []) {
  const counts = new Array(KIND_COUNT).fill(0);
  const seenIds = new Set();
  const seenObjects = new WeakSet();

  for (const [index, tile] of tiles.entries()) {
    if (tile && typeof tile === 'object') {
      if (tile.id !== undefined && tile.id !== null) {
        if (seenIds.has(tile.id)) continue;
        seenIds.add(tile.id);
      } else {
        if (seenObjects.has(tile)) continue;
        seenObjects.add(tile);
      }
    }
    const kind = tileKind(tile, `tiles[${index}]`);
    counts[kind]++;
    if (counts[kind] > 4) {
      throw new RangeError(`public state contains more than four tiles of kind ${kind}`);
    }
  }
  return counts;
}

function scoringTiles(scoreContext) {
  if (!scoreContext?.winTile) throw new TypeError('scoreContext.winTile is required');
  return [
    ...(scoreContext.hand ?? []),
    scoreContext.winTile,
    ...(scoreContext.melds ?? []).flatMap(meld => meld?.tiles ?? []),
  ];
}

// otherKnownTilesは河・他家副露など。本人の和了形と表ドラ表示牌は自動で加える。
export function buildPublicKnownCounts(scoreContext, otherKnownTiles = []) {
  return countKnownTileKinds([
    ...scoringTiles(scoreContext),
    ...(scoreContext.doraIndicators ?? []),
    ...otherKnownTiles,
  ]);
}

function normalizeIndicatorCount(value) {
  if (!Number.isInteger(value) || value < 0 || value > 5) {
    throw new RangeError('hiddenIndicatorCount must be an integer from 0 to 5');
  }
  return value;
}

// ルール上伏せられている裏表示牌の枚数。実際の王牌には触れない。
export function hiddenUraIndicatorCount({ riichi, rules, kanCount = 0 }) {
  if (!riichi || rules?.uraDora !== true) return 0;
  if (!Number.isInteger(kanCount) || kanCount < 0 || kanCount > 4) {
    throw new RangeError('kanCount must be an integer from 0 to 4');
  }
  return rules.kanUra === false ? 1 : kanCount + 1;
}

// 公開状態と矛盾しない裏表示牌の組合せのうち、裏ドラ翻が最大になるものを返す。
export function maximizePublicUraIndicators({
  scoreContext,
  hiddenIndicatorCount: requestedCount,
  otherKnownTiles = [],
}) {
  const indicatorCount = normalizeIndicatorCount(requestedCount);
  const scoringCounts = countKnownTileKinds(scoringTiles(scoreContext));
  const knownCounts = buildPublicKnownCounts(scoreContext, otherKnownTiles);
  const candidates = [];

  for (let indicatorKind = 0; indicatorKind < KIND_COUNT; indicatorKind++) {
    const capacity = 4 - knownCounts[indicatorKind];
    const uraDoraKind = doraFromIndicator(indicatorKind);
    const uraHan = scoringCounts[uraDoraKind];
    for (let copy = 0; copy < capacity; copy++) {
      candidates.push({ indicatorKind, uraDoraKind, uraHan });
    }
  }

  if (candidates.length < indicatorCount) {
    throw new RangeError('not enough unseen physical tiles for hidden ura indicators');
  }

  candidates.sort((a, b) =>
    b.uraHan - a.uraHan || a.indicatorKind - b.indicatorKind);
  const selected = candidates.slice(0, indicatorCount);

  return Object.freeze({
    indicatorCount,
    indicators: Object.freeze(selected.map(item => item.indicatorKind)),
    doraKinds: Object.freeze(selected.map(item => item.uraDoraKind)),
    maximumUraHan: selected.reduce((sum, item) => sum + item.uraHan, 0),
  });
}

// scoreContext.uraIndicatorsに何が入っていても無視する。これが秘密情報非依存の境界。
export function scorePublicWinUraRange({
  scoreContext,
  rules,
  extra,
  hiddenIndicatorCount: requestedCount,
  otherKnownTiles = [],
}) {
  const publicContext = { ...scoreContext, uraIndicators: [] };
  const minimumScore = scoreWin(publicContext, rules, extra);
  if (!minimumScore) return null;

  const effectiveCount = scoreContext?.riichi && rules?.uraDora === true
    ? normalizeIndicatorCount(requestedCount)
    : 0;
  const maximum = maximizePublicUraIndicators({
    scoreContext: publicContext,
    hiddenIndicatorCount: effectiveCount,
    otherKnownTiles,
  });
  const maximumScore = effectiveCount === 0
    ? minimumScore
    : scoreWin({ ...publicContext, uraIndicators: maximum.indicators }, rules, extra);

  if (!maximumScore || maximumScore.total < minimumScore.total) {
    throw new Error('ura score range violated monotonicity');
  }

  return Object.freeze({
    minimumScore,
    maximumScore,
    hiddenIndicatorCount: effectiveCount,
    maximizingIndicators: maximum.indicators,
    maximumUraHan: maximum.maximumUraHan,
  });
}

function endsInLastPlace(preview) {
  if (!preview) return false;
  const lastRank = (preview.afterPoints?.length ?? 4) - 1;
  return preview.endsInLastPlace === true ||
    (preview.matchEnds === true && preview.afterRank === lastRank);
}

// 最低点・上限点の両端から、ラス確を安全側に三値分類する。
// hard constraintが拒否してよいのは guaranteedLastPlace === true の場合だけ。
export function classifyLastPlaceCertainty(minimumPreview, maximumPreview) {
  if (!minimumPreview || !maximumPreview) {
    throw new TypeError('minimumPreview and maximumPreview are required');
  }
  const lastRank = (minimumPreview.afterPoints?.length ?? 4) - 1;
  const minimumEndsLast = endsInLastPlace(minimumPreview);
  const maximumEndsLast = endsInLastPlace(maximumPreview);

  let certainty;
  if (minimumEndsLast && maximumEndsLast) {
    certainty = LAST_PLACE_CERTAINTY.GUARANTEED;
  } else if (minimumPreview.afterRank < lastRank || maximumPreview.matchEnds === false) {
    // 最低点で既に順位上昇、または上限点でも対局続行なら、区間内にラス確はない。
    certainty = LAST_PLACE_CERTAINTY.AVOIDED;
  } else {
    // 裏ドラ次第で順位上昇／飛び終了が変わる。秘密を推測して断定しない。
    certainty = LAST_PLACE_CERTAINTY.UNCERTAIN;
  }

  return Object.freeze({
    certainty,
    guaranteedLastPlace: certainty === LAST_PLACE_CERTAINTY.GUARANTEED,
    minimumEndsLast,
    maximumEndsLast,
    minimumAfterRank: minimumPreview.afterRank,
    maximumAfterRank: maximumPreview.afterRank,
  });
}

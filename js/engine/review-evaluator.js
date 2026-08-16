// review-evaluator.js — 判断時点のsnapshotだけで局後レビュー用factsを作る純粋層
//
// 山・他家の非公開手牌・局の結果は入力にしてはならない。DecisionRecordに
// 固定された本人view、公開履歴、合法候補だけを共通DecisionEvaluatorへ渡し、
// 人格文を含まない採点根拠を返す。

import {
  findDecisionCandidate,
  validateDecisionRecord,
} from './decision-contract.js';
import { candidateForActorResponse } from './decision-boundary.js';
import {
  DECISION_EVALUATOR_VERSION,
  DecisionEvaluator,
} from './decision-evaluator.js?v=18';

export const REVIEW_EVALUATOR_VERSION = 'v15-round-review-1';
export const REVIEW_PROFILES = Object.freeze(['guardian', 'analyst', 'striker']);

const BASELINE_NOT_EVALUATED = /^BASELINE_.*_NOT_EVALUATED$/;

function copyJson(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copyJson);
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined && typeof child !== 'function') result[key] = copyJson(child);
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

function snapshot(value) {
  return deepFreeze(copyJson(value));
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function average(values) {
  const numbers = values.filter(Number.isFinite);
  if (numbers.length === 0) return null;
  return Math.round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((value, index) => value === right[index]);
}

// LegalAction.command と DecisionAnalysis.candidate.action の互換比較。
function commandsEqual(left, right) {
  const a = left?.action === 'pass' ? null : left;
  const b = right?.action === 'pass' ? null : right;
  if (a === null || b === null) return a === b;
  if (!a || !b || a.action !== b.action) return false;
  switch (a.action) {
    case 'discard':
      return a.index === b.index && (a.riichi === true) === (b.riichi === true);
    case 'ankan':
    case 'kakan':
      return a.kind === b.kind;
    case 'chi':
      return sameArray(a.tiles, b.tiles);
    default:
      return true;
  }
}

function selectedCommand(candidate) {
  return candidate.command ?? (candidate.action === 'pass' ? null : {
    action: candidate.action,
    ...(candidate.index !== undefined ? { index: candidate.index } : {}),
    ...(candidate.riichi !== undefined ? { riichi: candidate.riichi } : {}),
    ...(candidate.kind !== undefined ? { kind: candidate.kind } : {}),
    ...(candidate.tiles !== undefined ? { tiles: [...candidate.tiles] } : {}),
  });
}

function findAnalysisCandidate(analysis, legalCandidate) {
  const command = selectedCommand(legalCandidate);
  const exact = analysis.candidates.find(candidate => commandsEqual(candidate.action, command));
  if (exact) return exact;
  // 評価器は同じ物理打牌について推奨したリーチ有無を一つだけ持つ。
  // 感想戦では同牌ダマ／同牌リーチも牌効率値を共有して宣言差だけ採点する。
  if (command?.action === 'discard') {
    return analysis.candidates.find(candidate =>
      candidate.action?.action === 'discard' && candidate.action.index === command.index) ?? null;
  }
  return null;
}

function calledCandidate(record) {
  return record.availableCandidates.find(candidate => candidate.calledTile) ?? null;
}

// offerそのものは保存せず、保存済み合法候補から同値な公開offerを再構成する。
function claimOfferFromRecord(record) {
  const anchor = calledCandidate(record);
  if (!anchor) throw new TypeError(`review ${record.id}: claim候補にcalledTileがありません`);
  const ron = record.availableCandidates.some(candidate => candidate.action === 'ron');
  if (ron) {
    return {
      type: 'ron',
      tile: copyJson(anchor.calledTile),
      from: anchor.from,
      winPreview: copyJson(record.view.winPreview ?? null),
    };
  }
  return {
    type: 'call',
    tile: copyJson(anchor.calledTile),
    from: anchor.from,
    canPon: record.availableCandidates.some(candidate => candidate.action === 'pon'),
    canKan: record.availableCandidates.some(candidate => candidate.action === 'minkan'),
    canChi: record.availableCandidates
      .filter(candidate => candidate.action === 'chi')
      .map(candidate => [...candidate.tiles]),
  };
}

function analyzeRecord(record, profile, evaluator) {
  if (record.kind === 'turn') {
    return evaluator.evaluateTurn(record.view, record.options, profile);
  }
  if (record.kind === 'claim') {
    return evaluator.evaluateClaim(record.view, claimOfferFromRecord(record), profile);
  }
  throw new TypeError(`review ${record.id}: 未対応DecisionRecord kind ${record.kind}`);
}

function recommendedLegalCandidate(record, analysis) {
  try {
    return candidateForActorResponse(record.availableCandidates, analysis.selected.action, {
      decisionId: record.id,
      actor: record.actor,
    });
  } catch {
    // 共通評価器がまだ扱わない合法手は、推測で別候補へ丸めない。
    return null;
  }
}

function actionName(candidate) {
  return selectedCommand(candidate)?.action ?? 'pass';
}

function summarizeSafety(safety) {
  if (!safety) return null;
  return {
    category: safety.category ?? null,
    commonGenbutsu: safety.commonGenbutsu ?? false,
    genbutsuCount: safety.genbutsuCount ?? null,
    maxRisk: safety.maxRisk ?? null,
    totalRisk: safety.totalRisk ?? null,
  };
}

function candidateMetrics(analysisCandidate, legalCandidate) {
  const metrics = analysisCandidate?.metrics ?? {};
  return {
    action: actionName(legalCandidate),
    tile: legalCandidate?.tile ? copyJson(legalCandidate.tile) : null,
    shanten: Number.isFinite(metrics.shanten) ? metrics.shanten : null,
    ukeirePhysical: Number.isFinite(metrics.ukeirePhysical) ? metrics.ukeirePhysical : null,
    safety: summarizeSafety(metrics.safety),
    utility: Number.isFinite(analysisCandidate?.utility) ? analysisCandidate.utility : null,
    allowed: analysisCandidate?.allowed !== false,
  };
}

function metricDelta(selected, recommended) {
  const selectedSafety = selected.safety;
  const recommendedSafety = recommended.safety;
  return {
    shanten: Number.isFinite(selected.shanten) && Number.isFinite(recommended.shanten)
      ? selected.shanten - recommended.shanten : null,
    ukeirePhysical: Number.isFinite(selected.ukeirePhysical) && Number.isFinite(recommended.ukeirePhysical)
      ? selected.ukeirePhysical - recommended.ukeirePhysical : null,
    maxRisk: Number.isFinite(selectedSafety?.maxRisk) && Number.isFinite(recommendedSafety?.maxRisk)
      ? selectedSafety.maxRisk - recommendedSafety.maxRisk : null,
    totalRisk: Number.isFinite(selectedSafety?.totalRisk) && Number.isFinite(recommendedSafety?.totalRisk)
      ? selectedSafety.totalRisk - recommendedSafety.totalRisk : null,
    utility: Number.isFinite(selected.utility) && Number.isFinite(recommended.utility)
      ? selected.utility - recommended.utility : null,
  };
}

function samePhysicalTileKind(left, right) {
  if (!left?.tile || !right?.tile) return false;
  return left.tile.kind === right.tile.kind &&
    (left.tile.red === true) === (right.tile.red === true) &&
    actionName(left) === actionName(right) &&
    (selectedCommand(left)?.riichi === true) === (selectedCommand(right)?.riichi === true);
}

function baselineReasons(...analysisCandidates) {
  return analysisCandidates.flatMap(candidate => candidate?.reasons ?? [])
    .filter(code => BASELINE_NOT_EVALUATED.test(code));
}

function hardConstraintWasViolated(analysis, selectedAnalysis, selectedLegal) {
  if (selectedAnalysis?.allowed === false) return true;
  const selectedAction = actionName(selectedLegal);
  return analysis.hardConstraints.some(constraint =>
    constraint.active === true && constraint.affectedAction === selectedAction);
}

function scoreDiscardChoice({
  selectedLegal,
  recommendedLegal,
  selectedFacts,
  recommendedFacts,
  profile,
}) {
  const reasons = [];
  if (samePhysicalTileKind(selectedLegal, recommendedLegal)) {
    return { score: 99, reasons: ['SAME_TILE_KIND_EQUIVALENT'] };
  }

  const delta = metricDelta(selectedFacts, recommendedFacts);
  let score = 100;
  if (Number.isFinite(delta.shanten) && delta.shanten > 0) {
    score -= 45 * delta.shanten;
    reasons.push('SHANTEN_WORSE');
  }
  if (delta.shanten === 0 && Number.isFinite(delta.ukeirePhysical) && delta.ukeirePhysical < 0) {
    score -= Math.min(30, -delta.ukeirePhysical * 2);
    reasons.push('UKEIRE_LOSS');
  }
  if (delta.shanten === 0 && delta.ukeirePhysical === 0 &&
      Number.isFinite(delta.utility) && delta.utility < 0) {
    score -= Math.min(15, Math.ceil(-delta.utility * 10));
    reasons.push('UTILITY_LOSS');
  }
  if (Number.isFinite(delta.maxRisk) && delta.maxRisk > 0) {
    const weight = profile === 'guardian' ? 10 : (profile === 'analyst' ? 7 : 4);
    score -= Math.min(30, delta.maxRisk * weight);
    reasons.push('SAFETY_WORSE');
  }
  const selectedRiichi = selectedCommand(selectedLegal)?.riichi === true;
  const recommendedRiichi = selectedCommand(recommendedLegal)?.riichi === true;
  if (selectedRiichi !== recommendedRiichi) {
    score -= selectedRiichi ? 15 : 10;
    reasons.push('RIICHI_DECLARATION_DIFF');
  }
  if (reasons.length === 0) reasons.push('EQUIVALENT_MEASURED_METRICS');
  return { score: clampScore(score), reasons };
}

function scoreNonDiscardChoice(selectedLegal, recommendedLegal) {
  const selectedAction = actionName(selectedLegal);
  const recommendedAction = actionName(recommendedLegal);
  if ((recommendedAction === 'tsumo' || recommendedAction === 'ron') &&
      selectedAction !== recommendedAction) {
    return { score: 0, reasons: ['MISSED_LEGAL_WIN'] };
  }
  if (selectedAction === 'pass' && recommendedAction === 'pon') {
    return { score: 60, reasons: ['RECOMMENDED_CALL_PASSED'] };
  }
  if (recommendedAction === 'pass' && selectedAction !== 'pass') {
    return { score: 55, reasons: ['UNRECOMMENDED_CALL'] };
  }
  return { score: 50, reasons: ['DIFFERENT_EVALUATED_ACTION'] };
}

/**
 * DecisionRecord一件を指定profileで再評価する。
 * 戻り値は表示文を含まず、UIが人格別の台詞へ変換できるfactsだけである。
 */
export function evaluateDecisionRecord(record, profile = 'analyst', {
  evaluator = new DecisionEvaluator(),
} = {}) {
  validateDecisionRecord(record);
  if (!REVIEW_PROFILES.includes(profile)) throw new TypeError(`unknown review profile: ${profile}`);

  const analysis = analyzeRecord(record, profile, evaluator);
  const selectedLegal = findDecisionCandidate(record, record.chosen.actionId);
  const recommendedLegal = recommendedLegalCandidate(record, analysis);
  const selectedAnalysis = findAnalysisCandidate(analysis, selectedLegal);
  const recommendedAnalysis = recommendedLegal
    ? findAnalysisCandidate(analysis, recommendedLegal)
    : null;
  const selectedFacts = candidateMetrics(selectedAnalysis, selectedLegal);
  const recommendedFacts = recommendedLegal
    ? candidateMetrics(recommendedAnalysis, recommendedLegal)
    : null;
  const metrics = {
    selected: selectedFacts,
    recommended: recommendedFacts,
    delta: recommendedFacts ? metricDelta(selectedFacts, recommendedFacts) : null,
  };
  const exactMatch = recommendedLegal?.actionId === selectedLegal.actionId;
  const hardConstraintViolation = hardConstraintWasViolated(analysis, selectedAnalysis, selectedLegal);
  // 比較対象のどれか一つでも評価則が未実装なら、たとえ選択と暫定推奨が
  // passで一致しても「100点」とは断定しない。未評価候補を無視した採点は
  // 見かけ上の精度を作るため、局面全体を採点対象外にする。
  const notEvaluatedReasons = baselineReasons(...analysis.candidates);

  let status = 'scored';
  let score;
  let reasonCodes;
  if (hardConstraintViolation) {
    score = 0;
    reasonCodes = ['LAST_PLACE_LOCK_FORBIDDEN'];
  } else if (record.chosen.source === 'forced') {
    status = 'forced';
    score = null;
    reasonCodes = ['FORCED_ACTION_NOT_SCORED'];
  } else if (!recommendedLegal) {
    status = 'notEvaluated';
    score = null;
    reasonCodes = ['BASELINE_RECOMMENDATION_NOT_EVALUATED'];
  } else if (!selectedAnalysis) {
    // 合法だが共通ベースラインが早期確定し、比較候補を計算していない場合。
    const recommendedAction = actionName(recommendedLegal);
    if (recommendedAction === 'tsumo' || recommendedAction === 'ron') {
      score = 0;
      reasonCodes = ['MISSED_LEGAL_WIN'];
    } else {
      status = 'notEvaluated';
      score = null;
      reasonCodes = ['BASELINE_SELECTED_NOT_EVALUATED'];
    }
  } else if (notEvaluatedReasons.length > 0) {
    status = 'notEvaluated';
    score = null;
    reasonCodes = [...new Set(notEvaluatedReasons)];
  } else if (exactMatch) {
    score = 100;
    reasonCodes = ['EXACT_ACTION_MATCH'];
  } else if (actionName(selectedLegal) === 'discard' && actionName(recommendedLegal) === 'discard') {
    const result = scoreDiscardChoice({
      selectedLegal,
      recommendedLegal,
      selectedFacts,
      recommendedFacts,
      profile,
    });
    score = result.score;
    reasonCodes = result.reasons;
  } else {
    const result = scoreNonDiscardChoice(selectedLegal, recommendedLegal);
    score = result.score;
    reasonCodes = result.reasons;
  }

  return snapshot({
    profile,
    evaluatorVersion: analysis.evaluatorVersion ?? DECISION_EVALUATOR_VERSION,
    reviewEvaluatorVersion: REVIEW_EVALUATOR_VERSION,
    selectedActionId: selectedLegal.actionId,
    recommendedActionId: recommendedLegal?.actionId ?? null,
    exactMatch,
    score,
    status,
    reasonCodes,
    metrics,
    hardConstraintViolation,
  });
}

export function reviewDecisionRecord(record, options = {}) {
  return snapshot(REVIEW_PROFILES.map(profile =>
    evaluateDecisionRecord(record, profile, options)));
}

/**
 * 1局のユーザー席(0)の判断だけを時系列レビューへ変換する。
 * round.publicHistory/resultPointer/任意の結果フィールドは一切参照しない。
 */
export function buildRoundReview(round, { actor = 0, evaluator = new DecisionEvaluator() } = {}) {
  if (!round || typeof round !== 'object' || Array.isArray(round)) {
    throw new TypeError('round must be an object');
  }
  if (!Array.isArray(round.decisions)) throw new TypeError('round.decisions must be an array');
  if (!Number.isInteger(actor) || actor < 0 || actor > 3) throw new TypeError('actor must be 0..3');

  const decisions = round.decisions
    .filter(record => record.actor === actor &&
      ['human', 'autoPreference', 'forced'].includes(record.chosen?.source))
    .slice()
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));

  const entries = decisions.map((record, index) => {
    validateDecisionRecord(record);
    const chosenCandidate = findDecisionCandidate(record, record.chosen.actionId);
    const reviews = REVIEW_PROFILES.map(profile =>
      evaluateDecisionRecord(record, profile, { evaluator }));
    // 結果pointerはレビュー計算にも表示用recordにも持ち込まない。
    const reviewRecord = { ...record, resultPointer: null };
    return {
      index,
      sequence: record.sequence,
      decisionId: record.id,
      kind: record.kind,
      source: record.chosen.source,
      record: reviewRecord,
      chosenCandidate,
      reviews,
    };
  });

  const profileScores = Object.fromEntries(REVIEW_PROFILES.map(profile => [
    profile,
    average(entries.map(entry => entry.reviews
      .find(review => review.profile === profile)?.score)),
  ]));
  const scores = entries.flatMap(entry => entry.reviews.map(review => review.score));

  return snapshot({
    schemaVersion: 1,
    type: 'roundReview',
    reviewEvaluatorVersion: REVIEW_EVALUATOR_VERSION,
    roundId: typeof round.roundId === 'string' ? round.roundId : null,
    actor,
    entries,
    profileScores,
    overallScore: average(scores),
    scoredEvaluationCount: scores.filter(Number.isFinite).length,
  });
}

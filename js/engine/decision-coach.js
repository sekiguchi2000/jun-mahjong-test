// decision-coach.js — ユーザー向け「打ち手ガイド」の平易な説明
//
// 入力はユーザーにも見えている view / offer だけ。山の順番、他家の手牌、
// 王牌の未公開部分は読まず、DecisionEvaluator の分析結果だけを文章化する。
import { evaluateTurnDecision, evaluateClaimDecision } from './decision-evaluator.js?v=18';
import { isDragon, isHonor, numOf, doraFromIndicator, tileName } from './tiles.js';
import { decomposeBlocks, evaluateHandPlans, tileRetentionValue } from './hand-plans.js';

export const DECISION_COACH_VERSION = 'v2-candidate-comparison-coach';

function copy(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copy);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined && typeof child !== 'function') out[key] = copy(child);
  }
  return out;
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function phaseLabel(phase) {
  if (typeof phase === 'string') {
    if (phase === 'EARLY') return '序盤';
    if (phase === 'LATE') return '終盤';
    return '中盤';
  }
  if (phase?.code === 'EARLY') return '序盤';
  if (phase?.code === 'LATE') return '終盤';
  return '中盤';
}

function rankText(view) {
  const rank = view?.placement?.currentRank;
  if (!Number.isInteger(rank)) return '';
  return `${rank + 1}位`;
}

function publicContext(view) {
  const remaining = view?.public?.remaining;
  const points = view?.public?.points?.[view?.me];
  const parts = [];
  if (Number.isInteger(remaining)) parts.push(`残り${remaining}枚`);
  if (Number.isInteger(points)) parts.push(`${points}点`);
  if (rankText(view)) parts.push(rankText(view));
  return parts.join('・');
}

function tileAt(view, index) {
  const all = view?.drawn ? [...(view.hand ?? []), view.drawn] : (view?.hand ?? []);
  return all[index] ?? null;
}

function actionLabel(action, view, offer = null) {
  if (!action) return offer?.type === 'ron' ? 'ロンを見送る' : '今回は鳴かない';
  if (action.action === 'tsumo') return 'ツモあがり';
  if (action.action === 'ron') return 'ロンあがり';
  if (action.action === 'discard') {
    const tile = tileAt(view, action.index);
    if (action.riichi) return `${tile ? tileName(tile.kind) : 'この牌'}を切ってリーチ`;
    return `${tile ? tileName(tile.kind) : 'この牌'}を切る`;
  }
  if (action.action === 'pon') return `${offer?.tile ? tileName(offer.tile.kind) : 'この牌'}をポン`;
  if (action.action === 'minkan') return `${offer?.tile ? tileName(offer.tile.kind) : 'この牌'}をカン`;
  if (action.action === 'chi') return 'この牌をチー';
  return action.action;
}

function safetySentence(metrics) {
  const safety = metrics?.safety;
  if (!safety) return '';
  if (safety.commonGenbutsu) return '本人の河にあるか、リーチ後に場に通っている牌なので、見えている範囲では一番ぶつかりにくいです。';
  if (safety.category === 'GENBUTSU') return 'その相手の河にあるか、リーチ後に通っている牌です。';
  if (safety.suji && safety.residualWaits?.length) {
    return '公開された捨て牌から、消えている待ちの形があります。ただし別の待ちは残るので、完全に安全とは言いません。';
  }
  if (safety.noChance && safety.residualWaits?.length) {
    return '周りの牌が4枚見えて消えている形はありますが、別の待ち方は残ります。';
  }
  if (safety.oneChance) return '周りの牌が3枚見えて、同じ形が続きにくくなっています。ただし安全牌ではありません。';
  return '現物ではありません。公開情報から比べた相対的な危険度だけを見ています。';
}

function selectedCandidate(analysis) {
  return analysis?.candidates?.find(item => item.candidateId === analysis.selected?.candidateId) ?? null;
}

function selectedHonorContext(view, action) {
  if (action?.action !== 'discard') return null;
  const tile = tileAt(view, action.index);
  if (!tile || !isHonor(tile.kind)) return null;
  const all = view?.drawn ? [...(view.hand ?? []), view.drawn] : (view?.hand ?? []);
  const copies = all.filter(item => item.kind === tile.kind).length;
  const value = isDragon(tile.kind) || tile.kind === view?.seatWind || tile.kind === view?.roundWind;
  const labels = [];
  if (isDragon(tile.kind)) labels.push('三元牌');
  if (tile.kind === view?.seatWind) labels.push('自風');
  if (tile.kind === view?.roundWind) labels.push('場風');
  return { tile, copies, value, labels: [...new Set(labels)] };
}

function candidateTile(view, candidate) {
  return candidate?.action?.action === 'discard' ? tileAt(view, candidate.action.index) : null;
}

// ---- v12 プラン評価の言語化 ----

const PLAN_LABELS = {
  TANYAO_PINFU: 'タンヤオ・ピンフ系（3900点以上狙い）',
  YAKUHAI_PAIR: '役牌の速攻',
  HONITSU: 'ホンイツ',
  CHANTA: 'チャンタ',
  CHIITOI: '七対子',
  TOITOI: 'トイトイ（対子を刻子に育てる）',
};

const PLAN_NOTE_PHRASES = {
  BLOCK_CORE: '手の骨組みになっているブロックの牌',
  RED5_LINK: '赤5と繋がる形',
  DOUBLE_WIND_KEEP: '場風と自風が重なる牌',
  DORA_HONOR_KEEP: 'ドラの字牌',
  RED_TILE: '赤牌',
};

function planKeepPhrase(planEvaluation) {
  for (const note of planEvaluation?.notes ?? []) {
    if (PLAN_NOTE_PHRASES[note]) return PLAN_NOTE_PHRASES[note];
  }
  const top = planEvaluation?.topPlans?.[0]?.code;
  if (top && PLAN_LABELS[top]) return `${PLAN_LABELS[top]}の本線に入る牌`;
  return null;
}

function relativeSeatLabel(view, seat) {
  const me = Number.isInteger(view?.me) ? view.me : 0;
  const relative = ((seat - me) % 4 + 4) % 4;
  return relative === 1 ? '下家' : relative === 2 ? '対面' : relative === 3 ? '上家' : null;
}

function pressureCautionSentence(view, analysis) {
  const signals = (analysis?.estimates ?? []).filter(item => item.code === 'OPPONENT_TENPAI_PRESSURE');
  if (signals.length === 0) return null;
  const labels = signals.map(signal => relativeSeatLabel(view, signal.seat)).filter(Boolean);
  if (labels.length === 0) return null;
  const evidenceParts = [];
  if (signals.some(signal => signal.evidence?.meldCount >= 2)) evidenceParts.push('副露が重なっている');
  else if (signals.some(signal => signal.evidence?.meldCount === 1)) evidenceParts.push('副露が入っている');
  if (signals.some(signal => signal.evidence?.recentMiddleDiscards)) evidenceParts.push('河に中張牌が出始めた');
  if (signals.some(signal => signal.evidence?.flushSignal)) evidenceParts.push('一色に寄っている');
  const evidence = evidenceParts.length ? `（${evidenceParts.join('・')}）` : '';
  return `${labels.join('・')}に手が整った気配${evidence}があります。リーチはまだ入っていませんが、同じ進み方なら通りやすい牌から先に切ります。`;
}

function coachPlanContext(view) {
  return {
    seatWind: view?.seatWind,
    roundWind: view?.roundWind,
    doraKinds: (view?.public?.doraIndicators ?? []).map(tile => doraFromIndicator(tile.kind)),
    phase: 'early',
  };
}

function handAllOf(view) {
  return view?.drawn ? [...(view.hand ?? []), view.drawn] : [...(view?.hand ?? [])];
}

// 「どの形を伸ばそうとしているか」: 打牌後の骨組みから未完成ブロックと完成牌を言う
function blockGrowthSentence(view, action, selectedMetrics) {
  if (!Number.isInteger(selectedMetrics?.shanten) || selectedMetrics.shanten < 1) return '';
  const rest = handAllOf(view);
  if (Number.isInteger(action?.index)) rest.splice(action.index, 1);
  const { chosen } = decomposeBlocks(rest, coachPlanContext(view));
  const parts = [];
  for (const block of chosen) {
    if (block.type === 'taatsu') {
      const [low, high] = block.kinds;
      const waits = [];
      if (numOf(low) > 1) waits.push(low - 1);
      if (numOf(high) < 9) waits.push(high + 1);
      parts.push(`${tileName(low)}${tileName(high)}（${waits.map(kind => tileName(kind)).join('か')}で完成）`);
    } else if (block.type === 'kanchan') {
      parts.push(`${tileName(block.kinds[0])}${tileName(block.kinds[1])}（${tileName(block.kinds[0] + 1)}で完成）`);
    }
  }
  const unique = [...new Set(parts)];
  if (unique.length === 0) return '';
  return `伸ばしたい形は ${unique.slice(0, 3).join('、')}。`;
}

// 「何を受け入れようとしているか」: 進む牌を名前で言う
function acceptanceSentence(metrics) {
  const byKind = metrics?.ukeireByKind;
  if (!Array.isArray(byKind) || byKind.length === 0 || !Number.isFinite(metrics?.ukeirePhysical)) return '';
  const top = [...byKind].sort((left, right) => right.remaining - left.remaining).slice(0, 5);
  const names = top.map(item => tileName(item.kind)).join('・');
  const suffix = byKind.length > top.length ? `など${byKind.length}種類` : '';
  return `引いて嬉しいのは${names}${suffix}、見えている範囲で合計${metrics.ukeirePhysical}枚です。`;
}

// 「これを狙うならこっち」: 第二プランごとに最適な分岐打牌を出す
function planAlternativeParts(view, analysis) {
  const selected = selectedCandidate(analysis);
  const selectedMetrics = selected?.metrics;
  const selectedTile = candidateTile(view, selected);
  if (!selectedMetrics?.planEvaluation) return [];
  const planContext = coachPlanContext(view);
  const handAll = handAllOf(view);
  const plans = evaluateHandPlans(handAll, view?.melds ?? [], planContext);
  const mainPlan = selectedMetrics.planEvaluation.topPlans?.[0]?.code;
  const parts = [];
  for (const plan of plans) {
    if (plan.code === mainPlan || plan.weight < 0.3) continue;
    let best = null;
    for (const candidate of analysis?.candidates ?? []) {
      if (candidate?.action?.action !== 'discard') continue;
      if (candidate.metrics?.shanten !== selectedMetrics.shanten) continue;
      const tile = candidateTile(view, candidate);
      if (!tile) continue;
      const value = tileRetentionValue(tile, [plan], handAll, planContext).retention;
      if (!best || value < best.value) best = { tile, value };
    }
    if (best && selectedTile && (best.tile.kind !== selectedTile.kind || best.tile.red !== selectedTile.red)) {
      parts.push(`${PLAN_LABELS[plan.code] ?? plan.code}を狙うなら、${tileName(best.tile.kind, best.tile.red)}を切る分岐もあります。`);
    }
    if (parts.length >= 2) break;
  }
  return parts;
}

function planHeadlineSentences(selected) {
  const planEvaluation = selected?.metrics?.planEvaluation;
  const top = planEvaluation?.topPlans?.[0]?.code;
  const sentences = [];
  if (top && PLAN_LABELS[top]) sentences.push(`今の本線は${PLAN_LABELS[top]}です。`);
  if (planEvaluation?.valueBiasCode === 'CHASE_VALUE') {
    sentences.push('点棒状況から、順位を上げるには打点が必要です。多少効率を落としても高い手を狙います。');
  } else if (planEvaluation?.valueBiasCode === 'PROTECT_LEAD') {
    sentences.push('リードを守る局面なので、打点より速度と安全を優先します。');
  }
  return sentences;
}

function valueHonor(tile, view) {
  return Boolean(tile && isHonor(tile.kind) && (
    isDragon(tile.kind) || tile.kind === view?.seatWind || tile.kind === view?.roundWind
  ));
}

function comparisonHeadline(view, analysis) {
  const selected = selectedCandidate(analysis);
  const selectedTile = candidateTile(view, selected);
  const selectedMetrics = selected?.metrics;
  if (!selectedTile || !Number.isFinite(selectedMetrics?.ukeirePhysical)) return null;
  const alternatives = (analysis?.candidates ?? []).filter(candidate =>
    candidate !== selected && candidate?.action?.action === 'discard' &&
    candidate.metrics?.shanten === selectedMetrics.shanten &&
    Number.isFinite(candidate.metrics?.ukeirePhysical),
  );
  const strongestAlternative = alternatives.slice().sort((left, right) =>
    right.metrics.ukeirePhysical - left.metrics.ukeirePhysical,
  )[0];
  if (!strongestAlternative) return null;
  const alternativeTile = candidateTile(view, strongestAlternative);
  if (selectedMetrics.ukeirePhysical > strongestAlternative.metrics.ukeirePhysical && alternativeTile) {
    return `${tileName(alternativeTile.kind, alternativeTile.red)}より、次に手が前に進む牌を多く残せる`;
  }
  const honor = selectedHonorContext(view, selected.action);
  if (honor && !honor.value && honor.copies === 1) return `役にならない${tileName(honor.tile.kind)}を先に切る`;
  return null;
}

function comparisonParts(view, analysis) {
  const selected = selectedCandidate(analysis);
  const selectedTile = candidateTile(view, selected);
  const selectedMetrics = selected?.metrics;
  if (!selectedTile || !Number.isInteger(selectedMetrics?.shanten)) return [];
  const selectedName = tileName(selectedTile.kind, selectedTile.red);
  const alternativesByTile = new Map();
  for (const candidate of analysis?.candidates ?? []) {
    if (candidate === selected || candidate?.action?.action !== 'discard') continue;
    const tile = candidateTile(view, candidate);
    if (!tile || alternativesByTile.has(`${tile.kind}:${tile.red ? 1 : 0}`)) continue;
    alternativesByTile.set(`${tile.kind}:${tile.red ? 1 : 0}`, { candidate, tile });
  }
  const alternatives = [...alternativesByTile.values()]
    .sort((left, right) => {
      const leftSame = left.candidate.metrics?.shanten === selectedMetrics.shanten ? 0 : 1;
      const rightSame = right.candidate.metrics?.shanten === selectedMetrics.shanten ? 0 : 1;
      const leftHonor = isHonor(left.tile.kind) ? 0 : 1;
      const rightHonor = isHonor(right.tile.kind) ? 0 : 1;
      return leftSame - rightSame || leftHonor - rightHonor ||
        (right.candidate.metrics?.ukeirePhysical ?? -1) - (left.candidate.metrics?.ukeirePhysical ?? -1);
    })
    .slice(0, 8);
  const parts = [];
  const slowerNames = [];
  for (const { candidate, tile } of alternatives) {
    const metrics = candidate.metrics ?? {};
    const name = tileName(tile.kind, tile.red);
    if (metrics.shanten > selectedMetrics.shanten) {
      slowerNames.push(name);
      continue;
    }
    if (!Number.isFinite(metrics.ukeirePhysical) || !Number.isFinite(selectedMetrics.ukeirePhysical)) continue;
    const delta = selectedMetrics.ukeirePhysical - metrics.ukeirePhysical;
    // 受け入れが狭いだけの案は列挙しない(受け入れの中身は本文で説明済み)
    if (delta > 0) continue;
    // v12: 受け入れ同数の分かれ目はプラン価値で説明する
    const altPlan = metrics.planEvaluation;
    const selPlan = selectedMetrics.planEvaluation;
    if (delta === 0 && altPlan && selPlan && altPlan.retention - selPlan.retention > 0.2) {
      const keepPhrase = planKeepPhrase(altPlan);
      if (keepPhrase) {
        parts.push(`${name}を切る案も手の進み方は同じですが、${name}は${keepPhrase}なので手に残し、${selectedName}を先に切ります。`);
        continue;
      }
    }
    if (delta === 0 && selPlan?.notes?.includes('LONE_YAKUHAI_EARLY_CUT')) {
      parts.push(`${name}を切る案も手の進み方は同じです。${selectedName}は役牌ですが1枚だけで、重なりを待って安い手を拾うより数牌の伸びを残す方が本線です。`);
      continue;
    }
    if (delta === 0 && valueHonor(tile, view) && !valueHonor(selectedTile, view) &&
        !(altPlan && selPlan && selPlan.retention - altPlan.retention > 0.2)) {
      parts.push(`${name}を切る案は手の進み方が同じです。${name}はもう1枚重なると役として使える牌なので、同じ広さなら残します。`);
      continue;
    }
    const selectedHonor = selectedHonorContext(view, selected.action);
    if (delta === 0 && selectedHonor && !selectedHonor.value && selectedHonor.copies === 1) {
      parts.push(`${name}を切る案も手の進み方は同じです。${tileName(selectedHonor.tile.kind)}は役にならない単独の字牌なので、こちらを先に切ります。`);
      continue;
    }
    // v12第3-4段: 気配警戒や押しリスクが分かれ目のときは通りやすさで説明する
    const altDangerPenalty = (metrics.utilityAdjustments?.pressureCautionPenalty ?? 0) +
      (metrics.utilityAdjustments?.pushRiskPenalty ?? 0);
    const selDangerPenalty = (selectedMetrics.utilityAdjustments?.pressureCautionPenalty ?? 0) +
      (selectedMetrics.utilityAdjustments?.pushRiskPenalty ?? 0);
    if (delta === 0 && altDangerPenalty < selDangerPenalty - 0.3) {
      parts.push(`${name}を切る案も手の進み方は同じですが、相手には${selectedName}の方が通りやすいため、先に${selectedName}を処理します。`);
      continue;
    }
  }
  if (slowerNames.length === 1) {
    parts.push(`${slowerNames[0]}を切る案は、${selectedName}を切るよりテンパイが遠くなるため外しています。`);
  } else if (slowerNames.length >= 2 && slowerNames.length <= 3) {
    parts.push(`${slowerNames.join('・')}を切る案は、テンパイが遠くなるため外しています。`);
  } else if (slowerNames.length > 3) {
    parts.push('残りの牌は、切るとテンパイが遠くなるため候補から外しています。');
  }
  return parts;
}

function turnExplanationParts(view, analysis) {
  const selected = analysis?.candidates?.find(item => item.candidateId === analysis.selected?.candidateId);
  const action = analysis?.selected?.action;
  const factors = new Set((analysis?.decisiveFactors ?? []).map(factor => factor.code));
  const metrics = selected?.metrics ?? {};
  const context = publicContext(view);
  const phaseFact = (analysis?.facts ?? []).find(fact => fact.code === 'ROUND_PHASE');
  const sentences = [];

  if (action?.action === 'tsumo') {
    sentences.push('今はあがれる形です。点棒と順位の条件を見ても、ここで終わらせるのが自然です。');
  } else if (action?.action === 'discard') {
    if (action.riichi) sentences.push('この牌を切ると、待ちを残したままリーチできます。');
    const honor = selectedHonorContext(view, action);
    const selectedPlanNotes = selected?.metrics?.planEvaluation?.notes ?? [];
    if (honor && honor.value && honor.copies === 1 && selectedPlanNotes.includes('LONE_YAKUHAI_EARLY_CUT')) {
      sentences.push(`${tileName(honor.tile.kind)}は${honor.labels.join('・')}ですが1枚だけです。重なりを待って安手を拾うより、タンヤオ・ピンフ系で3900点以上を狙う方が本線なので、序盤のうちに切ります。`);
    } else if (honor && !honor.value && honor.copies === 1) {
      sentences.push(`${tileName(honor.tile.kind)}は${honor.labels.length ? `${honor.labels.join('・')}ではなく、` : ''}今の場では役になる牌ではありません。1枚だけなので、数牌のつながりを残すため先に切ります。`);
    } else if (honor && honor.value && honor.copies === 1) {
      sentences.push(`${tileName(honor.tile.kind)}は${honor.labels.join('・')}なので、もう1枚重なれば役になります。ただし、今の手を進めるほうが有利なら、その可能性を手放して切ることもあります。`);
    }
    if (factors.has('MAWASHI_SAFE_ADVANCE')) {
      sentences.push('相手のリーチに対して、無筋を切ってまで最速を追う見返りが小さい形です。通っている牌や危険の低い牌で手を回し、テンパイの芽は残します。');
    } else if (factors.has('EARLY_EFFICIENCY_PRIORITY')) {
      sentences.push('まだ序盤なので、今は手を広く残します。次のツモで組み合わせが増える余地を優先します。');
    } else if (factors.has('EFFICIENCY_EDGE')) {
      sentences.push('同じくらいの形の中で、次に引いて手が進む道が少し広い牌を残します。');
    } else if (factors.has('KNOWN_VALUE_PRESERVED')) {
      sentences.push('受け入れだけでなく、見えているドラや赤牌を残せることも考えています。');
    } else if (factors.has('SUIT_PRESSURE_AVOIDED')) {
      sentences.push('相手の捨て牌が一色に寄って見えるので、その色の牌を不用意に切らないようにします。');
    } else if (factors.has('RIICHI_COMMON_GENBUTSU')) {
      sentences.push('相手のリーチに対して完全に通っている牌があります。ここは無理をせず、現物から切って安全に進めます。');
      const safety = safetySentence(metrics);
      if (safety) sentences.push(safety);
    } else if (factors.has('LEAST_RISK_NON_GENBUTSU') || factors.has('RIICHI_SAFE_TILE')) {
      sentences.push('相手にリーチがあるので、完全な安全牌ではなくても、公開情報から比べて危険度が低い牌を選びます。');
      const safety = safetySentence(metrics);
      if (safety) sentences.push(safety);
    } else {
      sentences.push('この牌を切っても、手の中の組み合わせを崩しすぎず、次のツモで前に進めます。');
    }
    if (factors.has('PRESSURE_CAUTION')) {
      const caution = pressureCautionSentence(view, analysis);
      if (caution) sentences.push(caution);
    }
    if (Number.isInteger(metrics.shanten) && Number.isFinite(metrics.ukeirePhysical)) {
      const distance = metrics.shanten === 0
        ? 'すでにテンパイです'
        : metrics.shanten === 1
          ? 'あと1枚、必要な形ができればテンパイです'
          : 'テンパイまではまだ距離があります';
      const acceptance = acceptanceSentence(metrics);
      sentences.push(`${distance}。${acceptance || `次に引いて手が前に進む牌は、見えている範囲で${metrics.ukeirePhysical}枚あります。`}`);
    }
  }
  const comparisons = action?.action === 'discard' ? comparisonParts(view, analysis) : [];
  const planHead = action?.action === 'discard' ? planHeadlineSentences(selected) : [];
  // 狙い(伸ばす形)→選んだ理由→受け入れ→意味のある同格比較→別プランへの分岐→状況、の順で読ませる
  const growth = action?.action === 'discard' ? blockGrowthSentence(view, action, metrics) : '';
  const alternatives = action?.action === 'discard' ? planAlternativeParts(view, analysis) : [];
  const tail = context ? [`判断時点は${phaseLabel(phaseFact?.value)}、${context}です。`] : [];
  return [...planHead, ...(growth ? [growth] : []), ...sentences, ...comparisons, ...alternatives, ...tail];
}

function claimExplanation(view, offer, analysis) {
  const action = analysis?.selected?.action;
  const reason = analysis?.decisiveFactors?.[0]?.code;
  if (offer?.type === 'ron') {
    if (reason === 'LAST_PLACE_LOCK_FORBIDDEN') {
      return 'あがれますが、このままあがると最下位のまま終わる条件です。少しでも順位が上がる可能性を残すため、ここは見送ります。';
    }
    return 'あがりを選べます。点棒と順位の条件を満たすので、ここで終わらせます。';
  }
  if (!action) {
    if (reason === 'ANKO_ALREADY_COMPLETE') {
      return 'その牌は手の中で3枚そろっていて、面子として完成しています。鳴くと完成形を崩すだけなので見送ります。';
    }
    if (reason === 'KEEP_CLOSED') {
      return '今鳴くと手の形が固定されます。はっきりした得が確認できないので、鳴かずに自分のツモを待ちます。';
    }
    return 'この鳴きは、今の公開情報だけでは良さを計算しきれません。無理に鳴かず、手の形を保ちます。';
  }
  if (action.action === 'pon' && reason === 'YAKUHAI_PON') {
    return '役になる牌なので、鳴いてもあがりへの道を残せます。速度を上げる選択です。';
  }
  if (action.action === 'pon' && reason === 'TOITOI_ROUTE') {
    return '同じ牌の組を増やす手が見えているので、鳴いて手を進めます。';
  }
  return 'この鳴きは選べますが、点数や待ちの細部はまだ自動計算していません。理由を過大に断定せず、速度を優先する選択として表示します。';
}

function shortHeadline(phase, view, analysis, offer = null) {
  const action = analysis?.selected?.action;
  const factors = new Set((analysis?.decisiveFactors ?? []).map(factor => factor.code));
  if (phase === 'claim') {
    if (factors.has('LAST_PLACE_LOCK_FORBIDDEN')) return '順位を守るため、ロンを見送る';
    if (offer?.type === 'ron' && action?.action === 'ron') return '点棒と順位条件を満たすのでロンする';
    if (offer?.type === 'ron' && action?.action === 'pass') return 'あがらず、次の局で順位を上げる余地を残す';
    if (action?.action === 'pon' && factors.has('YAKUHAI_PON')) return '役牌を鳴いて速度を上げる';
    if (action?.action === 'pon' && factors.has('TOITOI_ROUTE')) return '同じ牌を集める手を進める';
    if (action?.action === 'chi') return 'この順子を使って形を一歩進める';
    if (action?.action === 'minkan' || action?.action === 'kakan') return '手を進めるために槓を選ぶ';
    if (!action) return offer?.type === 'ron' ? '順位優先でロンを見送る' : '鳴かずに手の形を保つ';
    return '鳴くことで手を進める理由がある';
  }
  if (action?.action === 'tsumo') return 'ここはツモあがり';
  if (action?.action === 'discard') {
    const honor = selectedHonorContext(view, action);
    if (honor && !honor.value && honor.copies === 1) return '役にならない字牌を先に切る';
    if (factors.has('FOLD_ON_RIICHI_THREAT') || factors.has('RIICHI_LEAST_RISK_NON_GENBUTSU') || factors.has('RIICHI_COMMON_GENBUTSU')) {
      return 'リーチ者への危険度を下げる';
    }
    if (factors.has('SUIT_PRESSURE_AVOIDED')) return '相手の色に合わせて危険牌を避ける';
    if (factors.has('KNOWN_VALUE_PRESERVED')) return '見えている価値牌を残す';
    const comparison = comparisonHeadline(view, analysis);
    if (comparison) return comparison;
    if (factors.has('EARLY_EFFICIENCY_PRIORITY')) return '序盤は形の広さを優先する';
    if (factors.has('EFFICIENCY_EDGE')) return '次に進みやすい形を残す';
    return '手を進めやすい形を残す';
  }
  if (action?.action === 'ankan') return '手を悪くしない暗槓';
  return '公開情報から候補を比べる';
}

function resultBase(phase, view, analysis, offer = null) {
  const action = analysis?.selected?.action ?? null;
  const detailParagraphs = phase === 'turn'
    ? turnExplanationParts(view, analysis)
    : [claimExplanation(view, offer, analysis)];
  const explanation = detailParagraphs.join('');
  return freeze({
    version: DECISION_COACH_VERSION,
    phase,
    informationScope: '公開情報のみ（本人の手牌・全員の河・副露・点棒・ドラ表示）',
    recommendation: actionLabel(action, view, offer),
    headline: shortHeadline(phase, view, analysis, offer),
    action: copy(action),
    explanation,
    detailParagraphs: copy(detailParagraphs),
    hasMore: detailParagraphs.length > 1 || explanation.length > 86,
    context: publicContext(view),
    confidence: analysis?.confidence ?? 'PARTIAL',
    coverage: copy(analysis?.coverage ?? {}),
    analysis: copy(analysis),
  });
}

export function buildTurnCoaching(view, options = [], profile = 'analyst') {
  if (!view || typeof view !== 'object') throw new TypeError('buildTurnCoaching: view is required');
  return resultBase('turn', view, evaluateTurnDecision(view, options, profile));
}

export function buildClaimCoaching(view, offer, profile = 'analyst') {
  if (!view || typeof view !== 'object') throw new TypeError('buildClaimCoaching: view is required');
  if (!offer || typeof offer !== 'object') throw new TypeError('buildClaimCoaching: offer is required');
  return resultBase('claim', view, evaluateClaimDecision(view, offer, profile), offer);
}

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
  if (!action) return offer?.type === 'ron' ? 'ロンを見送る' : 'スルー（鳴かない）';
  if (action.action === 'tsumo') return 'ツモあがり';
  if (action.action === 'ron') return 'ロンあがり';
  if (action.action === 'discard') {
    const tile = tileAt(view, action.index);
    if (action.riichi) return `${tile ? tileName(tile.kind) : 'この牌'}を切ってリーチ`;
    return `${tile ? tileName(tile.kind) : 'この牌'}を切る`;
  }
  if (action.action === 'pon') return `${offer?.tile ? tileName(offer.tile.kind) : 'この牌'}をポン`;
  if (action.action === 'minkan') return `${offer?.tile ? tileName(offer.tile.kind) : 'この牌'}をカン`;
  if (action.action === 'chi') return `${offer?.tile ? tileName(offer.tile.kind) : 'この牌'}をチー`;
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
  if (safety.oneChance) return '見えている牌から数えると当たり方が一形しか残っておらず、当たる可能性は非常に低いです。ただし完全な安全牌ではありません。';
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
  YAKUHAI_SECURED: '役牌確定（役はあるので最速でまとめる）',
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

// 当たり形の呼び名(ワンチャンスで残った一形を名指しする)
function waitShapeName(shape) {
  if (!shape) return 'その形';
  if (shape.kind === 'TANKI') return '単騎待ち';
  if (shape.kind === 'SHANPON') return 'シャンポン待ち';
  if (shape.kind === 'KOKUSHI') return '国士無双の待ち';
  if (shape.kind === 'SEQUENCE') {
    const label = shape.shape === 'RYANMEN' ? '両面' : shape.shape === 'KANCHAN' ? '嵌張' : '辺張';
    return `${shape.companions.map(kind => tileName(kind)).join('')}を使った${label}待ち`;
  }
  return 'その形';
}

// 「〜だから当たらない/当たりにくい」: 選んだ牌の安全根拠を証拠つきで言う (v12.7)
function safetyReasonSentences(view, metrics, selectedTile) {
  const details = metrics?.safety?.perThreatDetails;
  if (!Array.isArray(details) || details.length === 0 || !selectedTile) return [];
  const name = tileName(selectedTile.kind, selectedTile.red);
  if (metrics.safety.commonGenbutsu && details.length > 1) {
    return [`${name}は全員のリーチに対して通っている現物なので、当たりません。`];
  }
  const sentences = [];
  for (const detail of details.slice(0, 2)) {
    const label = relativeSeatLabel(view, detail.seat) ?? 'リーチ者';
    if (detail.genbutsu) {
      const inOwnRiver = (view?.public?.players?.[detail.seat]?.discards ?? [])
        .some(discard => discard.tile.kind === selectedTile.kind);
      sentences.push(inOwnRiver
        ? `${name}は${label}の河にある現物なので、${label}には当たりません。`
        : `${name}はリーチ宣言の後に場に通った牌なので、フリテンの規則で${label}には当たりません。`);
      continue;
    }
    if (detail.noChance) {
      sentences.push(`${name}は、見えている牌から数えると当たれる形が一つも作れないので、実質の安全牌です。`);
      continue;
    }
    const routes = detail.sequenceRoutes ?? [];
    const reasons = [];
    // 両面の消え方は左右の側ごとに根拠を言う。片側スジだけで「スジなので両面に
    // 当たらない」と言い切らない(2026-08-19指摘: 1筒通過のみ=片スジで7筒側は別)
    const ryanmenRoutes = routes.filter(route => route.shape === 'RYANMEN');
    const ryanmenAlive = ryanmenRoutes.some(route => route.possible);
    if (ryanmenRoutes.length > 0 && !ryanmenAlive) {
      const sujiSides = ryanmenRoutes.filter(route => route.eliminatedBySuji);
      const wallSides = ryanmenRoutes.filter(route => !route.eliminatedBySuji && route.eliminatedByNoChance);
      const sujiEvidence = [...new Set(sujiSides.map(route => tileName(route.alternateKind)))].join('・');
      const wallEvidence = [...new Set(wallSides
        .flatMap(route => route.companions.filter((companion, i) => route.companionRemaining[i] === 0)))]
        .map(kind => tileName(kind)).join('・');
      if (sujiSides.length > 0 && wallSides.length > 0) {
        reasons.push(`${sujiEvidence}が通っているスジと、${wallEvidence}が4枚見えている壁で、両面待ちはどちら側も消えています`);
      } else if (sujiSides.length > 0 && wallSides.length === 0 && ryanmenRoutes.every(route => route.eliminatedBySuji)) {
        reasons.push(`${sujiEvidence}が通っているスジなので、両面待ちには当たりません`);
      }
      // 全側が壁のケースは下の壁文+「両面待ちに対しては、ノーチャンスです」が担当
    }
    const wallKinds = [...new Set(routes
      .filter(route => route.eliminatedByNoChance)
      .flatMap(route => route.companions.filter((companion, i) => route.companionRemaining[i] === 0)))]
      .map(kind => tileName(kind));
    if (wallKinds.length > 0) {
      reasons.push(`${wallKinds.join('・')}が4枚見えていて、それを使う待ちの形は作れません`);
    }
    // 壁読みの用語は「両面待ちに対しては」と必ず限定する(初級者が勘違いしやすいため)
    if (detail.ryanmenNoChance) {
      reasons.push('両面待ちに対しては、ノーチャンスです');
    } else if (detail.ryanmenOneChance && (detail.ryanmenOneChanceWallKinds?.length ?? 0) > 0) {
      const walls = detail.ryanmenOneChanceWallKinds.map(kind => tileName(kind)).join('・');
      reasons.push(`${walls}が3枚見えていて、両面待ちに対しては、ワンチャンスです`);
    }
    if (routes.length === 0 && !detail.oneChance) {
      const waits = detail.residualWaits ?? [];
      const waitText = waits.includes('SHANPON') ? 'シャンポンか単騎' : '単騎';
      reasons.push(`字牌なので順子の待ちでは当たらず、残る可能性は${waitText}だけです`);
    }
    if (detail.oneChance && detail.oneChanceShape) {
      // 当たり形の数え上げで残り1形だけ: その一形を名指しして結論を言う
      reasons.push(`見えている牌から数えると当たり方は${waitShapeName(detail.oneChanceShape)}しか残っておらず、そこで待っている可能性は非常に低いです`);
    }
    if (detail.urasujiOfDeclaration) {
      reasons.push('ただし宣言牌の裏筋にあたるので、警戒は少し残します');
    }
    if (reasons.length > 0) {
      sentences.push(`${name}は、${reasons.join('。また、')}。`);
    } else if (detail.risk > 0) {
      sentences.push(`${name}は${label}への無筋で、通る根拠はありません。手の価値との比較で選んでいます。`);
    }
  }
  return [...new Set(sentences)];
}

// テンパイ気配(リーチ未満)の相手に対する通りやすさの根拠
function pressureSafetySentence(view, metrics, selectedTile) {
  const caution = metrics?.pressureCaution;
  if (!Array.isArray(caution) || caution.length === 0 || !selectedTile) return '';
  const safeSeats = caution.filter(item => item.danger === 0)
    .map(item => relativeSeatLabel(view, item.seat)).filter(Boolean);
  const name = tileName(selectedTile.kind, selectedTile.red);
  if (safeSeats.length > 0) {
    return `${name}は${safeSeats.join('・')}に対して通った実績のある牌です。`;
  }
  if (isHonor(selectedTile.kind)) {
    return `${name}は字牌なので、順子の待ちには当たりません。`;
  }
  return '';
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
  if (signals.some(signal => signal.evidence?.redDoraDiscard)) evidenceParts.push('赤ドラを切ってきた');
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
    } else if (block.type === 'ryankan') {
      parts.push(`${block.kinds.map(kind => tileName(kind)).join('')}（${tileName(block.kinds[0] + 1)}か${tileName(block.kinds[1] + 1)}で完成）`);
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

// 「広さで負けているのに選んだ」理由の内訳: 効用補正の差が最大の要因を名指しする。
// 定型の「見えている価値や相手の捨て牌を優先して」で済まさない(2026-08-19指摘)
export function dominantKeepReason(altCandidate, selectedCandidate, altName) {
  const altAdjustments = altCandidate?.metrics?.utilityAdjustments ?? {};
  const selectedAdjustments = selectedCandidate?.metrics?.utilityAdjustments ?? {};
  const phrases = {
    redDiscardPenalty: `${altName}は赤牌で、切ると確定1翻を失うため`,
    doraDiscardPenalty: `${altName}はドラのため`,
    planRetention: null, // planKeepPhraseで具体化
    suitPressurePenalty: `${altName}は相手の染め気配の色で切りにくいため`,
    pushRiskPenalty: `${altName}の方がリーチ相手に危険なため`,
    pressureCautionPenalty: `${altName}の方がテンパイ気配の相手に危険なため`,
  };
  let bestKey = null;
  let bestDiff = -0.2; // これ未満の差は「僅差」として扱う
  for (const key of Object.keys(phrases)) {
    const diff = (altAdjustments[key] ?? 0) - (selectedAdjustments[key] ?? 0);
    if (diff < bestDiff) { bestDiff = diff; bestKey = key; }
  }
  if (!bestKey) return null;
  if (bestKey === 'planRetention') {
    const keep = planKeepPhrase(altCandidate?.metrics?.planEvaluation);
    return keep ? `${altName}は${keep}のため` : `${altName}の方が手の形として残す価値が高いため`;
  }
  return phrases[bestKey];
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

function suitNameOf(suit) {
  return ['萬子', '筒子', '索子'][suit] ?? '';
}

function tileSuitOf(kind) {
  return kind >= 0 && kind < 27 ? Math.floor(kind / 9) : null;
}

// 読み分岐 (2026-08-19仕様): 読みは確率と違い打つ人の判断に委ねられる。
// 「この読みを重く見るならこれ」「受け入れだけならこれ」を併記し、
// 最後の一枚の選択はガイドの情報を見たユーザー自身がした、という形にする。
function readBranchParts(view, analysis) {
  const action = analysis?.selected?.action;
  if (action?.action !== 'discard' || view?.riichi) return [];
  const selected = selectedCandidate(analysis);
  const selectedTile = candidateTile(view, selected);
  const selectedMetrics = selected?.metrics;
  if (!selectedTile || !Number.isInteger(selectedMetrics?.shanten)) return [];
  const discards = (analysis?.candidates ?? []).filter(candidate =>
    candidate?.action?.action === 'discard' && !candidate.action.riichi &&
    Number.isInteger(candidate.metrics?.shanten) && candidateTile(view, candidate));
  const flushSignals = (analysis?.estimates ?? []).filter(item => item.code === 'OPPONENT_FLUSH_SIGNAL');
  const pressureSignals = (analysis?.estimates ?? []).filter(item => item.code === 'OPPONENT_TENPAI_PRESSURE');
  const anyRiichi = (view?.public?.players ?? []).some((player, seat) => seat !== view.me && player?.riichi);
  const parts = [];
  // 受け入れ未計算(向聴が落ちる側)の候補は、手放して一番惜しくない牌を分岐に選ぶ
  const planContext = coachPlanContext(view);
  const handAll = handAllOf(view);
  const plans = evaluateHandPlans(handAll, view?.melds ?? [], planContext);
  const retentionOf = tile => tileRetentionValue(tile, plans, handAll, planContext).retention;
  const pickBest = (pool, shanten) => pool
    .filter(candidate => candidate.metrics.shanten === shanten)
    .sort((left, right) =>
      ((right.metrics.ukeirePhysical ?? -1) - (left.metrics.ukeirePhysical ?? -1)) ||
      (retentionOf(candidateTile(view, left)) - retentionOf(candidateTile(view, right))))[0];

  // ①確率(受け入れ)側の対案: 読みや警戒で最大受け入れを選ばなかったとき
  if (flushSignals.length > 0 || pressureSignals.length > 0 || anyRiichi) {
    const best = [...discards].sort((left, right) =>
      (left.metrics.shanten - right.metrics.shanten) ||
      ((right.metrics.ukeirePhysical ?? 0) - (left.metrics.ukeirePhysical ?? 0)))[0];
    const bestTile = best ? candidateTile(view, best) : null;
    if (bestTile && (bestTile.kind !== selectedTile.kind || bestTile.red !== selectedTile.red) &&
        (best.metrics.shanten < selectedMetrics.shanten ||
         (best.metrics.shanten === selectedMetrics.shanten &&
          (best.metrics.ukeirePhysical ?? 0) > (selectedMetrics.ukeirePhysical ?? 0)))) {
      parts.push(`受け入れの枚数だけで選ぶなら、${tileName(bestTile.kind, bestTile.red)}切り（${best.metrics.ukeirePhysical}枚）が最大です。`);
    }
  }

  // ②染め気配: 読みを重く見る側の対案(推奨が既にその色を避けているときは不要)
  for (const signal of flushSignals.slice(0, 2)) {
    if (tileSuitOf(selectedTile.kind) !== signal.suit) continue;
    const label = relativeSeatLabel(view, signal.seat);
    if (!label) continue;
    const offSuit = discards.filter(candidate =>
      tileSuitOf(candidateTile(view, candidate).kind) !== signal.suit);
    const sameSpeed = pickBest(offSuit, selectedMetrics.shanten);
    const alternative = sameSpeed ?? pickBest(offSuit, selectedMetrics.shanten + 1);
    if (!alternative) continue;
    const altTile = candidateTile(view, alternative);
    const evidence = (signal.evidence?.sameSuitMelds ?? 0) >= 2
      ? `${suitNameOf(signal.suit)}の副露が${signal.evidence.sameSuitMelds}つ`
      : `河が${suitNameOf(signal.suit)}以外に偏っている`;
    const cost = sameSpeed ? '' : '（手は一歩遅れます）';
    parts.push(`${label}は${suitNameOf(signal.suit)}の染め気配です（${evidence}）。リーチはありませんが、この読みを重く見るなら、振り込みのリスク回避と、${suitNameOf(signal.suit)}を鳴かせて進めさせない意味も含めて、${tileName(altTile.kind, altTile.red)}を切る選択もあります${cost}。`);
  }

  // ③リーチへの回し先: リーチ相手がいるとき「回すならこの牌」はリーチへの
  // 安全度を最優先で選ぶ(気配相手の通過実績だけで選ぶとリーチに危険な牌を
  // 回し先として勧めてしまう=2026-08-19実機指摘)
  const riichiSeats = (view?.public?.players ?? [])
    .map((player, seat) => ({ player, seat }))
    .filter(({ player, seat }) => seat !== view.me && player?.riichi);
  if (riichiSeats.length > 0) {
    const riskOf = candidate => {
      const risk = candidate?.metrics?.safety?.maxRisk;
      return Number.isFinite(risk) ? risk : Number.POSITIVE_INFINITY;
    };
    const pickSafest = shanten => discards
      .filter(candidate => candidate.metrics.shanten === shanten)
      .sort((left, right) => (riskOf(left) - riskOf(right)) ||
        ((right.metrics.ukeirePhysical ?? -1) - (left.metrics.ukeirePhysical ?? -1)) ||
        (retentionOf(candidateTile(view, left)) - retentionOf(candidateTile(view, right))))[0];
    const bestSame = pickSafest(selectedMetrics.shanten);
    const bestSlower = pickSafest(selectedMetrics.shanten + 1);
    // 一歩遅らせる方が明確に安全なら、そちらを回し先として名指しする
    const useSlower = bestSlower && riskOf(bestSlower) < riskOf(bestSame);
    const alternative = useSlower ? bestSlower : bestSame;
    const selectedRisk = Number.isFinite(selectedMetrics?.safety?.maxRisk)
      ? selectedMetrics.safety.maxRisk : Number.POSITIVE_INFINITY;
    if (alternative && riskOf(alternative) < selectedRisk) {
      const altTile = candidateTile(view, alternative);
      if (altTile.kind !== selectedTile.kind || altTile.red !== selectedTile.red) {
        const safety = alternative.metrics.safety;
        // 回し先の根拠はその牌の実データで言い分ける。現物でない牌を現物と呼ばない
        const details = safety?.perThreatDetails ?? [];
        const sujiSafe = detail => {
          const ryanmen = (detail.sequenceRoutes ?? []).filter(route => route.shape === 'RYANMEN');
          return ryanmen.length > 0 && ryanmen.every(route => route.eliminatedBySuji);
        };
        let safeDesc = '一番危険の低い';
        let certainNote = '';
        if (safety?.commonGenbutsu || (details.length > 0 && details.every(detail => detail.genbutsu))) {
          safeDesc = '現物の';
        } else if (details.length > 0 && details.every(detail => detail.genbutsu || detail.noChance)) {
          // 当たり形の数え上げゼロ=確実な安全。「危険度が低い」とは言わず言い切る
          safeDesc = '当たる形が一つも残っていない';
          certainNote = '（実質の安全牌）';
        } else if (details.length > 0 && details.every(detail => detail.genbutsu || sujiSafe(detail))) {
          safeDesc = 'スジの';
        } else if (details.length > 0 && details.every(detail => detail.genbutsu || detail.ryanmenNoChance)) {
          safeDesc = '両面に当たらない';
        }
        const labels = riichiSeats.map(({ seat }) => relativeSeatLabel(view, seat)).filter(Boolean).join('・');
        const cost = useSlower ? '（手は一歩遅れます）' : '';
        parts.push(`${labels || 'リーチ者'}のリーチを重く見て回す（降りる）なら、${safeDesc}${tileName(altTile.kind, altTile.red)}${certainNote}へ回す選択もあります${cost}。`);
      }
    }
  }

  // ④テンパイ気配(染め以外): 通った実績側へ回す対案。
  // リーチが場に居るときはリーチ最優先の③が回し先を言うので出さない
  const flushSeats = new Set(flushSignals.map(signal => signal.seat));
  if (riichiSeats.length === 0) {
    for (const signal of pressureSignals.filter(item => !flushSeats.has(item.seat)).slice(0, 1)) {
      if (signal.genbutsuKinds?.includes(selectedTile.kind)) continue;
      const label = relativeSeatLabel(view, signal.seat);
      if (!label) continue;
      const safe = discards.filter(candidate =>
        signal.genbutsuKinds?.includes(candidateTile(view, candidate).kind));
      const sameSpeed = pickBest(safe, selectedMetrics.shanten);
      const alternative = sameSpeed ?? pickBest(safe, selectedMetrics.shanten + 1);
      if (!alternative) continue;
      const altTile = candidateTile(view, alternative);
      const cost = sameSpeed ? '' : '（手は一歩遅れます）';
      parts.push(`${label}のテンパイ気配を重く見るなら、${label}に通った実績のある${tileName(altTile.kind, altTile.red)}へ回す選択もあります${cost}。`);
    }
  }

  if (parts.length > 0) {
    parts.push('どの読みをどれだけ重く見るかで最善は変わります。最後の一枚は、ここまでの情報とあなたの読みで選んでください。');
  }
  return parts.slice(0, 4);
}

function planHeadlineSentences(selected) {
  const planEvaluation = selected?.metrics?.planEvaluation;
  const top = planEvaluation?.topPlans?.[0];
  const sentences = [];
  const strength = top ? (top.weight ?? 0) * (top.value ?? 0) : 0;
  // プランが弱い牌姿(暗刻が並ぶ手なり等)で「本線はタンヤオ・ピンフ」と
  // 嘘をつかない(カルテ27号)。役の当てが無いことを正直に言う
  if (top && PLAN_LABELS[top.code] && strength >= 0.45) {
    sentences.push(`今の本線は${PLAN_LABELS[top.code]}です。`);
  } else if (top) {
    sentences.push('はっきりした役の本線はまだ無い牌姿です。まずは形のテンパイを目指し、役はリーチや途中の変化で付けます。');
  }
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
    // 判断の分かれる字牌の対案は必ず具体的に言う(2026-08-19指定:
    // 「なんで南や白じゃないのか」を曖昧語でなく牌ごとの理由で説明する)
    if (isHonor(tile.kind) && delta >= 0 && delta <= 2) {
      if (valueHonor(tile, view)) {
        parts.push(delta === 0
          ? `${name}を切る案とは互角です。${name}はもう1枚重なると役として使える牌なので、その芽を見て${selectedName}を先にしましたが、${name}から切る選択もありです。`
          : `${name}を切る案は受け入れが${delta}枚だけ狭くなります。${name}はもう1枚重なると役として使える牌でもあるので残しましたが、${name}から切る選択もありです。`);
      } else {
        parts.push(delta === 0
          ? `${name}を切る案とは互角です。${name}は役にならない字牌で伸びもないため、${selectedName}切りとの差はほぼありません。${name}から切る選択もありです。`
          : `${name}は役にならない字牌なので早めに手放す考え方もあります。受け入れが${delta}枚狭くなるぶん${selectedName}を先にしましたが、${name}から切る選択もありです。`);
      }
      continue;
    }
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
    // 広さで負けているのに選んだケース: 効用差の最大要因を名指しする(カルテ28号)
    if (delta < 0) {
      const reason = dominantKeepReason(candidate, selected, name);
      parts.push(reason
        ? `${name}を切る案の方が受け入れは${-delta}枚広いですが、${reason}、${selectedName}を先に切ります。`
        : `${name}を切る案の方が受け入れは${-delta}枚広く、ほぼ互角です。残す価値の合計でわずかに${selectedName}切りを取っています。`);
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
    // リーチ保留 (カルテ26号): 「切る牌」と「リーチするか」は別の判断として説明する
    const riichiInfo = metrics?.riichiEvaluation;
    if (!action.riichi && riichiInfo?.holdBack) {
      const hold = riichiInfo.hold ?? {};
      const growth = [];
      if ((hold.tanyaoKinds?.length ?? 0) > 0) {
        growth.push(`${hold.tanyaoKinds.map(kind => tileName(kind)).join('・')}を引けばタンヤオが付いてダマでもあがれる形になり`);
      }
      if ((hold.widenKinds?.length ?? 0) > 0) {
        growth.push(`${hold.widenKinds.map(kind => tileName(kind)).join('・')}で待ちが広い形に育ちます`);
      }
      let sentence = `テンパイですが、リーチはまだ打ちません。今の待ちは残り${riichiInfo.physicalRemaining}枚と薄く、${growth.length > 0 ? growth.join('、') + '。' : ''}`;
      if (hold.pressure) {
        sentence += 'テンパイの気配がある相手もいて、リーチで手を固定すると降りられなくなります。';
      }
      sentence += '今は役が無いためロンはできませんが、形の成長を待つ判断です（効率モードなら即リーチします）。';
      sentences.push(sentence);
    }
    const honor = selectedHonorContext(view, action);
    const selectedPlanNotes = selected?.metrics?.planEvaluation?.notes ?? [];
    if (honor && honor.value && honor.copies === 1 && selectedPlanNotes.includes('LONE_YAKUHAI_EARLY_CUT')) {
      const topPlan = selected?.metrics?.planEvaluation?.topPlans?.[0];
      const strongTanyao = topPlan?.code === 'TANYAO_PINFU' &&
        (topPlan.weight ?? 0) * (topPlan.value ?? 0) >= 0.45;
      sentences.push(`${tileName(honor.tile.kind)}は${honor.labels.join('・')}ですが1枚だけです。重なりを待って安手を拾うより、${strongTanyao ? 'タンヤオ・ピンフ系で3900点以上を狙う方が本線' : '手なりでテンパイへ進む方が価値が高い'}ので、序盤のうちに切ります。`);
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
    } else if (factors.has('LEAST_RISK_NON_GENBUTSU') || factors.has('RIICHI_SAFE_TILE')) {
      sentences.push('相手にリーチがあるので、完全な安全牌ではなくても、公開情報から比べて危険度が低い牌を選びます。');
    } else {
      sentences.push('この牌を切っても、手の中の組み合わせを崩しすぎず、次のツモで前に進めます。');
    }
    // 打点対比 (カルテ21号): 相手リーチが高そうで自手が安いときは、その判断軸を言う
    {
      const contrast = (analysis?.facts ?? []).find(fact => fact.code === 'THREAT_VALUE_CONTRAST');
      if (contrast) {
        const threatParts = [];
        if ((contrast.threatKans ?? 0) > 0) threatParts.push('カンが入り');
        if ((contrast.indicators ?? 1) > 1) threatParts.push(`ドラ表示が${contrast.indicators}枚あって裏ドラも増える`);
        const threatText = threatParts.length > 0
          ? `相手のリーチは${threatParts.join('、')}ため、打点が高くなりやすい状況です。`
          : '';
        const cheapText = (contrast.ownValueTiles ?? 0) === 0
          ? 'こちらの手にはドラ・赤がなく安いので、押す見返りが小さく、安全寄りに判断します。'
          : ((contrast.ownValueTiles ?? 0) === 1
            ? 'こちらの手の打点の種は少なめなので、やや安全寄りに判断します。'
            : '');
        if (threatText || cheapText) sentences.push(`${threatText}${cheapText}`.trim());
      }
    }
    if (factors.has('PRESSURE_CAUTION')) {
      const caution = pressureCautionSentence(view, analysis);
      if (caution) sentences.push(caution);
    }
    // v12.7: リーチ・気配相手がいるときは、選んだ牌の安全根拠を証拠つきで言う
    {
      const selectedTileForSafety = tileAt(view, action.index);
      const safetyReasons = safetyReasonSentences(view, metrics, selectedTileForSafety);
      if (safetyReasons.length > 0) {
        sentences.push(...safetyReasons);
      } else {
        const pressureReason = pressureSafetySentence(view, metrics, selectedTileForSafety);
        if (pressureReason) sentences.push(pressureReason);
      }
    }
    // 次の一手問題の解説調(2026-08-19指定): テンパイ間近だけ短く言い、
    // 枚数の列挙(引いて嬉しい牌・受け入れ合計)や局面の定型おさらいは書かない
    if (metrics.shanten === 0) sentences.push('この一打でテンパイです。');
    else if (metrics.shanten === 1) sentences.push('テンパイまであと一歩の形です。');
  }
  const comparisons = action?.action === 'discard' ? comparisonParts(view, analysis) : [];
  const planHead = action?.action === 'discard' ? planHeadlineSentences(selected) : [];
  // 狙い(伸ばす形)→選んだ理由→意味のある同格比較→別プランへの分岐→読み分岐、の順で読ませる
  const growth = action?.action === 'discard' ? blockGrowthSentence(view, action, metrics) : '';
  const alternatives = action?.action === 'discard' ? planAlternativeParts(view, analysis) : [];
  const readBranches = action?.action === 'discard' ? readBranchParts(view, analysis) : [];
  return [...planHead, ...(growth ? [growth] : []), ...sentences, ...comparisons, ...alternatives, ...readBranches];
}

function shantenLabel(shanten) {
  return shanten === 0 ? 'テンパイ' : `${shanten}向聴`;
}

function claimExplanationParts(view, offer, analysis) {
  const action = analysis?.selected?.action;
  const reason = analysis?.decisiveFactors?.[0]?.code;
  if (offer?.type === 'ron') {
    if (reason === 'LAST_PLACE_LOCK_FORBIDDEN') {
      return ['あがれますが、このままあがると最下位のまま終わる条件です。少しでも順位が上がる可能性を残すため、ここは見送ります。'];
    }
    return ['あがりを選べます。点棒と順位の条件を満たすので、ここで終わらせます。'];
  }

  const claimedName = offer?.tile ? tileName(offer.tile.kind) : 'その牌';
  const ponCandidate = (analysis?.candidates ?? []).find(candidate =>
    String(candidate.candidateId ?? '').startsWith('pon:'));
  const ponMetrics = ponCandidate?.metrics ?? {};
  const shantenSentence = Number.isInteger(ponMetrics.shantenBefore) && Number.isInteger(ponMetrics.shantenAfter)
    ? (ponMetrics.shantenAfter < ponMetrics.shantenBefore
      ? `ポンすると手は${shantenLabel(ponMetrics.shantenBefore)}から${shantenLabel(ponMetrics.shantenAfter)}へ進みます。`
      : `ポンしても手は${shantenLabel(ponMetrics.shantenBefore)}のままで、速くなりません。`)
    : '';

  if (!action) {
    if (reason === 'ANKO_ALREADY_COMPLETE' || ponMetrics.ankoComplete) {
      return [`スルーを勧めます。${claimedName}は手の中で3枚そろっていて、すでに面子として完成しています。ここで鳴くと完成形を崩すだけです。`];
    }
    // 「鳴けば速い」ことは認めた上で、なぜ鳴かないかの天秤を明言する(カルテ25号)
    const passMetrics = (analysis?.candidates ?? []).find(candidate =>
      candidate.candidateId === 'pass')?.metrics ?? {};
    const improves = Number.isInteger(passMetrics.bestClaimShanten) &&
      Number.isInteger(passMetrics.shantenBefore) &&
      passMetrics.bestClaimShanten < passMetrics.shantenBefore;
    const parts = improves
      ? [`スルー（鳴かない）を勧めます。${claimedName}を鳴けば${shantenLabel(passMetrics.shantenBefore)}から${shantenLabel(passMetrics.bestClaimShanten)}へ速くなるのは見えています。ただ、この手はタンヤオ圏でも役牌バック（役牌の対子持ち）でもないため、鳴くと役の当てが薄く、安手か役無しになりがちです。`]
      : [`スルー（鳴かない）を勧めます。${claimedName}を鳴いても向聴が進まず、速度の得がありません。${shantenSentence}`.trim()];
    parts.push((view?.melds?.length ?? 0) > 0
      ? 'すでに副露している手ですが、この鳴きには得がありません。手の自由度を保って自分のツモで進めます。'
      : '面前のまま進めばリーチ（と裏ドラ）で打点が見えるため、ここは速度より役と打点を取ります。');
    return parts;
  }
  if (reason === 'CALL_TANYAO_SPEED') {
    const label = action.action === 'pon' ? 'ポン' : 'チー';
    const selMetrics = (analysis?.candidates ?? []).find(candidate =>
      candidate.candidateId === analysis?.selected?.candidateId)?.metrics ?? {};
    return [
      `${label}を勧めます。鳴いてもタンヤオが確定圏なので役は消えません。${shantenLabel(selMetrics.shantenBefore)}から${shantenLabel(selMetrics.shantenAfter)}へ速くなります。`,
      '代わりにリーチ・裏ドラは消えるので、打点より速度を取る判断です。',
    ];
  }
  if (reason === 'CALL_YAKUHAI_BACKED') {
    const label = action.action === 'pon' ? 'ポン' : 'チー';
    const selMetrics = (analysis?.candidates ?? []).find(candidate =>
      candidate.candidateId === analysis?.selected?.candidateId)?.metrics ?? {};
    const backedName = Number.isInteger(selMetrics.backedKind) ? tileName(selMetrics.backedKind) : '役牌';
    return [
      `${label}を勧めます。手に${backedName}の対子があり、鳴いても役の当てが残ります（役牌バック）。${shantenLabel(selMetrics.shantenBefore)}から${shantenLabel(selMetrics.shantenAfter)}へ速くなります。`,
      `${backedName}が最後まで鳴けない・引けないと役無しの危険が残る点だけ注意です。`,
    ];
  }
  if (action.action === 'pon' && reason === 'YAKUHAI_PON') {
    const parts = [`ポンを勧めます。${claimedName}は役牌なので、鳴いた時点で役（1翻）が確定し、あがりの資格を失いません。`];
    if (shantenSentence) parts.push(shantenSentence);
    parts.push('代わりにリーチと門前の役は消えます。ここは打点より速度を取る場面と判断しました。');
    return parts;
  }
  if (reason === 'FORMAL_TENPAI_RACE') {
    const label = action.action === 'pon' ? 'ポン' : 'チー';
    const remaining = analysis?.selected?.metrics?.remaining ??
      (analysis?.candidates ?? []).find(candidate => candidate.reasons?.includes('FORMAL_TENPAI_RACE'))?.metrics?.remaining ??
      view?.public?.remaining;
    return [
      `${label}を勧めます。流局が近く（残り${remaining}枚）、${claimedName}を鳴けばテンパイに届きます。`,
      'ここからのあがりは難しくても、流局時のテンパイ・ノーテンで最大3000点の差が付きます。形式テンパイを取りにいく場面です。',
    ];
  }
  if (action.action === 'pon' && reason === 'TOITOI_ROUTE') {
    const ponCountText = (ponMetrics.ponLikeMelds ?? 0) > 0 ? `ポン${ponMetrics.ponLikeMelds}つと` : '';
    const parts = [`ポンを勧めます。${ponCountText}対子${ponMetrics.pairs ?? '複数'}組で、トイトイ（すべてを刻子でそろえる2翻役）の形です。${claimedName}を刻子にして前へ進めます。`];
    if (Number.isInteger(ponMetrics.shantenBefore) && Number.isInteger(ponMetrics.shantenAfter) &&
        ponMetrics.shantenAfter < ponMetrics.shantenBefore) {
      parts.push(`ポンすると手は${shantenLabel(ponMetrics.shantenBefore)}から${shantenLabel(ponMetrics.shantenAfter)}へ進みます。`);
    } else if (ponMetrics.toitoiImproves) {
      parts.push('通常の形の向聴は変わりませんが、トイトイの完成には一歩近づきます。');
    }
    return parts;
  }
  return ['この鳴きは選べますが、点数や待ちの細部はまだ自動計算していません。理由を過大に断定せず、速度を優先する選択として表示します。'];
}

function shortHeadline(phase, view, analysis, offer = null) {
  const action = analysis?.selected?.action;
  const factors = new Set((analysis?.decisiveFactors ?? []).map(factor => factor.code));
  if (phase === 'claim') {
    if (factors.has('LAST_PLACE_LOCK_FORBIDDEN')) return '順位を守るため、ロンを見送る';
    if (offer?.type === 'ron' && action?.action === 'ron') return '点棒と順位条件を満たすのでロンする';
    if (offer?.type === 'ron' && action?.action === 'pass') return 'あがらず、次の局で順位を上げる余地を残す';
    if (action?.action === 'pon' && factors.has('YAKUHAI_PON')) return 'ポン推奨: 役牌で1翻を確定させる';
    if (action?.action === 'pon' && factors.has('TOITOI_ROUTE')) return 'ポン推奨: トイトイへ刻子を増やす';
    if (action?.action === 'chi') return 'チーで形を一歩進める';
    if (action?.action === 'minkan' || action?.action === 'kakan') return 'カンを選ぶ';
    if (!action) return offer?.type === 'ron' ? '順位優先でロンを見送る' : 'スルー推奨: 門前を守る';
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
    : claimExplanationParts(view, offer, analysis);
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

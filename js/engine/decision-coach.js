// decision-coach.js — ユーザー向け「打ち手ガイド」の平易な説明
//
// 入力はユーザーにも見えている view / offer だけ。山の順番、他家の手牌、
// 王牌の未公開部分は読まず、DecisionEvaluator の分析結果だけを文章化する。
import { evaluateTurnDecision, evaluateClaimDecision } from './decision-evaluator.js?v=18';
import { isDragon, isHonor, numOf, doraFromIndicator, tileName, toCounts } from './tiles.js';
import { decomposeBlocks, evaluateHandPlans, tileRetentionValue } from './hand-plans.js';
import { describeThreatRead, describeCushion } from './threat-read.js';

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
    // 赤5は「赤5筒」と正確に呼ぶ(自走リントD5: 実選択の表記と食い違っていた)
    const tile = tileAt(view, action.index);
    if (action.riichi) return `${tile ? tileName(tile.kind, tile.red) : 'この牌'}を切ってリーチ`;
    return `${tile ? tileName(tile.kind, tile.red) : 'この牌'}を切る`;
  }
  if (action.action === 'ankan') return `${Number.isInteger(action.kind) ? tileName(action.kind) : 'この牌'}を暗カン`;
  if (action.action === 'pon') return `${offer?.tile ? tileName(offer.tile.kind) : 'この牌'}をポン`;
  if (action.action === 'minkan') return `${offer?.tile ? tileName(offer.tile.kind) : 'この牌'}をカン`;
  if (action.action === 'chi') {
    const withTiles = (action.tiles ?? []).map(kind => tileName(kind)).join('・');
    return `${offer?.tile ? tileName(offer.tile.kind) : 'この牌'}を${withTiles ? `${withTiles}と` : ''}チー`;
  }
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
  TANYAO_PINFU: 'タンヤオ・ピンフ系（3900点以上狙い）', // ※表示時はplanLabelForで手の実態に合わせて言い分ける
  YAKUHAI_PAIR: '役牌の速攻',
  HONITSU: 'ホンイツ',
  CHANTA: 'チャンタ',
  CHIITOI: '七対子',
  TOITOI: 'トイトイ（対子を刻子に育てる）',
  YAKUHAI_SECURED: '役牌確定（役はあるので最速でまとめる）',
  FORMAL_TENPAI: '形式テンパイ（役が付けにくいのでテンパイ料が目標）',
  // カルテ50号(2026-09-01): 「少し見えている役を無視しない」。以下は視野プランで、
  // 立っていれば本線宣言か「◯を狙うなら…分岐」で必ず言及される
  SANSHOKU: '三色同順（同じ並びを三つの色で揃える）',
  ITTSU: '一気通貫（一つの色で1〜9を揃える）',
  SANGEN: '小三元・大三元（三元牌を集める）',
  KOKUSHI: '国士無双（么九牌13種を集める）',
};

const PLAN_NOTE_PHRASES = {
  BLOCK_CORE: '手の骨組みになっているブロックの牌',
  RED5_LINK: '赤5と繋がる形',
  DOUBLE_WIND_KEEP: '場風と自風が重なる牌',
  DORA_HONOR_KEEP: 'ドラの字牌',
  RED_TILE: '赤牌',
};

// TANYAO_PINFUプランの看板を手の実態で言い分ける(2026-08-24ユーザー指摘):
// 123mが完成している手に「タンヤオ」と言わない。暗刻や役牌対子のある手に「ピンフ」と言わない。
// プラン名は内部コードのままでも、表示は嘘をつかない。
function planLabelFor(code, view) {
  if (code !== 'TANYAO_PINFU' || !view) return PLAN_LABELS[code] ?? code;
  const handAll = handAllOf(view);
  const isYaochuKind = kind => kind >= 27 || numOf(kind) === 1 || numOf(kind) === 9;
  const { chosen } = decomposeBlocks(handAll, coachPlanContext(view));
  // 骨組みに選ばれたブロック(完成面子・対子・搭子)に么九牌が入っているなら、
  // タンヤオはその骨を壊さないと成立しない=本線と呼ばない。浮きの么九牌は整理できるので許容
  const chosenHasYaochu = chosen.some(block => block.kinds.some(isYaochuKind));
  const meldHasYaochu = (view.melds ?? []).some(meld =>
    (meld.tiles ?? []).some(tile => isYaochuKind(tile.kind)));
  const yaochuTiles = handAll.filter(tile => isYaochuKind(tile.kind)).length;
  const tanyaoViable = !chosenHasYaochu && !meldHasYaochu && yaochuTiles <= 2;
  const counts = {};
  for (const tile of handAll) counts[tile.kind] = (counts[tile.kind] ?? 0) + 1;
  const ankoCount = Object.keys(counts).filter(kind => counts[kind] >= 3).length;
  const yakuhaiPair = Object.keys(counts).map(Number).some(kind =>
    counts[kind] >= 2 && kind >= 27 &&
    (isDragon(kind) || kind === view.seatWind || kind === view.roundWind));
  const pinfuViable = (view.melds ?? []).length === 0 && ankoCount === 0 && !yakuhaiPair;
  if (tanyaoViable && pinfuViable) return 'タンヤオ・ピンフ系（3900点以上狙い）';
  if (tanyaoViable) return 'タンヤオ系（リーチや赤と合わせて打点を作る）';
  if (pinfuViable) return 'ピンフ系（リーチと合わせて3900点以上狙い）';
  return '手なり（役はリーチで付ける）';
}

function planKeepPhrase(planEvaluation, view = null) {
  for (const note of planEvaluation?.notes ?? []) {
    if (PLAN_NOTE_PHRASES[note]) return PLAN_NOTE_PHRASES[note];
  }
  const top = planEvaluation?.topPlans?.[0]?.code;
  if (top && PLAN_LABELS[top]) {
    const label = planLabelFor(top, view);
    // 「手なりの本線に入る牌」は循環的で意味が伝わらない(カルテ54号)。実質を言う
    if (label.startsWith('手なり')) return '中寄りでまだ良形に育つ位置の牌';
    return `${label}の本線に入る牌`;
  }
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
        // スジ引っかけの証拠(内隣の早手出し)があるときは過信を戒める(カルテ37号)
        if (detail.sujiTrap) {
          reasons.push(`${sujiEvidence}が通っているスジで両面には当たりませんが、相手は${tileName(selectedTile.kind - 1)}${tileName(selectedTile.kind + 1)}の嵌張を残してスジで待つ「引っかけ」の型を河が示唆しています(内側の牌を途中で手出し)。スジを過信できない牌です`);
        } else {
          reasons.push(`${sujiEvidence}が通っているスジなので、両面待ちには当たりません`);
        }
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
    if (detail.matagiSuji && Number.isInteger(detail.lastTedashiKind)) {
      reasons.push(`ただしリーチ直前に手出しされた${tileName(detail.lastTedashiKind)}のまたぎスジにあたるので、警戒は少し残します`);
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
  // 対子が2つ以上あるときは、片方が雀頭・もう片方は3枚目で面子になる成長要員(カルテ41号:
  // 「伸ばしたい形」が搭子しか言わず、受け入れの大半(対子の暗刻化)を説明しない穴)
  const pairBlocks = chosen.filter(block => block.type === 'pair');
  if (pairBlocks.length >= 2) {
    const pairNames = pairBlocks.map(block => `${tileName(block.kinds[0])}${tileName(block.kinds[0])}`).join('・');
    parts.push(`${pairNames}（どちらかが雀頭、3枚目を引けば面子）`);
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
export function dominantKeepReason(altCandidate, selectedCandidate, altName, view = null) {
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
    const keep = planKeepPhrase(altCandidate?.metrics?.planEvaluation, view);
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
  // 同じ打牌に落ちる分岐は1文にまとめる(カルテ49号: 「手なりなら南」「役牌速攻なら南」の重複)
  const branchByTile = new Map();
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
      const key = `${best.tile.kind}:${best.tile.red === true}`;
      if (!branchByTile.has(key)) branchByTile.set(key, { tile: best.tile, labels: [] });
      branchByTile.get(key).labels.push(planLabelFor(plan.code, view));
    }
    if (branchByTile.size >= 2) break;
  }
  return [...branchByTile.values()].map(branch =>
    `${branch.labels.join('や')}を狙うなら、${tileName(branch.tile.kind, branch.tile.red)}を切る分岐もあります。`);
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

function planHeadlineSentences(selected, view) {
  const planEvaluation = selected?.metrics?.planEvaluation;
  const top = planEvaluation?.topPlans?.[0];
  const second = planEvaluation?.topPlans?.[1];
  const sentences = [];
  const strength = top ? (top.weight ?? 0) * (top.value ?? 0) : 0;
  // プランが弱い牌姿(暗刻が並ぶ手なり等)で「本線はタンヤオ・ピンフ」と
  // 嘘をつかない(カルテ27号)。役の当てが無いことを正直に言う
  if (top && PLAN_LABELS[top.code] && strength >= 0.45) {
    // 鳴き済みの手でトイトイからタンヤオへ乗り換えたときは、その切替を言う
    // (2026-08-20ユーザー裁定②: 早くあがれそうだから切り替える、と説明する)
    const hasPonMeld = (view?.melds ?? []).some(meld =>
      meld?.type === 'pon' || meld?.type === 'minkan' || meld?.kanOrigin);
    if (selected?.metrics?.spiritualChiitoi) {
      sentences.push('この局は対子場だから、七対子だけを狙います。対子は対子を呼びます。');
    } else if (top.code === 'FORMAL_TENPAI') {
      sentences.push('この手はもう役を付けにくい形です。ここからは流局時のテンパイ料を目標に、形のテンパイへ向かいます。');
    } else if (top.code === 'TANYAO_PINFU' && second?.code === 'TOITOI' && hasPonMeld) {
      sentences.push('トイトイも見えますが、こちらの方が早くあがれそうなので、狙いをタンヤオに切り替えます。');
    } else if ((top.code === 'HONITSU' || top.code === 'KOKUSHI') && (top.weight ?? 0) < 0.8) {
      // 決め打ち系プラン(染め/国士)の移行期は断言しない(自走triage 2026-08-31)。
      // 二番手プランがあればそれと並べて言う(カルテ50号: 国士が視野から消えていた)
      const partner = second && PLAN_LABELS[second.code] && second.code !== top.code
        ? planLabelFor(second.code, view) : '手なり';
      sentences.push(`まだ本線を一本に決めない牌姿です。${partner}と${planLabelFor(top.code, view)}の両にらみで進めます。`);
    } else {
      sentences.push(`今の本線は${planLabelFor(top.code, view)}です。`);
    }
  } else if (top) {
    sentences.push('はっきりした役の本線はまだ無い牌姿です。まずは形のテンパイを目指し、役はリーチや途中の変化で付けます。');
  }
  if (planEvaluation?.valueBiasCode === 'CHASE_VALUE') {
    sentences.push('点棒状況から、順位を上げるには打点が必要です。多少効率を落としても高い手を狙います。');
  } else if (planEvaluation?.valueBiasCode === 'PROTECT_LEAD') {
    sentences.push('リードを守る局面なので、打点より速度と安全を優先します。');
  }
  // 視野の一言 (カルテ52号 2026-09-01: 789の2/3×3色に触れなかった): 三色・一通が
  // 本線でなくても見えていれば、必要牌を添えて一言触れる(推奨がその材料を切らない限り)
  const selectedKind = candidateTile(view, selected)?.kind;
  const allPlans = evaluateHandPlans(handAllOf(view), view?.melds ?? [], coachPlanContext(view));
  const counts = toCounts(handAllOf(view));
  const vision = allPlans.find(plan =>
    (plan.code === 'SANSHOKU' || plan.code === 'ITTSU') &&
    plan.code !== top?.code && plan.weight >= 0.4);
  if (vision && Number.isInteger(selectedKind)) {
    if (vision.code === 'SANSHOKU') {
      const inBand = !isHonor(selectedKind) && selectedKind % 9 >= vision.low && selectedKind % 9 <= vision.low + 2;
      const missing = [];
      for (let suit = 0; suit < 3; suit++) {
        const absent = [0, 1, 2].filter(offset => counts[suit * 9 + vision.low + offset] === 0);
        if (absent.length === 1) missing.push(tileName(suit * 9 + vision.low + absent[0]));
      }
      // 特筆性: 「たまたま帯に2枚ずつある」は頻出で雑音(実測15%超)。帯内2枚が
      // 手の骨格(選抜ブロックのターツ)として2組以上あるときだけ口に出す
      const { chosen } = decomposeBlocks(handAllOf(view), coachPlanContext(view));
      const bandBlocks = chosen.filter(block => block.kinds.length === 2 &&
        block.kinds.every(kind => !isHonor(kind) &&
          kind % 9 >= vision.low && kind % 9 <= vision.low + 2)).length;
      if (!inBand && missing.length > 0 && bandBlocks >= 3) {
        sentences.push(`${vision.low + 1}${vision.low + 2}${vision.low + 3}の三色同順も見えています。${missing.join('・')}が入れば本線候補になるので、この形は崩さず進めます。`);
      }
    } else if (vision.code === 'ITTSU' && (isHonor(selectedKind) || Math.floor(selectedKind / 9) !== vision.suit) &&
        (vision.groups ?? []).every(group => group >= 2)) {
      // 三色と同じ特筆性基準: どこかのグループが孤立1枚のうちは口に出さない
      sentences.push(`${suitNameOf(vision.suit)}の一気通貫も見えています。伸びればそちらへ寄せる手もあります。`);
    }
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
    // 選んだ牌と同種の対案は載せない(対子の片割れを切るとき「この牌は残します」と
    // 矛盾した説明が出るのを防ぐ。2026-08-22ペルソナ検品: ドラ対子の西)
    if (tile.kind === selectedTile.kind && Boolean(tile.red) === Boolean(selectedTile.red)) continue;
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
  const valueHonorEquals = [];
  const plainHonorEquals = [];
  const honorNarrowerNames = [];
  let honorNarrowerDelta = null;
  let furitenClauseSaid = false;
  const widerLosses = [];
  let narrowerNoted = false;
  const narrowerSameSpeed = [];
  let muchNarrowerExists = false;
  const terminalEquals = [];
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
    // 字牌の対子を残して数牌を切るとき、対子の本当の価値(雀頭・安全牌)と
    // 「最終的に手放す可能性」まで言う(カルテ43号: 枚数だけの理由づけをやめる)
    if (isHonor(tile.kind) &&
        handAllOf(view).filter(item => item.kind === tile.kind).length >= 2 &&
        !valueHonor(tile, view) && selectedTile && !isHonor(selectedTile.kind)) {
      parts.push(`${name}から整理する選択も十分あります。${name}の対子は役になりませんが、雀頭候補（客風なので、雀頭にしてもピンフは成立します）と、終盤にいつでも通せる安全牌2枚を兼ねるため、先に働きの重なっている${selectedName}を切りました。手が伸びて雀頭が別に決まれば、${name}は後から手放します。`);
      continue;
    }
    if (isHonor(tile.kind) && delta >= 0 && delta <= 2) {
      // ドラの字牌を「役にならない字牌」と呼ばない(カルテ30号: ドラの北を誤説明)
      const doraKinds = (view?.public?.doraIndicators ?? []).map(item => doraFromIndicator(item.kind));
      if (doraKinds.includes(tile.kind)) {
        parts.push(`${name}はドラの字牌です。切ると1翻ぶん打点を失うため残します（安全を最優先するときだけ手放す選択があります）。`);
        continue;
      }
      // ダブ風は「1翻の芽」ではなく2翻+ポン材。一般の役牌と同じ文で過小評価しない
      if (tile.kind === view?.seatWind && tile.kind === view?.roundWind) {
        parts.push(`${name}はダブ風（場風かつ自風）です。重なれば一つの対子で2翻、ポンで速度も出るため、同じ広さなら残します。`);
        continue;
      }
      // 同格の字牌が複数あるときは1文にまとめる(東・發・中を3回繰り返さない)
      if (valueHonor(tile, view)) {
        valueHonorEquals.push(name);
      } else {
        plainHonorEquals.push(name);
      }
      continue;
    }
    // 字牌切り推奨のとき、同格の孤立1・9は「選ばれない理由」ごと言う(カルテ42号:
    // 役牌には対案文があるのに端牌には無い非対称の解消。2026-08-24ユーザー指摘)
    if (!isHonor(tile.kind) && selectedTile && isHonor(selectedTile.kind) &&
        (numOf(tile.kind) === 1 || numOf(tile.kind) === 9) &&
        delta >= 0 && delta <= 9 &&
        candidate.metrics?.shanten === selectedMetrics.shanten &&
        handAllOf(view).filter(item => item.kind === tile.kind).length === 1) {
      // ドラの端牌を気軽な「先切り候補」に挙げない(カルテ52号: ドラ9筒を無警告で提示した)
      const isDora = (coachPlanContext(view)?.doraKinds ?? []).includes(tile.kind);
      terminalEquals.push({ name, delta, isDora });
      continue;
    }
    // 序盤に字牌を残して数牌を切るのが「受け入れの広さ」由来のときは、理由を明示する
    // (2026-08-22ユーザー裁定: 数牌先切りが強い場合はその根拠をガイドに書く)
    if (isHonor(tile.kind) && delta > 2) {
      honorNarrowerNames.push(name);
      if (honorNarrowerDelta === null || delta < honorNarrowerDelta) honorNarrowerDelta = delta;
      continue;
    }
    // 受け入れが狭いだけの案は原則列挙しないが、最有力の対案1つだけは一言添える
    // (カルテ41号: 見出しが「◯より広い」と比較するのに本文に◯が出ない不整合の解消)
    if (delta > 0) {
      if (!narrowerNoted && delta <= 3 && candidate.metrics?.shanten === selectedMetrics.shanten) {
        narrowerNoted = true;
        parts.push(`${name}を切る案も互角に近いですが、受け入れが${delta}枚狭くなります。`);
      } else if (candidate.metrics?.shanten === selectedMetrics.shanten) {
        // 同速で狭いだけの案を黙って落とすと「残りは遠くなる」に誤って飲み込まれる
        // (カルテ53号 2026-09-01: 1萬・9萬切りは同速なのに説明ゼロで、7索最大の
        // 枚数根拠も言わなかった)。まとめて枚数差ごと開示する。ただし大差(13枚+、
        // 順子破壊級)は同じ束に入れると幅が壊れるので末尾の一括文へ回す
        if (delta <= 12) narrowerSameSpeed.push({ name, delta });
        else muchNarrowerExists = true;
      }
      continue;
    }
    // v12: 受け入れ同数の分かれ目はプラン価値で説明する
    const altPlan = metrics.planEvaluation;
    const selPlan = selectedMetrics.planEvaluation;
    if (delta === 0 && altPlan && selPlan && altPlan.retention - selPlan.retention > 0.2) {
      const keepPhrase = planKeepPhrase(altPlan, view);
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
      // 将来フリテン(カルテ37号): 広い案の中身が「ロンできない待ち」なら、それを名指しする
      const altFuritenPenalty = metrics.utilityAdjustments?.furitenShapePenalty ?? 0;
      const selectedFuritenPenalty = selectedMetrics.utilityAdjustments?.furitenShapePenalty ?? 0;
      const altFuritenShapes = candidate.metrics?.furitenShapes ?? [];
      if (altFuritenPenalty < selectedFuritenPenalty - 0.1 && altFuritenShapes.length > 0) {
        if (furitenClauseSaid) {
          parts.push(`${name}切りも同様に、フリテンの形が残るため見送ります。`);
          continue;
        }
        furitenClauseSaid = true;
        const shape = altFuritenShapes[0];
        const myRiverKinds = new Set((view?.public?.players?.[view?.me ?? 0]?.discards ?? [])
          .map(discard => discard.tile.kind));
        const riverWait = shape.waits.find(waitKind => myRiverKinds.has(waitKind));
        parts.push(`${name}を切る案の方が受け入れは${-delta}枚広いですが、その場合に残る${shape.kinds.map(kind => tileName(kind)).join('')}の形は、あなたが${riverWait !== undefined ? tileName(riverWait) : '待ち牌'}を既に切っているため完成してもフリテン（ロンあがりできない待ち）です。広さの中身が目減りするので、${selectedName}を選びます。`);
        continue;
      }
      const reason = dominantKeepReason(candidate, selected, name, view);
      if (reason) {
        // 同じ残留理由が並ぶときは1文へまとめる(カルテ49号: 字牌5種に同型文が5連発した)
        widerLosses.push({ name, delta: -delta, reason });
      } else {
        parts.push(`${name}を切る案の方が受け入れは${-delta}枚広く、ほぼ互角です。残す価値の合計でわずかに${selectedName}切りを取っています。`);
      }
      continue;
    }
  }
  {
    const reasonGroups = new Map();
    for (const item of widerLosses) {
      const key = item.reason.startsWith(item.name) ? item.reason.slice(item.name.length) : item.reason;
      if (!reasonGroups.has(key)) reasonGroups.set(key, []);
      reasonGroups.get(key).push(item);
    }
    for (const [key, items] of reasonGroups) {
      if (items.length === 1) {
        const item = items[0];
        parts.push(`${item.name}を切る案の方が受け入れは${item.delta}枚広いですが、${item.reason}、${selectedName}を先に切ります。`);
      } else {
        const names = items.map(item => item.name).join('・');
        const maxDelta = Math.max(...items.map(item => item.delta));
        const shared = key.replace(/^(は|の方が)/, '');
        parts.push(`${names}を切る案の方が受け入れは広いです（最大${maxDelta}枚）が、いずれも${shared}、${selectedName}を先に切ります。`);
      }
    }
  }
  if (valueHonorEquals.length === 1) {
    parts.push(`${valueHonorEquals[0]}を切る案とは互角です。${valueHonorEquals[0]}はもう1枚重なると役として使える牌なので、その芽を見て${selectedName}を先にしましたが、${valueHonorEquals[0]}から切る選択もありです。`);
  } else if (valueHonorEquals.length >= 2) {
    parts.push(`${valueHonorEquals.join('・')}を切る案ともほぼ互角です。いずれももう1枚重なると役として使える牌なので後に回しましたが、これらから切る選択もありです。`);
  }
  if (plainHonorEquals.length === 1) {
    parts.push(`${plainHonorEquals[0]}を切る案とは互角です。${plainHonorEquals[0]}は役にならない字牌で伸びもないため、${selectedName}切りとの差はほぼありません。${plainHonorEquals[0]}から切る選択もありです。`);
  } else if (plainHonorEquals.length >= 2) {
    parts.push(`${plainHonorEquals.join('・')}はいずれも役にならない字牌で、${selectedName}切りとの差はほぼありません。これらから切る選択もありです。`);
  }
  if (honorNarrowerNames.length > 0) {
    parts.push(`セオリーどおり${honorNarrowerNames.join('・')}を先に片付ける手もあります。ただ今切ると受け入れが${honorNarrowerDelta}枚狭くなるため、ここでは手の広さを優先して${selectedName}を選びました。字牌は次の巡目以降で整理できます。`);
  }
  {
    const casualTerminals = terminalEquals.filter(item => !item.isDora);
    if (casualTerminals.length > 0) {
      const names = casualTerminals.map(item => item.name).join('・');
      const maxDelta = Math.max(...casualTerminals.map(item => item.delta));
      const deltaText = maxDelta > 0 ? `受け入れが${maxDelta}枚狭くなるのと、` : '';
      parts.push(`${names}（孤立の端牌）から切る選択もあります。端牌は両面に当たりにくく後で安全牌にも使いやすい牌です。ただ${deltaText}3や7と繋がって両面に育つ芽が字牌より残るため、役にも形にもならない${selectedName}を先にしました。`);
    }
    for (const item of terminalEquals.filter(entry => entry.isDora)) {
      parts.push(`${item.name}から切る選択もありますが、${item.name}はドラです。切ると1翻ぶん打点を失うため、手放すのは形が決まってからにします。`);
    }
  }
  if (narrowerSameSpeed.length > 0) {
    const names = narrowerSameSpeed.map(item => item.name).join('・');
    const deltas = narrowerSameSpeed.map(item => item.delta);
    const low = Math.min(...deltas);
    const high = Math.max(...deltas);
    const range = low === high ? `${low}枚` : `${low}〜${high}枚`;
    parts.push(`${names}を切る案も手の速さは同じですが、受け入れが${range}狭くなります。この枚数差が${selectedName}を先に切る理由です。`);
  }
  if (slowerNames.length === 1) {
    parts.push(`${slowerNames[0]}を切る案は、${selectedName}を切るよりテンパイが遠くなるため外しています。`);
  } else if (slowerNames.length >= 2 && slowerNames.length <= 3) {
    parts.push(`${slowerNames.join('・')}を切る案は、テンパイが遠くなるため外しています。`);
  } else if (slowerNames.length > 3) {
    parts.push(muchNarrowerExists
      ? '残りの牌は、切るとテンパイが遠くなるか、受け入れが大きく狭くなるため候補から外しています。'
      : '残りの牌は、切るとテンパイが遠くなるため候補から外しています。');
  }
  return parts;
}

// 数牌切り推奨で手に字牌が残るとき、その字牌を残す根拠を返す。
// 優先度: ドラ字牌 > ダブ風 > 染め・チャンタの材料。該当なしはnull(通常の字牌なら既に切っている)。
function keptHonorReason(view, selected, action) {
  const discard = tileAt(view, action?.index);
  if (!discard || isHonor(discard.kind)) return null;
  const handAll = view?.drawn ? [...view.hand, view.drawn] : [...(view?.hand ?? [])];
  const counts = {};
  for (const tile of handAll) counts[tile.kind] = (counts[tile.kind] || 0) + 1;
  const keptLoneHonors = Object.keys(counts).map(Number)
    .filter(kind => isHonor(kind) && counts[kind] === 1);
  if (keptLoneHonors.length === 0) return null;
  const doraKinds = (view?.public?.doraIndicators ?? []).map(tile => doraFromIndicator(tile.kind));
  const doraHonor = keptLoneHonors.find(kind => doraKinds.includes(kind));
  if (doraHonor !== undefined) return { type: 'dora', kind: doraHonor };
  const doubleWind = keptLoneHonors.find(kind => kind === view?.seatWind && kind === view?.roundWind);
  if (doubleWind !== undefined) return { type: 'doubleWind', kind: doubleWind };
  // topPlans(上位2件)では3位以下のCHANTA/HONITSUを取りこぼすため、プラン全体を再計算して見る
  let plans = [];
  try {
    plans = evaluateHandPlans(handAll, view?.melds ?? [], {
      seatWind: view?.seatWind, roundWind: view?.roundWind, doraKinds,
    });
  } catch { /* プラン計算不能なら理由なし扱い */ }
  if (plans.some(plan => plan.code === 'HONITSU' && (plan.weight ?? 0) * (plan.value ?? 0) >= 0.25)) {
    return { type: 'honitsu' };
  }
  if (plans.some(plan => plan.code === 'CHANTA' && (plan.weight ?? 0) * (plan.value ?? 0) >= 0.25)) {
    return { type: 'chanta' };
  }
  // 終盤(13巡目〜)は浮き字牌を安全牌ストックとして残す(カルテ39号)
  const turnNumber = (view?.public?.players?.[view?.me ?? 0]?.discards?.length ?? 0) + 1;
  if (turnNumber >= 13) return { type: 'safetyStock' };
  return null;
}

// 見出し用の短文。パネルで最初に見える行なので「なぜ字牌を残すのか」をここで即答する
function keptHonorHeadline(reason) {
  if (!reason) return null;
  switch (reason.type) {
    case 'dora': return `ドラの${tileName(reason.kind)}を残し、浮いた数牌から整理する`;
    case 'doubleWind': return `ダブ${tileName(reason.kind)}を残し、数牌から整理する`;
    case 'honitsu': return 'ホンイツ含みで字牌を残し、他の色から整理する';
    case 'chanta': return 'チャンタ・字牌の重なりを見て、真ん中の牌から整理する';
    case 'safetyStock': return '終盤へ備え、いつでも通せる字牌を残す';
    default: return null;
  }
}

function turnExplanationParts(view, analysis) {
  const selected = analysis?.candidates?.find(item => item.candidateId === analysis.selected?.candidateId);
  const action = analysis?.selected?.action;
  const factors = new Set((analysis?.decisiveFactors ?? []).map(factor => factor.code));
  const metrics = selected?.metrics ?? {};
  const context = publicContext(view);
  const phaseFact = (analysis?.facts ?? []).find(fact => fact.code === 'ROUND_PHASE');
  // 脅威がリーチでなく満貫級の副露のときは、文中の主語を差し替える(v90)
  const threatReadFact = (analysis?.facts ?? []).find(fact => fact.code === 'THREAT_READ');
  const openOnlyThreat = threatReadFact?.read?.worst?.open === true;
  const threatNoun = openOnlyThreat ? '満貫級が見えている副露の相手' : '相手のリーチ';
  const sentences = [];

  if (action?.action === 'tsumo') {
    sentences.push('今はあがれる形です。点棒と順位の条件を見ても、ここで終わらせるのが自然です。');
  } else if (action?.action === 'ankan') {
    sentences.push(`${Number.isInteger(action.kind) ? tileName(action.kind) : 'この牌'}の暗カンを勧めます。手の向聴も受け入れも狭めずに、ドラ表示が1枚増えて符も上がるため、得の方が大きいカンです。`);
  } else if (action?.action === 'discard') {
    if (action.riichi && metrics?.riichiEvaluation?.suppressionDeclare) {
      sentences.push('この牌を切ってリーチします。待ちは薄めですが、相手の河にテンパイへ近づく気配があります。リーチには相手の手を止めて降ろす効果もあるので、ここは宣言して主導権を取ります。');
    } else if (action.riichi) sentences.push('この牌を切ると、待ちを残したままリーチできます。');
    // リーチ保留 (カルテ26号): 「切る牌」と「リーチするか」は別の判断として説明する
    const riichiInfo = metrics?.riichiEvaluation;
    // フリテンリーチ禁止(v90): 待ちが自分の河にあるテンパイはダマの理由を明言する
    if (!action.riichi && riichiInfo?.furiten && metrics.shanten === 0) {
      const furitenWaitNames = (riichiInfo.waitKinds ?? []).map(kind => tileName(kind)).join('・');
      sentences.push(`テンパイですが、待ちの${furitenWaitNames}はあなたが既に切っているためフリテンで、ロンあがりできません。ツモ専用に手を固定するリーチは打たず、ダマでツモか待ち替わりを狙います。`);
    }
    if (!action.riichi && riichiInfo?.holdBack) {
      const hold = riichiInfo.hold ?? {};
      const growth = [];
      if ((hold.tanyaoKinds?.length ?? 0) > 0) {
        growth.push(`${hold.tanyaoKinds.map(kind => tileName(kind)).join('・')}を引けばタンヤオが付いてダマでもあがれる形になります`);
      }
      if ((hold.widenKinds?.length ?? 0) > 0) {
        growth.push(`${hold.widenKinds.map(kind => tileName(kind)).join('・')}で待ちが広い形に育ちます`);
      }
      let sentence = `テンパイですが、リーチはまだ打ちません。今の待ちは残り${riichiInfo.physicalRemaining}枚と薄く、${growth.length > 0 ? growth.join('。また、') + '。' : ''}`;
      if (hold.pressure) {
        sentence += 'テンパイの気配がある相手もいて、リーチで手を固定すると降りられなくなります。';
      }
      sentence += '今は役が無いためロンはできませんが、形の成長を待つ判断です（効率モードなら即リーチします）。';
      sentences.push(sentence);
    }
    const honor = selectedHonorContext(view, action);
    const selectedPlanNotes = selected?.metrics?.planEvaluation?.notes ?? [];
    if (honor && honor.value && honor.copies === 1 && selectedPlanNotes.includes('LONE_YAKUHAI_EARLY_CUT')) {
      // 自走triage 2026-08-31: 「タンヤオ・ピンフ系」固定文がピンフ系/手なりの手でも
      // 出ていた(定型文病)。実プランのラベルで言い、「序盤のうちに」も巡目で言い分ける
      const topPlan = selected?.metrics?.planEvaluation?.topPlans?.[0];
      const strongPlan = topPlan && PLAN_LABELS[topPlan.code] &&
        (topPlan.weight ?? 0) * (topPlan.value ?? 0) >= 0.45;
      const planLabelText = strongPlan ? planLabelFor(topPlan.code, view) : '';
      const planPhrase = strongPlan && !planLabelText.startsWith('手なり')
        ? `${planLabelText}を狙う方が本線なので`
        : '手なりでテンパイへ進む方が価値が高いので';
      const timing = (view?.public?.remaining ?? 0) >= 45 ? '序盤のうちに切ります' : 'ここで手放します';
      sentences.push(`${tileName(honor.tile.kind)}は${honor.labels.join('・')}ですが1枚だけです。重なりを待って安手を拾うより、${planPhrase}、${timing}。`);
    } else if (honor && !honor.value && honor.copies === 1) {
      // 自走triage 2026-08-31: 強ホンイツ本線の手で「数牌のつながりを残すため」は矛盾
      // (字牌はホンイツ材料)。染め本線では「材料の中で最も軽い1枚の整理」と言う
      const topPlanForHonor = selected?.metrics?.planEvaluation?.topPlans?.[0];
      if (topPlanForHonor?.code === 'HONITSU' && (topPlanForHonor.weight ?? 0) >= 0.8) {
        sentences.push(`${tileName(honor.tile.kind)}はホンイツの材料ではありますが、1枚だけで役にもならず、重なりの見込みも薄い牌です。材料の中で最も軽いこの牌から整理します。`);
      } else {
        // 場に切れている字牌はその事実も理由として言う(カルテ56号: 1枚切れの南)
        const cutCount = (view?.public?.players ?? []).reduce((sum, player) =>
          sum + (player?.discards ?? []).filter(discard => discard.tile?.kind === honor.tile.kind).length, 0);
        const loneText = cutCount >= 1
          ? `1枚だけの上に場へ${cutCount}枚出ていて、重なりの期待も薄い牌です`
          : '1枚だけなので';
        sentences.push(`${tileName(honor.tile.kind)}は${honor.labels.length ? `${honor.labels.join('・')}ではなく、` : ''}今の場では役になる牌ではありません。${loneText}${cutCount >= 1 ? '。' : '、'}数牌のつながりを残すため先に切ります。`);
      }
    } else if (honor && honor.value && honor.copies === 1) {
      sentences.push(`${tileName(honor.tile.kind)}は${honor.labels.join('・')}なので、もう1枚重なれば役になります。ただし、今の手を進めるほうが有利なら、その可能性を手放して切ることもあります。`);
    }
    // 数牌を切って字牌を残すとき、残す理由が対案説明に出ない形(ドラ/ダブ風が対案に
    // 並ばないケース)でも詳細に一言残す。対案側に同じ説明があるときは重複させない。
    if (!honor) {
      const keepReason = keptHonorReason(view, selected, action);
      if (keepReason?.type === 'honitsu') {
        sentences.push('字牌はホンイツの材料として残し、まず他の色の中張牌から整理します。');
      } else if (keepReason?.type === 'chanta') {
        sentences.push('手がバラバラなので、チャンタや字牌の重なりに寄せる前提で、真ん中の数牌から先に整理します。');
      } else if (keepReason?.type === 'safetyStock') {
        sentences.push('浮いた字牌は終盤の安全牌ストックとして手に残します。誰かのリーチが来たとき、いつでも通せる1枚が逃げ道になります。');
      }
    }
    if (factors.has('LEAD_PROTECT_FOLD')) {
      const leadFact = (analysis?.decisiveFactors ?? []).find(factor => factor.code === 'LEAD_PROTECT_FOLD');
      const styleVoice = analysis?.profile === 'attack'
        ? '攻め思考でも、既に持っている1位はそのまま勝ち切るのが1位狙いです。'
        : analysis?.profile === 'defense'
          ? '守り思考の真骨頂です。'
          : '';
      sentences.push(`${Math.round((leadFact?.lead ?? 0) / 100) * 100}点の大きなリードがあり、この安い手で押しても得るものがありません。${styleVoice}テンパイを捨ててでも安全第一で、この局は流しにいきます。`);
    } else if (factors.has('CHEAP_TENPAI_FOLD')) {
      // カルテ51号: 安手テンパイはテンパイでも降りる(ユーザー裁定「親リーチに南のみで
      // 突っ張るのは守りではない」)。見返りと想定失点を数字で対比して言う
      const foldFact = (analysis?.decisiveFactors ?? []).find(factor => factor.code === 'CHEAP_TENPAI_FOLD');
      const gain = (foldFact?.value ?? 0) + (foldFact?.pot ?? 0);
      const loss = foldFact?.expectedLoss;
      const styleVoice = analysis?.profile === 'defense' ? '守り思考の真骨頂です。' : '';
      sentences.push(`テンパイですが、この手の見返りは${gain}点ほどで、${threatNoun}に無筋を押して${loss ? `${loss}点級の` : ''}放銃と引き換えにする価値がありません。${styleVoice}テンパイに未練を残さず、安全な牌から切って守ります。`);
    } else if (factors.has('MAWASHI_SAFE_ADVANCE')) {
      // 選んだ牌に安全根拠が無いのに「通っている牌で回す」と言わない(2026-08-22ペルソナ検品)
      const mawashiTile = tileAt(view, action.index);
      const hasSafetyEvidence = safetyReasonSentences(view, metrics, mawashiTile).length > 0 ||
        (metrics.safety?.maxRisk ?? 1) === 0;
      const attackVoice = analysis?.profile === 'attack' ? '攻め思考でも、この手は押す見返りが足りません。' : '';
      if (hasSafetyEvidence) {
        sentences.push(`${attackVoice}${threatNoun}に対して、無筋を切ってまで最速を追う見返りが小さい形です。通っている牌や危険の低い牌で手を回し、テンパイの芽は残します。`);
      } else {
        sentences.push(`${attackVoice}${threatNoun}に対して完全に通る牌がない手です。最速は追わず、持っている中では危険度が低めの牌で回して、テンパイの芽は残します。`);
      }
    } else if (factors.has('EARLY_EFFICIENCY_PRIORITY')) {
      sentences.push('まだ序盤なので、今は手を広く残します。次のツモで組み合わせが増える余地を優先します。');
    } else if (factors.has('EFFICIENCY_EDGE')) {
      sentences.push('同じくらいの形の中で、次に引いて手が進む道が少し広い牌を残します。');
    } else if (factors.has('KNOWN_VALUE_PRESERVED')) {
      sentences.push('受け入れだけでなく、見えているドラや赤牌を残せることも考えています。');
    } else if (factors.has('SUIT_PRESSURE_AVOIDED')) {
      sentences.push('相手の捨て牌が一色に寄って見えるので、その色の牌を不用意に切らないようにします。');
    } else if (factors.has('RIICHI_COMMON_GENBUTSU')) {
      sentences.push(`${threatNoun}に対して完全に通っている牌があります。ここは無理をせず、現物から切って安全に進めます。`);
    } else if (factors.has('LEAST_RISK_NON_GENBUTSU') || factors.has('RIICHI_SAFE_TILE')) {
      sentences.push(`${openOnlyThreat ? '満貫級が見えている副露の相手がいるので' : '相手にリーチがあるので'}、完全な安全牌ではなくても、公開情報から比べて危険度が低い牌を選びます。`);
    } else {
      // 選んだ牌が「完成面子の余りコピー」なら、汎用文でなく重複の事実で言う
      // (カルテ53号: 678索完成済みの余り7索を切る理由が伝わらなかった)
      const spareInfo = (() => {
        const tile = tileAt(view, action.index);
        if (!tile || isHonor(tile.kind)) return null;
        const handAll = handAllOf(view);
        const copies = handAll.filter(item => item.kind === tile.kind).length;
        if (copies < 2) return null;
        const { chosen } = decomposeBlocks(handAll, coachPlanContext(view));
        const run = chosen.find(block => block.type === 'run' && block.kinds.includes(tile.kind));
        if (!run) return null;
        const used = chosen.reduce((sum, block) =>
          sum + block.kinds.filter(kind => kind === tile.kind).length, 0);
        return copies > used ? { run } : null;
      })();
      if (spareInfo) {
        const runName = spareInfo.run.kinds.map(kind => tileName(kind)).join('');
        const cutName = tileName(tileAt(view, action.index).kind);
        sentences.push(`${runName}がすでに完成しているので、余った${cutName}は同じ場所の仕事しかありません。切っても形は崩れず、手の幅が最も残ります。`);
      } else {
        sentences.push('この牌を切っても、手の中の組み合わせを崩しすぎず、次のツモで前に進めます。');
      }
    }
    // 読みの言語化 (2026-08-22ユーザー設計): 相手の高さを証拠つきで見積もり、
    // 「あがられたときの傷の深さ」「押す見返り」まで一続きで説明する
    const threatRead = (analysis?.facts ?? []).find(fact => fact.code === 'THREAT_READ');
    if (threatRead?.read) {
      const relativeNames = ['あなた', '下家', '対面', '上家'];
      const labels = [0, 1, 2, 3].map(seat => relativeNames[(seat - (view?.me ?? 0) + 4) % 4]);
      const readText = describeThreatRead(threatRead.read, labels);
      if (readText) sentences.push(readText);
      const cushionText = describeCushion(threatRead.cushion, threatRead.read);
      const gainEV = threatRead.prospect?.gainEV ?? 0;
      const ratio = gainEV / Math.max(1, threatRead.read.expectedLoss);
      const prospectText = ratio >= 0.45 ? 'こちらの手にも押す見返りが十分あります。'
        : ratio >= 0.2 ? 'こちらの見返りは中くらいです。'
        : 'こちらの手は見返りが小さい形です。';
      if (cushionText) sentences.push(cushionText + prospectText);
    }
    // 打点対比 (カルテ21号): 読みが無いときの後詰め(通常はTHREAT_READが言う)
    {
      const contrast = threatRead ? null : (analysis?.facts ?? []).find(fact => fact.code === 'THREAT_VALUE_CONTRAST');
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
    // 将来フリテンの正直な開示(カルテ37号): 選んだ打牌が残す形がフリテン予備軍なら言う
    if ((selected?.metrics?.furitenShapes?.length ?? 0) > 0) {
      const shape = selected.metrics.furitenShapes[0];
      const myRiverKinds = new Set((view?.public?.players?.[view?.me ?? 0]?.discards ?? [])
        .map(discard => discard.tile.kind));
      const riverWait = shape.waits.find(waitKind => myRiverKinds.has(waitKind));
      sentences.push(`残す${shape.kinds.map(kind => tileName(kind)).join('')}の形は、あなたが${riverWait !== undefined ? tileName(riverWait) : '待ち牌'}を切っているため完成するとフリテンです。ロンはできず、あがりはツモ限定になります。`);
    }
    // 次の一手問題の解説調(2026-08-19指定): テンパイ間近だけ短く言い、
    // 枚数の列挙(引いて嬉しい牌・受け入れ合計)や局面の定型おさらいは書かない
    if (metrics.shanten === 0) sentences.push('この一打でテンパイです。');
    else if (metrics.shanten === 1) sentences.push('テンパイまであと一歩の形です。');
  }
  const comparisons = action?.action === 'discard' ? comparisonParts(view, analysis) : [];
  let planHead = action?.action === 'discard' ? planHeadlineSentences(selected, view) : [];
  // 字牌をチャンタ/ホンイツ見合いで残す判断のときは、「本線はタンヤオ・ピンフ」と
  // 矛盾しないよう本線文を両にらみ表現へ差し替える(2026-08-22 実戦検品)
  if (action?.action === 'discard') {
    const keepReason = keptHonorReason(view, selected, action);
    if (keepReason?.type === 'chanta' || keepReason?.type === 'honitsu') {
      const label = keepReason.type === 'chanta' ? 'チャンタ・字牌の重なり' : 'ホンイツ';
      planHead = planHead.map(sentence => sentence.startsWith('今の本線は')
        ? `まだ本線を一本に決めない牌姿です。手なりと${label}の両にらみで進めます。`
        : sentence);
    }
    // 降り・回し(現物)を選んだ手番で「高い手を狙います」と言わない(2026-08-22ペルソナ検品)
    if (factors.has('FOLD_ON_RIICHI_THREAT') || factors.has('LEAD_PROTECT_FOLD') ||
        factors.has('RIICHI_COMMON_GENBUTSU')) {
      planHead = planHead.map(sentence => sentence.includes('多少効率を落としても高い手を狙います')
        ? '本当は打点が欲しい点棒状況ですが、今は当たる危険が上回るため、守りを優先します。'
        : sentence);
    }
  }
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
    // 死にテンパイ (カルテ29号): 鳴けばテンパイでも待ちが生きていないならそれが理由
    if (passMetrics.deadWait) {
      const dead = passMetrics.deadWait;
      const waitNames = (dead.waitKinds ?? []).map(kind => tileName(kind)).join('・');
      return [
        `スルー（鳴かない）を勧めます。${claimedName}を鳴けばテンパイに届きますが、その待ち（${waitNames}）は見えている範囲で残り${dead.live}枚しか生きていません。`,
        'ほぼあがれない形に手を固定するより、スルーして手の変化を待ちます。',
      ];
    }
    // 門前尊重 (カルテ47号): 役の当てはあるが、序盤の門前は鳴かずリーチの道を残す
    if (passMetrics.menzenKeep) {
      const keep = passMetrics.menzenKeep;
      return [
        `スルー（鳴かない）を勧めます。${claimedName}を鳴けば${shantenLabel(keep.shantenNow)}から${shantenLabel(keep.claimShanten)}へ速くなるのは見えています。`,
        'ただ、まだ序盤で手は門前のまま。ここで鳴くとリーチ・一発・裏ドラの道が丸ごと消え、安くて守りにくい手になります。自分のツモで進めて、リーチできる形を目指します。',
      ];
    }
    const improves = Number.isInteger(passMetrics.bestClaimShanten) &&
      Number.isInteger(passMetrics.shantenBefore) &&
      passMetrics.bestClaimShanten < passMetrics.shantenBefore;
    const speedText = passMetrics.bestClaimShanten === 0
      ? `${claimedName}を鳴けばテンパイに届くのは見えています。`
      : `${claimedName}を鳴けば${shantenLabel(passMetrics.shantenBefore)}から${shantenLabel(passMetrics.bestClaimShanten)}へ速くなるのは見えています。`;
    const parts = improves
      ? [`スルー（鳴かない）を勧めます。${speedText}ただ、この手はタンヤオ圏でも役牌バック（役牌の対子持ち）でもホンイツ圏でもないため、鳴くと役の当てが薄く、安手か役無しになりがちです。`]
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
  if (reason === 'CALL_FLUSH_SPEED') {
    const label = action.action === 'pon' ? 'ポン' : 'チー';
    const selMetrics = (analysis?.candidates ?? []).find(candidate =>
      candidate.candidateId === analysis?.selected?.candidateId)?.metrics ?? {};
    return [
      `${label}を勧めます。この手は一色に染まっていて、鳴いても混一色（ホンイツ）が確定しています。${shantenLabel(selMetrics.shantenBefore)}から${shantenLabel(selMetrics.shantenAfter)}へ速くなります。`,
    ];
  }
  if (reason === 'SPIRITUAL_LUCK_STEAL') {
    const label = action.action === 'pon' ? 'ポン' : action.action === 'chi' ? 'チー' : 'カン';
    return [
      `${label}を勧めます。役があるかどうかは関係ありません。ツイている上位の捨て牌には運が乗っています。鳴いてツキを吸い取りましょう。`,
    ];
  }
  if (reason === 'FORMAL_TENPAI_ROUTE') {
    const label = action.action === 'pon' ? 'ポン' : 'チー';
    const selMetrics = (analysis?.candidates ?? []).find(candidate =>
      candidate.candidateId === analysis?.selected?.candidateId)?.metrics ?? {};
    return [
      `${label}を勧めます。この手はもう役を付けにくく、目標は流局時のテンパイ料です。鳴いて形のテンパイへ近づけます（${shantenLabel(selMetrics.shantenBefore)}→${shantenLabel(selMetrics.shantenAfter)}）。`,
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
    // どの組でチーするかを見出しで名指しする(カルテ55号 2026-09-01 ユーザー指摘
    // 「チーって言われても、どれだよ」: 候補3組並びで指し先が無かった)
    if (action?.action === 'chi') {
      const tiles = (action.tiles ?? []).map(kind => tileName(kind)).join('');
      return tiles ? `${tiles}とのチーで形を一歩進める` : 'チーで形を一歩進める';
    }
    if (action?.action === 'minkan' || action?.action === 'kakan') return 'カンを選ぶ';
    if (!action) return offer?.type === 'ron' ? '順位優先でロンを見送る' : 'スルー推奨: 門前を守る';
    return '鳴くことで手を進める理由がある';
  }
  if (action?.action === 'tsumo') return 'ここはツモあがり';
  if (action?.action === 'discard') {
    const honor = selectedHonorContext(view, action);
    if (honor && !honor.value && honor.copies === 1) return '役にならない字牌を先に切る';
    if (honor && honor.value && honor.copies === 1) return '重なり待ちの役牌より、手の伸びを取る';
    if (factors.has('LEAD_PROTECT_FOLD')) return 'リードを守るため、安全牌で締める';
    if (factors.has('FOLD_ON_RIICHI_THREAT') || factors.has('RIICHI_LEAST_RISK_NON_GENBUTSU') || factors.has('RIICHI_COMMON_GENBUTSU')) {
      const readFact = (analysis?.facts ?? []).find(fact => fact.code === 'THREAT_READ');
      if (readFact?.read?.worst?.open === true) return '満貫級が見える副露を警戒して危険度を下げる';
      return 'リーチ者への危険度を下げる';
    }
    if (factors.has('SUIT_PRESSURE_AVOIDED')) return '相手の色に合わせて危険牌を避ける';
    {
      // 数牌切りで字牌が残る判断は、残す根拠(ドラ/ダブ風/染め/チャンタ)を見出しで即答する
      const selectedCandidate = (analysis?.candidates ?? []).find(candidate =>
        candidate.candidateId === analysis?.selected?.candidateId);
      const keepHeadline = keptHonorHeadline(keptHonorReason(view, selectedCandidate, action));
      if (keepHeadline) return keepHeadline;
    }
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

// decision-presenter.js — 判断評価をDOM非依存の日本語表示モデルへ変換する。
//
// ここでは評価・採点を行わない。DecisionAnalysis / DecisionRecord に実在する
// 値だけを文章化し、UIは返された文字列を textContent として表示する。

import { tileName } from '../engine/tiles.js';

const PROFILE_META = Object.freeze({
  guardian: Object.freeze({
    label: '守備派', name: '半蔵', role: '守備と順位', lead: '俺の見立てでは',
  }),
  analyst: Object.freeze({
    label: '分析派', name: 'ジョー', role: '牌効率と比較', lead: '結論から言うと',
  }),
  striker: Object.freeze({
    label: '攻撃派', name: 'ひめ子', role: '攻め筋', lead: 'あたしならね',
  }),
});

const ACTION_LABELS = Object.freeze({
  tsumo: 'ツモ',
  ron: 'ロン',
  pon: 'ポン',
  minkan: '大明槓',
  ankan: '暗槓',
  kakan: '加槓',
  kyuushu: '九種九牌',
  pass: '見送り',
});

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// textContent 前提でも、制御文字とタグに見える区切りは表示モデルへ残さない。
function plainText(value, fallback = '', maxLength = 160) {
  if (value === null || value === undefined) return fallback;
  const normalized = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/</g, '＜')
    .replace(/>/g, '＞')
    .replace(/&/g, '＆')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function validTile(value) {
  return value && Number.isInteger(value.kind) && value.kind >= 0 && value.kind <= 33;
}

function tileLabel(tile) {
  return validTile(tile) ? tileName(tile.kind, tile.red === true) : null;
}

function profileMeta(profile) {
  return PROFILE_META[profile] ?? PROFILE_META.analyst;
}

function selectedEvaluationCandidate(analysis) {
  if (!analysis || !Array.isArray(analysis.candidates)) return null;
  const selectedId = analysis.selected?.candidateId;
  return analysis.candidates.find(candidate => candidate?.candidateId === selectedId) ?? null;
}

function selectedRecordCandidate(record) {
  if (!record || !Array.isArray(record.availableCandidates)) return null;
  return record.availableCandidates.find(candidate =>
    candidate?.actionId === record.chosen?.actionId) ?? null;
}

function contextCandidate(context) {
  const source = context?.record ?? context;
  return selectedRecordCandidate(source) ?? selectedEvaluationCandidate(source);
}

function actionType(action, candidate) {
  if (typeof action === 'string') return action;
  if (action && typeof action.action === 'string') return action.action;
  if (candidate && typeof candidate.action === 'string') return candidate.action;
  if (candidate?.action && typeof candidate.action.action === 'string') {
    return candidate.action.action;
  }
  if (typeof candidate?.command?.action === 'string') return candidate.command.action;
  if (action === null || candidate?.command === null) return 'pass';
  return null;
}

function actionCommand(action, candidate) {
  if (action && typeof action === 'object') {
    if (action.command && typeof action.command === 'object') return action.command;
    return action;
  }
  if (candidate?.command && typeof candidate.command === 'object') return candidate.command;
  if (candidate?.action && typeof candidate.action === 'object') return candidate.action;
  return null;
}

function tileFromIndex(index, context) {
  if (!Number.isInteger(index)) return null;
  const record = context?.record ?? context;
  const hand = record?.view?.hand;
  if (!Array.isArray(hand)) return null;
  if (index < hand.length) return hand[index] ?? null;
  if (index === hand.length) return record.view.drawn ?? null;
  return null;
}

function actionTile(action, candidate, context) {
  const command = actionCommand(action, candidate);
  const direct = [
    action?.tile,
    candidate?.tile,
    action?.tileRef,
    candidate?.tileRef,
    context?.legacyTrace?.tile,
    context?.analysis?.legacyTrace?.tile,
  ].find(validTile);
  if (direct) return direct;
  const index = command?.index ?? candidate?.index ?? candidate?.handIndexAtDecision;
  const indexed = tileFromIndex(index, context);
  if (validTile(indexed)) return indexed;
  const kind = command?.kind ?? action?.kind ?? candidate?.kind;
  return Number.isInteger(kind) ? { kind, red: false } : null;
}

function chiTileLabels(action, candidate) {
  const command = actionCommand(action, candidate);
  const tiles = [];
  for (const ref of candidate?.tileRefs ?? []) if (validTile(ref)) tiles.push(ref);
  if (tiles.length === 0) {
    for (const kind of command?.tiles ?? action?.tiles ?? candidate?.tiles ?? []) {
      if (Number.isInteger(kind)) tiles.push({ kind, red: false });
    }
  }
  const called = candidate?.calledTile ?? candidate?.calledTileRef;
  if (validTile(called)) tiles.push(called);
  return tiles
    .sort((left, right) => left.kind - right.kind || Number(left.red) - Number(right.red))
    .map(tileLabel)
    .filter(Boolean);
}

/**
 * actor command、合法候補、評価器のselected.actionのどれからでも短い和文を作る。
 */
export function formatActionLabel(action, recordOrAnalysis = null) {
  const candidate = action && typeof action === 'object' &&
    ('command' in action || 'actionId' in action || typeof action.action === 'string')
    ? action
    : contextCandidate(recordOrAnalysis);
  const type = actionType(action, candidate);
  const command = actionCommand(action, candidate);

  if (type === 'discard' || type === 'riichi') {
    const tile = actionTile(action, candidate, recordOrAnalysis);
    const label = tileLabel(tile) ?? '牌';
    const riichi = type === 'riichi' || command?.riichi === true || candidate?.riichi === true;
    return riichi ? `${label}を切ってリーチ` : `${label}を切る`;
  }
  if (type === 'chi') {
    const labels = chiTileLabels(action, candidate);
    return labels.length > 0 ? `チー（${labels.join('・')}）` : 'チー';
  }
  if (type && Object.prototype.hasOwnProperty.call(ACTION_LABELS, type)) {
    const base = ACTION_LABELS[type];
    if (type === 'ankan' || type === 'kakan' || type === 'minkan') {
      const label = tileLabel(actionTile(action, candidate, recordOrAnalysis));
      return label ? `${base}（${label}）` : base;
    }
    return base;
  }
  return '選択';
}

function shantenLabel(value) {
  if (!Number.isInteger(value)) return null;
  if (value < 0) return '和了形';
  if (value === 0) return '聴牌';
  return `${value}向聴`;
}

function scoreLabel(value) {
  const score = finite(value);
  return score === null ? '採点不能' : `${Number.isInteger(score) ? score : score.toFixed(1)}点`;
}

function reasonCodes(analysis) {
  const codes = [];
  const add = value => {
    if (typeof value !== 'string') return;
    const safe = plainText(value, '', 80);
    if (safe && !codes.includes(safe)) codes.push(safe);
  };
  for (const code of analysis?.selected?.reasonCodes ?? []) add(code);
  for (const factor of analysis?.decisiveFactors ?? []) add(factor?.code);
  for (const constraint of analysis?.hardConstraints ?? []) {
    if (constraint?.active === true) add(constraint.code);
  }
  add(analysis?.legacyTrace?.reason);
  return codes;
}

function ukeireText(metrics) {
  const total = finite(metrics?.ukeirePhysical);
  if (total === null) return null;
  const byKind = Array.isArray(metrics.ukeireByKind)
    ? metrics.ukeireByKind
      .filter(item => Number.isInteger(item?.kind) && finite(item.remaining) !== null)
      .map(item => `${tileName(item.kind)} ${item.remaining}枚`)
    : [];
  const shown = byKind.slice(0, 4);
  const remainder = byKind.length - shown.length;
  return shown.length > 0
    ? `公開情報上の受け入れは${total}枚。主な牌は${shown.join('、')}${remainder > 0 ? `、ほか${remainder}種` : ''}です。`
    : `公開情報上の受け入れは${total}枚です。`;
}

function safetyText(metrics) {
  const safety = metrics?.safety;
  if (!safety || !Array.isArray(safety.perThreat)) return null;
  const details = Array.isArray(safety.perThreatDetails) ? safety.perThreatDetails : [];
  const threats = safety.perThreat
    .filter(item => Number.isInteger(item?.seat))
    .map(item => {
      if (item.genbutsu === true) return `${item.seat + 1}番席には現物`;
      const detail = details.find(entry => entry?.seat === item.seat);
      const evidence = ['現物ではありません'];
      if (detail?.suji) evidence.push('両面筋で消える待ち筋があります');
      if (detail?.oneChance) evidence.push('ワンチャンスの形があります');
      if (detail?.noChance) evidence.push('壁で消えた順子形があります');
      if (detail?.residualWaits?.length > 0) evidence.push('単騎・双碰などは残ります');
      return `${item.seat + 1}番席には${evidence.join('。')}`;
    });
  return threats.length > 0 ? `リーチ者別では、${threats.join('。')}。` : null;
}

function analysisFactor(analysis, code) {
  return analysis?.decisiveFactors?.find?.(factor => factor?.code === code) ?? null;
}

function personaSentence(profile, choices) {
  return choices[profile] ?? choices.analyst ?? Object.values(choices)[0] ?? null;
}

function coverageSentence(analysis) {
  const coverage = analysis?.coverage;
  if (!coverage || typeof coverage !== 'object') return null;
  const unavailable = [];
  if (coverage.handValue === 'PARTIAL_KNOWN_BONUS_ONLY') unavailable.push('手役全体と最大打点');
  if (coverage.handValue === 'NOT_EVALUATED') unavailable.push('手役と打点');
  if (coverage.placementEV === 'NOT_EVALUATED') unavailable.push('順位期待値');
  if (coverage.safety === 'STRUCTURAL_NOT_CALIBRATED') unavailable.push('統計的な放銃率');
  return unavailable.length > 0
    ? `${unavailable.join('、')}はまだ計算範囲外なので、そこまでは断定しません。`
    : null;
}

function riichiText(metrics) {
  const evaluation = metrics?.riichiEvaluation;
  if (!evaluation) return null;
  const waits = Array.isArray(evaluation.waitKinds)
    ? evaluation.waitKinds.filter(Number.isInteger).map(kind => tileName(kind))
    : [];
  const remaining = finite(evaluation.physicalRemaining);
  const required = finite(evaluation.requiredMinimum);
  const pieces = [];
  if (waits.length > 0) {
    const shown = waits.slice(0, 5);
    pieces.push(`待ちは${shown.join('・')}${waits.length > shown.length ? `ほか${waits.length - shown.length}種` : ''}`);
  }
  if (remaining !== null) pieces.push(`公開情報上の残りは${remaining}枚`);
  if (required !== null) pieces.push(`リーチ基準は${required}枚以上`);
  return pieces.length > 0 ? `${pieces.join('、')}です。` : null;
}

function reasonSentences(analysis, candidate, profile = analysis?.profile ?? 'analyst') {
  const metrics = candidate?.metrics ?? {};
  const priority = new Map([
    ['LAST_PLACE_LOCK_FORBIDDEN', 0], ['FORBIDDEN_WIN_THEN_TSUMOGIRI', 0],
    ['RIICHI_COMMON_GENBUTSU', 1], ['RIICHI_LEAST_RISK_NON_GENBUTSU', 1],
    ['FOLD_ON_RIICHI_THREAT', 1], ['SUIT_PRESSURE_AVOIDED', 2],
    ['KNOWN_VALUE_PRESERVED', 2], ['EARLY_EFFICIENCY_PRIORITY', 3],
    ['EFFICIENCY_EDGE', 3], ['SHANTEN_UKEIRE', 9],
  ]);
  const codes = reasonCodes(analysis)
    .map((code, index) => ({ code, index }))
    .sort((left, right) =>
      (priority.get(left.code) ?? 5) - (priority.get(right.code) ?? 5) || left.index - right.index)
    .map(item => item.code);
  const sentences = [];
  const add = sentence => {
    if (sentence && !sentences.includes(sentence)) sentences.push(sentence);
  };

  for (const code of codes) {
    switch (code) {
      case 'SHANTEN_UKEIRE': {
        const state = shantenLabel(metrics.shanten);
        const phase = metrics.phase?.code;
        const turn = finite(metrics.phase?.turnNumber);
        const timing = phase === 'EARLY'
          ? (turn === null ? 'まだ序盤' : `まだ${turn}巡目`)
          : phase === 'MIDDLE' ? '中盤に入ったところ' : phase === 'LATE' ? 'もう終盤' : 'この局面';
        add(personaSentence(profile, {
          guardian: `${timing}だ。形を早く決めすぎず、次に伸びる道を残しておく${state ? `。この打牌なら${state}で進められる` : ''}。`,
          analyst: `${timing}なので、形を固定せず次の選択肢を多く残します${state ? `。この打牌後は${state}です` : ''}。`,
          striker: `${timing}！　今は形を決めすぎず、伸びる道を多く残すよ${state ? `。これで${state}` : ''}。`,
        }));
        add(riichiText(metrics));
        break;
      }
      case 'RIICHI_COMMON_GENBUTSU':
        add(personaSentence(profile, {
          guardian: '……ここは退く。リーチ者全員に通る現物を切る。',
          analyst: '守備へ切り替え、リーチ者全員の現物を選びます。',
          striker: 'ここは無理押ししない！　全員に通る現物で一巡見るよ。',
        }));
        add(safetyText(metrics));
        break;
      case 'RIICHI_LEAST_RISK_NON_GENBUTSU':
        add(personaSentence(profile, {
          guardian: '現物はない。安全牌とは呼べないが、公開情報から比べた構造上の危険指標が最も低い牌を選ぶ。',
          analyst: '現物がないため、各リーチ者に残る待ち形を比較し、相対的に危険要素が少ない牌を選びます。',
          striker: '安全牌はないね。だったら「安全」と決めつけず、一番ましな牌を選ぶよ。',
        }));
        add(safetyText(metrics));
        break;
      case 'RIICHI_SAFE_TILE':
        // 旧牌譜との互換表示。非現物を「安全」「放銃回避」と断定しない。
        add('リーチ者ごとに、確認できる危険要素を比較します。');
        add(safetyText(metrics));
        break;
      case 'FOLD_ON_RIICHI_THREAT': {
        const factor = analysisFactor(analysis, code);
        const current = finite(factor?.currentShanten);
        add(personaSentence(profile, {
          guardian: current === null
            ? 'リーチを受けた。ここは手を進めるより守備を優先する。'
            : `リーチを受け、こちらは${shantenLabel(current)}。ここは守備を優先する。`,
          analyst: current === null
            ? 'リーチへの押し引きを比較し、今回は守備を選びます。'
            : `リーチに対して現在${shantenLabel(current)}なので、今回は守備へ切り替えます。`,
          striker: current === null
            ? '勝負どころじゃない。ここはちゃんと降りるよ。'
            : `まだ${shantenLabel(current)}。ここで無理押しはしないよ。`,
        }));
        break;
      }
      case 'EARLY_EFFICIENCY_PRIORITY': {
        const factor = analysisFactor(analysis, code);
        const turn = finite(factor?.turnNumber);
        const delta = finite(factor?.delta);
        const prefix = turn === null ? 'まだ序盤' : `まだ${turn}巡目`;
        add(personaSentence(profile, {
          guardian: `${prefix}だ。今回は守備へ切り替えず、今は手を狭めない。`,
          analyst: `${prefix}。比較候補より受け入れが${delta === null ? '広い' : `${delta}枚多い`}ため、速度を優先します。`,
          striker: `${prefix}！　ここは手広く、先に聴牌を取りにいくよ。`,
        }));
        break;
      }
      case 'EFFICIENCY_EDGE': {
        const factor = analysisFactor(analysis, code);
        const delta = finite(factor?.delta);
        add(personaSentence(profile, {
          guardian: '今回は守備へ切り替えず、形を崩さず手を進める。',
          analyst: delta === null
            ? '同じ向聴数なら、受け入れの広い方を選びます。'
            : `同じ向聴数で受け入れが${delta}枚多いため、こちらを選びます。`,
          striker: '今はスピード勝負！　受けの広い方で前へ出るよ。',
        }));
        break;
      }
      case 'SUIT_PRESSURE_AVOIDED': {
        const factor = analysisFactor(analysis, code);
        const signal = factor?.signals?.[0];
        const suit = ['萬子', '筒子', '索子'][signal?.suit] ?? '同色牌';
        const seat = Number.isInteger(signal?.seat) ? `${signal.seat + 1}番席` : '相手';
        const evidence = signal?.evidence;
        const guardianEvidence = finite(evidence?.sameSuitMelds) >= 2
          ? `${seat}は${suit}の副露を${evidence.sameSuitMelds}組見せている。`
          : finite(evidence?.offSuitDiscards) >= 4
            ? `${seat}の副露は${suit}で、河には他色の数牌が${evidence.offSuitDiscards}枚ある。`
            : `${seat}には${suit}の染め手を疑う公開材料がある。`;
        add(personaSentence(profile, {
          guardian: `${guardianEvidence}染め手の可能性を見て、${suit}は不用意に放さない。`,
          analyst: `${seat}には${suit}の染め手シグナルがあります。推定なので断定はせず、受け入れ差と合わせて${suit}を残します。`,
          striker: `${seat}、${suit}を集めてる気配があるね。今はそこを雑に切らないよ。`,
        }));
        break;
      }
      case 'KNOWN_VALUE_PRESERVED':
        add(personaSentence(profile, {
          guardian: '確認できるドラは残す。手役全体の上限までは決めつけない。',
          analyst: '受け入れ差より、公開情報で確認できるドラ保持を優先します。最大打点は未計算です。',
          striker: '見えてる打点の種は残すよ！　ただし、高目が確定したとは言わない。',
        }));
        break;
      case 'LEGAL_WIN':
        add('順位条件に反しない合法な和了を選びます。');
        break;
      case 'LAST_PLACE_LOCK_FORBIDDEN':
        add('対局終了時の4位が確定する和了を避け、順位を上げる余地を残します。');
        break;
      case 'FORBIDDEN_WIN_THEN_TSUMOGIRI':
        add('4位確定の和了を見送り、リーチ後のツモ牌をそのまま切ります。');
        break;
      case 'RIICHI_TSUMOGIRI':
        add('リーチ後なので、ツモ牌をそのまま切ります。');
        break;
      case 'KYUUSHU_KYUUHAI':
        add('九種九牌を宣言できるため、途中流局を選びます。');
        break;
      case 'SHANTEN_NOT_WORSE': {
        const before = shantenLabel(metrics.beforeShanten);
        const after = shantenLabel(metrics.afterShanten);
        add(before && after
          ? `槓の前後で${before}から${after}となり、向聴数は悪化しません。`
          : '向聴数を悪化させない槓です。');
        break;
      }
      case 'YAKUHAI_PON': {
        const label = Number.isInteger(metrics.kind) ? tileName(metrics.kind) : '役牌';
        add(`${label}を鳴いて役を確保します。`);
        break;
      }
      case 'TOITOI_ROUTE': {
        const pairs = finite(metrics.pairs);
        add(pairs === null
          ? '対々和へ進める牌形としてポンします。'
          : `対子が${pairs}組あり、対々和への進行を選びます。`);
        break;
      }
      case 'KEEP_CLOSED':
        add('この鳴きは見送り、今の形を維持します。');
        break;
      case 'BASELINE_KAKAN_NOT_EVALUATED':
        add('現在の評価基準では、加槓の価値を未評価です。');
        break;
      case 'BASELINE_MINKAN_NOT_EVALUATED':
        add('現在の評価基準では、大明槓の価値を未評価です。');
        break;
      case 'BASELINE_CHI_NOT_EVALUATED':
        add('現在の評価基準では、チーの価値を未評価です。');
        break;
      default:
        break;
    }
  }
  if (sentences.length === 0) add('記録された候補から、この選択を採用します。');
  return sentences;
}

function detailRows(analysis, candidate) {
  const metrics = candidate?.metrics ?? {};
  const details = [];
  const add = (key, label, value) => {
    if (value !== null && value !== undefined && value !== '') {
      details.push({ key, label, value: plainText(value, '—', 240) });
    }
  };
  add('shanten', '打牌後', shantenLabel(metrics.shanten));
  if (finite(metrics.ukeirePhysical) !== null) {
    add('ukeire', '受け入れ', `${metrics.ukeirePhysical}枚`);
  }
  const byKind = Array.isArray(metrics.ukeireByKind)
    ? metrics.ukeireByKind
      .filter(item => Number.isInteger(item?.kind) && finite(item.remaining) !== null)
      .map(item => `${tileName(item.kind)} ${item.remaining}枚`)
      .join('、')
    : '';
  add('ukeireKinds', '受け入れ牌', byKind);
  if (finite(metrics.utilityAdjustment) !== null && metrics.utilityAdjustment !== 0) {
    add('utilityAdjustment', '評価補正', String(metrics.utilityAdjustment));
  }
  const safety = safetyText(metrics);
  add('safety', '対リーチ', safety?.replace(/。$/, ''));
  const riichi = riichiText(metrics);
  add('riichi', 'リーチ判断', riichi?.replace(/。$/, ''));
  const activeConstraint = analysis?.hardConstraints?.find(constraint => constraint?.active === true);
  if (activeConstraint?.code === 'LAST_PLACE_LOCK_FORBIDDEN') {
    add('constraint', '順位制約', '4位確定和了を禁止');
  }
  return details;
}

function unavailableThought(name, profile) {
  const meta = profileMeta(profile);
  return deepFreeze({
    type: 'thought',
    available: false,
    status: 'unavailable',
    profile: PROFILE_META[profile] ? profile : 'analyst',
    profileLabel: meta.label,
    speaker: plainText(name, meta.label, 40),
    eyebrow: '思考公開',
    actionLabel: '判断待ち',
    headline: '判断データを待っています',
    body: '公開できる判断理由はまだありません。',
    fullBody: '公開できる判断理由はまだありません。',
    detailParagraphs: [],
    hasMore: false,
    reasonCodes: [],
    details: [],
    metrics: [],
    confidence: null,
    confidenceLabel: '',
    evaluatorVersion: '',
    completeness: null,
  });
}

/** DecisionAnalysisを思考公開ドック用の表示モデルへ変換する。 */
export function presentThought(analysis, { name, profile } = {}) {
  if (!analysis || typeof analysis !== 'object') return unavailableThought(name, profile);
  const normalizedProfile = PROFILE_META[profile]
    ? profile
    : (PROFILE_META[analysis.profile] ? analysis.profile : 'analyst');
  const meta = profileMeta(normalizedProfile);
  const candidate = selectedEvaluationCandidate(analysis);
  const action = analysis.selected?.action ?? candidate?.action ?? null;
  const actionLabel = formatActionLabel(action, analysis);
  const completeness = finite(analysis.completeness);
  const complete = completeness === 1;
  const sentences = reasonSentences(analysis, candidate, normalizedProfile);
  const coverage = coverageSentence(analysis);
  const codes = reasonCodes(analysis);
  const measuredDetail = codes.includes('SHANTEN_UKEIRE')
    ? ukeireText(candidate?.metrics)
    : null;
  const detailParagraphs = [...sentences, measuredDetail, coverage]
    .filter(Boolean)
    .map(sentence => plainText(sentence, '', 700))
    .filter(Boolean);
  const body = sentences.slice(0, 3).join('');
  const fullBody = detailParagraphs.join('\n\n');
  const details = detailRows(analysis, candidate);
  return deepFreeze({
    type: 'thought',
    available: true,
    status: complete ? 'evaluated' : 'incomplete',
    profile: normalizedProfile,
    profileLabel: meta.label,
    speaker: plainText(name, meta.label, 40),
    eyebrow: '思考公開',
    actionLabel,
    headline: complete ? `「${actionLabel}」を選びます` : '判断理由の記録が不完全です',
    body: plainText(body, '記録された範囲だけを表示します。', 600),
    fullBody: plainText(fullBody, '記録された範囲だけを表示します。', 2400),
    detailParagraphs,
    hasMore: detailParagraphs.length > 2 || fullBody.length > body.length,
    reasonCodes: codes,
    details,
    metrics: details.map(detail => `${detail.label}: ${detail.value}`),
    confidence: typeof analysis.confidence === 'string' ? plainText(analysis.confidence, '', 12) : null,
    confidenceLabel: typeof analysis.confidence === 'string'
      ? `信頼度 ${plainText(analysis.confidence, '', 12)}`
      : '',
    evaluatorVersion: plainText(analysis.evaluatorVersion, '', 80),
    completeness,
  });
}

function sameAction(left, right) {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  const leftType = left.action;
  const rightType = right.action;
  if (leftType !== rightType) return false;
  if (left.index !== undefined && left.index !== right.index) return false;
  if (left.riichi !== undefined && left.riichi !== right.riichi) return false;
  if (left.kind !== undefined && left.kind !== right.kind) return false;
  if (Array.isArray(left.tiles) || Array.isArray(right.tiles)) {
    if (JSON.stringify(left.tiles ?? []) !== JSON.stringify(right.tiles ?? [])) return false;
  }
  return true;
}

function candidateForRecommendedAction(record, evaluation, analysis) {
  if (!Array.isArray(record?.availableCandidates)) return null;
  const explicitId = evaluation?.recommendedActionId ??
    evaluation?.recommendation?.actionId ?? evaluation?.actionId;
  if (typeof explicitId === 'string') {
    const explicit = record.availableCandidates.find(candidate => candidate.actionId === explicitId);
    if (explicit) return explicit;
  }
  const selectedAction = analysis?.selected?.action;
  return record.availableCandidates.find(candidate => {
    if (selectedAction === null) return candidate.action === 'pass' || candidate.command === null;
    const command = candidate.command ?? {
      action: candidate.action === 'riichi' ? 'discard' : candidate.action,
      ...(candidate.index !== undefined ? { index: candidate.index } : {}),
      ...(candidate.riichi !== undefined ? { riichi: candidate.riichi } : {}),
      ...(candidate.kind !== undefined ? { kind: candidate.kind } : {}),
      ...(candidate.tiles !== undefined ? { tiles: candidate.tiles } : {}),
    };
    return sameAction(selectedAction, command);
  }) ?? null;
}

function findEvaluation(evaluations, profile) {
  if (Array.isArray(evaluations)) {
    return evaluations.find(item => item?.profile === profile) ?? null;
  }
  if (!evaluations || typeof evaluations !== 'object') return null;
  return evaluations[profile] ??
    evaluations.byProfile?.[profile] ??
    evaluations.evaluations?.find?.(item => item?.profile === profile) ?? null;
}

function analysisFromEvaluation(evaluation) {
  if (!evaluation || typeof evaluation !== 'object') return null;
  if (evaluation.selected && Array.isArray(evaluation.candidates)) return evaluation;
  return evaluation.analysis ?? evaluation.decisionAnalysis ?? evaluation.recommendation?.analysis ?? null;
}

function syntheticAnalysisFromEvaluation(evaluation, recommended) {
  if (!evaluation || typeof evaluation !== 'object') return null;
  const codes = Array.isArray(evaluation.reasonCodes)
    ? evaluation.reasonCodes.filter(code => typeof code === 'string')
    : [];
  const candidateMetrics = evaluation.metrics?.recommended ?? evaluation.metrics ?? {};
  return {
    profile: evaluation.profile,
    completeness: evaluation.status === 'scored' ? 1 : null,
    coverage: evaluation.coverage ?? {
      legality: 'EXACT',
      shanten: 'EXACT',
      ukeire: 'EXACT_MIN_SHANTEN_CANDIDATES',
      handValue: 'PARTIAL_KNOWN_BONUS_ONLY',
      safety: 'STRUCTURAL_NOT_CALIBRATED',
      placementEV: 'NOT_EVALUATED',
    },
    hardConstraints: evaluation.hardConstraintViolation === true
      ? [{ code: 'LAST_PLACE_LOCK_FORBIDDEN', active: true }]
      : [],
    candidates: [{
      candidateId: 'review-recommended',
      action: recommended?.command ?? null,
      metrics: candidateMetrics,
      reasons: codes,
    }],
    selected: {
      candidateId: 'review-recommended',
      action: recommended?.command ?? null,
      reasonCodes: codes,
    },
    decisiveFactors: codes.map(code => ({ code })),
    legacyTrace: { reason: codes[0] },
  };
}

function evaluationScore(evaluation) {
  return finite(evaluation?.score ?? evaluation?.points ?? evaluation?.rating?.score);
}

function reviewReasonSentences(evaluation, profile = 'analyst') {
  if (!evaluation || typeof evaluation !== 'object') return [];
  const codes = Array.isArray(evaluation.reasonCodes) ? evaluation.reasonCodes : [];
  const delta = evaluation.metrics?.delta ?? {};
  const sentences = [];
  const add = text => {
    if (text && !sentences.includes(text)) sentences.push(text);
  };
  for (const code of codes) {
    switch (code) {
      case 'EXACT_ACTION_MATCH':
        add(personaSentence(profile, {
          guardian: '俺も同じ牌を選ぶ。局面に合った一打だ。',
          analyst: '選んだ手は推奨手と完全に一致しています。',
          striker: 'いいね、その一打！　あたしも同じ牌を切るよ。',
        }));
        break;
      case 'SAME_TILE_KIND_EQUIVALENT':
        add('同じ種類・同じ赤区分の牌を選んでおり、実質的に推奨手と同等です。');
        break;
      case 'SHANTEN_WORSE': {
        const difference = finite(delta.shanten);
        const fact = difference !== null && difference > 0
          ? `推奨手より向聴数が${difference}つ悪化します。`
          : '推奨手より向聴数が悪化します。';
        add(personaSentence(profile, {
          guardian: `${fact} ここで手を遠ざける理由は薄い。`,
          analyst: fact,
          striker: `${fact} 前へ出るなら、この回り道は避けたいね。`,
        }));
        break;
      }
      case 'UKEIRE_LOSS': {
        const difference = finite(delta.ukeirePhysical);
        const fact = difference !== null && difference < 0
          ? `推奨手より受け入れが${Math.abs(difference)}枚少ない選択です。`
          : '推奨手より受け入れが少ない選択です。';
        add(personaSentence(profile, {
          guardian: `${fact} 守備や打点の見返りがないなら狭めない方がいい。`,
          analyst: fact,
          striker: `${fact} 勝負するなら、もっと手広くいこう。`,
        }));
        break;
      }
      case 'SAFETY_WORSE': {
        const difference = finite(delta.maxRisk);
        const fact = difference !== null && difference > 0
          ? `待ち形から算出した危険指標は、推奨手より${difference}高い値です。`
          : '構造上の危険指標が推奨手より高い選択です。';
        add(personaSentence(profile, {
          guardian: `${fact} 通った結果ではなく、切る時点の根拠で見るべきだ。`,
          analyst: fact,
          striker: `${fact} 押すにしても、もっと筋の通った牌を選びたいね。`,
        }));
        break;
      }
      case 'RIICHI_DECLARATION_DIFF':
        add('推奨手とはリーチ宣言の有無が異なります。');
        break;
      case 'UTILITY_LOSS': {
        const difference = finite(delta.utility);
        add(difference !== null && difference < 0
          ? `同じ向聴・受け入れでも、赤牌保持などの効用が${Math.abs(difference)}低い選択です。`
          : '同じ向聴・受け入れでも、赤牌保持などの効用が下がる選択です。');
        break;
      }
      case 'EQUIVALENT_MEASURED_METRICS':
        add('計測できた比較項目では、推奨手と同等です。');
        break;
      case 'MISSED_LEGAL_WIN':
        add('合法な和了を選べる局面で、和了を見送っています。');
        break;
      case 'RECOMMENDED_CALL_PASSED':
        add('推奨された鳴きを見送りました。');
        break;
      case 'UNRECOMMENDED_CALL':
        add('鳴き見送りが推奨された局面で鳴いています。');
        break;
      case 'DIFFERENT_EVALUATED_ACTION':
        add('評価済みの推奨手とは異なる行動です。');
        break;
      case 'FORCED_ACTION_NOT_SCORED':
        add('選択肢が一つだけだったため、採点しません。');
        break;
      case 'BASELINE_RECOMMENDATION_NOT_EVALUATED':
        add('現在の基準では推奨手を確定できないため、採点しません。');
        break;
      case 'BASELINE_SELECTED_NOT_EVALUATED':
        add('選んだ手の比較値を計算できないため、採点しません。');
        break;
      case 'LAST_PLACE_LOCK_FORBIDDEN':
        add(personaSentence(profile, {
          guardian: 'これは対局終了時の4位が確定する和了だ。順位を上げる余地を自分から閉じてはいけない。',
          analyst: '対局終了時の4位が確定する和了に当たるため、順位方針に反します。',
          striker: 'これは4位が確定する和了。点数だけ拾って終わるより、順位を上げる道を残そう。',
        }));
        break;
      case 'BASELINE_KAKAN_NOT_EVALUATED':
      case 'BASELINE_MINKAN_NOT_EVALUATED':
      case 'BASELINE_CHI_NOT_EVALUATED':
        add('現在の評価基準では、この行動を比較採点できません。');
        break;
      default:
        break;
    }
  }
  return sentences;
}

function reviewDetailRows(evaluation, analysis, candidate) {
  const details = analysis ? detailRows(analysis, candidate) : [];
  const selected = evaluation?.metrics?.selected;
  const recommended = evaluation?.metrics?.recommended;
  const delta = evaluation?.metrics?.delta;
  const add = (key, label, value) => {
    if (value !== null && value !== undefined && value !== '' &&
        !details.some(detail => detail.key === key)) {
      details.push({ key, label, value: plainText(value, '—', 240) });
    }
  };
  add('selectedShanten', '選択後', shantenLabel(selected?.shanten));
  add('recommendedShanten', '推奨後', shantenLabel(recommended?.shanten));
  if (finite(selected?.ukeirePhysical) !== null) {
    add('selectedUkeire', '選択の受け入れ', `${selected.ukeirePhysical}枚`);
  }
  if (finite(recommended?.ukeirePhysical) !== null) {
    add('recommendedUkeire', '推奨の受け入れ', `${recommended.ukeirePhysical}枚`);
  }
  if (finite(delta?.shanten) !== null) add('shantenDelta', '向聴差', String(delta.shanten));
  if (finite(delta?.ukeirePhysical) !== null) {
    add('ukeireDelta', '受け入れ差', `${delta.ukeirePhysical}枚`);
  }
  if (finite(delta?.maxRisk) !== null) add('riskDelta', '危険度差', String(delta.maxRisk));
  return details;
}

function personaComment(record, evaluations, profile, forced) {
  const meta = profileMeta(profile);
  const evaluation = findEvaluation(evaluations, profile);
  const suppliedAnalysis = analysisFromEvaluation(evaluation);
  const recommended = candidateForRecommendedAction(record, evaluation, suppliedAnalysis);
  const analysis = suppliedAnalysis ?? syntheticAnalysisFromEvaluation(evaluation, recommended);
  const candidate = selectedEvaluationCandidate(analysis);
  const recommendationLabel = recommended
    ? formatActionLabel(recommended, { record })
    : (analysis ? formatActionLabel(analysis.selected?.action, analysis) : '評価なし');
  const completeness = finite(evaluation?.completeness ?? analysis?.completeness);
  const evaluatorScored = evaluation?.status === 'scored';
  const evaluatorForced = evaluation?.status === 'forced';
  const complete = (evaluatorScored || completeness === 1) &&
    evaluation?.status !== 'incomplete' && evaluation?.status !== 'notEvaluated';
  const rawScore = evaluationScore(evaluation);
  const isForced = forced || evaluatorForced;
  const scorable = !isForced && complete && evaluation?.scorable !== false && rawScore !== null;
  const reviewSentences = reviewReasonSentences(evaluation, profile);
  const sentences = reviewSentences.length > 0
    ? reviewSentences
    : (analysis ? reasonSentences(analysis, candidate, profile) : []);
  const limitation = coverageSentence(analysis);
  if (limitation && !sentences.includes(limitation)) sentences.push(limitation);
  const reason = sentences.join('') || '評価データがありません。';
  return {
    persona: profile,
    profile,
    profileLabel: meta.label,
    name: meta.name,
    role: meta.role,
    headline: isForced
      ? '選択の余地がない打牌です'
      : (!complete
        ? 'この判断は採点対象外です'
        : (recommended?.actionId === record?.chosen?.actionId
          ? '推奨手と一致しています'
          : `推奨: ${recommendationLabel}`)),
    status: isForced ? 'forced' : (scorable ? 'scored' : 'notEvaluated'),
    scorable,
    score: scorable ? rawScore : null,
    scoreLabel: scorable ? scoreLabel(rawScore) : '採点不能',
    recommendationActionId: recommended?.actionId ?? null,
    recommendationLabel,
    agreesWithChoice: recommended
      ? recommended.actionId === record?.chosen?.actionId
      : null,
    verdict: isForced
      ? '選択の余地がないため採点しません'
      : (!complete
        ? '評価記録が不完全なため採点しません'
        : (recommended
          ? `${recommendationLabel}を推奨します`
          : '推奨手を特定できません')),
    body: plainText(`${meta.lead}、${reason}`, '評価データがありません。', 900),
    detailParagraphs: sentences.map(sentence => plainText(sentence, '', 700)).filter(Boolean),
    details: reviewDetailRows(evaluation, analysis, candidate),
    reasonCodes: analysis ? reasonCodes(analysis) : [],
  };
}

/** DecisionRecordと3者評価を局後感想戦用の表示モデルへ変換する。 */
export function presentReviewDecision({ record, evaluations, index = 0, total = 0 } = {}) {
  const safeIndex = Number.isInteger(index) && index >= 0 ? index : 0;
  const safeTotal = Number.isInteger(total) && total >= 0 ? total : 0;
  const chosen = selectedRecordCandidate(record);
  const forced = record?.chosen?.source === 'forced' || record?.availableCandidates?.length === 1;
  const comments = ['guardian', 'analyst', 'striker']
    .map(profile => personaComment(record, evaluations, profile, forced));
  const suppliedOverallScore = finite(
    evaluations?.score ?? evaluations?.overallScore ?? evaluations?.summary?.score,
  );
  const allComplete = comments.every(comment => comment.status === 'scored');
  const commentScores = comments.map(comment => comment.score).filter(score => score !== null);
  const derivedOverallScore = commentScores.length === comments.length
    ? commentScores.reduce((sum, score) => sum + score, 0) / commentScores.length
    : null;
  const overallScore = suppliedOverallScore ?? derivedOverallScore;
  const scorable = !forced && allComplete && overallScore !== null;
  const recommendationIds = [...new Set(comments
    .map(comment => comment.recommendationActionId)
    .filter(Boolean))];
  const consensusRecommendation = recommendationIds.length === 1
    ? comments.find(comment => comment.recommendationActionId === recommendationIds[0])
    : null;
  const actionLabel = chosen ? formatActionLabel(chosen, { record }) : '選択記録なし';
  const sourceLabels = {
    human: 'あなたの選択',
    com: 'COMの選択',
    autoPreference: '自動見送り',
    forced: '強制手順',
  };
  return deepFreeze({
    type: 'reviewDecision',
    available: Boolean(record && chosen),
    index: safeIndex,
    displayIndex: safeIndex + 1,
    total: safeTotal,
    progressLabel: safeTotal > 0 ? `${safeIndex + 1} / ${safeTotal}` : `${safeIndex + 1}`,
    actor: Number.isInteger(record?.actor) ? record.actor : null,
    source: plainText(record?.chosen?.source, '', 32),
    sourceLabel: sourceLabels[record?.chosen?.source] ?? '記録された選択',
    stateId: plainText(record?.stateId, '', 256),
    chosen: {
      actionId: plainText(record?.chosen?.actionId, '', 128),
      label: actionLabel,
    },
    actionLabel,
    recommendation: consensusRecommendation?.recommendationLabel ??
      (recommendationIds.length > 1 ? '3人の推奨が分かれています' : '推奨手なし'),
    recommendationActionId: consensusRecommendation?.recommendationActionId ?? null,
    recommendationByProfile: comments.map(comment => ({
      persona: comment.persona,
      name: comment.name,
      actionId: comment.recommendationActionId,
      label: comment.recommendationLabel,
    })),
    forced,
    scored: scorable,
    scorable,
    score: scorable ? overallScore : null,
    scoreLabel: scorable ? scoreLabel(overallScore) : '採点不能',
    statusLabel: forced
      ? '選択の余地がないため採点対象外'
      : (!allComplete ? '評価記録が不完全' : (scorable ? '採点済み' : '総合点なし')),
    comments,
  });
}

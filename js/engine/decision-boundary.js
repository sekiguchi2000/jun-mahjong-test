// decision-boundary.js — legacy actor応答をLegalActionのactionIdへ厳密に結ぶ
//
// Game外部から返るindex/kind/chi組合せを範囲補正しない。不正または曖昧な
// 応答は即座に例外にし、無限retryや「近い合法手」への黙った置換を防ぐ。

export class InvalidActorDecisionError extends Error {
  constructor(message, { decisionId = null, actor = null, response = null } = {}) {
    super(message);
    this.name = 'InvalidActorDecisionError';
    this.decisionId = decisionId;
    this.actor = actor;
    this.response = response;
  }
}

function arraysEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((value, index) => value === right[index]);
}

function commandMatches(candidate, response) {
  const command = candidate.command;
  if (command === null) return response === null || response?.action === 'pass';
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false;
  if (response.action !== command.action) return false;
  switch (command.action) {
    case 'discard':
      return response.index === command.index && (response.riichi === true) === (command.riichi === true);
    case 'ankan':
    case 'kakan':
      return response.kind === command.kind;
    case 'chi':
      return arraysEqual(response.tiles, command.tiles);
    default:
      return true;
  }
}

export function candidateForActorResponse(candidates, response, context = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new InvalidActorDecisionError('legal candidates are required', { ...context, response });
  }
  if (response && typeof response === 'object' && !Array.isArray(response) &&
      typeof response.actionId === 'string') {
    const exact = candidates.find(candidate => candidate.actionId === response.actionId);
    if (!exact) {
      throw new InvalidActorDecisionError(`unknown actionId: ${response.actionId}`, { ...context, response });
    }
    return exact;
  }
  const matches = candidates.filter(candidate => commandMatches(candidate, response));
  if (matches.length === 0) {
    throw new InvalidActorDecisionError('actor response does not match a legal candidate', { ...context, response });
  }
  // 同一種類のチーに複数の物理組合せがあり、legacy応答が牌種しか返さない場合は
  // 列挙器の固定順（Gameが実際に取り除く順）を唯一の互換規則とする。
  return matches[0];
}

export function sourceForActorChoice(actor, candidate, response, { forced = false } = {}) {
  if (forced) {
    if (!candidate) throw new TypeError('forced choice requires a candidate');
    return 'forced';
  }
  if (actor?.isHuman === true && candidate?.action === 'pass' && response?.source === 'autoPreference') {
    return 'autoPreference';
  }
  return actor?.isHuman === true ? 'human' : 'com';
}

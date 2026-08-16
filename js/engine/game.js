// game.js — 対局進行エンジン
// COMも人間も「actor」インターフェース経由で参加する。
// actorは自分の手牌と公開情報(state)しか渡されない = COMが他家の手や山を見る経路は存在しない。
//
// actor = {
//   onTurn(view, options) -> Promise<{action:'discard',index,riichi?}|{action:'tsumo'}|{action:'ankan',kind}|{action:'kakan',kind}|{action:'kyuushu'}>
//   onClaim(view, offer) -> Promise<null | {action:'ron'}|{action:'pon'}|{action:'minkan'}|{action:'chi',tiles:[i,i]}>
// }

import { toCounts, isYaochu, TON } from './tiles.js';
import { buildWall, deal, doraIndicators, uraIndicators } from './wall.js';
import { dealerForHand, normalizeDealerCeremony } from './opening-dealer.js';
import { shanten, waitingTiles } from './shanten.js';
import { scoreWin } from './score.js';
import {
  classifyLastPlaceCertainty,
  hiddenUraIndicatorCount,
  scorePublicWinUraRange,
} from './win-uncertainty.js';
import { DECISION_EVALUATOR_VERSION } from './decision-evaluator.js?v=18';
import { DecisionLog } from './decision-log.js';
import { captureSessionSnapshot, resolveReplayChoice } from './session-snapshot.js';
import {
  enumerateClaimLegalActions,
  enumerateTurnLegalActions,
  legalActionToActorDecision,
} from './legal-actions.js';
import {
  candidateForActorResponse,
  sourceForActorChoice,
} from './decision-boundary.js';
import {
  applyWinPoints, buildPlacementContext, previewRoundAdvance,
  previewWinOutcome, rankPlayers,
} from './placement.js';

const WINDS = [TON, TON + 1, TON + 2, TON + 3];

export class GameCancelledError extends Error {
  constructor(reason = 'cancelled') {
    super(`game cancelled: ${reason}`);
    this.name = 'GameCancelledError';
    this.code = 'GAME_CANCELLED';
    this.reason = reason;
  }
}

export class SessionReplayError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionReplayError';
    this.code = 'SESSION_REPLAY_DIVERGED';
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function immutableSnapshot(value) {
  return deepFreeze(structuredClone(value));
}

export function availableAnkanKinds(hand, drawn = null) {
  const all = drawn ? hand.concat([drawn]) : [...hand];
  const counts = toCounts(all);
  const kinds = [];
  for (let k = 0; k < 34; k++) if (counts[k] === 4) kinds.push(k);
  return kinds;
}

export function availableKakanKinds(hand, drawn, melds) {
  const all = drawn ? hand.concat([drawn]) : [...hand];
  const counts = toCounts(all);
  return [...new Set(
    melds
      .filter(m => m.type === 'pon' && m.tiles[0] && counts[m.tiles[0].kind] >= 1)
      .map(m => m.tiles[0].kind),
  )];
}

export function promotePonToKan(meld, added) {
  if (!meld || meld.type !== 'pon' || !added || meld.tiles[0]?.kind !== added.kind ||
      added.id === undefined || added.id === null) return false;
  // ポンの末尾は他家から鳴いた横向き牌。そこを維持し、その直前へ4枚目を足す。
  meld.tiles.splice(Math.max(0, meld.tiles.length - 1), 0, added);
  meld.type = 'minkan';
  // 役判定が参照する既存typeは変えず、表示側が大明槓と加槓を判別できる
  // 公開メタデータだけを足す。addedTileIdは横牌の奥へ平置きする4枚目を指す。
  meld.kanOrigin = 'kakan';
  meld.addedTileId = added.id;
  return true;
}

export function availableChiSets(hand, tile) {
  if (!tile || tile.kind >= 27) return [];
  const chiSets = [];
  const has = kind => hand.some(candidate => candidate.kind === kind);
  const number = tile.kind % 9;
  if (number >= 2 && has(tile.kind - 2) && has(tile.kind - 1)) chiSets.push([tile.kind - 2, tile.kind - 1]);
  if (number >= 1 && number <= 7 && has(tile.kind - 1) && has(tile.kind + 1)) chiSets.push([tile.kind - 1, tile.kind + 1]);
  if (number <= 6 && has(tile.kind + 1) && has(tile.kind + 2)) chiSets.push([tile.kind + 1, tile.kind + 2]);
  return chiSets;
}

export class Game {
  constructor(rules, actors, onEvent = () => {}, options = {}) {
    this.rules = rules;
    this.actors = actors;          // [4]
    this.onEvent = onEvent;        // UI通知用 (type, data)
    const resume = options.resumeSession ?? null;
    const roundStart = resume?.roundStart ?? null;
    this.points = roundStart?.points
      ? [...roundStart.points]
      : [rules.startPoints, rules.startPoints, rules.startPoints, rules.startPoints];
    this.roundWindIdx = roundStart?.roundWindIdx ?? 0; // 0=東場,1=南場...
    this.kyoku = roundStart?.kyoku ?? 0;               // 0-3 (東1-東4)
    const suppliedCeremony = options.dealerCeremony
      ? normalizeDealerCeremony(options.dealerCeremony)
      : null;
    this.initialDealer = roundStart?.initialDealer ?? suppliedCeremony?.initialDealer ?? options.initialDealer ?? 0;
    if (!Number.isInteger(this.initialDealer) || this.initialDealer < 0 || this.initialDealer > 3) {
      throw new RangeError('initialDealer must be an integer from 0 to 3');
    }
    if (suppliedCeremony && suppliedCeremony.initialDealer !== this.initialDealer) {
      throw new RangeError('dealer ceremony and initialDealer do not match');
    }
    this.dealerCeremony = suppliedCeremony;
    this.dealerCeremonyPending = Boolean(suppliedCeremony && !resume);
    this.honba = roundStart?.honba ?? 0;
    this.riichiSticks = roundStart?.riichiSticks ?? 0;
    this.finished = false;
    this.cancelled = false;
    this.cancelReason = null;
    this.decisionObserver = options.onDecisionEvent ?? (() => {});
    this.decisionLog = options.decisionLog ?? new DecisionLog({
      matchId: options.matchId ?? 'local-match',
      rulesVersion: options.rulesVersion ?? 'riichi-rules-v1',
      evaluatorVersion: options.evaluatorVersion ?? DECISION_EVALUATOR_VERSION,
    });
    this.lastRoundDecisionLog = null;
    this.resumeSession = resume ? immutableSnapshot(resume) : null;
    this.replayChoices = resume?.decisions?.map(choice => ({ ...choice })) ?? [];
    this.replayActive = Boolean(resume);
    this.resumeVisualPending = false;
    this.currentRoundWall = null;
    this.currentRoundStart = null;
  }

  dealerOf() { return dealerForHand(this.initialDealer, this.kyoku); }
  seatWindOf(p) { return WINDS[(p - this.dealerOf() + 4) % 4]; }
  roundWind() { return WINDS[this.roundWindIdx]; }

  cancel(reason = 'user') {
    if (this.cancelled) return;
    this.cancelled = true;
    this.cancelReason = reason;
  }

  isCancelled() { return this.cancelled; }
  isReplaying() { return this.replayActive; }

  shouldEmitReplayEvent() {
    if (!this.replayActive) return true;
    if (this.replayChoices.length > 0) return false;
    // 保存時点の最後の判断が生んだ公開イベントだけは表示する。これにより
    // 復元後の盤面が一度で正しい状態になり、和了判断で保存した場合も結果画面へ進める。
    this.replayActive = false;
    this.resumeVisualPending = true;
    return true;
  }

  assertActive() {
    if (this.cancelled) throw new GameCancelledError(this.cancelReason ?? 'user');
  }

  async emit(type, data, resumeVisual = {}) {
    this.assertActive();
    if (this.resumeVisualPending && type !== 'resumeReady') {
      this.resumeVisualPending = false;
      await this.onEvent('resumeReady', {
        state: this.publicState(),
        actor: this.st?.turn ?? null,
        drawn: resumeVisual.drawn ?? null,
      });
      this.assertActive();
    }
    const result = await this.onEvent(type, data);
    this.assertActive();
    return result;
  }

  async observe(type, data) {
    this.assertActive();
    const result = await this.decisionObserver(type, data);
    this.assertActive();
    return result;
  }

  createSessionCheckpoint() {
    this.assertActive();
    if (!this.currentRoundWall || !this.currentRoundStart || !this.decisionLog.roundId) {
      throw new Error('a session can only be saved while a round is active');
    }
    return captureSessionSnapshot({
      createdAt: new Date().toISOString(),
      rules: structuredClone(this.rules),
      roundStart: structuredClone(this.currentRoundStart),
      wall: structuredClone(this.currentRoundWall),
      decisionLog: this.decisionLog,
    });
  }

  async run() {
    if (this.dealerCeremonyPending) {
      this.dealerCeremonyPending = false;
      await this.emit('dealerCeremony', structuredClone(this.dealerCeremony));
    }
    while (!this.finished) {
      this.assertActive();
      const result = await this.playRound();
      this.assertActive();
      this.advance(result);
    }
    const ranking = rankPlayers(this.points, this.initialDealer);
    await this.emit('gameEnd', { points: this.points, ranking });
    return { points: this.points, ranking };
  }

  async decide({ actor: actorIndex, kind, view, options, candidates, invoke, forced = false }) {
    this.assertActive();
    const actor = this.actors[actorIndex];
    if (!actor) throw new Error(`actor ${actorIndex} is missing`);
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error(`no legal candidates for actor ${actorIndex} (${kind})`);
    }
    if (forced && candidates.length !== 1) {
      throw new Error(`forced decision requires exactly one candidate (${candidates.length} given)`);
    }
    if (this.replayActive && this.replayChoices.length === 0) {
      this.replayActive = false;
      await this.emit('resumeReady', {
        state: this.publicState(),
        actor: actorIndex,
        drawn: actorIndex === 0 && view?.drawn ? { ...view.drawn } : null,
      });
    }

    const request = this.decisionLog.beginDecision({
      kind,
      actor: actorIndex,
      options,
      view,
      availableCandidates: candidates,
      evaluatorVersion: DECISION_EVALUATOR_VERSION,
    });
    if (this.replayActive) {
      const expected = this.replayChoices.shift();
      if (!expected || expected.actor !== actorIndex || expected.kind !== kind) {
        throw new SessionReplayError(
          `saved decision does not match ${kind} for actor ${actorIndex}`);
      }
      let replayCandidate;
      try {
        replayCandidate = resolveReplayChoice(expected, candidates, {
          actor: actorIndex,
          kind,
        }).candidate;
      } catch (error) {
        throw new SessionReplayError(
          `saved action is no longer legal: ${expected.actionId} (${error.code ?? error.message})`);
      }
      const replayRecord = this.decisionLog.commitDecision(request, {
        actionId: replayCandidate.actionId,
        source: expected.source,
        resultPointer: `${request.roundId}:result`,
      });
      return {
        candidate: replayCandidate,
        command: legalActionToActorDecision(replayCandidate),
        record: replayRecord,
      };
    }

    await this.observe('beforeDecision', { request });

    let response = null;
    let candidate;
    if (forced) {
      candidate = candidates[0];
    } else {
      response = typeof actor.onDecision === 'function'
        ? await actor.onDecision(request)
        : await invoke(actor, request.view);
      this.assertActive();
      candidate = candidateForActorResponse(candidates, response, {
        decisionId: request.id,
        actor: actorIndex,
      });
    }
    const source = sourceForActorChoice(actor, candidate, response, { forced });
    const record = this.decisionLog.commitDecision(request, {
      actionId: candidate.actionId,
      source,
      resultPointer: `${request.roundId}:result`,
    });
    const analysis = forced ? null : actor.lastDecisionAnalysis ?? null;
    await this.observe('decisionCommitted', { record, analysis });
    return {
      candidate,
      command: legalActionToActorDecision(candidate),
      record,
    };
  }

  async decideTurn(actor, view, options, { forced = false } = {}) {
    const candidates = enumerateTurnLegalActions(view, options, this.rules);
    return this.decide({
      actor,
      kind: 'turn',
      view,
      options,
      candidates,
      forced,
      invoke: (participant, frozenView) => participant.onTurn(frozenView, [...options]),
    });
  }

  async decideClaim(actor, view, offer) {
    // actorへ渡すofferも判断記録と同様にsnapshot/freezeし、COMや将来adapterが
    // 捨て牌・winPreview本体を書き換えて対局状態を壊す経路を閉じる。
    const frozenOffer = immutableSnapshot(offer);
    const candidates = enumerateClaimLegalActions(view, frozenOffer);
    return this.decide({
      actor,
      kind: 'claim',
      view,
      options: candidates.map(candidate => candidate.action),
      candidates,
      invoke: (participant, frozenView) => participant.onClaim(frozenView, frozenOffer),
    });
  }

  advanceDecisionState() {
    return this.decisionLog.advanceState();
  }

  getDecisionLog() {
    return this.decisionLog.exportMatch();
  }

  shouldAbortFourKans() {
    const st = this.st;
    if (!this.rules.tochuRyukyoku || st.kanCount < 4) return false;
    if (st.kanCount > 4) return true;
    const kanPlayers = new Set(st.players.flatMap((player, seat) =>
      player.melds.filter(meld => meld.type.includes('kan')).map(() => seat)));
    return kanPlayers.size > 1;
  }

  doraIndicatorTiles() {
    const kanCount = this.rules.kanDora === false ? 0 : Math.min(this.st.kanCount ?? 0, 4);
    return doraIndicators(this.st.deadWall, kanCount);
  }

  uraIndicatorTiles() {
    const kanCount = this.rules.kanUra === false ? 0 : Math.min(this.st.kanCount ?? 0, 4);
    return uraIndicators(this.st.deadWall, kanCount);
  }

  async publishKan(player, action, kind, { fromClaim = false } = {}) {
    this.advanceDecisionState();
    this.decisionLog.appendPublicEvent('kan', {
      actor: player,
      action,
      kind,
      kanCount: this.st.kanCount,
    });
    if (this.shouldEmitReplayEvent()) await this.emit('kan', {
      player,
      action,
      kind,
      kanCount: this.st.kanCount,
      fromClaim,
      state: this.publicState(),
    });
    return this.shouldAbortFourKans();
  }

  advance(result) {
    const dealer = this.dealerOf();
    const next = previewRoundAdvance({
      rules: this.rules,
      points: this.points,
      roundWindIdx: this.roundWindIdx,
      kyoku: this.kyoku,
      honba: this.honba,
      result,
      initialDealer: this.initialDealer,
      dealer,
    });
    this.roundWindIdx = next.roundWindIdx;
    this.kyoku = next.kyoku;
    this.honba = next.honba;
    this.finished = next.finished;
  }

  // 1局を回し、全終端を同じ判断artifactへ確定してからadvanceへ返す。
  async playRound() {
    this.assertActive();
    this.currentRoundStart = immutableSnapshot({
      points: [...this.points],
      roundWindIdx: this.roundWindIdx,
      kyoku: this.kyoku,
      initialDealer: this.initialDealer,
      honba: this.honba,
      riichiSticks: this.riichiSticks,
    });
    this.decisionLog.startRound({
      roundWindIdx: this.roundWindIdx,
      kyoku: this.kyoku,
      honba: this.honba,
    });
    const result = await this.playRoundBody();
    if (this.replayActive) {
      throw new SessionReplayError('saved decisions extend beyond the restored round');
    }
    this.lastRoundDecisionLog = this.decisionLog.finishRound(`${this.decisionLog.roundId}:result`);
    await this.observe('roundComplete', {
      round: this.lastRoundDecisionLog,
      result,
    });
    this.currentRoundWall = null;
    this.currentRoundStart = null;
    return result;
  }

  // 1局の内部進行。返り値 { renchan, ryukyoku, winner? }
  async playRoundBody() {
    const R = this.rules;
    const wall = this.resumeSession?.wall
      ? structuredClone(this.resumeSession.wall)
      : buildWall(R);
    this.currentRoundWall = immutableSnapshot(wall);
    this.resumeSession = null;
    const { hands, live, deadWall } = deal(wall);
    const dealer = this.dealerOf();

    const st = this.st = {
      players: [0, 1, 2, 3].map(p => ({
        hand: hands[p], melds: [], discards: [],
        riichi: false, doubleRiichi: false, ippatsu: false,
        furiten: false, furitenTemp: false,
        anyCalled: false,   // 自分の捨て牌が鳴かれた(流し満貫用)
      })),
      live, deadWall, kanCount: 0, discardSeq: 0,
      turn: dealer, firstGoAround: true, turnCount: 0,
      lastDiscard: null, lastKanTile: null,
      riichiThisTurn: -1,
    };
    // 手牌ソート(表示・思考用)
    for (const pl of st.players) pl.hand.sort((a, b) => a.kind - b.kind || (a.red ? 1 : 0) - (b.red ? 1 : 0));

    this.decisionLog.appendPublicEvent('roundStart', {
      roundWindIdx: this.roundWindIdx,
      kyoku: this.kyoku,
      initialDealer: this.initialDealer,
      dealer,
      honba: this.honba,
      riichiSticks: this.riichiSticks,
      points: [...this.points],
      doraIndicators: this.doraIndicatorTiles().map(t => ({ ...t })),
    });
    if (this.shouldEmitReplayEvent()) await this.emit('roundStart', this.publicState());

    let pendingRinshan = false;
    while (true) {
      this.assertActive();
      const p = st.turn;
      const pl = st.players[p];

      // --- ツモ ---
      if (st.live.length === 0) return await this.ryukyoku();
      const drawn = pendingRinshan ? st.deadWall[st.kanCount - 1] : st.live.shift();
      if (pendingRinshan) st.deadWall.push(st.live.pop()); // 王牌補充
      const isRinshan = pendingRinshan;
      pendingRinshan = false;
      pl.furitenTemp = false;
      this.advanceDecisionState();
      this.decisionLog.appendPublicEvent('draw', {
        actor: p,
        remaining: st.live.length,
        rinshan: isRinshan,
      });
      if (this.shouldEmitReplayEvent()) {
        await this.emit('draw', {
          player: p,
          tile: this.actors[p].isHuman ? drawn : null,
          remaining: st.live.length,
          state: this.publicState(),
        });
      }

      // --- 手番の選択肢を構築 ---
      const options = this.turnOptions(p, drawn, isRinshan);
      const publicWinFlags = {
        tsumo: true, rinshan: isRinshan, haitei: st.live.length === 0,
        dryRun: true, publicOnly: true,
      };
      const publicWin = options.includes('tsumo')
        ? this.tryWin(p, drawn, publicWinFlags)
        : null;
      const publicWinRange = publicWin ? this.publicWinScoreRange(p, drawn, publicWinFlags) : null;
      const winPreview = publicWin
        ? this.previewWin(p, null, publicWinRange?.minimumScore ?? publicWin,
          publicWinRange?.maximumScore ?? publicWin)
        : null;
      const turnView = this.viewFor(p, drawn, { winPreview });
      const legalTurnActions = enumerateTurnLegalActions(turnView, options, this.rules);
      const forceTsumogiri = pl.riichi && !options.includes('tsumo') && legalTurnActions.length === 1;
      const turnDecision = (await this.decide({
        actor: p,
        kind: 'turn',
        view: turnView,
        options,
        candidates: legalTurnActions,
        forced: forceTsumogiri,
        invoke: (participant, frozenView) => participant.onTurn(frozenView, [...options]),
      })).command;

      // --- 九種九牌 ---
      if (turnDecision.action === 'kyuushu') {
        this.advanceDecisionState();
        this.decisionLog.appendPublicEvent('kyuushu', { actor: p });
        if (this.shouldEmitReplayEvent()) await this.emit('kyuushu', { player: p });
        return await this.ryukyoku(true);
      }

      // --- ツモ和了 ---
      if (turnDecision.action === 'tsumo') {
        const win = this.tryWin(p, drawn, { tsumo: true, rinshan: isRinshan, haitei: st.live.length === 0 });
        if (win) return await this.applyWin(p, null, win, drawn);
      }

      // --- 暗槓・加槓 ---
      if (turnDecision.action === 'ankan' || turnDecision.action === 'kakan') {
        const kind = turnDecision.kind;
        if (turnDecision.action === 'ankan') {
          const tiles = [];
          pl.hand = pl.hand.concat([drawn]).filter(t => {
            if (t.kind === kind && tiles.length < 4) { tiles.push(t); return false; }
            return true;
          });
          pl.melds.push({ type: 'ankan', kanOrigin: 'ankan', tiles });
        } else {
          // 加槓: 宣言を公開して槍槓を確認し、全員pass後にだけ手牌を変更する。
          const meld = pl.melds.find(m => m.type === 'pon' && m.tiles[0].kind === kind);
          const handAll = pl.hand.concat([drawn]);
          const idx = handAll.findIndex(t => t.kind === kind);
          if (!meld || idx < 0) throw new Error(`illegal kakan state for kind ${kind}`);
          const added = handAll[idx];
          this.advanceDecisionState();
          this.decisionLog.appendPublicEvent('kan', {
            actor: p,
            action: 'kakanDeclared',
            kind,
            kanCount: st.kanCount,
          });
          if (this.shouldEmitReplayEvent()) {
            await this.emit('kanDeclared', {
              player: p,
              action: 'kakan',
              kind,
              // 宣言した4枚目はこの時点で公開情報。物理IDと赤牌情報を
              // 描画層へ渡し、槍槓時にも同じ牌を強調できるようにする。
              tile: { ...added },
              state: this.publicState(),
            }, { drawn: this.actors[p].isHuman ? drawn : null });
          }
          const chankanWin = await this.checkChankan(p, added);
          if (chankanWin) return chankanWin;
          handAll.splice(idx, 1);
          pl.hand = handAll;
          promotePonToKan(meld, added);
        }
        st.kanCount++;
        for (const q of st.players) q.ippatsu = false;
        st.firstGoAround = false;
        if (await this.publishKan(p, turnDecision.action, kind)) {
          return await this.ryukyoku(true); // 四槓散了
        }
        pendingRinshan = true;
        continue; // 同プレイヤーが嶺上ツモ
      }

      // --- 打牌 ---
      const handAll = pl.hand.concat([drawn]);
      const discIdx = turnDecision.index;
      if (!Number.isInteger(discIdx) || discIdx < 0 || discIdx >= handAll.length) {
        throw new Error(`recorded discard index ${discIdx} is outside the current hand`);
      }
      const discarded = handAll.splice(discIdx, 1)[0];
      pl.hand = handAll.sort((a, b) => a.kind - b.kind || (a.red ? 1 : 0) - (b.red ? 1 : 0));

      // リーチ後、次の自分の打牌で一発権は消える(この打牌が宣言牌の場合を除く)
      const wasRiichi = pl.riichi;
      // リーチ宣言
      let declaredRiichi = false;
      if (turnDecision.riichi && !pl.riichi) {
        const counts = toCounts(pl.hand);
        if (pl.melds.every(m => m.type === 'ankan') && shanten(counts, pl.melds.length) === 0 &&
            (this.points[p] >= 1000 || R.riichiBelow1000)) {
          pl.riichi = true;
          pl.doubleRiichi = st.firstGoAround && pl.discards.length === 0 && !st.players.some(q => q.anyCalled);
          pl.ippatsu = true;
          declaredRiichi = true;
          this.points[p] -= 1000;
          this.riichiSticks++;
        }
      }
      if (wasRiichi) pl.ippatsu = false;
      const tsumogiri = discIdx === handAll.length; // spliceで1減った後なので length===元の最後
      // seq: 局内の全捨て牌に共通の通し番号。リーチ後に「通った」牌の判定に使う(公開情報)。
      // 旧セーブ再開などでカウンタが無い場合は既存の捨て牌総数から復元する。
      if (!Number.isInteger(st.discardSeq)) {
        st.discardSeq = st.players.reduce((sum, player) => sum + player.discards.length, 0);
      }
      pl.discards.push({ tile: discarded, riichi: declaredRiichi, tsumogiri, seq: st.discardSeq++ });
      st.lastDiscard = { player: p, tile: discarded };
      this.advanceDecisionState();
      this.decisionLog.appendPublicEvent('discard', {
        actor: p,
        tile: { ...discarded },
        riichi: declaredRiichi,
        tsumogiri,
      });
      if (this.shouldEmitReplayEvent()) {
        await this.emit('discard', { player: p, tile: discarded, riichi: declaredRiichi, state: this.publicState() });
      }

      // リーチ後のフリテン確定用に待ちを記録
      if (pl.riichi && !pl.waits) pl.waits = waitingTiles(toCounts(pl.hand), pl.melds.length);

      // --- 他家の反応 (ロン > ポン/カン > チー)。鳴き→打牌→さらに鳴き…の連鎖をループで処理 ---
      let curClaim = await this.collectClaims(p, discarded);
      let curDiscarder = p, curTile = discarded;
      let claimed = false, ronResult = null;
      while (curClaim) {
        if (curClaim.action === 'ron') { ronResult = curClaim.result; break; }
        claimed = true;
        const q = st.players[curClaim.player];
        st.players[curDiscarder].anyCalled = true;
        st.players[curDiscarder].discards[st.players[curDiscarder].discards.length - 1].claimed = true;
        for (const r of st.players) r.ippatsu = false;
        st.firstGoAround = false;
        if (curClaim.action === 'pon' || curClaim.action === 'minkan') {
          const need = curClaim.action === 'pon' ? 2 : 3;
          const taken = [];
          q.hand = q.hand.filter(t => (t.kind === curTile.kind && taken.length < need) ? (taken.push(t), false) : true);
          q.melds.push({
            type: curClaim.action,
            ...(curClaim.action === 'minkan' ? { kanOrigin: 'minkan' } : {}),
            tiles: [...taken, curTile],
            from: curDiscarder,
          });
        } else { // chi
          const taken = [];
          for (const k of curClaim.tiles) {
            const i = q.hand.findIndex(t => t.kind === k && !taken.includes(t));
            taken.push(q.hand.splice(i, 1)[0]);
          }
          q.melds.push({ type: 'chi', tiles: [...taken, curTile], from: curDiscarder });
        }
        st.turn = curClaim.player; // イベント通知前に手番を移す(表示が旧手番のままになるのを防ぐ)
        st.turnCount++;
        this.advanceDecisionState();
        this.decisionLog.appendPublicEvent('claim', {
          actor: curClaim.player,
          from: curDiscarder,
          action: curClaim.action,
          tile: { ...curTile },
        });
        if (this.shouldEmitReplayEvent()) {
          await this.emit('claim', { player: curClaim.player, action: curClaim.action, tile: curTile, state: this.publicState() });
        }
        if (curClaim.action === 'minkan') {
          st.kanCount++;
          if (await this.publishKan(curClaim.player, 'minkan', curTile.kind, { fromClaim: true })) {
            return await this.ryukyoku(true); // 四槓散了
          }
          pendingRinshan = true;
          curClaim = null; // 外ループで嶺上ツモへ
          break;
        }
        // 鳴いた人が打牌
        const postClaimView = this.viewFor(curClaim.player, null);
        const decision = (await this.decideTurn(curClaim.player, postClaimView, ['discard'])).command;
        const di = decision.index;
        if (!Number.isInteger(di) || di < 0 || di >= q.hand.length) {
          throw new Error(`recorded post-claim discard index ${di} is outside the current hand`);
        }
        const d2 = q.hand.splice(di, 1)[0];
        q.hand.sort((a, b) => a.kind - b.kind);
        if (!Number.isInteger(st.discardSeq)) {
          st.discardSeq = st.players.reduce((sum, player) => sum + player.discards.length, 0);
        }
        q.discards.push({ tile: d2, riichi: false, tsumogiri: false, seq: st.discardSeq++ });
        st.lastDiscard = { player: curClaim.player, tile: d2 };
        this.advanceDecisionState();
        this.decisionLog.appendPublicEvent('discard', {
          actor: curClaim.player,
          tile: { ...d2 },
          riichi: false,
          tsumogiri: false,
        });
        if (this.shouldEmitReplayEvent()) {
          await this.emit('discard', { player: curClaim.player, tile: d2, riichi: false, state: this.publicState() });
        }
        curDiscarder = curClaim.player;
        curTile = d2;
        curClaim = await this.collectClaims(curDiscarder, d2);
        if (!curClaim) st.turn = (curDiscarder + 1) % 4;
      }
      if (ronResult) return ronResult;
      if (claimed || pendingRinshan) continue;

      // 四風連打
      if (R.tochuRyukyoku && st.firstGoAround && st.players.every(q => q.discards.length >= 1)) {
        const firsts = st.players.map(q => q.discards[0].tile.kind);
        if (firsts.every(k => k === firsts[0] && k >= 27 && k <= 30)) return await this.ryukyoku(true);
        st.firstGoAround = false;
      }
      // 四家リーチ
      if (R.tochuRyukyoku && st.players.every(q => q.riichi)) return await this.ryukyoku(true);

      st.turn = (p + 1) % 4;
      st.turnCount++;
    }
  }

  turnOptions(p, drawn, isRinshan) {
    const st = this.st, pl = st.players[p], R = this.rules;
    const options = ['discard'];
    // ツモ和了可能?
    if (this.tryWin(p, drawn, {
      tsumo: true, rinshan: isRinshan, haitei: st.live.length === 0,
      dryRun: true, publicOnly: true,
    })) options.push('tsumo');
    // 暗槓/加槓
    if (st.live.length > 0 && !pl.riichi && (st.kanCount ?? 0) < 4) { // 5つ目の槓は存在しない
      if (availableAnkanKinds(pl.hand, drawn).length > 0) options.push('ankan');
      if (availableKakanKinds(pl.hand, drawn, pl.melds).length > 0) options.push('kakan');
    }
    // 九種九牌
    if (R.tochuRyukyoku && st.firstGoAround && pl.discards.length === 0 && pl.melds.length === 0) {
      const kinds = new Set(pl.hand.concat([drawn]).filter(t => isYaochu(t.kind)).map(t => t.kind));
      if (kinds.size >= 9) options.push('kyuushu');
    }
    return options;
  }

  // ロン/ポン/チーの募集。ロン優先。
  async collectClaims(discarder, tile) {
    const st = this.st;
    const houtei = st.live.length === 0;
    // ロン (頭ハネ: 下家優先)
    for (let d = 1; d <= 3; d++) {
      const p = (discarder + d) % 4;
      const pl = st.players[p];
      if (pl.furiten || pl.furitenTemp) continue;
      const publicWinFlags = {
        tsumo: false, houtei, dryRun: true, publicOnly: true,
      };
      const win = this.tryWin(p, tile, publicWinFlags);
      if (!win) continue;
      const range = this.publicWinScoreRange(p, tile, publicWinFlags);
      const winPreview = this.previewWin(
        p, discarder, range?.minimumScore ?? win, range?.maximumScore ?? win);
      const offer = {
        type: 'ron', tile, from: discarder, winPreview,
      };
      const choice = await this.decideClaim(p, this.viewFor(p, null, { winPreview }), offer);
      if (choice.candidate.action === 'ron') {
        const result = await this.applyWin(p, discarder, this.tryWin(p, tile, { tsumo: false, houtei }), tile);
        return { action: 'ron', player: p, result };
      }
      // ロン見逃し → 同巡フリテン(リーチ中なら永久)
      pl.furitenTemp = true;
      if (pl.riichi) pl.furiten = true;
      this.advanceDecisionState();
    }
    if (houtei) return null;
    // ポン/明槓/チー。各人へ同時点の全合法候補を一度だけ提示し、
    // 全回答後にポン・明槓 > チー、同優先なら下家順で解決する。
    const callIntents = [];
    for (let d = 1; d <= 3; d++) {
      const p = (discarder + d) % 4;
      const pl = st.players[p];
      if (pl.riichi) continue;
      const same = pl.hand.filter(t => t.kind === tile.kind).length;
      const chiSets = d === 1 ? availableChiSets(pl.hand, tile) : [];
      if (same < 2 && chiSets.length === 0) continue;
      const offer = {
        type: 'call',
        tile,
        from: discarder,
        ...(same >= 2 ? { canPon: true } : {}),
        ...(same >= 3 && st.live.length > 0 && (st.kanCount ?? 0) < 4 ? { canKan: true } : {}),
        ...(chiSets.length > 0 ? { canChi: chiSets } : {}),
      };
      const choice = await this.decideClaim(p, this.viewFor(p, null), offer);
      if (choice.candidate.action !== 'pass') {
        callIntents.push({
          distance: d,
          player: p,
          action: choice.candidate.action,
          ...(choice.candidate.action === 'chi' ? { tiles: [...choice.candidate.tiles] } : {}),
        });
      }
    }
    const selected = callIntents.find(intent => intent.action === 'pon' || intent.action === 'minkan')
      ?? callIntents.find(intent => intent.action === 'chi')
      ?? null;
    if (!selected) return null;
    return {
      action: selected.action,
      player: selected.player,
      ...(selected.tiles ? { tiles: selected.tiles } : {}),
    };
  }

  async checkChankan(kanPlayer, tile) {
    for (let d = 1; d <= 3; d++) {
      const p = (kanPlayer + d) % 4;
      const pl = this.st.players[p];
      if (pl.furiten || pl.furitenTemp) continue;
      const publicWinFlags = {
        tsumo: false, chankan: true, dryRun: true, publicOnly: true,
      };
      const win = this.tryWin(p, tile, publicWinFlags);
      if (!win) continue;
      const range = this.publicWinScoreRange(p, tile, publicWinFlags);
      const winPreview = this.previewWin(
        p, kanPlayer, range?.minimumScore ?? win, range?.maximumScore ?? win);
      const offer = {
        type: 'ron', tile, from: kanPlayer, chankan: true, winPreview,
      };
      const choice = await this.decideClaim(p, this.viewFor(p, null, { winPreview }), offer);
      if (choice.candidate.action === 'ron') {
        return await this.applyWin(p, kanPlayer, this.tryWin(p, tile, { tsumo: false, chankan: true }), tile);
      }
      pl.furitenTemp = true;
      if (pl.riichi) pl.furiten = true;
      this.advanceDecisionState();
    }
    return null;
  }

  winScoreContext(p, tile, {
    tsumo, rinshan = false, haitei = false, houtei = false, chankan = false,
    publicOnly = false,
  }) {
    const st = this.st, pl = st.players[p];
    return {
      hand: pl.hand, melds: pl.melds, winTile: tile, tsumo,
      riichi: pl.riichi, doubleRiichi: pl.doubleRiichi, ippatsu: pl.ippatsu,
      rinshan, chankan, haitei, houtei,
      tenhou: tsumo && p === this.dealerOf() && pl.discards.length === 0 && st.players.every(q => q.melds.length === 0),
      chihou: tsumo && p !== this.dealerOf() && pl.discards.length === 0 && st.players.every(q => q.melds.length === 0) && st.firstGoAround,
      seatWind: this.seatWindOf(p), roundWind: this.roundWind(),
      doraIndicators: this.doraIndicatorTiles().map(t => t.kind),
      // AIの意思決定用previewへ、まだ公開されていない裏ドラを渡さない。
      uraIndicators: pl.riichi && this.rules.uraDora && !publicOnly
        ? this.uraIndicatorTiles().map(t => t.kind)
        : [],
    };
  }

  winScoreExtra(p) {
    return {
      isDealer: p === this.dealerOf(),
      honba: this.honba,
      riichiSticks: this.riichiSticks,
    };
  }

  publicKnownTilesForUra() {
    return this.st.players.flatMap(player => [
      ...player.discards.map(discard => discard.tile),
      ...player.melds.flatMap(meld => meld.tiles),
    ]);
  }

  // 実際の裏表示牌を読まず、公開状態と矛盾しない最低点〜最大点を求める。
  publicWinScoreRange(p, tile, flags) {
    const pl = this.st.players[p];
    return scorePublicWinUraRange({
      scoreContext: this.winScoreContext(p, tile, { ...flags, publicOnly: true }),
      rules: this.rules,
      extra: this.winScoreExtra(p),
      hiddenIndicatorCount: hiddenUraIndicatorCount({
        riichi: pl.riichi,
        rules: this.rules,
        kanCount: Math.min(this.st.kanCount ?? 0, 4),
      }),
      otherKnownTiles: this.publicKnownTilesForUra(),
    });
  }

  // 和了判定+点数。dryRun時も同じ計算(見えてよい情報しか使わない)。
  tryWin(p, tile, flags) {
    const { tsumo } = flags;
    const pl = this.st.players[p];
    // フリテン(ロンのみ)
    if (!tsumo) {
      const waits = waitingTiles(toCounts(pl.hand), pl.melds.length);
      if (!waits.includes(tile.kind)) return null;
      if (waits.some(w => pl.discards.some(d => d.tile.kind === w))) return null;
    }
    return scoreWin(this.winScoreContext(p, tile, flags), this.rules, this.winScoreExtra(p));
  }

  // 公開情報だけで算出した最低scoreと裏ドラ上限scoreの両方から、
  // 「最大でも4位」の場合だけラス確と証明する。
  previewWin(winner, loser, publicScore, maximumPublicScore = publicScore) {
    const common = {
      rules: this.rules,
      points: this.points,
      roundWindIdx: this.roundWindIdx,
      kyoku: this.kyoku,
      initialDealer: this.initialDealer,
      dealer: this.dealerOf(),
      honba: this.honba,
      riichiSticks: this.riichiSticks,
      winner,
      loser,
    };
    const minimumPreview = previewWinOutcome({ ...common, score: publicScore });
    const maximumPreview = previewWinOutcome({ ...common, score: maximumPublicScore });
    const certainty = classifyLastPlaceCertainty(minimumPreview, maximumPreview);
    return {
      ...minimumPreview,
      guaranteedLastPlace: certainty.guaranteedLastPlace,
      lastPlaceCertainty: certainty.certainty,
      maximumAfterRank: maximumPreview.afterRank,
      maximumAfterPoints: maximumPreview.afterPoints,
      maximumScore: maximumPreview.score,
    };
  }

  async applyWin(winner, loser, score, winTile) {
    const dealer = this.dealerOf();
    const before = [...this.points];
    this.points = applyWinPoints({
      points: this.points,
      winner,
      loser,
      score,
      dealer,
      riichiSticks: this.riichiSticks,
    });
    this.riichiSticks = 0;
    const st = this.st;
    const winnerRiichi = st.players[winner].riichi;
    const deltas = this.points.map((v, i) => v - before[i]);
    this.advanceDecisionState();
    this.decisionLog.appendPublicEvent('win', {
      winner,
      loser: loser ?? null,
      winTile: { ...winTile },
      deltas,
    });
    if (this.shouldEmitReplayEvent()) await this.emit('win', {
      winner, loser, score, winTile,
      deltas,
      hand: st.players[winner].hand, melds: st.players[winner].melds,
      doraInd: this.doraIndicatorTiles().map(t => ({ ...t })),
      uraInd: winnerRiichi && this.rules.uraDora ? this.uraIndicatorTiles().map(t => ({ ...t })) : [],
      state: this.publicState(),
    });
    return { renchan: winner === dealer, ryukyoku: false, winner };
  }

  async ryukyoku(tochu = false) {
    const st = this.st, R = this.rules;
    const dealer = this.dealerOf();
    if (tochu) {
      this.advanceDecisionState();
      this.decisionLog.appendPublicEvent('ryukyoku', {
        tochu: true,
        tenpai: [],
        deltas: [0, 0, 0, 0],
      });
      if (this.shouldEmitReplayEvent()) {
        await this.emit('ryukyoku', { tochu: true, tenpai: [], deltas: [0, 0, 0, 0], revealed: [], state: this.publicState() });
      }
      return { renchan: true, ryukyoku: true };
    }
    const before = [...this.points];
    // 流し満貫
    if (R.nagashiMangan) {
      for (let p = 0; p < 4; p++) {
        const pl = st.players[p];
        if (pl.discards.length > 0 && pl.discards.every(d => isYaochu(d.tile.kind)) && !pl.anyCalled) {
          const isDealer = p === dealer;
          for (let q = 0; q < 4; q++) {
            if (q === p) continue;
            const pay = isDealer ? 4000 : (q === dealer ? 4000 : 2000);
            this.points[q] -= pay;
            this.points[p] += pay;
          }
          const deltas = this.points.map((v, i) => v - before[i]);
          this.advanceDecisionState();
          this.decisionLog.appendPublicEvent('nagashi', { actor: p, deltas });
          if (this.shouldEmitReplayEvent()) await this.emit('nagashi', {
            player: p,
            deltas,
            state: this.publicState(),
          });
          return { renchan: p === dealer || (R.tenpaiRenchan && this.isTenpai(dealer)), ryukyoku: true };
        }
      }
    }
    const tenpai = [0, 1, 2, 3].filter(p => this.isTenpai(p));
    if (tenpai.length > 0 && tenpai.length < 4) {
      const payTotal = 3000;
      const receive = payTotal / tenpai.length;
      const pay = payTotal / (4 - tenpai.length);
      for (let p = 0; p < 4; p++) {
        this.points[p] += tenpai.includes(p) ? receive : -pay;
      }
    }
    const deltas = this.points.map((v, i) => v - before[i]);
    this.advanceDecisionState();
    this.decisionLog.appendPublicEvent('ryukyoku', {
      tochu: false,
      tenpai,
      deltas,
    });
    if (this.shouldEmitReplayEvent()) await this.emit('ryukyoku', {
      tochu: false, tenpai,
      deltas,
      revealed: tenpai.map(p => ({ player: p, hand: st.players[p].hand.map(t => ({ ...t })), melds: st.players[p].melds })),
      state: this.publicState(),
    });
    const renchan = R.tenpaiRenchan ? tenpai.includes(dealer) : false;
    return { renchan, ryukyoku: true };
  }

  isTenpai(p) {
    const pl = this.st.players[p];
    if (!this.rules.tenpaiRyukyoku && !pl.riichi) {
      // 形式聴牌なし: リーチ者のみ聴牌扱い…は過激なので、役の有無は問わず形だけで判定に留める
    }
    return shanten(toCounts(pl.hand), pl.melds.length) === 0;
  }

  // 本人のUI表示用(人間プレイヤーの自席手牌のみ参照する想定)
  handOf(p) { return this.st ? this.st.players[p].hand.map(t => ({ ...t })) : []; }

  // --- 情報公開制御 ---
  // publicState: 全員に見えるもののみ
  publicState() {
    const st = this.st;
    return {
      stateId: this.decisionLog.stateId,
      points: [...this.points],
      ranking: rankPlayers(this.points, this.initialDealer),
      kyoku: this.kyoku, roundWindIdx: this.roundWindIdx, honba: this.honba,
      initialDealer: this.initialDealer,
      dealer: this.dealerOf(),
      riichiSticks: this.riichiSticks,
      turn: st.turn, remaining: st.live.length,
      doraIndicators: this.doraIndicatorTiles().map(t => ({ ...t })),
      players: st.players.map((pl, seat) => ({
        seat,
        discards: pl.discards.map(d => ({ tile: { ...d.tile }, riichi: d.riichi, tsumogiri: !!d.tsumogiri, claimed: !!d.claimed, ...(Number.isInteger(d.seq) ? { seq: d.seq } : {}) })),
        melds: pl.melds.map(m => ({
          type: m.type,
          ...(m.from === undefined ? {} : { from: m.from }),
          ...(m.kanOrigin === undefined ? {} : { kanOrigin: m.kanOrigin }),
          ...(m.addedTileId === undefined ? {} : { addedTileId: m.addedTileId }),
          tiles: m.tiles.map(t => ({ ...t })),
        })),
        riichi: pl.riichi,
        handCount: pl.hand.length,
      })),
    };
  }

  // viewFor: 本人の手牌+公開情報のみ。他家の手牌・山・王牌(表示牌以外)は絶対に含めない。
  viewFor(p, drawn, { winPreview = null } = {}) {
    return {
      me: p,
      hand: this.st.players[p].hand.map(t => ({ ...t })),
      drawn: drawn ? { ...drawn } : null,
      melds: this.st.players[p].melds.map(m => ({
        type: m.type,
        ...(m.kanOrigin === undefined ? {} : { kanOrigin: m.kanOrigin }),
        ...(m.addedTileId === undefined ? {} : { addedTileId: m.addedTileId }),
        tiles: m.tiles.map(t => ({ ...t })),
      })),
      seatWind: this.seatWindOf(p), roundWind: this.roundWind(),
      isDealer: p === this.dealerOf(),
      riichi: this.st.players[p].riichi,
      // リーチ供託可否は公開ルールと公開点棒だけから確定する。判断記録へ
      // 残すことで、感想戦でも当時と同じ合法性を再現できる。
      riichiAffordable: this.rules.riichiBelow1000 === true || this.points[p] >= 1000,
      placement: buildPlacementContext({
        rules: this.rules,
        points: this.points,
        player: p,
        roundWindIdx: this.roundWindIdx,
        kyoku: this.kyoku,
        initialDealer: this.initialDealer,
        dealer: this.dealerOf(),
        honba: this.honba,
        riichiSticks: this.riichiSticks,
      }),
      winPreview,
      public: this.publicState(),
    };
  }
}

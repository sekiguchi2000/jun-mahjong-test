// character-select.js — 対戦相手選択画面 (v3 / 2026-09-03 ユーザー指示でフロー変更)
// 流れ: キャラをタップ → 上半分の紹介パネルに紹介文と「このキャラと対戦する」 →
//       ボタンでポップアップ「どこの卓に座らせる？」→ 席(右/正面/左)を選んで着席。
// 紹介パネルはスクロールさせない(傾向ゲージは出さない)。
// ロジックは持たない: 選択結果は onChange で呼び出し側(main.js)へ返すだけ。

import { COM_CHARACTERS, characterById, characterFaceSrc, characterFullSrc } from '../engine/com-characters.js?v=5';

export const SEAT_NAMES = Object.freeze(['右の相手', '正面の相手', '左の相手']);
export const SEAT_SHORT = Object.freeze(['右', '正面', '左']);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {object} options
 * @param {HTMLElement} options.root            #screen-characters
 * @param {HTMLDialogElement} options.seatDialog #cast-seat-dialog
 * @param {() => number} options.level
 * @param {(id: string) => number} options.unlockLevel
 * @param {() => string[]} options.selection    現在の3席のキャラid
 * @param {(ids: string[]) => void} options.onChange
 * @param {() => void} [options.onDone]
 */
export function createCharacterSelect({ root, seatDialog, level, unlockLevel, selection, onChange, onDone }) {
  const gridHost = root.querySelector('#cast-grid');
  const detailHost = root.querySelector('#cast-detail');
  const doneButton = root.querySelector('#btn-characters-done');
  const seatList = seatDialog?.querySelector('#cast-seat-list');
  const seatCancel = seatDialog?.querySelector('#cast-seat-cancel');
  let shownId = null;

  const isUnlocked = id => level() >= unlockLevel(id);
  const seatOf = id => selection().indexOf(id);

  function assign(id, seat) {
    if (!isUnlocked(id)) return false;
    const ids = [...selection()];
    const already = ids.indexOf(id);
    if (already === seat) return true;
    if (already >= 0) ids[already] = ids[seat]; // 席の入れ替え
    ids[seat] = id;
    onChange(ids);
    return true;
  }

  function faceSpan(character, className = 'cast-face') {
    const face = el('span', className);
    face.style.backgroundImage = `url('${characterFaceSrc(character)}')`;
    return face;
  }

  function openSeatDialog(character) {
    if (!seatDialog || !seatList) return;
    seatList.replaceChildren();
    const current = seatOf(character.id);
    selection().forEach((occupantId, seat) => {
      const occupant = characterById(occupantId);
      const button = el('button', 'cast-seat-choice');
      button.type = 'button';
      button.dataset.seat = String(seat);
      if (seat === current) button.classList.add('current');
      if (seat === 0) button.setAttribute('data-gamepad-default', '');
      const copy = el('span', 'cast-seat-choice-copy');
      copy.append(el('strong', '', SEAT_NAMES[seat]),
        el('small', '', seat === current ? `${character.name}が着席中` : `いまは ${occupant.name}`));
      button.append(faceSpan(occupant, 'cast-face small'), copy);
      button.addEventListener('click', () => {
        assign(character.id, seat);
        seatDialog.close();
        render();
      });
      seatList.appendChild(button);
    });
    seatDialog.showModal();
  }

  function renderGrid() {
    gridHost.replaceChildren();
    for (const character of COM_CHARACTERS) {
      const unlocked = isUnlocked(character.id);
      const seat = seatOf(character.id);
      const card = el('button', 'cast-card');
      card.type = 'button';
      card.dataset.id = character.id;
      card.classList.toggle('locked', !unlocked);
      card.classList.toggle('assigned', seat >= 0);
      card.classList.toggle('shown', character.id === shownId);
      if (character.id === shownId) card.setAttribute('data-gamepad-default', '');
      const name = el('strong', 'cast-card-name', unlocked ? character.name : '？？？');
      const sub = el('small', 'cast-card-sub', unlocked ? character.title : `Lv${unlockLevel(character.id)}で解禁`);
      card.append(faceSpan(character), name, sub);
      if (seat >= 0) card.appendChild(el('i', 'cast-badge', SEAT_SHORT[seat]));
      card.setAttribute('aria-label', unlocked
        ? `${character.name}（${character.title}）${seat >= 0 ? '・' + SEAT_NAMES[seat] : ''}`
        : `未解禁のキャラクター。Lv${unlockLevel(character.id)}で解禁`);
      card.addEventListener('click', () => { shownId = character.id; render(); });
      gridHost.appendChild(card);
    }
  }

  function renderDetail() {
    detailHost.replaceChildren();
    const character = characterById(shownId) ?? characterById(selection()[0]);
    if (!character) return;
    const unlocked = isUnlocked(character.id);
    const portrait = el('div', 'cast-portrait');
    portrait.classList.toggle('locked', !unlocked);
    portrait.style.backgroundImage = `url('${characterFullSrc(character)}')`;
    const body = el('div', 'cast-detail-body');
    if (!unlocked) {
      body.append(
        el('h3', 'cast-detail-name', '？？？'),
        el('p', 'cast-detail-title', `Lv${unlockLevel(character.id)}で解禁`),
        el('p', 'cast-intro', '対局に勝ってレベルを上げると、この打ち手が卓に着きます'),
      );
    } else {
      const seat = seatOf(character.id);
      const name = el('h3', 'cast-detail-name', character.name);
      name.appendChild(el('small', '', character.kana));
      const title = el('p', 'cast-detail-title', character.title);
      const quote = el('p', 'cast-quote', `「${character.quote}」`);
      const intro = el('p', 'cast-intro', character.intro);
      const action = el('button', 'btn primary cast-assign');
      action.type = 'button';
      action.textContent = seat >= 0 ? `${SEAT_NAMES[seat]}に着席中（席を変える）` : 'このキャラと対戦する';
      action.addEventListener('click', () => openSeatDialog(character));
      body.append(name, title, quote, intro, action);
    }
    detailHost.append(portrait, body);
  }

  function render() {
    if (!shownId) shownId = selection()[0];
    renderDetail();
    renderGrid();
  }

  doneButton?.addEventListener('click', () => onDone?.());
  seatCancel?.addEventListener('click', () => seatDialog?.close());

  return {
    render,
    open() { shownId = selection()[0]; render(); },
  };
}

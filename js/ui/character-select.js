// character-select.js — 対戦相手選択画面 (v1 / 2026-09-03)
// タイトルのOS標準<select>を置き換える。席(右/正面/左)を選んでキャラクターを割り当て、
// 紹介文・打ち筋の傾向・解禁条件を同じ画面で見せる。
// ロジックは持たない: 選択結果は onChange で呼び出し側(main.js)へ返すだけ。

import { COM_CHARACTERS, characterById, characterFaceSrc, characterFullSrc, STYLE_AXES } from '../engine/com-characters.js?v=3';

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
 * @param {() => number} options.level          現在のプレイヤーLv
 * @param {(id: string) => number} options.unlockLevel
 * @param {() => string[]} options.selection    現在の3席のキャラid
 * @param {(ids: string[]) => void} options.onChange
 * @param {() => void} [options.onDone]
 */
export function createCharacterSelect({ root, level, unlockLevel, selection, onChange, onDone }) {
  const seatsHost = root.querySelector('#cast-seats');
  const gridHost = root.querySelector('#cast-grid');
  const detailHost = root.querySelector('#cast-detail');
  const doneButton = root.querySelector('#btn-characters-done');
  let activeSeat = 0;
  let shownId = null;

  const isUnlocked = id => level() >= unlockLevel(id);

  function seatOf(id) { return selection().indexOf(id); }

  function assign(id) {
    if (!isUnlocked(id)) return false;
    const ids = [...selection()];
    const already = ids.indexOf(id);
    if (already === activeSeat) return true;
    if (already >= 0) ids[already] = ids[activeSeat]; // 席の入れ替え
    ids[activeSeat] = id;
    onChange(ids);
    activeSeat = (activeSeat + 1) % 3;
    return true;
  }

  function renderSeats() {
    seatsHost.replaceChildren();
    selection().forEach((id, seat) => {
      const character = characterById(id);
      const button = el('button', 'cast-seat');
      button.type = 'button';
      button.dataset.seat = String(seat);
      button.setAttribute('aria-pressed', String(seat === activeSeat));
      if (seat === activeSeat) button.classList.add('active');
      const face = el('span', `cast-face ${character.portrait}`);
      face.style.backgroundImage = `url('${characterFaceSrc(character)}')`;
      const copy = el('span', 'cast-seat-copy');
      copy.append(el('small', '', SEAT_NAMES[seat]), el('strong', '', character.name));
      button.append(face, copy);
      button.addEventListener('click', () => { activeSeat = seat; shownId = id; render(); });
      button.addEventListener('focus', () => { if (shownId !== id) { shownId = id; renderDetail(); } });
      seatsHost.appendChild(button);
    });
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
      if (character.id === selection()[activeSeat]) card.setAttribute('data-gamepad-default', '');
      const face = el('span', 'cast-face');
      face.style.backgroundImage = `url('${characterFaceSrc(character)}')`;
      const name = el('strong', 'cast-card-name', unlocked ? character.name : '？？？');
      const sub = el('small', 'cast-card-sub', unlocked ? character.title : `Lv${unlockLevel(character.id)}で解禁`);
      card.append(face, name, sub);
      if (seat >= 0) card.appendChild(el('i', 'cast-badge', SEAT_SHORT[seat]));
      card.setAttribute('aria-label', unlocked
        ? `${character.name}（${character.title}）${seat >= 0 ? '・' + SEAT_NAMES[seat] : ''}`
        : `未解禁のキャラクター。Lv${unlockLevel(character.id)}で解禁`);
      card.addEventListener('click', () => {
        shownId = character.id;
        if (unlocked) assign(character.id);
        render();
      });
      card.addEventListener('focus', () => { if (shownId !== character.id) { shownId = character.id; renderDetail(); renderGridState(); } });
      gridHost.appendChild(card);
    }
  }

  function renderGridState() {
    for (const card of gridHost.querySelectorAll('.cast-card')) {
      card.classList.toggle('shown', card.dataset.id === shownId);
    }
  }

  function renderDetail() {
    detailHost.replaceChildren();
    const character = characterById(shownId) ?? characterById(selection()[activeSeat]);
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
        el('p', 'cast-intro', '対局に勝ってレベルを上げると、この打ち手が卓に着きます。'),
      );
    } else {
      const head = el('div', 'cast-detail-head');
      const name = el('h3', 'cast-detail-name', character.name);
      name.appendChild(el('small', '', character.kana));
      head.append(name, el('p', 'cast-detail-title', character.title));
      const quote = el('p', 'cast-quote', `「${character.quote}」`);
      const intro = el('p', 'cast-intro', character.intro);
      const axes = el('dl', 'cast-axes');
      for (const axis of STYLE_AXES) {
        const value = character.style?.[axis.key] ?? 3;
        const dt = el('dt', '', axis.label);
        const dd = el('dd', '');
        dd.setAttribute('aria-label', `${axis.label} ${value}/5`);
        for (let i = 1; i <= 5; i += 1) dd.appendChild(el('i', i <= value ? 'on' : ''));
        axes.append(dt, dd);
      }
      const seat = seatOf(character.id);
      const action = el('button', 'btn primary cast-assign');
      action.type = 'button';
      action.textContent = seat >= 0 ? `${SEAT_NAMES[seat]}に着席中` : `${SEAT_NAMES[activeSeat]}にする`;
      action.disabled = seat >= 0;
      action.addEventListener('click', () => { assign(character.id); render(); });
      body.append(head, quote, intro, axes, action);
    }
    detailHost.append(portrait, body);
  }

  function render() {
    if (!shownId) shownId = selection()[activeSeat];
    renderSeats();
    renderGrid();
    renderDetail();
  }

  doneButton?.addEventListener('click', () => onDone?.());

  return {
    render,
    open() { activeSeat = 0; shownId = selection()[0]; render(); },
  };
}

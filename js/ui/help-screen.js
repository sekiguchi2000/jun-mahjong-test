// help-screen.js — ヘルプ画面 (v2 / 2026-09-03)
// 遊び方 / 用語 / 役一覧 / 符計算 / 点数表 の5タブ。データは engine/yaku-guide.js。
// 役と用語には牌の絵(tilesvg)で例を添える。ルール依存の項目には現在の設定を添える。

import {
  YAKU_GROUPS, FU_RULES, SCORE_RULES, HOW_TO_PLAY, GLOSSARY,
  ronPoints, SCORE_TABLE_FU, SCORE_TABLE_HAN,
} from '../engine/yaku-guide.js?v=2';
import { svgFace } from './tilesvg.js?v=10';

const TABS = Object.freeze([
  { key: 'howto', label: '遊び方' },
  { key: 'glossary', label: '用語' },
  { key: 'yaku', label: '役一覧' },
  { key: 'fu', label: '符計算' },
  { key: 'score', label: '点数表' },
]);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 牌の絵。groups = [[kind, ...], ...] 面子ごとに間を空ける。'|' 相当は配列の切れ目
export function tileRow(groups, { size = 'md', label = '' } = {}) {
  const row = el('div', `help-tiles ${size}`);
  if (label) row.appendChild(el('span', 'help-tiles-label', label));
  for (const group of groups) {
    const box = el('span', 'help-tile-group');
    for (const spec of group) {
      const kind = typeof spec === 'number' ? spec : spec.kind;
      const red = typeof spec === 'object' && spec.red === true;
      const tile = el('span', 'help-tile');
      if (typeof spec === 'object' && spec.back) { tile.classList.add('back'); }
      else tile.innerHTML = svgFace(kind, red);
      if (typeof spec === 'object' && spec.side) tile.classList.add('side');
      box.appendChild(tile);
    }
    row.appendChild(box);
  }
  return row;
}

function ruleNote(rules, key) {
  if (!rules || !(key in rules)) return '';
  const value = rules[key];
  if (key === 'akaDora') return `現在の設定: ${value ? value + '枚' : 'なし'}`;
  if (typeof value === 'boolean') return `現在の設定: ${value ? 'あり' : 'なし'}`;
  return `現在の設定: ${value}`;
}

export function renderHowTo() {
  const list = el('div', 'help-cards');
  for (const item of HOW_TO_PLAY) {
    const card = el('section', 'help-card');
    card.append(el('h3', '', item.title), el('p', '', item.body));
    if (item.tiles) card.appendChild(tileRow(item.tiles, { size: 'sm' }));
    list.appendChild(card);
  }
  return list;
}

export function renderGlossary() {
  const list = el('div', 'help-cards glossary');
  for (const item of GLOSSARY) {
    const card = el('section', 'help-card');
    const head = el('h3', '', item.term);
    if (item.kana) head.appendChild(el('small', '', item.kana));
    card.append(head, el('p', '', item.body));
    if (item.tiles) card.appendChild(tileRow(item.tiles, { size: 'sm' }));
    list.appendChild(card);
  }
  return list;
}

export function renderYaku(rules) {
  const wrap = el('div', 'help-yaku');
  wrap.appendChild(el('p', 'help-legend', '門前=鳴くと成立しない。喰い下がり=鳴くと1翻下がる。例の牌は一例です。'));
  for (const group of YAKU_GROUPS) {
    const section = el('section', 'help-group');
    section.appendChild(el('h3', '', group.title));
    const list = el('div', 'yaku-list');
    for (const item of group.items) {
      const row = el('article', 'yaku-row');
      const head = el('div', 'yaku-head');
      const name = el('strong', 'yaku-name', item.name);
      const han = el('span', 'yaku-han', item.yakuman ? '役満' : `${item.han}翻${item.kuisagari ? `（鳴くと${item.han - 1}翻）` : ''}`);
      head.append(name, han);
      if (item.menzen) head.appendChild(el('i', 'tag menzen', '門前'));
      if (item.kuisagari) head.appendChild(el('i', 'tag kui', '喰い下がり'));
      const how = el('p', 'yaku-how', item.how);
      row.append(head, how);
      if (item.example) row.appendChild(tileRow(item.example, { size: 'sm' }));
      if (item.note) row.appendChild(el('small', 'yaku-note', item.note));
      const rn = item.rule ? ruleNote(rules, item.rule) : '';
      if (rn) row.appendChild(el('small', 'yaku-note rule-note', rn));
      list.appendChild(row);
    }
    section.appendChild(list);
    wrap.appendChild(section);
  }
  return wrap;
}

export function renderFu() {
  const wrap = el('div', 'help-fu');
  const lead = el('section', 'help-card');
  lead.append(
    el('h3', '', '符とは'),
    el('p', '', '点数は「符」と「翻」の2つで決まります。翻は役とドラの合計、符はあがりの形の細かさ。符は基本20に、形の要素を足して10の位で切り上げます。5翻以上は符に関係なく満貫以上です。'),
  );
  wrap.appendChild(lead);

  const special = el('section', 'help-group');
  special.appendChild(el('h3', '', '先に決まる形'));
  const st = el('table', 'help-table');
  const stb = el('tbody');
  for (const row of FU_RULES.special) {
    const tr = el('tr');
    tr.append(el('td', '', row.label), el('td', 'num', `${row.fu}符`), el('td', '', row.note));
    stb.appendChild(tr);
  }
  st.appendChild(stb);
  special.appendChild(st);
  wrap.appendChild(special);

  const add = el('section', 'help-group');
  add.appendChild(el('h3', '', `基本${FU_RULES.base}符に足すもの`));
  const at = el('table', 'help-table');
  const atb = el('tbody');
  for (const row of FU_RULES.additions) {
    const tr = el('tr');
    tr.append(el('td', '', row.label), el('td', 'num', `+${row.fu}`), el('td', '', row.note ?? ''));
    atb.appendChild(tr);
  }
  at.appendChild(atb);
  add.appendChild(at);
  wrap.appendChild(add);

  const sets = el('section', 'help-group');
  sets.appendChild(el('h3', '', '刻子・槓子の符'));
  const tbl = el('table', 'help-table');
  const th = el('thead');
  const thr = el('tr');
  thr.append(el('th', '', ''), el('th', '', '例'), el('th', 'num', '2〜8'), el('th', 'num', '1・9・字牌'));
  th.appendChild(thr);
  const tb = el('tbody');
  for (const row of FU_RULES.sets) {
    const tr = el('tr');
    const exCell = el('td', 'tiles-cell');
    if (row.example) exCell.appendChild(tileRow([row.example], { size: 'xs' }));
    tr.append(el('td', '', row.label), exCell, el('td', 'num', `+${row.chunchan}`), el('td', 'num', `+${row.yaochu}`));
    tb.appendChild(tr);
  }
  tbl.append(th, tb);
  sets.append(tbl, el('p', 'help-note', 'ロンで完成した刻子は明刻扱い。順子と雀頭(役牌以外)は0符。'));
  wrap.appendChild(sets);

  const ex = el('section', 'help-group');
  ex.appendChild(el('h3', '', '計算例'));
  for (const row of FU_RULES.examples) {
    const card = el('div', 'fu-example');
    card.append(el('p', 'fu-example-hand', row.hand), el('p', 'fu-example-calc', row.calc));
    if (row.tiles) card.appendChild(tileRow(row.tiles, { size: 'sm' }));
    ex.appendChild(card);
  }
  ex.appendChild(el('p', 'help-note', FU_RULES.rounding));
  wrap.appendChild(ex);
  return wrap;
}

export function renderScore(rules) {
  const wrap = el('div', 'help-score');
  const lead = el('section', 'help-card');
  lead.append(el('h3', '', '計算式'), el('p', '', SCORE_RULES.formula));
  wrap.appendChild(lead);

  const limits = el('section', 'help-group');
  limits.appendChild(el('h3', '', '満貫以上'));
  const lt = el('table', 'help-table');
  const lth = el('thead');
  const lthr = el('tr');
  lthr.append(el('th', '', ''), el('th', '', '条件'), el('th', 'num', '子'), el('th', 'num', '親'));
  lth.appendChild(lthr);
  const ltb = el('tbody');
  for (const row of SCORE_RULES.limits) {
    if (row.name === '数え役満' && rules && rules.kazoeYakuman === false) continue;
    const tr = el('tr');
    tr.append(el('td', '', row.name), el('td', '', row.cond), el('td', 'num', row.ko), el('td', 'num', row.oya));
    ltb.appendChild(tr);
  }
  lt.append(lth, ltb);
  limits.appendChild(lt);
  wrap.appendChild(limits);

  const kazoe = rules ? rules.kazoeYakuman !== false : true;
  for (const dealer of [false, true]) {
    const section = el('section', 'help-group');
    section.appendChild(el('h3', '', dealer ? '親のロン点数' : '子のロン点数'));
    const scroller = el('div', 'help-scroll');
    const table = el('table', 'help-table score-table');
    const thead = el('thead');
    const tr = el('tr');
    tr.appendChild(el('th', '', '符＼翻'));
    for (const han of SCORE_TABLE_HAN) tr.appendChild(el('th', 'num', han >= 13 ? '13+' : String(han)));
    thead.appendChild(tr);
    const tbody = el('tbody');
    for (const fu of SCORE_TABLE_FU) {
      const row = el('tr');
      row.appendChild(el('th', '', `${fu}符`));
      for (const han of SCORE_TABLE_HAN) {
        const invalid = fu === 25 && han < 2;
        const cell = el('td', 'num');
        if (invalid) { cell.textContent = '—'; }
        else {
          const points = ronPoints(han, fu, { dealer, kazoeYakuman: kazoe });
          if (rules?.kiriage && ((han === 4 && fu === 30) || (han === 3 && fu === 60))) {
            cell.textContent = String(dealer ? 12000 : 8000);
            cell.classList.add('kiriage');
          } else cell.textContent = String(points);
          if (points >= (dealer ? 12000 : 8000)) cell.classList.add('limit');
        }
        row.appendChild(cell);
      }
      tbody.appendChild(row);
    }
    table.append(thead, tbody);
    scroller.appendChild(table);
    section.appendChild(scroller);
    wrap.appendChild(section);
  }
  wrap.appendChild(el('p', 'help-note', 'ツモは子が「子×1・親×2」、親が「全員×2」の合計になります(合計は同じか少し高い)。20符は平和ツモだけ、25符は七対子だけ。' + (rules?.kiriage ? ' 切り上げ満貫あり(30符4翻・60符3翻は満貫)。' : '')));
  return wrap;
}

export function createHelpScreen({ root, rules, onDone }) {
  const tabsHost = root.querySelector('#help-tabs');
  const bodyHost = root.querySelector('#help-body');
  const doneButton = root.querySelector('#btn-help-done');
  let current = 'howto';
  const renderers = {
    howto: renderHowTo, glossary: renderGlossary,
    yaku: () => renderYaku(rules?.()), fu: renderFu, score: () => renderScore(rules?.()),
  };

  function renderTabs() {
    tabsHost.replaceChildren();
    for (const tab of TABS) {
      const button = el('button', 'help-tab', tab.label);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(tab.key === current));
      if (tab.key === current) button.setAttribute('data-gamepad-default', '');
      button.addEventListener('click', () => { current = tab.key; render(); });
      tabsHost.appendChild(button);
    }
  }

  function render() {
    renderTabs();
    bodyHost.replaceChildren(renderers[current]());
    bodyHost.scrollTop = 0;
  }

  doneButton?.addEventListener('click', () => onDone?.());
  return { render, open(tab) { if (tab) current = tab; render(); } };
}

// help-screen.js — ヘルプ画面 (v1 / 2026-09-03)
// 遊び方 / 役一覧 / 符計算 / 点数早見 の4タブ。データは engine/yaku-guide.js。
// ルール依存の項目には現在のルール設定を添える。

import {
  YAKU_GROUPS, FU_RULES, SCORE_RULES, HOW_TO_PLAY,
  ronPoints, SCORE_TABLE_FU, SCORE_TABLE_HAN,
} from '../engine/yaku-guide.js?v=1';

const TABS = Object.freeze([
  { key: 'howto', label: '遊び方' },
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
    list.appendChild(card);
  }
  return list;
}

export function renderYaku(rules) {
  const wrap = el('div', 'help-yaku');
  for (const group of YAKU_GROUPS) {
    const section = el('section', 'help-group');
    section.appendChild(el('h3', '', group.title));
    const table = el('table', 'help-table yaku-table');
    const thead = el('thead');
    const hr = el('tr');
    hr.append(el('th', '', '役'), el('th', 'num', '翻'), el('th', '', '作り方'));
    thead.appendChild(hr);
    const tbody = el('tbody');
    for (const item of group.items) {
      const tr = el('tr');
      const nameCell = el('td', 'yaku-name');
      nameCell.appendChild(el('strong', '', item.name));
      const tags = el('span', 'yaku-tags');
      if (item.menzen) tags.appendChild(el('i', 'tag menzen', '門前'));
      if (item.kuisagari) tags.appendChild(el('i', 'tag kui', '喰い下がり'));
      if (tags.childElementCount) nameCell.appendChild(tags);
      const han = el('td', 'num', item.yakuman ? '役満' : `${item.han}${item.kuisagari ? '→' + (item.han - 1) : ''}`);
      const how = el('td', 'yaku-how');
      how.appendChild(el('span', '', item.how));
      if (item.note) how.appendChild(el('small', '', item.note));
      const rn = item.rule ? ruleNote(rules, item.rule) : '';
      if (rn) how.appendChild(el('small', 'rule-note', rn));
      tr.append(nameCell, han, how);
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    section.appendChild(table);
    wrap.appendChild(section);
  }
  const legend = el('p', 'help-legend', '門前=鳴くと成立しない。喰い下がり=鳴くと1翻下がる。');
  wrap.prepend(legend);
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
  thr.append(el('th', '', ''), el('th', 'num', '2〜8'), el('th', 'num', '1・9・字牌'));
  th.appendChild(thr);
  const tb = el('tbody');
  for (const row of FU_RULES.sets) {
    const tr = el('tr');
    tr.append(el('td', '', row.label), el('td', 'num', `+${row.chunchan}`), el('td', 'num', `+${row.yaochu}`));
    tb.appendChild(tr);
  }
  tbl.append(th, tb);
  sets.append(tbl, el('p', 'help-note', 'ロンで完成した刻子は明刻扱い。順子と雀頭(役牌以外)は0符。'));
  wrap.appendChild(sets);

  const ex = el('section', 'help-group');
  ex.appendChild(el('h3', '', '計算例'));
  const et = el('table', 'help-table');
  const etb = el('tbody');
  for (const row of FU_RULES.examples) {
    const tr = el('tr');
    tr.append(el('td', '', row.hand), el('td', 'num', row.calc));
    etb.appendChild(tr);
  }
  et.appendChild(etb);
  ex.append(et, el('p', 'help-note', FU_RULES.rounding));
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
        const invalid = (fu === 25 && han < 2) || (fu === 20 && han < 2 && !dealer && false);
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
  const renderers = { howto: renderHowTo, yaku: () => renderYaku(rules?.()), fu: renderFu, score: () => renderScore(rules?.()) };

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

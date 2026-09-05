// cinematics.js — リーチ／和了の演出 (v1 / 2026-09-03 ユーザー指示: 一枚絵の拡縮ではなくアニメーションで)
//
// リーチ: 宣言者のカットイン(帯+立ち絵+千点棒の映り込み+「リーチ」)→ 棒が盤面の所定位置へ
//         ちゃらんと落ちる(Web Animations API・落下は放物線+バウンド)。
// 和了:   翻数の格で演出を段階化。1〜4翻=小さな帯、満貫=カットイン、跳満=+揺れ、
//         倍満以上=カットイン+専用セリフ+強い揺れ+二重フラッシュ、役満=最高テンション。
// ここはDOMとタイミングだけ。格の判定は win-presentation.js、セリフは com-characters.js。

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sideOf(player) { return player === 1 ? 'right' : player === 3 ? 'left' : player === 2 ? 'top' : 'bottom'; }

// カットイン帯の共通ビルダー。portraitSrc が無ければ「あなた」の金プレート
function buildBand({ kind, player, name, portraitSrc, mainText, subText, line, tier }) {
  const band = el('div', `cine-band cine-${kind}`);
  band.dataset.side = sideOf(player);
  if (tier) band.dataset.tier = tier;
  const stripes = el('div', 'cine-stripes');
  const glow = el('div', 'cine-glow');
  const portraitWrap = el('div', 'cine-portrait-wrap');
  if (portraitSrc) {
    const portrait = el('div', 'cine-portrait');
    portrait.style.backgroundImage = `url('${portraitSrc}')`;
    portraitWrap.appendChild(portrait);
  } else {
    const plate = el('div', 'cine-plate', name || 'あなた');
    portraitWrap.appendChild(plate);
  }
  const copy = el('div', 'cine-copy');
  const main = el('div', 'cine-main', mainText);
  copy.appendChild(main);
  if (subText) copy.appendChild(el('div', 'cine-sub', subText));
  if (line) copy.appendChild(el('div', 'cine-line', `「${line}」`));
  const nameTag = el('div', 'cine-name', name ?? '');
  band.append(stripes, glow, portraitWrap, copy, nameTag);
  return { band, portraitWrap, copy, main };
}

/**
 * リーチ演出。
 * @param {object} o
 * @param {HTMLElement} o.host        #riichi-cutin
 * @param {number} o.player
 * @param {string} o.name
 * @param {string|null} o.portraitSrc
 * @param {string} o.line             宣言セリフ
 * @param {() => DOMRect|null} o.targetRect  棒の着地位置(卓中央の供託スロット)
 * @param {(id:string)=>void} o.playSfx
 * @param {() => void} [o.onStickLanded]
 * @param {(ms:number)=>Promise<void>} o.delay   pause対応の待ち
 */
export async function playRiichiCinematic({ host, player, name, portraitSrc, line, targetRect, playSfx, onStickLanded, delay = wait }) {
  if (!host) return;
  host.replaceChildren();
  host.classList.remove('hidden');
  const rm = reducedMotion();
  const { band } = buildBand({ kind: 'riichi', player, name, portraitSrc, mainText: 'リーチ', line });
  // 千点棒: 帯の手前に大きく、映り込み(ハイライト)が走る
  const stick = el('div', 'cine-stick');
  stick.append(el('span', 'cine-stick-red left'), el('span', 'cine-stick-body', '1000'), el('span', 'cine-stick-red right'), el('span', 'cine-stick-shine'));
  host.append(band, stick);

  const fromX = band.dataset.side === 'left' ? '-110%' : band.dataset.side === 'right' ? '110%' : '0%';
  const fromY = band.dataset.side === 'top' ? '-120%' : band.dataset.side === 'bottom' ? '120%' : '0%';
  if (!rm) {
    band.animate([
      { transform: `translate(${fromX}, ${fromY}) skewX(-8deg)`, opacity: 0 },
      { transform: 'translate(0, 0) skewX(-8deg)', opacity: 1, offset: .35 },
      { transform: 'translate(0, 0) skewX(-8deg)', opacity: 1 },
    ], { duration: 520, easing: 'cubic-bezier(.16,.9,.2,1)', fill: 'both' });
    band.querySelector('.cine-portrait-wrap')?.animate([
      { transform: 'translateX(-12%) scale(1.08)', opacity: 0 },
      { transform: 'translateX(0) scale(1)', opacity: 1 },
    ], { duration: 560, delay: 90, easing: 'cubic-bezier(.16,.9,.2,1)', fill: 'both' });
    band.querySelector('.cine-main')?.animate([
      { transform: 'scale(2.6) translateY(-.1em)', opacity: 0, filter: 'blur(6px)' },
      { transform: 'scale(.94)', opacity: 1, filter: 'blur(0)', offset: .6 },
      { transform: 'scale(1)', opacity: 1, filter: 'blur(0)' },
    ], { duration: 420, delay: 260, easing: 'cubic-bezier(.08,.9,.18,1.2)', fill: 'both' });
    stick.animate([
      { transform: 'translate(-50%, -50%) translateX(60vw) rotate(-24deg) scale(.6)', opacity: 0 },
      { transform: 'translate(-50%, -50%) translateX(0) rotate(-14deg) scale(1)', opacity: 1, offset: .55 },
      { transform: 'translate(-50%, -50%) rotate(-12deg) scale(1)', opacity: 1 },
    ], { duration: 560, delay: 140, easing: 'cubic-bezier(.16,.9,.2,1)', fill: 'both' });
    stick.querySelector('.cine-stick-shine')?.animate([
      { transform: 'translateX(-140%) skewX(-28deg)', opacity: 0 },
      { opacity: .95, offset: .4 },
      { transform: 'translateX(180%) skewX(-28deg)', opacity: 0 },
    ], { duration: 620, delay: 560, easing: 'ease-in-out', fill: 'both' });
  }
  playSfx?.('call-accent');
  await delay(rm ? 300 : 1250);

  // 帯を引き上げ、棒が盤面へ落ちる
  const start = stick.getBoundingClientRect();
  const target = targetRect?.() ?? null;
  if (!rm) {
    band.animate([
      { transform: 'translate(0,0) skewX(-8deg)', opacity: 1 },
      { transform: `translate(${fromX === '0%' ? '0%' : fromX}, ${fromY === '0%' ? '0%' : fromY}) skewX(-8deg)`, opacity: 0 },
    ], { duration: 340, easing: 'cubic-bezier(.6,0,.9,.4)', fill: 'both' });
  } else {
    band.style.opacity = '0';
  }
  if (target && !rm) {
    // 飛行用の小さな棒(卓上の棒と同じ縮尺)。開始は演出棒の中心、終点は供託スロット
    const flyer = el('div', 'cine-stick-flyer');
    flyer.append(el('span', 'cine-stick-red left'), el('span', 'cine-stick-body'), el('span', 'cine-stick-red right'));
    host.appendChild(flyer);
    const fw = Math.max(28, Math.min(64, target.width || 44));
    flyer.style.width = `${fw}px`;
    flyer.style.height = `${Math.max(5, fw * 0.16)}px`;
    const sx = start.left + start.width / 2;
    const sy = start.top + start.height / 2;
    const tx = target.left + target.width / 2;
    const ty = target.top + target.height / 2;
    flyer.style.left = `${sx}px`;
    flyer.style.top = `${sy}px`;
    const dx = tx - sx;
    const dy = ty - sy;
    stick.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'both' });
    const flight = flyer.animate([
      { transform: 'translate(-50%, -50%) translate(0, 0) rotate(-12deg) scale(3.2)', opacity: 1 },
      { transform: `translate(-50%, -50%) translate(${dx * .5}px, ${dy * .5 - Math.max(60, Math.abs(dx) * .18)}px) rotate(160deg) scale(1.6)`, opacity: 1, offset: .5 },
      { transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) rotate(352deg) scale(1)`, opacity: 1, offset: .82 },
      { transform: `translate(-50%, -50%) translate(${dx}px, ${dy - 9}px) rotate(358deg) scale(1)`, opacity: 1, offset: .9 },
      { transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) rotate(360deg) scale(1)`, opacity: 1 },
    ], { duration: 720, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'both' });
    await delay(720 * .82);
    playSfx?.('stick-drop');
    const ripple = el('div', 'cine-ripple');
    ripple.style.left = `${tx}px`;
    ripple.style.top = `${ty}px`;
    host.appendChild(ripple);
    ripple.animate([
      { transform: 'translate(-50%, -50%) scale(.3)', opacity: .9 },
      { transform: 'translate(-50%, -50%) scale(1.8)', opacity: 0 },
    ], { duration: 420, easing: 'ease-out', fill: 'both' });
    await delay(720 * .18 + 120);
    onStickLanded?.();
    // animation.finished は非表示/バックグラウンドのタブでタイムラインが止まると解決しない
    // (UI通しストレス 2026-09-05: 30半荘中29回で #riichi-cutin が15秒以上残った)。時間で進める
    flight.cancel();
    flyer.style.transform = `translate(-50%, -50%) translate(${dx}px, ${dy}px) rotate(360deg) scale(1)`;
    flyer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'both' });
    await delay(160);
  } else {
    playSfx?.('stick-drop');
    onStickLanded?.();
    await delay(rm ? 80 : 260);
  }
  host.classList.add('hidden');
  host.replaceChildren();
}

/**
 * 和了演出。scene は classifyWinPresentation の結果。
 * 返り値は待つべき合計ms(呼び出し側がpause対応の待ちで消化する)。
 */
export function buildWinCinematic({ host, scene, player, name, loserName, portraitSrc, line, tileNode, playSfx, tierLabel = null }) {
  const label = tierLabel || scene.tierLabel;
  host.replaceChildren();
  // display:none のまま animate() すると開始時刻が解決されず止まったままになる(実画診断 v124)
  host.classList.remove('hidden');
  void host.offsetWidth;
  const rm = reducedMotion();
  const tier = scene.tier; // standard | mangan | haneman | baiman | yakuman
  const compact = tier === 'standard';
  host.dataset.tier = tier;
  host.dataset.kind = scene.kind;
  host.dataset.compact = compact ? 'true' : 'false';
  const action = scene.kind === 'tsumo' ? 'ツモ' : 'ロン';

  if (compact) {
    // 1〜4翻: 帯だけ。稲妻もカットインも無し
    const band = el('div', 'cine-band cine-win-compact');
    band.dataset.side = sideOf(player);
    band.append(el('div', 'cine-stripes'));
    const copy = el('div', 'cine-copy');
    copy.append(el('div', 'cine-main', action), el('div', 'cine-sub', `${name}${loserName ? `　←　${loserName}` : ''}`),
      el('div', 'cine-score', `${scene.total.toLocaleString('ja-JP')} 点`));
    band.appendChild(copy);
    if (tileNode) { const t = el('div', 'cine-wintile'); t.appendChild(tileNode); band.appendChild(t); }
    host.appendChild(band);
    if (!rm) {
      band.animate([
        { transform: 'translateY(40px) skewX(-8deg)', opacity: 0 },
        { transform: 'translateY(0) skewX(-8deg)', opacity: 1 },
      ], { duration: 320, easing: 'cubic-bezier(.16,.9,.2,1)', fill: 'both' });
      band.querySelector('.cine-main')?.animate([
        { transform: 'scale(1.8)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 },
      ], { duration: 300, delay: 80, easing: 'cubic-bezier(.08,.9,.18,1.2)', fill: 'both' });
    }
    playSfx?.('call-accent');
    return { durationMs: rm ? 400 : 1500, shake: false };
  }

  // 満貫以上: フラッシュ+稲妻フレーム+カットイン帯(立ち絵・格・セリフ)
  const flash = el('div', 'cine-flash');
  const frame = el('div', 'cine-frame');
  const aura = el('div', 'cine-aura');
  const particles = el('div', 'cine-particles');
  for (let i = 0; i < scene.particleCount; i++) {
    const p = el('i', 'cine-particle');
    p.style.setProperty('--angle', `${(i * 137.508) % 360}deg`);
    p.style.animationDelay = `${(i % 7) * 24}ms`;
    particles.appendChild(p);
  }
  const { band } = buildBand({
    kind: 'win', player, name, portraitSrc, tier,
    mainText: action, subText: `${label}　${scene.total.toLocaleString('ja-JP')}点${loserName ? `　←　${loserName}` : ''}`,
    line: (tier === 'baiman' || tier === 'yakuman') ? line : null,
  });
  const tierStamp = el('div', 'cine-tier-stamp', label);
  host.append(aura, frame, flash, particles, band, tierStamp);
  if (tileNode) { const t = el('div', 'cine-wintile big'); t.appendChild(tileNode); host.appendChild(t); }

  const fromX = band.dataset.side === 'left' ? '-110%' : band.dataset.side === 'right' ? '110%' : '0%';
  const fromY = band.dataset.side === 'top' ? '-120%' : band.dataset.side === 'bottom' ? '120%' : '0%';
  const heavy = tier === 'baiman' || tier === 'yakuman';
  if (!rm) {
    band.animate([
      { transform: `translate(${fromX}, ${fromY}) skewX(-8deg)`, opacity: 0 },
      { transform: 'translate(0,0) skewX(-8deg)', opacity: 1, offset: .4 },
      { transform: 'translate(0,0) skewX(-8deg)', opacity: 1 },
    ], { duration: heavy ? 640 : 520, delay: 120, easing: 'cubic-bezier(.16,.9,.2,1)', fill: 'both' });
    band.querySelector('.cine-portrait-wrap')?.animate([
      { transform: 'translateX(-10%) scale(1.12)', opacity: 0 },
      { transform: 'translateX(0) scale(1)', opacity: 1 },
    ], { duration: 640, delay: 200, easing: 'cubic-bezier(.16,.9,.2,1)', fill: 'both' });
    band.querySelector('.cine-main')?.animate([
      { transform: 'scale(2.8)', opacity: 0, filter: 'blur(8px)' },
      { transform: 'scale(.94)', opacity: 1, filter: 'blur(0)', offset: .6 },
      { transform: 'scale(1)', opacity: 1, filter: 'blur(0)' },
    ], { duration: 460, delay: 360, easing: 'cubic-bezier(.08,.9,.18,1.2)', fill: 'both' });
    const lineNode = band.querySelector('.cine-line');
    lineNode?.animate([
      { transform: 'translateY(10px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 },
    ], { duration: 380, delay: 900, easing: 'ease-out', fill: 'both' });
    tierStamp.animate([
      { transform: 'translate(-50%, -50%) scale(4) rotate(-12deg)', opacity: 0 },
      { transform: 'translate(-50%, -50%) scale(.9) rotate(-8deg)', opacity: 1, offset: .55 },
      { transform: 'translate(-50%, -50%) scale(1.05) rotate(-8deg)', opacity: 1, offset: .75 },
      { transform: 'translate(-50%, -50%) scale(1) rotate(-8deg)', opacity: 1 },
    ], { duration: 520, delay: heavy ? 1150 : 900, easing: 'cubic-bezier(.16,1.2,.3,1)', fill: 'both' });
    if (heavy) {
      flash.animate([
        { opacity: 0 }, { opacity: .95, offset: .06 }, { opacity: 0, offset: .3 }, { opacity: .8, offset: .36 }, { opacity: 0 },
      ], { duration: 900, fill: 'both' });
    }
  }
  playSfx?.('call-accent');
  if (heavy) setTimeout(() => playSfx?.(tier === 'yakuman' ? 'yakuman-hit' : 'slam'), rm ? 0 : 1150);
  const durationMs = rm ? 500 : { mangan: 3000, haneman: 3600, baiman: 4400, yakuman: 5800 }[tier] ?? 3000;
  return { durationMs, shake: scene.screenShake, shakeClass: tier === 'yakuman' ? 'cine-shake-max' : heavy ? 'cine-shake-strong' : 'cine-shake' };
}

// リザルト: 役を1つずつ数え、翻数カウンターを回し、満貫以上なら限度名を「めり込ませる」
export async function playResultReveal({ overlay, hanCounter, delay = wait, playSfx, onSlam }) {
  if (!overlay) return;
  const steps = [...overlay.querySelectorAll('.reveal-step')];
  if (steps.length === 0) return;
  const rm = reducedMotion();
  for (const step of steps) step.classList.add('reveal-pending');
  let skipped = rm;
  const skip = () => { skipped = true; };
  overlay.addEventListener('pointerdown', skip, { once: true });
  let han = 0;
  for (const step of steps) {
    if (!skipped) {
      const beat = step.classList.contains('reveal-slam') ? 560
        : step.classList.contains('reveal-pop') ? 400
        : 160;
      await delay(beat);
    }
    if (skipped) {
      for (const rest of steps) { rest.classList.remove('reveal-pending'); rest.classList.add('reveal-instant'); }
      if (hanCounter) hanCounter.textContent = hanCounter.dataset.finalText ?? '';
      break;
    }
    step.classList.remove('reveal-pending');
    step.classList.add('reveal-shown');
    if (step.classList.contains('yaku-line')) {
      const add = Number(step.dataset.han ?? 0);
      if (hanCounter && add > 0) {
        han += add;
        hanCounter.textContent = `${han}翻`;
        hanCounter.animate([{ transform: 'scale(1.5)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'ease-out' });
      }
      playSfx?.('ui-button');
    }
    if (step.classList.contains('limit-name')) {
      if (hanCounter) hanCounter.textContent = hanCounter.dataset.finalText ?? hanCounter.textContent;
      playSfx?.('slam');
      onSlam?.(step);
    }
  }
  if (hanCounter && !skipped) hanCounter.textContent = hanCounter.dataset.finalText ?? hanCounter.textContent;
  overlay.removeEventListener('pointerdown', skip);
}

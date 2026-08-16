// gamepad-controller.js — Steam向け標準ゲームパッド入力とDOMフォーカス移動
//
// UI側は原則として既存のbutton/input/selectを使えば操作対象になる。
// 特別な画面は次の属性で振る舞いを明示できる。
//   data-gamepad-scope / data-gamepad-active="true" : 最前面の操作スコープ
//   data-gamepad-default                         : スコープを開いた直後の初期位置
//   data-gamepad-group="hand"                   : 左右を一次元移動するグループ
//   data-gamepad-back                            : Bボタンで押す要素
//   data-gamepad-menu                            : Menuボタンで押す要素
//   data-gamepad-prev / data-gamepad-next        : LB/RBで押す要素
//   data-gamepad-shortcut                         : 空間focusから除外する専用ボタン
// 既存の #my-hand、#action-bar、#review-dialog には属性なしでも対応する。

export const GAMEPAD_EVENTS = Object.freeze({
  connectionChange: 'jun:gamepadconnectionchange',
  input: 'jun:gamepadinput',
  back: 'jun:gamepadback',
  menu: 'jun:gamepadmenu',
  noCalls: 'jun:gamepadtogglenocalls',
});

export const DEFAULT_GAMEPAD_OPTIONS = Object.freeze({
  deadzone: 0.52,
  repeatDelayMs: 330,
  repeatIntervalMs: 105,
  scrollMarginPx: 12,
});

const DIRECTIONS = Object.freeze(['up', 'down', 'left', 'right']);
const ACTIVATE_KEYS = Object.freeze(['a', 'b', 'x', 'menu', 'lb', 'rb']);
const FOCUSABLE_SELECTOR = [
  '[data-gamepad-focus]:not([data-gamepad-focus="false"])',
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '#my-hand .tile.selectable',
  '.tile.selectable',
].join(',');

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pressed(button) {
  if (typeof button === 'number') return button >= 0.5;
  return Boolean(button?.pressed || finite(button?.value) >= 0.5);
}

export function normalizeAxis(value, deadzone = DEFAULT_GAMEPAD_OPTIONS.deadzone) {
  const raw = clamp(finite(value), -1, 1);
  const zone = clamp(finite(deadzone, DEFAULT_GAMEPAD_OPTIONS.deadzone), 0, 0.95);
  const magnitude = Math.abs(raw);
  if (magnitude <= zone) return 0;
  const normalized = (magnitude - zone) / (1 - zone);
  return Math.sign(raw) * clamp(normalized, 0, 1);
}

/**
 * Standard Gamepad mappingをUIが扱う不変snapshotへ変換する。
 * axesの値はdeadzone除去後、方向判定は生値がdeadzoneを越えた時点で有効になる。
 */
export function readStandardGamepad(gamepad, deadzone = DEFAULT_GAMEPAD_OPTIONS.deadzone) {
  const buttons = gamepad?.buttons ?? [];
  const axes = gamepad?.axes ?? [];
  const rawX = clamp(finite(axes[0]), -1, 1);
  const rawY = clamp(finite(axes[1]), -1, 1);
  const zone = clamp(finite(deadzone, DEFAULT_GAMEPAD_OPTIONS.deadzone), 0, 0.95);
  return Object.freeze({
    index: Number.isInteger(gamepad?.index) ? gamepad.index : -1,
    id: String(gamepad?.id ?? ''),
    connected: gamepad?.connected !== false,
    timestamp: finite(gamepad?.timestamp),
    axisX: normalizeAxis(rawX, zone),
    axisY: normalizeAxis(rawY, zone),
    stickLeft: rawX < -zone,
    stickRight: rawX > zone,
    stickUp: rawY < -zone,
    stickDown: rawY > zone,
    dpadUp: pressed(buttons[12]),
    dpadDown: pressed(buttons[13]),
    dpadLeft: pressed(buttons[14]),
    dpadRight: pressed(buttons[15]),
    a: pressed(buttons[0]),
    b: pressed(buttons[1]),
    x: pressed(buttons[2]),
    y: pressed(buttons[3]),
    lb: pressed(buttons[4]),
    rb: pressed(buttons[5]),
    view: pressed(buttons[8]),
    menu: pressed(buttons[9]),
  });
}

/** D-padを優先し、アナログスティックは振れの大きい軸だけを採用する。 */
export function navigationDirection(state) {
  if (!state) return null;
  if (state.dpadUp) return 'up';
  if (state.dpadDown) return 'down';
  if (state.dpadLeft) return 'left';
  if (state.dpadRight) return 'right';
  const horizontal = Math.abs(finite(state.axisX));
  const vertical = Math.abs(finite(state.axisY));
  if (horizontal === 0 && vertical === 0) return null;
  if (horizontal > vertical) return state.stickLeft ? 'left' : state.stickRight ? 'right' : null;
  return state.stickUp ? 'up' : state.stickDown ? 'down' : null;
}

/** 接続・復帰直後の誤操作防止に使う。実際に割り当てた全入力のreleaseを要求する。 */
export function isNeutralGamepadState(state) {
  if (!state) return true;
  const anyDirection = DIRECTIONS.some(direction => {
    const title = direction[0].toUpperCase() + direction.slice(1);
    return Boolean(state[`dpad${title}`] || state[`stick${title}`]);
  });
  return !anyDirection && ACTIVATE_KEYS.every(key => !state[key]);
}

export class InputRepeater {
  constructor({
    delayMs = DEFAULT_GAMEPAD_OPTIONS.repeatDelayMs,
    intervalMs = DEFAULT_GAMEPAD_OPTIONS.repeatIntervalMs,
  } = {}) {
    this.delayMs = Math.max(0, finite(delayMs, DEFAULT_GAMEPAD_OPTIONS.repeatDelayMs));
    this.intervalMs = Math.max(16, finite(intervalMs, DEFAULT_GAMEPAD_OPTIONS.repeatIntervalMs));
    this.held = new Map();
  }

  update(key, isPressed, now, allowRepeat = false) {
    const time = finite(now);
    const prior = this.held.get(key);
    if (!isPressed) {
      this.held.delete(key);
      return false;
    }
    if (!prior || time < prior.startedAt) {
      this.held.set(key, { startedAt: time, nextAt: time + this.delayMs });
      return true;
    }
    if (!allowRepeat || time < prior.nextAt) return false;
    const elapsed = time - prior.nextAt;
    prior.nextAt += (Math.floor(elapsed / this.intervalMs) + 1) * this.intervalMs;
    return true;
  }

  reset() {
    this.held.clear();
  }
}

function rectCenter(rect) {
  const left = finite(rect?.left, finite(rect?.x));
  const top = finite(rect?.top, finite(rect?.y));
  const width = Math.max(0, finite(rect?.width, finite(rect?.right) - left));
  const height = Math.max(0, finite(rect?.height, finite(rect?.bottom) - top));
  return { x: left + width / 2, y: top + height / 2, width, height };
}

/**
 * 画面上の幾何だけで次の要素を選ぶ。候補順は同点時の決定性にのみ使用する。
 * 進行方向から45度以上外れた候補にも到達できるが、直線上の候補を強く優先する。
 */
export function chooseSpatialIndex(rects, currentIndex, direction) {
  if (!Array.isArray(rects) || !DIRECTIONS.includes(direction)) return -1;
  if (currentIndex < 0 || currentIndex >= rects.length) return rects.length > 0 ? 0 : -1;
  const origin = rectCenter(rects[currentIndex]);
  let bestIndex = -1;
  let bestScore = Infinity;
  for (let index = 0; index < rects.length; index++) {
    if (index === currentIndex) continue;
    const candidate = rectCenter(rects[index]);
    const dx = candidate.x - origin.x;
    const dy = candidate.y - origin.y;
    let primary;
    let secondary;
    if (direction === 'left') { primary = -dx; secondary = Math.abs(dy); }
    else if (direction === 'right') { primary = dx; secondary = Math.abs(dy); }
    else if (direction === 'up') { primary = -dy; secondary = Math.abs(dx); }
    else { primary = dy; secondary = Math.abs(dx); }
    if (primary <= 0.5) continue;
    const anglePenalty = secondary / Math.max(1, primary);
    const distance = Math.hypot(primary, secondary);
    const score = distance + secondary * 2.5 + anglePenalty * 80;
    if (score < bestScore - 0.001) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

export function nextLinearIndex(length, currentIndex, delta, wrap = false) {
  const size = Math.max(0, Math.trunc(finite(length)));
  if (size === 0) return -1;
  const current = clamp(Math.trunc(finite(currentIndex)), 0, size - 1);
  const next = current + Math.sign(finite(delta));
  if (wrap) return (next + size) % size;
  return clamp(next, 0, size - 1);
}

function nativeFocusable(element) {
  const name = String(element?.tagName ?? '').toLowerCase();
  return ['button', 'input', 'select', 'textarea', 'a'].includes(name);
}

function elementGroup(element) {
  const explicit = element?.closest?.('[data-gamepad-group]');
  if (explicit?.dataset?.gamepadGroup) return explicit.dataset.gamepadGroup;
  if (element?.closest?.('#my-hand')) return 'hand';
  if (element?.closest?.('#action-bar')) return 'actions';
  if (element?.closest?.('#review-timeline-list')) return 'review-timeline';
  return null;
}

function isAvailable(element, windowObject) {
  if (!element || element.disabled || element.hidden) return false;
  if (element.getAttribute?.('aria-disabled') === 'true') return false;
  if (element.getAttribute?.('aria-hidden') === 'true') return false;
  if (element.closest?.('.hidden, [hidden], [inert], [aria-hidden="true"]')) return false;
  const style = windowObject?.getComputedStyle?.(element);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  const rect = element.getBoundingClientRect?.();
  if (rect && finite(rect.width) <= 0 && finite(rect.height) <= 0) return false;
  return true;
}

function safeClick(element) {
  if (!element || element.disabled) return false;
  if (typeof element.click === 'function') {
    element.click();
    return true;
  }
  return false;
}

function queryLast(root, selector, predicate = () => true) {
  const matches = Array.from(root?.querySelectorAll?.(selector) ?? []).filter(predicate);
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

export class GamepadController {
  constructor(options = {}) {
    this.window = options.window ?? globalThis.window ?? null;
    this.document = options.document ?? this.window?.document ?? globalThis.document ?? null;
    this.navigator = options.navigator ?? this.window?.navigator ?? globalThis.navigator ?? null;
    this.options = {
      ...DEFAULT_GAMEPAD_OPTIONS,
      ...options,
    };
    this.now = options.now ?? (() => this.window?.performance?.now?.() ?? Date.now());
    this.requestFrame = options.requestAnimationFrame
      ?? this.window?.requestAnimationFrame?.bind(this.window)
      ?? (callback => setTimeout(() => callback(this.now()), 16));
    this.cancelFrame = options.cancelAnimationFrame
      ?? this.window?.cancelAnimationFrame?.bind(this.window)
      ?? clearTimeout;
    this.repeater = new InputRepeater({
      delayMs: this.options.repeatDelayMs,
      intervalMs: this.options.repeatIntervalMs,
    });
    this.activeGamepadIndex = null;
    this.connected = false;
    this.awaitNeutral = false;
    this.running = false;
    this.frameHandle = null;
    this.currentFocus = null;
    this.lastScope = null;
    this.focusMemory = new WeakMap();
    this.generatedTabIndex = new WeakMap();
    this.reducedMotion = Boolean(this.window?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
    this.boundFrame = timestamp => this.poll(timestamp);
    this.boundConnected = event => this.setConnection(event?.gamepad ?? null);
    this.boundDisconnected = event => this.handleDisconnect(event?.gamepad ?? null);
    this.boundVisibility = () => this.handleVisibility();
    this.mutationObserver = null;
  }

  start() {
    if (this.running || !this.document) return this;
    this.running = true;
    this.window?.addEventListener?.('gamepadconnected', this.boundConnected);
    this.window?.addEventListener?.('gamepaddisconnected', this.boundDisconnected);
    this.document.addEventListener?.('visibilitychange', this.boundVisibility);
    const Observer = this.window?.MutationObserver ?? globalThis.MutationObserver;
    if (Observer && this.document.body) {
      this.mutationObserver = new Observer(() => this.reconcileFocus());
      this.mutationObserver.observe(this.document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class', 'open', 'disabled', 'hidden', 'data-gamepad-active'],
      });
    }
    this.updateConnectionPresentation(null);
    if (!this.document.hidden) this.schedule();
    return this;
  }

  destroy() {
    if (!this.running) return;
    this.running = false;
    if (this.frameHandle !== null) this.cancelFrame(this.frameHandle);
    this.frameHandle = null;
    this.window?.removeEventListener?.('gamepadconnected', this.boundConnected);
    this.window?.removeEventListener?.('gamepaddisconnected', this.boundDisconnected);
    this.document?.removeEventListener?.('visibilitychange', this.boundVisibility);
    this.mutationObserver?.disconnect?.();
    this.mutationObserver = null;
    this.repeater.reset();
    this.clearFocus();
    this.lastScope = null;
    this.focusMemory = new WeakMap();
  }

  schedule() {
    if (!this.running || this.frameHandle !== null || this.document?.hidden) return;
    this.frameHandle = this.requestFrame(this.boundFrame);
  }

  poll(timestamp = this.now()) {
    this.frameHandle = null;
    if (!this.running || this.document?.hidden) return;
    let pads = [];
    try { pads = Array.from(this.navigator?.getGamepads?.() ?? []).filter(Boolean); } catch { pads = []; }
    const selected = pads.find(pad => pad.index === this.activeGamepadIndex) ?? pads[0] ?? null;
    if (selected) {
      if (!this.connected || selected.index !== this.activeGamepadIndex) this.setConnection(selected);
      this.processSnapshot(readStandardGamepad(selected, this.options.deadzone), timestamp);
    } else if (this.connected) {
      this.setConnection(null);
    }
    this.schedule();
  }

  processSnapshot(snapshot, timestamp = this.now()) {
    if (this.awaitNeutral) {
      this.repeater.reset();
      if (isNeutralGamepadState(snapshot)) this.awaitNeutral = false;
      return;
    }
    const direction = navigationDirection(snapshot);
    for (const candidate of DIRECTIONS) {
      if (this.repeater.update(candidate, direction === candidate, timestamp, true)) this.handleInput(candidate);
    }
    for (const key of ACTIVATE_KEYS) {
      if (this.repeater.update(key, Boolean(snapshot?.[key]), timestamp, false)) this.handleInput(key);
    }
  }

  handleInput(action) {
    let handled = false;
    if (DIRECTIONS.includes(action)) handled = this.move(action);
    else if (action === 'a') handled = this.activate();
    else if (action === 'b') handled = this.back();
    else if (action === 'x') handled = this.toggleNoCalls();
    else if (action === 'menu') handled = this.menu();
    else if (action === 'lb') handled = this.page(-1);
    else if (action === 'rb') handled = this.page(1);
    this.dispatch(GAMEPAD_EVENTS.input, { action, handled, gamepadIndex: this.activeGamepadIndex }, false);
    return handled;
  }

  resolveScope() {
    if (!this.document) return null;
    // 同時に複数の操作候補がDOMに残っても、最前面だけを入力対象にする。
    // pause > review > result > coach detail > thought > claim > turn > board > title の順は製品入力契約。
    const prioritySelectors = [
      '[data-gamepad-scope="pause"][data-gamepad-active="true"], #pause-dialog[open]',
      '[data-gamepad-scope="review"][data-gamepad-active="true"], #review-dialog[open]',
      '[data-gamepad-scope="result"][data-gamepad-active="true"], #overlay:not(.hidden)',
      '[data-gamepad-scope="coach-detail"][data-gamepad-active="true"], #coach-detail-dialog[open]',
      '[data-gamepad-scope="thought"][data-gamepad-active="true"]',
      '[data-gamepad-scope="claim"][data-gamepad-active="true"], #action-bar.claim-mode',
    ];
    for (const selector of prioritySelectors) {
      const scope = queryLast(this.document, selector, element => isAvailable(element, this.window));
      if (scope) return scope;
    }
    const genericModal = queryLast(this.document, 'dialog[open]', element => isAvailable(element, this.window));
    if (genericModal) return genericModal;
    const explicit = queryLast(
      this.document,
      '[data-gamepad-scope][data-gamepad-active="true"]',
      element => isAvailable(element, this.window),
    );
    if (explicit) return explicit;
    // 手牌と手番ボタンは別DOMなので、turn中だけは両方を含むgame screenを返す。
    const turn = queryLast(this.document, '#action-bar.turn-mode', element => isAvailable(element, this.window));
    if (turn) return turn.closest?.('#screen-game') ?? turn.parentElement ?? turn;
    const screen = queryLast(this.document, '.screen:not(.hidden)', element => isAvailable(element, this.window));
    return screen ?? this.document.body ?? this.document.documentElement;
  }

  focusables(scope = this.resolveScope()) {
    if (!scope) return [];
    const found = Array.from(scope.querySelectorAll?.(FOCUSABLE_SELECTOR) ?? []);
    if (scope.matches?.(FOCUSABLE_SELECTOR)) found.unshift(scope);
    return [...new Set(found)].filter(element =>
      isAvailable(element, this.window) && !element.closest?.('[data-gamepad-shortcut]'));
  }

  reconcileFocus() {
    if (!this.connected) return;
    const scope = this.resolveScope();
    const items = this.focusables(scope);
    if (scope !== this.lastScope) {
      if (this.lastScope && this.currentFocus) this.focusMemory.set(this.lastScope, this.currentFocus);
      this.clearFocus();
      this.lastScope = scope;
    }
    if (items.length === 0) {
      this.clearFocus();
      return;
    }
    if (this.currentFocus && items.includes(this.currentFocus)) return;
    const remembered = scope ? this.focusMemory.get(scope) : null;
    const defaultItem = items.find(item => item.hasAttribute?.('data-gamepad-default'));
    const forceDefault = scope?.getAttribute?.('data-gamepad-scope') === 'thought';
    const preferred = (forceDefault ? defaultItem : null)
      ?? (remembered && items.includes(remembered) ? remembered : null)
      ?? defaultItem
      ?? items.find(item => item.getAttribute?.('aria-current') === 'true')
      ?? items.find(item => item.classList?.contains('lifted'))
      ?? items.find(item => item.id === 'btn-start')
      ?? (scope?.querySelector?.('#action-bar.turn-mode')
        ? [...items].reverse().find(item => elementGroup(item) === 'hand')
        : null)
      ?? (items.every(item => elementGroup(item) === 'hand') ? items.at(-1) : items[0]);
    this.focusElement(preferred);
  }

  move(direction) {
    const scope = this.resolveScope();
    if (scope !== this.lastScope) this.reconcileFocus();
    const items = this.focusables(scope);
    if (items.length === 0) return false;
    let currentIndex = items.indexOf(this.currentFocus);
    if (currentIndex < 0) currentIndex = items.indexOf(this.document?.activeElement);
    if (currentIndex < 0) {
      this.reconcileFocus();
      return Boolean(this.currentFocus);
    }
    const current = items[currentIndex];
    if ((direction === 'left' || direction === 'right') &&
        String(current.tagName ?? '').toLowerCase() === 'input' &&
        String(current.type ?? current.getAttribute?.('type') ?? '').toLowerCase() === 'range') {
      return this.adjustRange(current, direction === 'right' ? 1 : -1);
    }
    const group = elementGroup(current);
    let nextIndex = -1;
    if ((direction === 'left' || direction === 'right') && group) {
      const groupItems = items.filter(item => elementGroup(item) === group);
      const localIndex = groupItems.indexOf(current);
      const localNext = nextLinearIndex(groupItems.length, localIndex, direction === 'left' ? -1 : 1, false);
      const next = groupItems[localNext];
      if (next && next !== current) nextIndex = items.indexOf(next);
    }
    if (nextIndex < 0) {
      const rects = items.map(item => item.getBoundingClientRect?.() ?? {});
      nextIndex = chooseSpatialIndex(rects, currentIndex, direction);
    }
    if (nextIndex < 0 || nextIndex === currentIndex) return false;
    this.focusElement(items[nextIndex]);
    return true;
  }

  focusElement(element) {
    if (!element || element === this.currentFocus) return Boolean(element);
    this.clearFocus();
    this.currentFocus = element;
    element.classList?.add('gamepad-focus');
    element.setAttribute?.('data-gamepad-focused', 'true');
    if (!nativeFocusable(element) && !element.hasAttribute?.('tabindex')) {
      this.generatedTabIndex.set(element, null);
      element.setAttribute?.('tabindex', '-1');
    }
    try { element.focus?.({ preventScroll: true }); } catch { element.focus?.(); }
    try {
      element.scrollIntoView?.({
        block: 'nearest',
        inline: 'nearest',
        behavior: this.reducedMotion ? 'auto' : 'smooth',
      });
    } catch { element.scrollIntoView?.(); }
    return true;
  }

  clearFocus() {
    const element = this.currentFocus;
    if (!element) return;
    element.classList?.remove('gamepad-focus');
    element.removeAttribute?.('data-gamepad-focused');
    if (this.generatedTabIndex.has(element)) {
      element.removeAttribute?.('tabindex');
      this.generatedTabIndex.delete(element);
    }
    this.currentFocus = null;
  }

  activate() {
    if (this.resolveScope() !== this.lastScope) this.reconcileFocus();
    if (!this.currentFocus || !isAvailable(this.currentFocus, this.window)) this.reconcileFocus();
    const element = this.currentFocus;
    if (!element) return false;
    const tag = String(element.tagName ?? '').toLowerCase();
    if (tag === 'select') {
      const options = Array.from(element.options ?? []).filter(option => !option.disabled);
      if (options.length === 0) return false;
      const current = Math.max(0, options.indexOf(element.selectedOptions?.[0]));
      const next = options[nextLinearIndex(options.length, current, 1, true)];
      element.value = next.value;
      this.fireChange(element);
      return true;
    }
    return safeClick(element);
  }

  adjustRange(element, delta) {
    const before = Number(element.value);
    try {
      if (delta > 0 && typeof element.stepUp === 'function') element.stepUp();
      else if (delta < 0 && typeof element.stepDown === 'function') element.stepDown();
      else {
        const minimum = Number.isFinite(Number(element.min)) ? Number(element.min) : 0;
        const maximum = Number.isFinite(Number(element.max)) ? Number(element.max) : 100;
        const parsedStep = Number(element.step);
        const step = Number.isFinite(parsedStep) && parsedStep > 0 ? parsedStep : 1;
        const current = Number.isFinite(before) ? before : minimum;
        element.value = String(Math.min(maximum, Math.max(minimum, current + delta * step)));
      }
    } catch {
      return true;
    }
    if (Number(element.value) !== before) this.fireChange(element);
    return true;
  }

  back() {
    if (!this.dispatch(GAMEPAD_EVENTS.back, { scope: this.resolveScope() }, true)) return true;
    const scope = this.resolveScope();
    const backButton = scope?.querySelector?.(
      '[data-gamepad-back]:not([disabled]), #review-close:not([disabled]), #btn-rules-done:not([disabled])',
    );
    if (backButton && isAvailable(backButton, this.window)) return safeClick(backButton);
    if (scope?.matches?.('#action-bar.claim-mode, [data-gamepad-scope="claim"]')) {
      const pass = scope.querySelector?.('.act-btn.pass:not([disabled])');
      if (pass && isAvailable(pass, this.window)) return safeClick(pass);
    }
    const dialog = scope?.matches?.('dialog[open]') ? scope : null;
    if (dialog) {
      const EventConstructor = this.window?.Event ?? globalThis.Event;
      let cancelEvent = null;
      try { cancelEvent = new EventConstructor('cancel', { cancelable: true }); } catch { /* old WebView */ }
      const shouldClose = cancelEvent ? dialog.dispatchEvent?.(cancelEvent) !== false : true;
      if (shouldClose && dialog.open && typeof dialog.close === 'function') dialog.close();
      return true;
    }
    return false;
  }

  menu() {
    if (!this.dispatch(GAMEPAD_EVENTS.menu, { scope: this.resolveScope() }, true)) return true;
    const scope = this.resolveScope();
    const menuButton = scope?.querySelector?.(
      '[data-gamepad-menu]:not([disabled]), #btn-pause:not([disabled]), #btn-menu:not([disabled])',
    ) ?? this.document?.querySelector?.('[data-gamepad-menu]:not([disabled]), #btn-pause:not([disabled]), #btn-menu:not([disabled])');
    return menuButton && isAvailable(menuButton, this.window) ? safeClick(menuButton) : false;
  }

  toggleNoCalls() {
    return !this.dispatch(GAMEPAD_EVENTS.noCalls, {
      scope: this.resolveScope(),
      gamepadIndex: this.activeGamepadIndex,
    }, true);
  }

  page(delta) {
    const scope = this.resolveScope();
    const selector = delta < 0
      ? '[data-gamepad-prev]:not([disabled]), #review-prev:not([disabled])'
      : '[data-gamepad-next]:not([disabled]), #review-next:not([disabled])';
    const button = scope?.querySelector?.(selector);
    return button && isAvailable(button, this.window) ? safeClick(button) : false;
  }

  fireChange(element) {
    const EventConstructor = this.window?.Event ?? globalThis.Event;
    try {
      element.dispatchEvent?.(new EventConstructor('input', { bubbles: true }));
      element.dispatchEvent?.(new EventConstructor('change', { bubbles: true }));
    } catch { /* 古いWebViewではvalue更新だけを維持 */ }
  }

  handleVisibility() {
    this.repeater.reset();
    this.awaitNeutral = true;
    if (this.document?.hidden) {
      if (this.frameHandle !== null) this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
      return;
    }
    this.schedule();
  }

  handleDisconnect(gamepad) {
    if (gamepad && gamepad.index !== this.activeGamepadIndex) return;
    this.setConnection(null);
  }

  setConnection(gamepad) {
    const wasConnected = this.connected;
    const previousIndex = this.activeGamepadIndex;
    this.connected = Boolean(gamepad);
    this.activeGamepadIndex = gamepad ? gamepad.index : null;
    this.repeater.reset();
    this.awaitNeutral = true;
    this.updateConnectionPresentation(gamepad);
    if (wasConnected !== this.connected || previousIndex !== this.activeGamepadIndex) {
      this.dispatch(GAMEPAD_EVENTS.connectionChange, {
        connected: this.connected,
        index: this.activeGamepadIndex,
        id: String(gamepad?.id ?? ''),
      }, false);
    }
    if (this.connected) this.reconcileFocus();
  }

  updateConnectionPresentation(gamepad) {
    const root = this.document?.documentElement;
    if (root?.dataset) root.dataset.gamepad = gamepad ? 'connected' : 'disconnected';
    const status = this.document?.querySelector?.('[data-gamepad-status]');
    if (status) {
      status.textContent = gamepad ? `コントローラー接続: ${String(gamepad.id || 'Gamepad')}` : 'コントローラー未接続';
      status.dataset.state = gamepad ? 'connected' : 'disconnected';
    }
  }

  dispatch(name, detail, cancelable) {
    const target = this.document;
    if (!target?.dispatchEvent) return true;
    const CustomEventConstructor = this.window?.CustomEvent ?? globalThis.CustomEvent;
    let event = null;
    try {
      event = new CustomEventConstructor(name, { bubbles: true, cancelable, detail });
    } catch {
      event = this.document.createEvent?.('CustomEvent') ?? null;
      event?.initCustomEvent?.(name, true, cancelable, detail);
    }
    return event ? target.dispatchEvent(event) !== false : true;
  }
}

export function installGamepadController(options = {}) {
  return new GamepadController(options).start();
}

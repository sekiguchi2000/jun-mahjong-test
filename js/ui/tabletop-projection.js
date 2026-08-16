/**
 * Pure seat-local geometry for every object placed on the table.
 *
 * R is the owner's left-to-right axis; +R always ends at that player's
 * physical right edge. I points from the owner into the table. Consumers may
 * scale these unit vectors to pixels, but must not invent a second seat basis.
 */
const RAW_SEAT_BASIS = [
  { name: 'bottom', R: { x: 1, y: 0 }, I: { x: 0, y: -1 } },
  { name: 'right', R: { x: 0, y: -1 }, I: { x: -1, y: 0 } },
  { name: 'top', R: { x: -1, y: 0 }, I: { x: 0, y: 1 } },
  { name: 'left', R: { x: 0, y: 1 }, I: { x: 1, y: 0 } },
];

function freezeBasis(basis) {
  return Object.freeze({
    name: basis.name,
    R: Object.freeze({ ...basis.R }),
    I: Object.freeze({ ...basis.I }),
  });
}

export const SEAT_BASIS = Object.freeze(RAW_SEAT_BASIS.map(freezeBasis));
export const TABLETOP_SEAT_NAMES = Object.freeze(SEAT_BASIS.map(({ name }) => name));

function assertSeat(seat) {
  if (!Number.isInteger(seat) || seat < 0 || seat >= SEAT_BASIS.length) {
    throw new RangeError('seat must be an integer from 0 through 3');
  }
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

export function seatBasis(seat) {
  assertSeat(seat);
  return SEAT_BASIS[seat];
}

/** The screen-plane angle of the owner's +R axis. */
export function seatBasisAngle(seat) {
  const { R } = seatBasis(seat);
  return Number((Math.atan2(R.y, R.x) * 180 / Math.PI).toFixed(6));
}

/**
 * Bind the pure seat basis to the real scene consumed by CSS.  Perspective
 * correction remains a view concern in CSS; the cardinal owner axis does not.
 */
export function bindSeatBasisToScene(scene, seat) {
  assertSeat(seat);
  if (!scene?.style || typeof scene.style.setProperty !== 'function') {
    throw new TypeError('scene must expose a CSS style declaration');
  }
  const basis = seatBasis(seat);
  scene.dataset.tableSeat = String(seat);
  scene.dataset.tableBasisBound = 'true';
  scene.style.setProperty('--seat-basis-angle', `${seatBasisAngle(seat)}deg`);
  scene.style.setProperty('--seat-rx', String(basis.R.x));
  scene.style.setProperty('--seat-ry', String(basis.R.y));
  scene.style.setProperty('--seat-ix', String(basis.I.x));
  scene.style.setProperty('--seat-iy', String(basis.I.y));
  return scene;
}

export function connectTabletopSeatScenes(documentRef = globalThis.document) {
  if (!documentRef || typeof documentRef.querySelector !== 'function') return 0;
  let connected = 0;
  for (let seat = 0; seat < SEAT_BASIS.length; seat += 1) {
    const scene = documentRef.querySelector(`#seat-scene-${seat}`);
    if (!scene) continue;
    bindSeatBasisToScene(scene, seat);
    connected += 1;
  }
  return connected;
}

/** Standard Japanese-mahjong river order: six columns, then the next row. */
export function riverGridPosition(discardSerial) {
  assertNonNegativeInteger(discardSerial, 'discardSerial');
  return Object.freeze({
    column: discardSerial % 6,
    row: Math.floor(discardSerial / 6),
  });
}

/**
 * Meld groups begin at +R, the owner's outer right edge, and grow inward.
 * r is deliberately negative after the first group; i keeps melds on the same
 * table-depth rail until a future rule explicitly introduces a second row.
 */
export function meldGridPosition(seat, meldIndex) {
  assertSeat(seat);
  assertNonNegativeInteger(meldIndex, 'meldIndex');
  return Object.freeze({
    seat,
    r: meldIndex === 0 ? 0 : -meldIndex,
    i: 0,
    edge: '+R',
  });
}

function hashString(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x21f0aaad);
  hash ^= hash >>> 15;
  return hash >>> 0;
}

function unitNoise(key, channel) {
  let value = hashString(`${key}|${channel}`);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0xffffffff;
}

/**
 * A tiny, deterministic human placement error. It depends only on public,
 * stable identity: seat + physical tile id + original discard serial.
 */
export function stableTabletopJitter({ seat, tileId, discardSerial }) {
  assertSeat(seat);
  if (tileId === undefined || tileId === null || String(tileId).length === 0) {
    throw new TypeError('tileId must identify the physical tile');
  }
  assertNonNegativeInteger(discardSerial, 'discardSerial');
  const key = `${seat}|${String(tileId)}|${discardSerial}`;
  return Object.freeze({
    x: Number(((unitNoise(key, 'x') - .5) * 1.8).toFixed(3)),
    y: Number(((unitNoise(key, 'y') - .5) * 1.2).toFixed(3)),
    angle: Number(((unitNoise(key, 'angle') - .5) * 2.2).toFixed(3)),
  });
}

function createOuterElement(tile) {
  const documentRef = tile?.ownerDocument ?? globalThis.document;
  if (!documentRef || typeof documentRef.createElement !== 'function') {
    throw new TypeError('tile must belong to a document capable of creating the placement element');
  }
  return documentRef.createElement('div');
}

function setClassName(element, value) {
  element.className = value;
}

/**
 * Wrap a tile instead of decorating it. Jitter and grid placement live on the
 * outer slot; the intermediate mesh owns table pose (including sideways);
 * the existing tile remains the untouched face and animation target.
 */
export function createTabletopPlacement(tile, {
  seat,
  zone,
  stableKey,
  sideways = false,
}) {
  assertSeat(seat);
  if (!['river', 'meld'].includes(zone)) throw new TypeError('zone must be river or meld');
  if (!stableKey || typeof stableKey !== 'object') {
    throw new TypeError('stableKey must contain tileId and discardSerial');
  }

  const tileId = stableKey.tileId;
  const discardSerial = stableKey.discardSerial;
  const jitter = stableTabletopJitter({ seat, tileId, discardSerial });
  const placement = createOuterElement(tile);
  const mesh = createOuterElement(tile);
  const riverPosition = zone === 'river' ? riverGridPosition(discardSerial) : null;
  const meldIndex = zone === 'meld'
    ? (stableKey.meldIndex ?? discardSerial)
    : null;
  const meldPosition = zone === 'meld' ? meldGridPosition(seat, meldIndex) : null;

  setClassName(placement, `tabletop-placement tabletop-placement-${zone}`);
  setClassName(mesh, `tabletop-tile-mesh${sideways ? ' is-sideways' : ''}`);
  placement.dataset.tableSeat = String(seat);
  placement.dataset.tableSeatName = seatBasis(seat).name;
  placement.dataset.tableZone = zone;
  placement.dataset.tableTileId = String(tileId);
  placement.dataset.tableDiscardSerial = String(discardSerial);
  placement.dataset.tableSideways = sideways ? 'true' : 'false';
  placement.style.setProperty('--table-jitter-x', `${jitter.x}px`);
  placement.style.setProperty('--table-jitter-y', `${jitter.y}px`);
  placement.style.setProperty('--table-jitter-angle', `${jitter.angle}deg`);

  if (riverPosition) {
    placement.dataset.tableColumn = String(riverPosition.column);
    placement.dataset.tableRow = String(riverPosition.row);
    placement.style.setProperty('--table-grid-column', String(riverPosition.column));
    placement.style.setProperty('--table-grid-row', String(riverPosition.row));
  }
  if (meldPosition) {
    placement.dataset.tableMeldIndex = String(meldIndex);
    placement.dataset.tableEdge = meldPosition.edge;
    placement.style.setProperty('--table-grid-r', String(meldPosition.r));
    placement.style.setProperty('--table-grid-i', String(meldPosition.i));
  }

  mesh.dataset.tableSideways = sideways ? 'true' : 'false';
  mesh.appendChild(tile);
  placement.appendChild(mesh);
  return placement;
}

/*
 * Compatibility helpers for the in-progress integration. They intentionally
 * leave inner transforms alone; new call sites should use createTabletopPlacement.
 */
export function tabletopJitter(seat, zone, index) {
  return stableTabletopJitter({ seat, tileId: `${zone}:${index}`, discardSerial: index });
}

export function decorateTabletopTile(element, { seat, zone, index }) {
  assertSeat(seat);
  assertNonNegativeInteger(index, 'index');
  if (!['river', 'meld'].includes(zone)) throw new TypeError('zone must be river or meld');
  const jitter = tabletopJitter(seat, zone, index);
  element.classList.add('tabletop-tile');
  element.dataset.tableSeat = String(seat);
  element.dataset.tableSeatName = seatBasis(seat).name;
  element.dataset.tableZone = zone;
  element.dataset.tableIndex = String(index);
  element.style.setProperty('--table-jitter-x', `${jitter.x}px`);
  element.style.setProperty('--table-jitter-y', `${jitter.y}px`);
  element.style.setProperty('--table-jitter-angle', `${jitter.angle}deg`);
  return element;
}

export function decorateMeldSlot(slot, seat, index) {
  assertSeat(seat);
  assertNonNegativeInteger(index, 'index');
  const jitter = tabletopJitter(seat, 'meld', index);
  const position = meldGridPosition(seat, index);
  slot.classList.add('tabletop-meld-slot');
  slot.dataset.tableSeat = String(seat);
  slot.dataset.tableIndex = String(index);
  slot.dataset.tableEdge = position.edge;
  slot.style.setProperty('--table-grid-r', String(position.r));
  slot.style.setProperty('--table-grid-i', String(position.i));
  slot.style.setProperty('--table-meld-order', String(-position.r));
  slot.style.setProperty('--meld-jitter-x', `${jitter.x}px`);
  slot.style.setProperty('--meld-jitter-y', `${jitter.y}px`);
  slot.style.setProperty('--meld-jitter-angle', `${jitter.angle}deg`);
  return slot;
}

// main.js and the v35 fixture import this module after their seat-scene DOM exists.
// The guard keeps the pure Node tests and non-DOM consumers side-effect free.
connectTabletopSeatScenes();

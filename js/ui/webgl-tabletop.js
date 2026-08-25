/* Hallmark · pre-emit critique: P5 H4 E5 S5 R5 V5 · component: single-camera WebGL tabletop · genre: atmospheric · theme: locked Jun system */
import * as THREE from '../vendor/three/three.module.js';
import { RoundedBoxGeometry } from '../vendor/three/addons/geometries/RoundedBoxGeometry.js';

const PI = Math.PI;
const HALF_PI = PI / 2;

const frozenPoint = (x, y, z) => Object.freeze({ x, y, z });

/**
 * The accepted proto3 geometry expressed as data. Keeping these values outside
 * renderer code lets tests lock the physical contract without constructing a
 * WebGL context.
 */
export const WEBGL_TABLETOP_CONTRACT = Object.freeze({
  version: 1,
  camera: Object.freeze({
    fov: 46,
    near: 10,
    far: 4000,
    position: frozenPoint(0, 470, 600),
    lookAt: frozenPoint(0, -30, -80),
  }),
  tile: Object.freeze({
    width: 26,
    height: 35,
    thickness: 16,
    backThickness: 6.5,
  }),
  table: Object.freeze({
    feltSize: 700,
    rimWidth: 72,
    rimHeight: 34,
  }),
  rack: Object.freeze({
    gap: 0.8,
    z: 288,
    lean: 7 * PI / 180,
  }),
  meld: Object.freeze({
    z: 291,
    rightEdge: 304,
    tileGap: 1.6,
    groupGap: 8,
    handGap: 10,
  }),
  river: Object.freeze({
    z0: 122,
    rowPitch: 38,
    gap: 1.6,
    columns: 6,
    maxRows: 4,
  }),
  wall: Object.freeze({
    // The live wall belongs between the river and the player's rack. A fourth
    // river row suppresses that seat's remaining wall slots rather than
    // putting two physical objects through each other.
    z: 240,
    stacksPerSeat: 17,
    stackGap: 0.8,
    deadWallTiles: 14,
  }),
  riichiStick: Object.freeze({
    width: 92,
    height: 4,
    depth: 8,
    z: 82,
  }),
});

export const WEBGL_TABLETOP_SEATS = Object.freeze(['bottom', 'right', 'top', 'left']);

const LANDSCAPE_CAMERA_PROFILE = Object.freeze({
  id: 'landscape-v6',
  ...WEBGL_TABLETOP_CONTRACT.camera,
  fog: Object.freeze({ near: 1600, far: 3000 }),
});

const PORTRAIT_ELEVATION = 55 * PI / 180;
const PORTRAIT_FOV = 60;
// Crop only the outer timber in portrait so public tile faces retain a
// readable physical size. All gameplay placements stay inside this radius.
const PORTRAIT_GAMEPLAY_RADIUS = 319;

function portraitCameraProfile(width, height) {
  const horizontalMargin = 10;
  const usableHalfWidth = Math.max(1, width / 2 - horizontalMargin);
  const fitRadius = PORTRAIT_GAMEPLAY_RADIUS;
  const fitHeight = 34;
  const horizontalDistance = fitRadius * Math.cos(PORTRAIT_ELEVATION) +
    fitHeight * Math.sin(PORTRAIT_ELEVATION) +
    height * fitRadius / (2 * Math.tan(PORTRAIT_FOV * PI / 360) * usableHalfWidth);
  // 縦フィット (portrait-fit-v4, 2026-08-25 iPhone13実機報告):
  // Safariのバー等で実効高が縮むと、水平フィットだけの距離ではカメラが寄りすぎて
  // 対面の河・山がフレーム上端と上辺HUD帯(プレート+局パネル)の裏に切れる。
  // 遠端(z=-R, y=牌の高さ)が「上からHUD帯ぶん下がった線」より下に写る距離まで引く。
  const hudBandPx = 150;
  const tanHalfFov = Math.tan(PORTRAIT_FOV * PI / 360);
  const allowedTan = tanHalfFov * Math.max(0.2, 1 - (2 * hudBandPx) / Math.max(height, 1));
  const sinE = Math.sin(PORTRAIT_ELEVATION);
  const cosE = Math.cos(PORTRAIT_ELEVATION);
  let verticalDistance = horizontalDistance;
  for (let candidate = 200; candidate <= 4000; candidate += 5) {
    const uy = fitHeight - candidate * sinE;
    const uz = -fitRadius - candidate * cosE;
    const along = -(uy * sinE + uz * cosE);        // 視線方向成分
    const upComponent = uy * cosE - uz * sinE;     // 画面上方向成分
    if (along > 0 && upComponent / along <= allowedTan) {
      verticalDistance = candidate;
      break;
    }
  }
  const distance = Math.max(horizontalDistance, verticalDistance);
  return Object.freeze({
    id: 'portrait-fit-v4',
    fov: PORTRAIT_FOV,
    near: WEBGL_TABLETOP_CONTRACT.camera.near,
    far: WEBGL_TABLETOP_CONTRACT.camera.far,
    position: frozenPoint(0,
      distance * Math.sin(PORTRAIT_ELEVATION),
      distance * Math.cos(PORTRAIT_ELEVATION)),
    lookAt: frozenPoint(0, 0, 0),
    fog: Object.freeze({ near: 3000, far: 5000 }),
  });
}

/**
 * Stage B's accepted 16:9 camera is immutable. Portrait receives a dedicated
 * near-overhead physical camera so all four racks stay on screen; every
 * landscape viewport retains the exact v6 position/FOV/look target.
 */
export function cameraProfileForViewport(width, height) {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1280;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 720;
  if (safeWidth < safeHeight) return portraitCameraProfile(safeWidth, safeHeight);
  return LANDSCAPE_CAMERA_PROFILE;
}

const FACE_FILES = Object.freeze([
  'Man1.svg', 'Man2.svg', 'Man3.svg', 'Man4.svg', 'Man5.svg', 'Man6.svg', 'Man7.svg', 'Man8.svg', 'Man9.svg',
  'Pin1.svg', 'Pin2.svg', 'Pin3.svg', 'Pin4.svg', 'Pin5.svg', 'Pin6.svg', 'Pin7.svg', 'Pin8.svg', 'Pin9.svg',
  'Sou1.svg', 'Sou2.svg', 'Sou3.svg', 'Sou4.svg', 'Sou5.svg', 'Sou6.svg', 'Sou7.svg', 'Sou8.svg', 'Sou9.svg',
  'Ton.svg', 'Nan.svg', 'Shaa.svg', 'Pei.svg', 'Haku.svg', 'Hatsu.svg', 'Chun.svg',
]);

const RED_FACE_FILES = Object.freeze(new Map([
  [4, 'Man5-Dora.svg'],
  [13, 'Pin5-Dora.svg'],
  [22, 'Sou5-Dora.svg'],
]));

const FACE_ROOT = new URL('../../assets/tile_faces_v10/', import.meta.url);

function clampInteger(value, min, max, fallback = min) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function normalizedSeat(value, fallback = 0) {
  return clampInteger(value, 0, 3, fallback);
}

function normalizeTile(tile, fallbackKind = 31) {
  if (Number.isInteger(tile)) return { kind: clampInteger(tile, 0, 33, fallbackKind), red: false, id: null };
  if (!tile || typeof tile !== 'object') return { kind: fallbackKind, red: false, id: null };
  return {
    kind: clampInteger(tile.kind, 0, 33, fallbackKind),
    red: tile.red === true,
    id: tile.id ?? null,
  };
}

function stableHash(value) {
  const input = String(value ?? '');
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Stable public-identity jitter; no render-time randomness. */
export function deterministicTabletopJitter(stableId, salt) {
  const id = stableHash(`${stableId}:${salt}`);
  const x = Math.sin(id * 0.0001271 + salt * 311.7) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

export function meldSourceForSeat(meld, seat) {
  const explicit = meld?.source;
  if (explicit === 'kamicha' || explicit === 'toimen' || explicit === 'shimocha') return explicit;
  if (!Number.isInteger(meld?.from)) return null;
  const delta = (meld.from - normalizedSeat(seat) + 4) % 4;
  if (delta === 3) return 'kamicha';
  if (delta === 2) return 'toimen';
  if (delta === 1) return 'shimocha';
  return null;
}

export function calledSlotForSource(source, tileCount) {
  const count = Math.max(1, Math.trunc(tileCount || 0));
  if (source === 'kamicha') return 0;
  if (source === 'toimen') return Math.floor((count - 1) / 2);
  if (source === 'shimocha') return count - 1;
  return null;
}

function samePhysicalTile(tile, id) {
  return id !== undefined && id !== null && tile?.id !== undefined && tile?.id !== null && String(tile.id) === String(id);
}

function normalizePreview(preview) {
  if (!preview || typeof preview !== 'object') return null;
  const seat = preview.seat ?? preview.player;
  if (!Number.isInteger(seat) || seat < 0 || seat > 3) return null;
  const tile = normalizeTile(preview.tile ?? { kind: preview.kind, id: preview.addedTileId ?? null });
  return { seat, tile };
}

function normalizeLastDiscard(lastDiscard) {
  if (!lastDiscard || typeof lastDiscard !== 'object') return null;
  const seat = lastDiscard.seat ?? lastDiscard.player;
  if (!Number.isInteger(seat) || seat < 0 || seat > 3) return null;
  return {
    seat,
    tileId: lastDiscard.tileId ?? lastDiscard.tile?.id ?? null,
    discardSerial: Number.isInteger(lastDiscard.discardSerial) ? lastDiscard.discardSerial :
      (Number.isInteger(lastDiscard.serial) ? lastDiscard.serial : null),
  };
}

function riichiFollowupSerial(discards) {
  const riichiAt = discards.findIndex(discard => discard?.riichi === true);
  if (riichiAt < 0 || discards[riichiAt]?.claimed !== true) return -1;
  return discards.findIndex((discard, serial) => serial > riichiAt && discard?.claimed !== true);
}

function placement(zone, seat, tile, position, rotation, extra = {}) {
  return {
    zone,
    seat,
    tile: normalizeTile(tile),
    position: { ...position },
    rotation: { ...rotation },
    faceVisible: extra.faceVisible !== false,
    sideways: extra.sideways === true,
    faceDown: extra.faceDown === true,
    key: String(extra.key ?? `${zone}:${seat}`),
    meta: { ...(extra.meta ?? {}) },
  };
}

function layoutMeldsForSeat(player, seat, preview, diagnostics) {
  const { tile, meld } = WEBGL_TABLETOP_CONTRACT;
  const melds = Array.isArray(player?.melds) ? player.melds : [];
  const tiles = [];
  const groups = [];
  let rightEdge = meld.rightEdge;

  melds.forEach((rawMeld, meldIndex) => {
    const rawTiles = Array.isArray(rawMeld?.tiles) ? rawMeld.tiles.map(value => normalizeTile(value)) : [];
    const isCompletedKakan = rawMeld?.kanOrigin === 'kakan' || rawMeld?.type === 'kakan';
    const isPreviewKakan = !isCompletedKakan && rawMeld?.type === 'pon' && preview?.seat === seat &&
      rawTiles.some(value => value.kind === preview.tile.kind);
    const isKakan = isCompletedKakan || isPreviewKakan;
    let addedTile = isPreviewKakan ? preview.tile : null;
    let baseTiles = [...rawTiles];

    if (isCompletedKakan) {
      let addedIndex = baseTiles.findIndex(value => samePhysicalTile(value, rawMeld?.addedTileId));
      if (addedIndex < 0 && baseTiles.length >= 4) {
        // Engine kakan keeps the called tile last and inserts the added tile immediately before it.
        addedIndex = rawMeld?.type === 'kakan' ? baseTiles.length - 1 : baseTiles.length - 2;
      }
      if (addedIndex >= 0) addedTile = baseTiles.splice(addedIndex, 1)[0];
    }

    const isClosedKan = rawMeld?.type === 'ankan' || rawMeld?.kanOrigin === 'ankan';
    const baseCount = isKakan ? 3 : (rawMeld?.type === 'minkan' || isClosedKan ? 4 : 3);
    if (baseTiles.length < baseCount) {
      diagnostics.push(`seat ${seat} meld ${meldIndex}: expected ${baseCount} base tiles, got ${baseTiles.length}`);
      return;
    }
    baseTiles = baseTiles.slice(0, baseCount);

    const source = meldSourceForSeat(rawMeld, seat);
    const calledSlot = isClosedKan ? null : calledSlotForSource(source, baseCount);
    const ordered = Array(baseCount).fill(null);
    if (calledSlot !== null) {
      const called = baseTiles[baseTiles.length - 1];
      const rest = baseTiles.slice(0, -1).sort((a, b) => a.kind - b.kind || Number(a.red) - Number(b.red));
      ordered[calledSlot] = called;
      let restIndex = 0;
      for (let slot = 0; slot < baseCount; slot += 1) {
        if (ordered[slot] === null) ordered[slot] = rest[restIndex++];
      }
    } else {
      baseTiles.forEach((value, index) => { ordered[index] = value; });
    }

    const footprints = ordered.map((_, index) => index === calledSlot ? tile.height : tile.width);
    const width = footprints.reduce((sum, value) => sum + value, 0) + meld.tileGap * Math.max(0, baseCount - 1);
    const leftEdge = rightEdge - width;
    let cursor = leftEdge;
    let sidewaysPlacement = null;

    ordered.forEach((value, slot) => {
      const sideways = slot === calledSlot;
      const faceDown = isClosedKan && (slot === 0 || slot === baseCount - 1);
      const footprint = footprints[slot];
      const item = placement('meld', seat, value, {
        x: cursor + footprint / 2,
        y: tile.thickness / 2 + 0.2,
        z: meld.z,
      }, {
        x: faceDown ? HALF_PI : -HALF_PI,
        y: 0,
        z: sideways ? -HALF_PI : 0,
      }, {
        key: `meld:${seat}:${meldIndex}:base:${slot}`,
        sideways,
        faceDown,
        faceVisible: !faceDown,
        meta: { meldIndex, slot, source, called: sideways, type: rawMeld?.type ?? 'unknown' },
      });
      tiles.push(item);
      if (sideways) sidewaysPlacement = item;
      cursor += footprint + meld.tileGap;
    });

    if (isKakan && addedTile && sidewaysPlacement) {
      // The fourth tile lies flat beyond the called tile toward table centre.
      // It deliberately keeps the same y and orientation: no physical stack.
      tiles.push(placement('meld', seat, addedTile, {
        ...sidewaysPlacement.position,
        z: sidewaysPlacement.position.z - tile.width - meld.tileGap,
      }, sidewaysPlacement.rotation, {
        key: `meld:${seat}:${meldIndex}:added`,
        sideways: true,
        meta: {
          meldIndex,
          source,
          called: false,
          kakanAdded: true,
          kakanPreview: isPreviewKakan,
          addedTileId: addedTile.id,
        },
      }));
    }

    groups.push({
      seat,
      meldIndex,
      type: rawMeld?.type ?? 'unknown',
      source,
      calledSlot,
      rightEdge,
      leftEdge,
      kakan: isKakan,
      kakanPreview: isPreviewKakan,
    });
    rightEdge = leftEdge - meld.groupGap;
  });

  return { tiles, groups, nextRightEdge: rightEdge };
}

function layoutRackForSeat(player, seat, availableRightEdge, drawnSeat, hasMelds) {
  if (seat === 0) return { tiles: [], bounds: null };
  const { tile, rack } = WEBGL_TABLETOP_CONTRACT;
  const count = clampInteger(player?.handCount, 0, 14, 0);
  const width = count * tile.width + Math.max(0, count - 1) * rack.gap;
  const hasDrawn = seat === drawnSeat;
  // Proto2's closed racks are centered. Proto3's open racks sit immediately
  // inward of their right-edge melds, reserving a separated draw slot only
  // while that public draw is present.
  const handRightEdge = hasMelds
    // Keep an open rack immobile across draw/discard frames. Its owner-right
    // draw lane is reserved even while empty, avoiding a 33px rack jump.
    ? availableRightEdge - tile.width - 7
    : width / 2;
  const leftEdge = handRightEdge - width;
  const pitch = tile.width + rack.gap;
  const result = [];
  for (let index = 0; index < count; index += 1) {
    result.push(placement('rack', seat, null, {
      x: leftEdge + tile.width / 2 + index * pitch,
      y: (tile.height / 2) * Math.cos(rack.lean) + 1.2,
      z: rack.z,
    }, { x: -rack.lean, y: 0, z: 0 }, {
      key: `rack:${seat}:${index}`,
      faceVisible: false,
      meta: { index, concealed: true },
    }));
  }
  if (hasDrawn) {
    // Public state exposes only the fact that another player has drawn. Keep
    // the physical tile back hidden and separate it at the rack's free end.
    result.push(placement('rack', seat, null, {
      x: handRightEdge + tile.width / 2 + 7,
      y: (tile.height / 2) * Math.cos(rack.lean) + 1.2,
      z: rack.z,
    }, { x: -rack.lean, y: 0, z: 0 }, {
      key: `drawn:${seat}`,
      faceVisible: false,
      meta: { index: count, concealed: true, drawn: true },
    }));
  }
  return { tiles: result, bounds: { seat, count, leftEdge, rightEdge: handRightEdge, drawn: hasDrawn, hasMelds } };
}

function layoutRiverForSeat(player, seat, lastDiscardPlayer, lastDiscard) {
  const { tile, river } = WEBGL_TABLETOP_CONTRACT;
  const discards = Array.isArray(player?.discards) ? player.discards : [];
  const followup = riichiFollowupSerial(discards);
  const rowStart = -(tile.width * river.columns + river.gap * (river.columns - 1)) / 2;
  const cursors = Array(river.maxRows).fill(rowStart);
  const result = [];

  for (let serial = 0; serial < Math.min(discards.length, river.columns * river.maxRows); serial += 1) {
    const discard = discards[serial] ?? {};
    const row = Math.floor(serial / river.columns);
    const sideways = discard.riichi === true || serial === followup;
    const footprint = sideways ? tile.height : tile.width;
    const stableId = discard.tile?.id ?? `seat${seat}:discard${serial}:kind${discard.tile?.kind ?? 'x'}`;
    const x = cursors[row] + footprint / 2;
    cursors[row] += footprint + river.gap;
    if (discard.claimed === true) continue;

    const item = placement('river', seat, discard.tile, {
      x: x + deterministicTabletopJitter(stableId, 1) * 1.1,
      y: tile.thickness / 2 + 0.2,
      z: river.z0 + row * river.rowPitch + deterministicTabletopJitter(stableId, 2) * 1.1,
    }, {
      x: -HALF_PI,
      y: 0,
      z: (sideways ? -HALF_PI : 0) + deterministicTabletopJitter(stableId, 3) * 0.028,
    }, {
      key: `discard:${seat}:${serial}`,
      sideways,
      meta: {
        serial,
        row,
        column: serial % river.columns,
        riichi: discard.riichi === true,
        riichiFollowup: serial === followup,
        tsumogiri: discard.tsumogiri === true,
        isLastDiscard: lastDiscard
          ? seat === lastDiscard.seat &&
            (lastDiscard.discardSerial !== null
              ? serial === lastDiscard.discardSerial
              : lastDiscard.tileId !== null && String(discard.tile?.id) === String(lastDiscard.tileId))
          : seat === lastDiscardPlayer && serial === discards.length - 1,
      },
    });
    result.push(item);
  }
  return result;
}

function layoutWall(state) {
  const { tile, wall } = WEBGL_TABLETOP_CONTRACT;
  if (!Number.isFinite(state?.remaining)) return [];
  const liveTiles = clampInteger(state.remaining, 0, 122, 0);
  const physicalCount = Math.min(136, liveTiles + wall.deadWallTiles);
  const stackCount = Math.ceil(physicalCount / 2);
  const totalSlots = wall.stacksPerSeat * 4;
  const startSlot = ((normalizedSeat(state?.dealer, 0) + 1) % 4) * wall.stacksPerSeat;
  const pitch = tile.width + wall.stackGap;
  const left = -((wall.stacksPerSeat - 1) * pitch) / 2;
  const result = [];
  const blockedSeats = new Set((state?.players ?? [])
    .map((player, seat) => (Array.isArray(player?.discards) && player.discards.length > 18 ? seat : -1))
    .filter(seat => seat >= 0));
  const slotCycle = Array.from({ length: totalSlots }, (_, offset) => (startSlot + offset) % totalSlots);
  const orderedSlots = [
    ...slotCycle.filter(slot => !blockedSeats.has(Math.floor(slot / wall.stacksPerSeat))),
    ...slotCycle.filter(slot => blockedSeats.has(Math.floor(slot / wall.stacksPerSeat))),
  ];

  for (let offset = 0; offset < stackCount; offset += 1) {
    const globalSlot = orderedSlots[offset];
    const seat = Math.floor(globalSlot / wall.stacksPerSeat);
    const slot = globalSlot % wall.stacksPerSeat;
    const tileCount = offset === stackCount - 1 && physicalCount % 2 === 1 ? 1 : 2;
    for (let layer = 0; layer < tileCount; layer += 1) {
      result.push(placement('wall', seat, null, {
        x: left + slot * pitch,
        y: tile.thickness / 2 + 0.2 + layer * (tile.thickness - 0.8),
        z: wall.z,
      }, { x: HALF_PI, y: 0, z: 0 }, {
        key: `wall:${globalSlot}:${layer}`,
        faceVisible: false,
        faceDown: true,
        meta: { globalSlot, slot, layer },
      }));
    }
  }
  return result;
}

function layoutRiichiSticks(state, players) {
  const count = clampInteger(state?.riichiSticks, 0, 8, 0);
  if (count === 0) return [];
  const activeSeats = players.map((player, seat) => player?.riichi === true ? seat : -1).filter(seat => seat >= 0);
  // Only sticks declared in the current hand have an owner-side 3D location.
  // Carried-over deposits stay in the existing centre DOM counter.
  return activeSeats.slice(0, count).map((seat, index) => ({
      zone: 'riichi-stick',
      seat,
      key: `riichi-stick:${index}`,
      position: { x: 0, y: 4.2, z: WEBGL_TABLETOP_CONTRACT.riichiStick.z },
      rotation: { x: 0, y: 0, z: 0 },
    }));
}

/**
 * Pure public-state -> seat-local placement contract. It never reads private
 * hands or wall order and deliberately tolerates partial state fixtures.
 */
export function layoutWebGLTabletop(state = {}, options = {}) {
  const players = Array.from({ length: 4 }, (_, seat) => state?.players?.[seat] ?? { seat });
  const preview = normalizePreview(options?.kakanPreview);
  const lastDiscard = normalizeLastDiscard(options?.lastDiscard);
  const lastDiscardPlayer = Number.isInteger(options?.lastDiscardPlayer) ? normalizedSeat(options.lastDiscardPlayer) : -1;
  const drawnSeat = Number.isInteger(options?.drawnSeat) && options.drawnSeat >= 1 && options.drawnSeat <= 3
    ? options.drawnSeat
    : -1;
  const diagnostics = [];
  const rackTiles = [];
  const riverTiles = [];
  const meldTiles = [];
  const meldGroups = [];
  const rackBounds = Array(4).fill(null);

  for (let seat = 0; seat < 4; seat += 1) {
    const meldLayout = layoutMeldsForSeat(players[seat], seat, preview, diagnostics);
    meldTiles.push(...meldLayout.tiles);
    meldGroups.push(...meldLayout.groups);
    const rackLayout = layoutRackForSeat(
      players[seat],
      seat,
      meldLayout.nextRightEdge - WEBGL_TABLETOP_CONTRACT.meld.handGap,
      drawnSeat,
      meldLayout.groups.length > 0,
    );
    rackTiles.push(...rackLayout.tiles);
    rackBounds[seat] = rackLayout.bounds;
    riverTiles.push(...layoutRiverForSeat(players[seat], seat, lastDiscardPlayer, lastDiscard));
  }

  return {
    version: WEBGL_TABLETOP_CONTRACT.version,
    renderedStateId: state?.stateId ?? null,
    seatCount: 4,
    rackTiles,
    riverTiles,
    meldTiles,
    wallTiles: layoutWall(state),
    riichiSticks: layoutRiichiSticks(state, players),
    meldGroups,
    rackBounds,
    diagnostics,
  };
}

function faceFile(tile) {
  if (tile?.red === true && RED_FACE_FILES.has(tile.kind)) return RED_FACE_FILES.get(tile.kind);
  return FACE_FILES[clampInteger(tile?.kind, 0, 33, 31)];
}

export class WebGLTabletopRenderer {
  constructor({ container } = {}) {
    this.container = container ?? null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.cameraProfile = null;
    this.contentRoot = null;
    this.seatGroups = [];
    this.ready = false;
    this.disposed = false;
    this.contextLost = false;
    this.error = null;
    this.lastState = null;
    this.lastOptions = {};
    this.lastLayout = layoutWebGLTabletop();
    this.targetMap = new Map();
    this.resources = new Set();
    this.faceTextures = new Map();
    this.faceMaterials = new Map();
    this.resizeObserver = null;
    this.animationFrame = null;
    this.focusTargetSpec = null;
    this.focusedTile = null;
    this.focusEffect = null;
    this.ephemeralTile = null;
    this.hiddenDrawnTile = null;
    this.onContextLost = null;
    this.onContextRestored = null;
  }

  async init() {
    if (this.ready) return true;
    if (this.disposed) return false;
    try {
      if (!this.container || typeof this.container.appendChild !== 'function' || typeof document === 'undefined') {
        throw new Error('WebGL tabletop container is unavailable');
      }

      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.3;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.domElement.setAttribute('role', 'img');
      this.renderer.domElement.setAttribute('aria-label', '四家の伏せ手牌・河・副露・牌山・リーチ棒を単一カメラで描く麻雀卓');
      this.renderer.domElement.style.display = 'block';
      this.renderer.domElement.style.width = '100%';
      this.renderer.domElement.style.height = '100%';
      this.container.appendChild(this.renderer.domElement);

      this.onContextLost = event => {
        event.preventDefault?.();
        this.contextLost = true;
        this._updateReport();
      };
      this.onContextRestored = () => {
        this.contextLost = false;
        if (this.lastState) this.render(this.lastState, this.lastOptions);
        else this._drawFrame();
      };
      this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost, false);
      this.renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored, false);

      this._buildScene();
      await this._preloadFaces();
      this._buildFocusEffect();
      this._installResizeHandling();
      this.ready = true;
      this.container.dataset.ready = 'true';
      delete this.container.dataset.error;
      if (this.lastState) this.render(this.lastState, this.lastOptions);
      else this._drawFrame();
      return true;
    } catch (error) {
      this.error = String(error?.message || error);
      if (this.container?.dataset) {
        this.container.dataset.ready = 'false';
        this.container.dataset.error = this.error;
      }
      this._updateReport(this.error);
      return false;
    }
  }

  render(state = {}, options = {}) {
    this.lastState = state && typeof state === 'object' ? state : {};
    this.lastOptions = options && typeof options === 'object' ? options : {};
    this.lastLayout = layoutWebGLTabletop(this.lastState, this.lastOptions);
    if (!this.ready || this.disposed || this.contextLost || !this.scene) return this.lastLayout;

    const focus = this.focusTargetSpec;
    this._detachFocusEffect();
    if (this.contentRoot) this.scene.remove(this.contentRoot);
    this.contentRoot = new THREE.Group();
    this.contentRoot.name = 'jun-tabletop-dynamic';
    this.scene.add(this.contentRoot);
    this.seatGroups = Array.from({ length: 4 }, (_, seat) => {
      const group = new THREE.Group();
      group.name = `seat-${seat}`;
      group.rotation.y = seat * HALF_PI;
      this.contentRoot.add(group);
      return group;
    });
    this.targetMap.clear();

    for (const item of this.lastLayout.wallTiles) this._addTilePlacement(item);
    for (const item of this.lastLayout.rackTiles) this._addTilePlacement(item);
    for (const item of this.lastLayout.riverTiles) this._addTilePlacement(item);
    for (const item of this.lastLayout.meldTiles) this._addTilePlacement(item);
    for (const item of this.lastLayout.riichiSticks) this._addRiichiStick(item);

    for (let seat = 0; seat < 4; seat += 1) {
      const last = [...this.lastLayout.riverTiles].reverse().find(item => item.seat === seat);
      if (last) this.targetMap.set(`last-discard:${seat}`, this.targetMap.get(last.key));
    }
    this._drawFrame();
    if (focus) this._applyFocus(focus);
    return this.lastLayout;
  }

  focusWinTarget(target) {
    if (!target || typeof target !== 'object') {
      this.clearWinFocus();
      return false;
    }
    this.focusTargetSpec = { ...target };
    if (!this.ready || this.disposed || this.contextLost) return false;
    return this._applyFocus(this.focusTargetSpec);
  }

  clearWinFocus() {
    this.focusTargetSpec = null;
    this._detachFocusEffect();
    this._removeEphemeralTile();
    this._drawFrame();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this._detachFocusEffect();
    this._removeEphemeralTile();
    this.resizeObserver?.disconnect?.();
    this.resizeObserver = null;
    if (typeof window !== 'undefined') window.removeEventListener?.('resize', this._boundResize);
    if (this.renderer?.domElement) {
      this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost, false);
      this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored, false);
      this.renderer.domElement.remove?.();
    }
    for (const resource of this.resources) resource?.dispose?.();
    this.resources.clear();
    this.faceTextures.clear();
    this.faceMaterials.clear();
    this.renderer?.dispose?.();
    this.renderer?.forceContextLoss?.();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.contentRoot = null;
    if (this.container?.dataset) this.container.dataset.ready = 'false';
  }

  _track(resource) {
    if (resource) this.resources.add(resource);
    return resource;
  }

  _buildScene() {
    const { camera: cameraSpec, table } = WEBGL_TABLETOP_CONTRACT;
    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.scene.fog = new THREE.Fog(0x0a0d13, 1600, 3000);

    // Deliberately the renderer's one and only camera.
    this.camera = new THREE.PerspectiveCamera(cameraSpec.fov, 16 / 9, cameraSpec.near, cameraSpec.far);
    this.camera.position.set(cameraSpec.position.x, cameraSpec.position.y, cameraSpec.position.z);
    this.camera.lookAt(cameraSpec.lookAt.x, cameraSpec.lookAt.y, cameraSpec.lookAt.z);

    this.scene.add(new THREE.HemisphereLight(0xc9d4e6, 0x33291c, 1.05));
    const key = new THREE.DirectionalLight(0xfff2dd, 2.6);
    key.position.set(-260, 900, 420);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -560;
    key.shadow.camera.right = 560;
    key.shadow.camera.top = 560;
    key.shadow.camera.bottom = -560;
    key.shadow.camera.near = 200;
    key.shadow.camera.far = 2000;
    key.shadow.bias = -0.0004;
    key.shadow.radius = 4;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x9db4d8, 0.5);
    fill.position.set(340, 500, -300);
    this.scene.add(fill);

    this.ivoryMaterial = this._track(new THREE.MeshPhysicalMaterial({
      color: 0xf3ecd8, roughness: 0.32, metalness: 0, clearcoat: 0.55, clearcoatRoughness: 0.35,
    }));
    this.backMaterial = this._track(new THREE.MeshPhysicalMaterial({
      color: 0xd98f2b, roughness: 0.38, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.4,
    }));

    const tile = WEBGL_TABLETOP_CONTRACT.tile;
    this.frontGeometry = this._track(new RoundedBoxGeometry(tile.width, tile.height, tile.thickness - tile.backThickness + 1.2, 3, 2.4));
    this.backGeometry = this._track(new RoundedBoxGeometry(tile.width, tile.height, tile.backThickness + 1.2, 3, 2.4));
    this.decalGeometry = this._track(new THREE.PlaneGeometry(tile.width - 4.5, tile.height - 4.5));
    const stick = WEBGL_TABLETOP_CONTRACT.riichiStick;
    this.riichiBodyGeometry = this._track(new RoundedBoxGeometry(stick.width, stick.height, stick.depth, 2, 1.4));
    this.riichiBodyMaterial = this._track(new THREE.MeshPhysicalMaterial({
      color: 0xf0e5cb, roughness: 0.34, clearcoat: 0.4,
    }));
    this.riichiMarkMaterial = this._track(new THREE.MeshStandardMaterial({ color: 0xb92c28, roughness: 0.45 }));
    this.riichiDotGeometry = this._track(new THREE.CylinderGeometry(2.2, 2.2, 0.7, 24));
    this.riichiMarkGeometry = this._track(new THREE.CylinderGeometry(0.9, 0.9, 0.7, 16));

    const feltSide = this._track(new THREE.MeshStandardMaterial({ color: 0x1c3557, roughness: 0.96 }));
    const feltTop = this._track(new THREE.MeshStandardMaterial({ map: this._makeFeltTexture(), roughness: 0.96, metalness: 0 }));
    const feltGeometry = this._track(new THREE.BoxGeometry(table.feltSize + table.rimWidth, 18, table.feltSize + table.rimWidth));
    const felt = new THREE.Mesh(feltGeometry, [feltSide, feltSide, feltTop, feltSide, feltSide, feltSide]);
    felt.position.y = -9;
    felt.receiveShadow = true;
    this.scene.add(felt);

    const woodSide = this._track(new THREE.MeshStandardMaterial({ color: 0x54331d, roughness: 0.55, metalness: 0.05 }));
    const woodTop = this._track(new THREE.MeshStandardMaterial({ color: 0x6b4326, roughness: 0.5, metalness: 0.05 }));
    const rimLength = table.feltSize + table.rimWidth * 2;
    const rimDistance = table.feltSize / 2 + table.rimWidth / 2;
    const rimGeometry = this._track(new THREE.BoxGeometry(rimLength, table.rimHeight + 18, table.rimWidth));
    for (let index = 0; index < 4; index += 1) {
      const rim = new THREE.Mesh(rimGeometry, [woodSide, woodSide, woodTop, woodSide, woodSide, woodSide]);
      const angle = index * HALF_PI;
      rim.position.set(Math.sin(angle) * rimDistance, (table.rimHeight - 18) / 2, Math.cos(angle) * rimDistance);
      rim.rotation.y = angle;
      rim.castShadow = true;
      rim.receiveShadow = true;
      this.scene.add(rim);
    }

  }

  _makeFeltTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1024;
    const context = canvas.getContext('2d');
    if (!context) return null;
    const gradient = context.createRadialGradient(512, 512, 60, 512, 512, 760);
    gradient.addColorStop(0, '#2b5187');
    gradient.addColorStop(0.7, '#254672');
    gradient.addColorStop(1, '#1c3557');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 1024, 1024);
    const image = context.getImageData(0, 0, 1024, 1024);
    let seed = 22695477;
    for (let offset = 0; offset < image.data.length; offset += 4) {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      const noise = ((seed >> 16) & 15) - 8;
      image.data[offset] += noise;
      image.data[offset + 1] += noise;
      image.data[offset + 2] += noise;
    }
    context.putImageData(image, 0, 0);
    context.strokeStyle = 'rgba(150,175,210,0.28)';
    context.lineWidth = 2.5;
    context.strokeRect(118, 118, 788, 788);
    context.strokeStyle = 'rgba(150,175,210,0.16)';
    context.lineWidth = 1.5;
    context.strokeRect(132, 132, 760, 760);
    const texture = this._track(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return texture;
  }

  async _preloadFaces() {
    const files = new Set([...FACE_FILES, ...RED_FACE_FILES.values()]);
    await Promise.all([...files].map(async file => {
      const texture = await this._loadFaceTexture(file);
      if (texture) this.faceTextures.set(file, texture);
    }));
    for (let kind = 0; kind < FACE_FILES.length; kind += 1) {
      const normal = FACE_FILES[kind];
      this.faceMaterials.set(`${kind}:0`, this._makeFaceMaterial(this.faceTextures.get(normal) ?? null));
      if (RED_FACE_FILES.has(kind)) {
        this.faceMaterials.set(`${kind}:1`, this._makeFaceMaterial(this.faceTextures.get(RED_FACE_FILES.get(kind)) ?? null));
      }
    }
  }

  async _loadFaceTexture(file) {
    try {
      // Same-origin direct image loading is compatible with index.html's
      // `img-src 'self' data:` policy. Do not introduce blob: as a CSP escape.
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = reject;
        element.src = new URL(file, FACE_ROOT).href;
      });
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 344;
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 8, 8, 240, 328);
      const texture = this._track(new THREE.CanvasTexture(canvas));
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = this.renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
      return texture;
    } catch {
      return null;
    }
  }

  _makeFaceMaterial(texture) {
    return this._track(new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      roughness: 0.5,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    }));
  }

  _buildFocusEffect() {
    const tile = WEBGL_TABLETOP_CONTRACT.tile;
    const material = this._track(new THREE.MeshBasicMaterial({
      color: 0xffd25a,
      transparent: true,
      opacity: 0.38,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
    }));
    const glow = new THREE.Mesh(
      this._track(new RoundedBoxGeometry(tile.width + 3.4, tile.height + 3.4, tile.thickness + 3.4, 3, 2.8)),
      material,
    );
    glow.name = 'win-focus-glow';
    glow.renderOrder = 8;
    const light = new THREE.PointLight(0xffc84a, 1.8, 105, 2);
    light.position.z = tile.thickness;
    const effect = new THREE.Group();
    effect.name = 'win-focus-effect';
    effect.userData.effectOnly = true;
    effect.add(glow, light);
    effect.visible = false;
    effect.userData.glow = glow;
    effect.userData.light = light;
    this.focusEffect = effect;
  }

  _makeTile(tileData, faceVisible) {
    const tileSpec = WEBGL_TABLETOP_CONTRACT.tile;
    const tile = normalizeTile(tileData);
    const group = new THREE.Group();
    group.userData.tile = tile;
    const front = new THREE.Mesh(this.frontGeometry, this.ivoryMaterial);
    front.position.z = tileSpec.thickness - (tileSpec.thickness - tileSpec.backThickness + 1.2) / 2 - tileSpec.thickness / 2;
    front.castShadow = true;
    front.receiveShadow = true;
    group.add(front);
    const back = new THREE.Mesh(this.backGeometry, this.backMaterial);
    back.position.z = -tileSpec.thickness / 2 + (tileSpec.backThickness + 1.2) / 2;
    back.castShadow = true;
    back.receiveShadow = true;
    group.add(back);
    if (faceVisible) {
      const key = `${tile.kind}:${tile.red && RED_FACE_FILES.has(tile.kind) ? 1 : 0}`;
      const material = this.faceMaterials.get(key) ?? this.faceMaterials.get(`${tile.kind}:0`);
      if (material) {
        const decal = new THREE.Mesh(this.decalGeometry, material);
        decal.position.z = tileSpec.thickness / 2 + 0.15;
        group.add(decal);
      }
    }
    return group;
  }

  _addTilePlacement(item) {
    const group = this._makeTile(item.tile, item.faceVisible);
    group.name = item.key;
    group.position.set(item.position.x, item.position.y, item.position.z);
    group.rotation.set(item.rotation.x, item.rotation.y, item.rotation.z);
    group.userData.placement = item;
    this.seatGroups[item.seat]?.add(group);
    this.targetMap.set(item.key, group);
    if (item.tile?.id !== null && item.tile?.id !== undefined) this.targetMap.set(`tile-id:${item.tile.id}`, group);
    if (item.meta?.kakanAdded) {
      this.targetMap.set(`kakan:${item.seat}:${item.meta.meldIndex}`, group);
      this.targetMap.set(`kakan:${item.seat}`, group);
      if (item.meta.kakanPreview) this.targetMap.set(`kakan-preview:${item.seat}`, group);
    }
    if (item.meta?.isLastDiscard) this.targetMap.set('last-discard', group);
    return group;
  }

  _addRiichiStick(item) {
    const body = new THREE.Mesh(this.riichiBodyGeometry, this.riichiBodyMaterial);
    body.castShadow = true;
    body.receiveShadow = true;
    const group = new THREE.Group();
    group.name = item.key;
    group.add(body);
    const dot = new THREE.Mesh(this.riichiDotGeometry, this.riichiMarkMaterial);
    dot.position.y = 2.35;
    group.add(dot);
    for (const x of [-29, -22, 22, 29]) {
      const mark = new THREE.Mesh(this.riichiMarkGeometry, this.riichiMarkMaterial);
      mark.position.set(x, 2.35, 0);
      group.add(mark);
    }
    group.position.set(item.position.x, item.position.y, item.position.z);
    this.seatGroups[item.seat]?.add(group);
  }

  _resolveFocusTarget(target) {
    const type = String(target?.type ?? '').toLowerCase();
    const seat = normalizedSeat(target?.discarder ?? target?.loser ?? target?.seat ?? target?.player ?? this.lastOptions?.lastDiscardPlayer, 0);
    const tileId = target?.tile?.id ?? target?.tileId;
    if (tileId !== undefined && tileId !== null) {
      const exact = this.targetMap.get(`tile-id:${tileId}`);
      if (exact) return exact;
    }
    if (type === 'chankan-added' || type === 'chankan' || type === 'kakan' || type === 'kakan-preview') {
      const meldIndex = target?.meldIndex;
      return this.targetMap.get(Number.isInteger(meldIndex) ? `kakan:${seat}:${meldIndex}` : `kakan-preview:${seat}`) ??
        this.targetMap.get(`kakan:${seat}`) ?? null;
    }
    if (type === 'tsumo-drawn' || type === 'tsumo' || type === 'drawn') {
      return target?.tile ? this._createTsumoTarget(seat, target.tile) : this.targetMap.get(`drawn:${seat}`) ?? null;
    }
    if (type === 'ron-discard' || type === 'ron' || type === 'discard' || type === 'last-discard') {
      const serial = target?.serial ?? target?.discardSerial;
      return this.targetMap.get(Number.isInteger(serial) ? `discard:${seat}:${serial}` : `last-discard:${seat}`) ??
        this.targetMap.get('last-discard') ?? null;
    }
    return null;
  }

  _createTsumoTarget(seat, tileData) {
    if (seat === 0 || !tileData) return null;
    this._removeEphemeralTile();
    const bounds = this.lastLayout?.rackBounds?.[seat];
    const tile = WEBGL_TABLETOP_CONTRACT.tile;
    const rack = WEBGL_TABLETOP_CONTRACT.rack;
    const x = bounds ? bounds.rightEdge + tile.width / 2 + 7 : 0;
    const concealedDrawn = this.targetMap.get(`drawn:${seat}`) ?? null;
    if (concealedDrawn) {
      concealedDrawn.visible = false;
      this.hiddenDrawnTile = concealedDrawn;
    }
    const group = this._makeTile(tileData, true);
    group.name = `tsumo:${seat}`;
    group.position.set(x, tile.thickness / 2 + 0.2, rack.z - tile.height - 5);
    group.rotation.set(-HALF_PI, 0, 0);
    group.userData.ephemeralWinTile = true;
    this.seatGroups[seat]?.add(group);
    this.ephemeralTile = group;
    this.targetMap.set(`tsumo:${seat}`, group);
    return group;
  }

  _applyFocus(target) {
    this._detachFocusEffect();
    const type = String(target?.type ?? '').toLowerCase();
    if (type !== 'tsumo-drawn' && type !== 'tsumo' && type !== 'drawn') this._removeEphemeralTile();
    const group = this._resolveFocusTarget(target);
    if (!group || !this.focusEffect) {
      this._drawFrame();
      return false;
    }
    group.add(this.focusEffect);
    this.focusEffect.position.set(0, 0, 0);
    this.focusEffect.rotation.set(0, 0, 0);
    this.focusEffect.visible = true;
    this.focusedTile = group;
    this._startFocusAnimation();
    return true;
  }

  _detachFocusEffect() {
    if (this.animationFrame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.focusEffect?.removeFromParent?.();
    if (this.focusEffect) this.focusEffect.visible = false;
    this.focusedTile = null;
  }

  _removeEphemeralTile() {
    if (this.ephemeralTile) {
      this.ephemeralTile.removeFromParent?.();
      this.ephemeralTile = null;
    }
    if (this.hiddenDrawnTile) {
      this.hiddenDrawnTile.visible = true;
      this.hiddenDrawnTile = null;
    }
  }

  _startFocusAnimation() {
    const started = typeof performance !== 'undefined' ? performance.now() : 0;
    const tick = now => {
      if (!this.focusEffect?.visible || this.disposed || this.contextLost) return;
      const wave = 0.5 + Math.sin((now - started) / 260) * 0.5;
      this.focusEffect.userData.glow.material.opacity = 0.27 + wave * 0.22;
      this.focusEffect.userData.light.intensity = 1.2 + wave * 1.2;
      this._drawFrame();
      this.animationFrame = requestAnimationFrame(tick);
    };
    if (typeof requestAnimationFrame === 'function') this.animationFrame = requestAnimationFrame(tick);
    else this._drawFrame();
  }

  _installResizeHandling() {
    this._boundResize = () => this._resize();
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(this._boundResize);
      this.resizeObserver.observe(this.container);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', this._boundResize);
    }
    this._resize();
  }

  _resize() {
    if (!this.renderer || !this.camera || !this.container) return;
    const width = Math.max(1, Math.round(this.container.clientWidth || 1280));
    const height = Math.max(1, Math.round(this.container.clientHeight || width * 9 / 16));
    const pixelRatio = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    const cameraProfile = cameraProfileForViewport(width, height);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.cameraProfile = cameraProfile;
    this.camera.fov = cameraProfile.fov;
    this.camera.near = cameraProfile.near;
    this.camera.far = cameraProfile.far;
    this.camera.aspect = width / height;
    this.camera.position.set(cameraProfile.position.x, cameraProfile.position.y, cameraProfile.position.z);
    this.camera.lookAt(cameraProfile.lookAt.x, cameraProfile.lookAt.y, cameraProfile.lookAt.z);
    if (this.scene?.fog) {
      this.scene.fog.near = cameraProfile.fog.near;
      this.scene.fog.far = cameraProfile.fog.far;
    }
    this.camera.updateProjectionMatrix();
    this._drawFrame();
  }

  _drawFrame() {
    if (this.ready && !this.contextLost && this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
    this._updateReport();
  }

  _updateReport(error = null) {
    const layout = this.lastLayout ?? layoutWebGLTabletop();
    const report = Object.freeze({
      version: WEBGL_TABLETOP_CONTRACT.version,
      cameraCount: this.camera ? 1 : 0,
      cameraProfile: this.cameraProfile?.id ?? null,
      cameraFov: this.camera?.fov ?? null,
      cameraAspect: this.camera?.aspect ?? null,
      cameraPosition: this.camera ? Object.freeze({
        x: this.camera.position.x,
        y: this.camera.position.y,
        z: this.camera.position.z,
      }) : null,
      cameraFog: this.scene?.fog ? Object.freeze({
        near: this.scene.fog.near,
        far: this.scene.fog.far,
      }) : null,
      seatCount: 4,
      contextLost: this.contextLost === true,
      renderedStateId: layout.renderedStateId ?? null,
      riverTileCount: layout.riverTiles.length,
      meldTileCount: layout.meldTiles.length,
      wallTileCount: layout.wallTiles.length,
      error: error ?? this.error,
    });
    if (typeof window !== 'undefined') window.__JUN_WEBGL_REPORT = report;
    return report;
  }
}

// sw.js — オフライン対応 (HTTPSで配信されたときのみ登録される)
const CACHE = 'jun-mahjong-v67-threat-value';
const TILE_FACE_FILES = [
  'Man1.svg', 'Man2.svg', 'Man3.svg', 'Man4.svg', 'Man5.svg', 'Man5-Dora.svg', 'Man6.svg', 'Man7.svg', 'Man8.svg', 'Man9.svg',
  'Pin1.svg', 'Pin2.svg', 'Pin3.svg', 'Pin4.svg', 'Pin5.svg', 'Pin5-Dora.svg', 'Pin6.svg', 'Pin7.svg', 'Pin8.svg', 'Pin9.svg',
  'Sou1.svg', 'Sou2.svg', 'Sou3.svg', 'Sou4.svg', 'Sou5.svg', 'Sou5-Dora.svg', 'Sou6.svg', 'Sou7.svg', 'Sou8.svg', 'Sou9.svg',
  'Ton.svg', 'Nan.svg', 'Shaa.svg', 'Pei.svg', 'Haku.svg', 'Hatsu.svg', 'Chun.svg',
].map(file => `assets/tile_faces_v10/${file}`);
const VOICE_CUES = [
  'riichi', 'pon', 'chi', 'kan', 'ron', 'tsumo',
  'thought-defense', 'thought-push', 'thought-efficiency', 'thought-value', 'thought-suit_read',
];
const VOICE_FILES = ['hanzo', 'joe', 'himeko']
  .flatMap(character => VOICE_CUES.map(cue => `assets/audio/voice/${character}/${cue}-v1.wav`));
const ASSETS = [
  '.', 'index.html', 'css/style.css?v=12', 'css/table-v9.css?v=16',
  'css/tokens-v15.css?v=15', 'css/learning-modes-v15.css?v=17', 'css/product-ui-v16.css?v=1',
  'css/product-ui-v17.css?v=1', 'css/are-report-v1.css?v=4', 'css/stats-v1.css?v=1', 'css/win-cinematic-v1.css?v=4', 'css/tile-3d-v1.css?v=1', 'css/riichi-stick-v1.css?v=1', 'css/title-cinematic-v1.css?v=1', 'css/table-physical-v2.css?v=1', 'css/table-geometry-v3.css?v=1', 'css/table-geometry-v4.css?v=1', 'css/tile-cuboid-v2.css?v=1', 'css/tabletop-projection-v1.css?v=1', 'css/webgl-tabletop-v1.css?v=4', 'manifest.webmanifest',
  'js/ui/main.js?v=51', 'js/ui/stats-store.js?v=1', 'js/ui/are-report.js?v=1', 'js/ui/register-sw.js?v=14', 'js/ui/tilesvg.js?v=10', 'js/ui/tile-cuboid.js?v=2', 'js/ui/tabletop-projection.js?v=1', 'js/ui/webgl-tabletop.js?v=4', 'js/ui/gameplay-controls.js?v=12',
  'js/vendor/three/three.module.js', 'js/vendor/three/three.core.js',
  'js/vendor/three/addons/geometries/RoundedBoxGeometry.js',
  'js/ui/win-presentation.js?v=3',
  'js/ui/decision-presenter.js?v=17', 'js/ui/audio-director.js?v=18', 'js/ui/audio-manifest.js?v=18',
  'js/ui/gamepad-controller.js?v=17',
  'js/platform/desktop-settings.js?v=17',
  'js/engine/rules.js', 'js/engine/tiles.js', 'js/engine/wall.js',
  'js/engine/agari.js', 'js/engine/shanten.js', 'js/engine/yaku.js',
  'js/engine/score.js', 'js/engine/placement.js',
  'js/engine/opening-dealer.js', 'js/engine/opening-dealer.js?v=17',
  'js/engine/game.js?v=18', 'js/engine/ai.js?v=18',
  'js/engine/decision-contract.js', 'js/engine/decision-log.js',
  'js/engine/legal-actions.js', 'js/engine/decision-boundary.js',
  'js/engine/decision-evaluator.js?v=18', 'js/engine/win-uncertainty.js',
  'js/engine/review-evaluator.js?v=18', 'js/engine/session-snapshot.js', 'js/engine/decision-coach.js?v=5',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'assets/gptimage_v1/table_felt_v1.png',
  'assets/gptimage_v1/hanzou_portrait_v1.png',
  'assets/gptimage_v1/joe_portrait_v1.png',
  'assets/gptimage_v1/himeko_portrait_v1.png',
  'assets/gptimage_v2/mahjong_tile_master_cropped_v1.png',
  'assets/gptimage_v3/center_device_v1.png',
  'assets/gptimage_v4/oblique_blue_table_base_v1.webp',
  'assets/gptimage_v4/oblique_blue_table_portrait_v1.webp',
  'assets/gptimage_v8/private_room_no_table_v1.png',
  'assets/gptimage_v5/win_lightning_impact_v1.png',
  'assets/gptimage_v6/riichi_stick_sprite_v1.png',
  'assets/gptimage_v7/title_private_table_v1.png',
  'assets/audio/music/night_private_table_loop_v1.ogg',
  'assets/audio/sfx/tile_discard_v2.ogg',
  'assets/audio/sfx/ui_button_v1.ogg',
  'assets/audio/sfx/call_accent_v1.ogg',
  'assets/audio/VOICE_LICENSES.md',
  'assets/audio/voice/voice-assets-v1.json',
  ...VOICE_FILES,
  ...TILE_FACE_FILES,
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }))
  );
});

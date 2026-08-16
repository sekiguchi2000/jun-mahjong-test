// register-sw.js — 公開PWAだけService Workerを登録する。Electronのjun:では不要。
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(error => {
    console.warn('Service Worker registration failed.', error);
  });
}

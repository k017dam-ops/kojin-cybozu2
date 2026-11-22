// 個人サイボウズ2 Service Worker: アプリ本体のキャッシュだけを扱う。
// 予定データは localStorage 側にあり、ここでは一切扱わない。
// 方針はネット優先：新しい版が置かれたら必ず届くようにし、
// 取れた応答でキャッシュも更新する。オフラインのときだけキャッシュを返す。
const CACHE = "kojin-cybozu2-v13";
// アイコンPNGはまだ配置できていない（404のファイルが1つでもあると addAll 全体が失敗するため、置けるまで外す）。
const ASSETS = ["./index.html", "./app.js", "./manifest.webmanifest"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request))
  );
});

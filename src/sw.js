// ============================================================
// sw.js — カスタムService Worker
// vite-plugin-pwa(injectManifest方式)がビルド時に
// self.__WB_MANIFEST へプリキャッシュ対象を注入する
// ============================================================
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// ---- プッシュ受信: アプリを閉じていてもOSが通知を表示する ----
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "🍺 やらかし警報", {
      body: data.body || "定時報告や。水を一杯挟んどきや。",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // tagは指定しない: 同じtagの通知が通知センターに残っていると、iOSは
      // 新しい通知をバナーも音もなしでサイレントに差し替えてしまう
      // (renotifyはWebKit未対応のため回避できない)
    })
  );
});

// 通知タップ → アプリを開く(開いていればフォーカス)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const client = list.find((c) => c.url.includes(self.location.origin));
      return client ? client.focus() : self.clients.openWindow("/");
    })
  );
});

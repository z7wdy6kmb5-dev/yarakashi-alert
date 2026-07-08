// ============================================================
// /api/notify — プッシュ通知の送信エンドポイント
// 外部スケジューラ(cron-job.org等)から定期的にPOSTされる想定
//
// 認証: Authorization: Bearer <CRON_SECRET>
// ボディ: { "subscription": {...}, "title": "任意", "body": "任意" }
//   subscription はアプリの「予約・設定」タブでコピーできる購読情報JSON
//
// 必要な環境変数(Vercelダッシュボードで設定):
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / CRON_SECRET
// ============================================================
const webpush = require("web-push");

const MSGS = [
  "定時報告や。この間の写真、覚えてるか？",
  "水も一杯挟んどきや。",
  "今のペース、あの夜と同じやで。",
  "明日の自分から警告が届いてます。",
  "財布とスマホの位置を今すぐ確認せよ。",
  "終電の時刻、把握してるか？",
];

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  // 認証(誰でも通知を打てる状態を防ぐ)
  const auth = req.headers.authorization || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return res.status(500).json({ error: "VAPID keys not configured" });
  }

  const { subscription, title, body } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "subscription required" });
  }

  webpush.setVapidDetails(
    "mailto:notify@yarakashi-alert.local",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  try {
    await webpush.sendNotification(
      subscription,
      JSON.stringify({
        title: title || "🍺 やらかし警報",
        body: body || MSGS[Math.floor(Math.random() * MSGS.length)],
      })
    );
    return res.status(200).json({ ok: true });
  } catch (e) {
    // 410 Gone = 購読が失効(iOS側で無効化された等) → アプリで再有効化が必要
    return res.status(e.statusCode === 410 ? 410 : 500).json({
      error: e.statusCode === 410 ? "subscription expired: re-enable in app" : String(e.message),
    });
  }
};

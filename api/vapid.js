// ============================================================
// /api/vapid — 現在サーバーが使っているVAPID公開鍵を返す
// クライアントは購読時に必ずここから鍵を取得することで、
// 古いJSバンドルのキャッシュによる鍵不一致(BadJwtToken)を防ぐ
// 公開鍵は秘匿情報ではないため認証不要
// ============================================================
export default (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY || "";
  if (!key) {
    return res.status(500).json({ error: "VAPID_PUBLIC_KEY not configured" });
  }
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ key });
};

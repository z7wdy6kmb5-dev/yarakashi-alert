// ============================================================
// /api/ping — Service Workerがpushを受信した事実を記録するだけの診断用
// iOSがアプリ終了中にSWを起こしているのかを切り分けるために使う
// (Vercelのランタイムログに出るのでSafariの開発者ツールが不要)
// ============================================================
export default (req, res) => {
  const from = req.query?.from || "unknown";
  console.log(`[ping] sw push received from=${from} at=${new Date().toISOString()}`);
  res.setHeader("Cache-Control", "no-store");
  return res.status(204).end();
};

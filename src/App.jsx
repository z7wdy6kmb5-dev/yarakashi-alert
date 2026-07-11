import { useState, useEffect, useRef, useCallback } from "react";
import { storage } from "./storage";

// ============================================================
// 飲み会やらかし警報 — YARAKASHI ALERT
// ・やらかし写真を登録 → 飲み会中に強制表示して飲みすぎを抑止
// ・事前スケジュール登録 / 「今すぐ開始」の両対応
// ・window.storage で永続化(リロードしても消えない)
// ============================================================

// ---------- storage helpers ----------
const sGet = async (key) => {
  try {
    const r = await storage.get(key);
    return r ? JSON.parse(r.value) : null;
  } catch {
    return null;
  }
};
const sSet = async (key, val) => {
  try {
    await storage.set(key, JSON.stringify(val));
  } catch (e) {
    console.error("storage set failed", e);
  }
};
const sDel = async (key) => {
  try {
    await storage.delete(key);
  } catch {}
};

// ---------- image compression (canvas → jpeg base64) ----------
const compressImage = (file, maxDim = 720, quality = 0.65) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const scale = Math.min(1, maxDim / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

// ---------- warning messages (escalating) ----------
const MSGS_INTERVAL = [
  "定時報告や。この写真、覚えてるか？",
  "水も一杯挟んどきや。",
  "今のペース、あの夜と同じやで。",
  "明日の自分から警告が届いてます。",
  "この顔になりたくなかったら、次はウーロン茶。",
];
const MSGS_OVER = [
  "⚠ 上限超過。この写真の再現が始まろうとしています。",
  "⚠ もうやめとけ。証拠は揃ってる。",
  "⚠ ここから先は記憶が保証されません。",
  "⚠ 財布とスマホの位置を今すぐ確認せよ。",
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---------- beep ----------
const beep = () => {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const play = (freq, t0, dur) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "square";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.12, ctx.currentTime + t0);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t0 + dur);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t0);
      o.stop(ctx.currentTime + t0 + dur);
    };
    play(880, 0, 0.15);
    play(660, 0.2, 0.15);
    play(880, 0.4, 0.25);
  } catch {}
};

const notifyBrowser = (body) => {
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("🍺 やらかし警報", { body });
    }
  } catch {}
};

// ---- Web Push購読 ----
const VAPID_PUBLIC_KEY =
  "BD1XZruT68QKr-FZUBEiV8xbqANYBG50lIpRy6cZMhEXgmMY4frNIuIqJA6URmlXLuNhje0YkRfwEYlIh0nO5gY";

// VAPID鍵(base64url)をPushManagerが要求するUint8Arrayへ変換
const urlBase64ToUint8Array = (base64) => {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};

const fmtTime = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h > 0 ? `${h}:` : "") + `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
};
const fmtDT = (iso) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ============================================================
export default function App() {
  const [tab, setTab] = useState("home"); // home | photos | schedule
  const [photos, setPhotos] = useState([]); // {id, caption}
  const [photoData, setPhotoData] = useState({}); // id -> dataURL
  const [schedules, setSchedules] = useState([]); // {id, at, done}
  const [settings, setSettings] = useState({ intervalMin: 30, drinkLimit: 4 });
  const [session, setSession] = useState(null); // {startedAt, drinks, lastAlertAt}
  const [alert, setAlert] = useState(null); // {photoId, msg, over}
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [now, setNow] = useState(Date.now());
  const fileRef = useRef(null);

  // ---------- load ----------
  useEffect(() => {
    (async () => {
      const meta = (await sGet("photos-meta")) || [];
      const st = (await sGet("app-state")) || {};
      setPhotos(meta);
      setSchedules(st.schedules || []);
      setSettings(st.settings || { intervalMin: 30, drinkLimit: 4 });
      setSession(st.session || null);
      const data = {};
      for (const p of meta) {
        const d = await sGet(`photo:${p.id}`);
        if (d) data[p.id] = d;
      }
      setPhotoData(data);
      setLoading(false);
    })();
  }, []);

  // ---------- persist app-state ----------
  const persist = useCallback((sch, set, ses) => {
    sSet("app-state", { schedules: sch, settings: set, session: ses });
  }, []);

  // ---------- tick: 1秒ごとに時刻更新・スケジュール起動・定時警報を判定 ----------
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const fireAlert = useCallback(
    (over) => {
      const msg = over ? pick(MSGS_OVER) : pick(MSGS_INTERVAL);
      const photoId = photos.length ? pick(photos).id : null;
      setAlert({ photoId, msg, over });
      beep();
      notifyBrowser(msg);
    },
    [photos]
  );

  useEffect(() => {
    if (loading) return;
    // スケジュール到達 → 自動開始
    const due = schedules.find((s) => !s.done && new Date(s.at).getTime() <= now);
    if (due && !session) {
      const newSch = schedules.map((s) => (s.id === due.id ? { ...s, done: true } : s));
      const ses = { startedAt: now, drinks: 0, lastAlertAt: now };
      setSchedules(newSch);
      setSession(ses);
      persist(newSch, settings, ses);
      fireAlert(false);
      return;
    }
    // 定時警報
    if (session && !alert) {
      const elapsed = now - session.lastAlertAt;
      if (elapsed >= settings.intervalMin * 60 * 1000) {
        const ses = { ...session, lastAlertAt: now };
        setSession(ses);
        persist(schedules, settings, ses);
        fireAlert(session.drinks >= settings.drinkLimit);
      }
    }
  }, [now, loading]); // eslint-disable-line

  // ---------- actions ----------
  const startSession = () => {
    try {
      if ("Notification" in window && Notification.permission === "default")
        Notification.requestPermission();
    } catch {}
    const ses = { startedAt: Date.now(), drinks: 0, lastAlertAt: Date.now() };
    setSession(ses);
    persist(schedules, settings, ses);
  };
  const endSession = () => {
    setSession(null);
    setAlert(null);
    persist(schedules, settings, null);
  };
  const addDrink = () => {
    const drinks = session.drinks + 1;
    const over = drinks > settings.drinkLimit;
    const ses = { ...session, drinks, ...(over ? { lastAlertAt: Date.now() } : {}) };
    setSession(ses);
    persist(schedules, settings, ses);
    if (over) fireAlert(true);
  };

  const onUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setUploading(true);
    const newMeta = [...photos];
    const newData = { ...photoData };
    for (const f of files) {
      try {
        const dataUrl = await compressImage(f);
        const id = uid();
        await sSet(`photo:${id}`, dataUrl);
        newMeta.push({ id, caption: "" });
        newData[id] = dataUrl;
      } catch (err) {
        console.error("upload failed", err);
      }
    }
    setPhotos(newMeta);
    setPhotoData(newData);
    await sSet("photos-meta", newMeta);
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  };
  const setCaption = (id, caption) => {
    const m = photos.map((p) => (p.id === id ? { ...p, caption } : p));
    setPhotos(m);
    sSet("photos-meta", m);
  };
  const deletePhoto = (id) => {
    const m = photos.filter((p) => p.id !== id);
    setPhotos(m);
    const d = { ...photoData };
    delete d[id];
    setPhotoData(d);
    sSet("photos-meta", m);
    sDel(`photo:${id}`);
  };

  const [schInput, setSchInput] = useState("");

  // ---- プッシュ通知の購読管理 ----
  const [pushSub, setPushSub] = useState(null); // 購読情報JSON文字列
  const [pushMsg, setPushMsg] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // 既存の購読があれば表示に反映
    (async () => {
      try {
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) setPushSub(JSON.stringify(sub));
      } catch {}
    })();
  }, []);

  const enablePush = async () => {
    setPushMsg("");
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setPushMsg("この環境はプッシュ通知非対応です。iPhoneは「ホーム画面に追加」したアプリから開いてください。");
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setPushMsg("通知が許可されませんでした。iPhoneの設定から本アプリの通知を許可してください。");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) await existing.unsubscribe(); // 鍵を変えて再購読する前に既存分を解除
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      setPushSub(JSON.stringify(sub));
      setPushMsg("有効化完了。下の購読情報をスケジューラに登録してください。");
    } catch (e) {
      setPushMsg("有効化に失敗: " + String(e.message || e));
    }
  };

  const copySub = async () => {
    try {
      await navigator.clipboard.writeText(pushSub);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  const addSchedule = () => {
    if (!schInput) return;
    const sch = [...schedules, { id: uid(), at: schInput, done: false }].sort(
      (a, b) => new Date(a.at) - new Date(b.at)
    );
    setSchedules(sch);
    persist(sch, settings, session);
    setSchInput("");
  };
  const deleteSchedule = (id) => {
    const sch = schedules.filter((s) => s.id !== id);
    setSchedules(sch);
    persist(sch, settings, session);
  };
  const updateSettings = (patch) => {
    const s = { ...settings, ...patch };
    setSettings(s);
    persist(schedules, s, session);
  };

  // ---------- derived ----------
  const nextSchedule = schedules.find((s) => !s.done && new Date(s.at).getTime() > now);
  const nextAlertIn = session
    ? settings.intervalMin * 60 * 1000 - (now - session.lastAlertAt)
    : 0;
  const overLimit = session && session.drinks > settings.drinkLimit;

  if (loading)
    return (
      <div className="app-root" style={{ ...S.root, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <style>{CSS}</style>
        <div className="load-lantern" style={S.loadLantern}>酒</div>
      </div>
    );

  return (
    <div className="app-root" style={S.root}>
      <style>{CSS}</style>
      {/* 質感レイヤー: 粒状ノイズ + 提灯の環境光(どちらも操作を妨げない) */}
      <div style={S.noise} aria-hidden="true" />
      <div style={S.ambient} aria-hidden="true" />

      {/* header */}
      <header style={S.header}>
        <div style={S.lantern}>酒</div>
        <div>
          <div style={S.title}>やらかし警報</div>
          <div style={S.subtitle}>YARAKASHI ALERT SYSTEM</div>
        </div>
        {session && <div className="live-dot" style={S.liveDot} />}
      </header>

      {/* ============ SESSION MODE ============ */}
      {session ? (
        <main style={S.main}>
          <div style={S.sessionCard} className="rise">
            <div style={S.eyebrow}>飲み会 進行中</div>
            <div style={S.bigTimer}>{fmtTime(now - session.startedAt)}</div>
            <div style={S.timerLabel}>経過時間</div>

            <div style={S.drinkRow}>
              <div>
                <div style={{ ...S.drinkCount, color: overLimit ? "#FF4438" : "#FFB03A" }}>
                  {session.drinks}
                  <span style={S.drinkUnit}>/{settings.drinkLimit} 杯</span>
                </div>
                <div style={S.timerLabel}>{overLimit ? "上限超過中" : "飲んだ杯数"}</div>
              </div>
              <button className="btn-drink" onClick={addDrink}>
                🍺 一杯飲んだ
              </button>
            </div>

            <div style={S.nextAlert}>
              次の警報まで <b style={{ color: "#FFB03A" }}>{fmtTime(nextAlertIn)}</b>
              {photos.length === 0 && (
                <div style={{ color: "#FF4438", marginTop: 6, fontSize: 12 }}>
                  ※ やらかし写真が未登録です。「写真」タブから登録してください
                </div>
              )}
            </div>

            <button className="btn-end" onClick={endSession}>
              飲み会を終了する
            </button>
          </div>
        </main>
      ) : (
        /* ============ NORMAL MODE ============ */
        <main style={S.main}>
          {tab === "home" && (
            <>
              <button className="btn-start" onClick={startSession}>
                <span style={{ fontSize: 15, opacity: 0.85 }}>いまから飲む</span>
                <span style={{ fontSize: 30, fontFamily: "'DotGothic16', monospace" }}>
                  飲み会 開始
                </span>
              </button>

              <div style={S.infoGrid} className="stagger">
                <div style={S.infoCard}>
                  <div style={S.infoNum}>{photos.length}</div>
                  <div style={S.infoLabel}>登録済みの証拠写真</div>
                </div>
                <div style={S.infoCard}>
                  <div style={{ ...S.infoNum, fontSize: nextSchedule ? 18 : 28 }}>
                    {nextSchedule ? fmtDT(nextSchedule.at) : "—"}
                  </div>
                  <div style={S.infoLabel}>次回の飲み会</div>
                </div>
              </div>

              <div style={S.note}>
                スケジュール登録した時刻になると自動で監視が始まります(このアプリを開いておくこと)。
                飲み会中は{settings.intervalMin}分ごと・上限{settings.drinkLimit}杯超過時に、
                過去のやらかし写真が警告として表示されます。
              </div>
            </>
          )}

          {tab === "photos" && (
            <>
              <button className="btn-upload" onClick={() => fileRef.current?.click()} disabled={uploading}>
                {uploading ? "圧縮・保存中…" : "＋ やらかし写真を追加"}
              </button>
              <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={onUpload} />
              {photos.length === 0 && (
                <div style={S.empty}>
                  まだ証拠がありません。
                  <br />
                  未来の自分を止めるのは、過去の自分の写真です。
                </div>
              )}
              <div style={S.photoGrid} className="stagger">
                {photos.map((p) => (
                  <div key={p.id} style={S.photoCard}>
                    {photoData[p.id] ? (
                      <img src={photoData[p.id]} alt={p.caption || "やらかし写真"} style={S.photoImg} />
                    ) : (
                      <div style={{ ...S.photoImg, background: "#241C16" }} />
                    )}
                    <input
                      style={S.captionInput}
                      placeholder="何をやらかした？"
                      value={p.caption}
                      onChange={(e) => setCaption(p.id, e.target.value)}
                    />
                    <button className="btn-del" onClick={() => deletePhoto(p.id)}>
                      削除
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === "schedule" && (
            <>
              <div style={S.sectionTitle}>飲み会を予約</div>
              <div style={S.schedRow}>
                <input
                  type="datetime-local"
                  style={S.dtInput}
                  value={schInput}
                  onChange={(e) => setSchInput(e.target.value)}
                />
                <button className="btn-add" onClick={addSchedule}>
                  登録
                </button>
              </div>
              {schedules.filter((s) => !s.done).map((s) => (
                <div key={s.id} style={S.schedItem}>
                  <span style={{ fontFamily: "'DotGothic16', monospace", fontSize: 18 }}>
                    {fmtDT(s.at)}
                  </span>
                  <button className="btn-del" onClick={() => deleteSchedule(s.id)}>
                    取消
                  </button>
                </div>
              ))}

              <div style={{ ...S.sectionTitle, marginTop: 28 }}>警報の設定</div>
              <div style={S.settingRow}>
                <span>警報の間隔</span>
                <select
                  style={S.select}
                  value={settings.intervalMin}
                  onChange={(e) => updateSettings({ intervalMin: Number(e.target.value) })}
                >
                  {[0.5, 15, 20, 30, 45, 60].map((m) => (
                    <option key={m} value={m}>
                      {m < 1 ? "30秒(テスト用)" : `${m}分ごと`}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ ...S.sectionTitle, marginTop: 28 }}>プッシュ通知(アプリを閉じていても届く)</div>
              <button className="btn-upload" onClick={enablePush}>
                {pushSub ? "✓ 有効化済み(再発行する)" : "プッシュ通知を有効化"}
              </button>
              {pushMsg && <div style={{ fontSize: 12, color: "#C9B08A", lineHeight: 1.7 }}>{pushMsg}</div>}
              {pushSub && (
                <>
                  <textarea readOnly value={pushSub} style={S.subArea} rows={4} />
                  <button className="btn-add" onClick={copySub}>
                    {copied ? "コピーした" : "購読情報をコピー"}
                  </button>
                  <div style={S.note}>
                    この購読情報を cron-job.org 等の外部スケジューラに登録すると、
                    アプリを閉じていても定時通知が届きます(設定手順は別途)。
                  </div>
                </>
              )}

              <div style={S.settingRow}>
                <span>杯数の上限</span>
                <select
                  style={S.select}
                  value={settings.drinkLimit}
                  onChange={(e) => updateSettings({ drinkLimit: Number(e.target.value) })}
                >
                  {[2, 3, 4, 5, 6, 8].map((n) => (
                    <option key={n} value={n}>
                      {n}杯まで
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
        </main>
      )}

      {/* bottom tabs (通常時のみ) */}
      {!session && (
        <nav style={S.nav}>
          {[
            ["home", "ホーム"],
            ["photos", `写真 (${photos.length})`],
            ["schedule", "予約・設定"],
          ].map(([k, label]) => (
            <button
              key={k}
              className={"tab" + (tab === k ? " tab-on" : "")}
              onClick={() => setTab(k)}
            >
              {label}
            </button>
          ))}
        </nav>
      )}

      {/* ============ ALERT OVERLAY ============ */}
      {alert && (
        <div style={S.overlay} className="alert-flash">
          <div style={S.alertBanner}>⚠ やらかし警報 ⚠</div>
          {alert.photoId && photoData[alert.photoId] ? (
            <img src={photoData[alert.photoId]} alt="登録したやらかし写真" className="evidence" style={S.alertImg} />
          ) : (
            <div style={S.alertNoPhoto}>
              (写真未登録)
              <br />
              想像してください。あの夜を。
            </div>
          )}
          {alert.photoId &&
            photos.find((p) => p.id === alert.photoId)?.caption && (
              <div style={S.alertCaption}>
                「{photos.find((p) => p.id === alert.photoId).caption}」
              </div>
            )}
          <div style={S.alertMsg}>{alert.msg}</div>
          <button className="btn-ack" onClick={() => setAlert(null)}>
            反省した。水を飲む
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================
// styles
// ============================================================
// ざらつき用ノイズ(SVG feTurbulenceをdata URI化。画像リクエスト不要)
const NOISE_URI =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E\")";

const S = {
  root: {
    // min-heightはCSS側で 100vh → 100dvh フォールバック管理(iOS Safari対策)
    background: "#120D0A",
    color: "#F2E4CE",
    fontFamily: "'Zen Kaku Gothic New', sans-serif",
    display: "flex",
    flexDirection: "column",
    maxWidth: 480,
    margin: "0 auto",
    position: "relative",
    overflow: "hidden",
  },
  noise: {
    position: "fixed",
    inset: 0,
    backgroundImage: NOISE_URI,
    opacity: 0.05,
    pointerEvents: "none",
    zIndex: 200, // 警報オーバーレイの上にも粒子を乗せてフィルム感を統一
    mixBlendMode: "overlay",
  },
  ambient: {
    position: "absolute",
    inset: 0,
    background:
      "radial-gradient(ellipse 90% 40% at 50% -5%, rgba(255,106,60,.10), transparent 70%)",
    pointerEvents: "none",
    zIndex: 0,
  },
  loadLantern: {
    width: 72,
    height: 72,
    borderRadius: "50% 50% 46% 46%",
    background: "radial-gradient(circle at 50% 35%, #FF6A3C, #C42B1C)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 30,
    color: "#FFF3DC",
    fontWeight: 700,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: "18px 20px 14px",
    borderBottom: "1px solid #2E241B",
  },
  lantern: {
    width: 44,
    height: 44,
    borderRadius: "50% 50% 46% 46%",
    background: "radial-gradient(circle at 50% 35%, #FF6A3C, #C42B1C)",
    boxShadow: "0 0 18px rgba(255,106,60,.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 20,
    color: "#FFF3DC",
    fontWeight: 700,
  },
  title: { fontFamily: "'DotGothic16', monospace", fontSize: 22, letterSpacing: 2 },
  subtitle: { fontSize: 10, letterSpacing: 3, color: "#8A6F4D", marginTop: 2 },
  liveDot: {
    marginLeft: "auto",
    width: 12,
    height: 12,
    borderRadius: "50%",
    background: "#FF4438",
  },
  main: { flex: 1, padding: "20px 20px 90px", display: "flex", flexDirection: "column", gap: 16 },
  infoGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
  infoCard: {
    background: "#1C1510",
    border: "1px solid #2E241B",
    borderRadius: 12,
    padding: "16px 14px",
    textAlign: "center",
  },
  infoNum: { fontFamily: "'DotGothic16', monospace", fontVariantNumeric: "tabular-nums", fontSize: 28, color: "#FFB03A" },
  infoLabel: { fontSize: 11, color: "#8A6F4D", marginTop: 4 },
  note: { fontSize: 12, lineHeight: 1.8, color: "#8A6F4D", padding: "0 4px" },
  sessionCard: {
    background: "#1C1510",
    border: "1px solid #3A2B1C",
    borderRadius: 16,
    padding: 24,
    display: "flex",
    flexDirection: "column",
    gap: 18,
  },
  eyebrow: {
    fontSize: 11,
    letterSpacing: 3,
    color: "#FF4438",
    fontFamily: "'DotGothic16', monospace",
  },
  bigTimer: {
    fontFamily: "'DotGothic16', monospace",
    fontVariantNumeric: "tabular-nums",
    fontSize: 56,
    color: "#FFB03A",
    lineHeight: 1,
    letterSpacing: 2,
    textShadow: "0 0 24px rgba(255,176,58,.3)",
  },
  timerLabel: { fontSize: 11, color: "#8A6F4D", marginTop: -10 },
  drinkRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
  drinkCount: { fontFamily: "'DotGothic16', monospace", fontVariantNumeric: "tabular-nums", fontSize: 40, lineHeight: 1 },
  drinkUnit: { fontSize: 16, color: "#8A6F4D", marginLeft: 4 },
  nextAlert: {
    fontSize: 13,
    color: "#C9B08A",
    background: "#241C14",
    borderRadius: 10,
    padding: "10px 14px",
  },
  empty: {
    textAlign: "center",
    color: "#8A6F4D",
    fontSize: 13,
    lineHeight: 2,
    padding: "36px 0",
  },
  photoGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
  photoCard: {
    background: "#1C1510",
    border: "1px solid #2E241B",
    borderRadius: 12,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  photoImg: { width: "100%", height: 130, objectFit: "cover", display: "block" },
  captionInput: {
    background: "transparent",
    border: "none",
    borderTop: "1px solid #2E241B",
    color: "#F2E4CE",
    fontSize: 12,
    padding: "8px 10px",
    outline: "none",
    fontFamily: "inherit",
  },
  sectionTitle: { fontFamily: "'DotGothic16', monospace", fontSize: 15, color: "#FFB03A", letterSpacing: 2 },
  schedRow: { display: "flex", gap: 10 },
  dtInput: {
    flex: 1,
    background: "#1C1510",
    border: "1px solid #3A2B1C",
    borderRadius: 10,
    color: "#F2E4CE",
    padding: "10px 12px",
    fontSize: 14,
    fontFamily: "inherit",
    colorScheme: "dark",
  },
  schedItem: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    background: "#1C1510",
    border: "1px solid #2E241B",
    borderRadius: 10,
    padding: "10px 14px",
  },
  subArea: {
    background: "#1C1510",
    border: "1px solid #3A2B1C",
    borderRadius: 10,
    color: "#8A6F4D",
    fontSize: 10,
    fontFamily: "monospace",
    padding: 10,
    resize: "none",
    wordBreak: "break-all",
  },
  settingRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 14,
  },
  select: {
    background: "#1C1510",
    border: "1px solid #3A2B1C",
    borderRadius: 8,
    color: "#F2E4CE",
    padding: "8px 10px",
    fontSize: 14,
    fontFamily: "inherit",
  },
  nav: {
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
    maxWidth: 480,
    margin: "0 auto",
    display: "flex",
    background: "#181209",
    borderTop: "1px solid #2E241B",
  },
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(12,6,4,.96)",
    zIndex: 100,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 16,
  },
  alertBanner: {
    fontFamily: "'DotGothic16', monospace",
    fontSize: 26,
    color: "#FF4438",
    letterSpacing: 4,
    textShadow: "0 0 20px rgba(255,68,56,.6)",
  },
  alertImg: {
    maxWidth: "82%",
    maxHeight: "40vh",
    borderRadius: 3,
    border: "10px solid #F2E4CE",
    borderBottomWidth: 34, // ポラロイドの余白
    boxShadow: "0 16px 40px rgba(0,0,0,.6), 0 0 60px rgba(255,68,56,.25)",
    objectFit: "contain",
    background: "#F2E4CE",
  },
  alertNoPhoto: {
    color: "#8A6F4D",
    textAlign: "center",
    fontSize: 14,
    lineHeight: 2,
    border: "2px dashed #3A2B1C",
    borderRadius: 12,
    padding: "40px 30px",
  },
  alertCaption: {
    color: "#FFB03A",
    fontSize: 14,
    fontFamily: "'DotGothic16', monospace",
    letterSpacing: 1,
  },
  alertMsg: {
    color: "#F2E4CE",
    fontSize: 16,
    textAlign: "center",
    lineHeight: 1.7,
    maxWidth: 320,
  },
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DotGothic16&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap');

/* iOS Safariのビューポートバグ対策: dvh対応ブラウザではdvhが勝つ */
.app-root { min-height: 100vh; min-height: 100dvh; }

button { -webkit-tap-highlight-color: transparent; }

/* 押した感 + キーボード操作の焦点リング(全ボタン共通) */
.btn-start, .btn-drink, .btn-end, .btn-upload, .btn-add, .btn-del, .btn-ack, .tab {
  transition: transform .18s cubic-bezier(.34,1.56,.64,1), box-shadow .25s ease, filter .2s ease, background .2s ease;
}
.btn-start:focus-visible, .btn-drink:focus-visible, .btn-end:focus-visible,
.btn-upload:focus-visible, .btn-add:focus-visible, .btn-del:focus-visible,
.btn-ack:focus-visible, .tab:focus-visible {
  outline: 2px solid #FFB03A; outline-offset: 3px;
}

.btn-start {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  background: linear-gradient(160deg, #E8532E, #B01F14);
  color: #FFF3DC; border: none; border-radius: 18px;
  padding: 30px 20px; cursor: pointer; font-family: inherit;
  box-shadow: 0 0 32px rgba(232,83,46,.3), inset 0 1px 0 rgba(255,255,255,.15), inset 0 -2px 0 rgba(0,0,0,.2);
  position: relative; z-index: 1;
}
.btn-start:hover { box-shadow: 0 0 48px rgba(232,83,46,.45), inset 0 1px 0 rgba(255,255,255,.2), inset 0 -2px 0 rgba(0,0,0,.2); transform: translateY(-2px); }
.btn-start:active { transform: scale(.97); }

.btn-drink {
  background: #FFB03A; color: #1C1005; border: none; border-radius: 12px;
  padding: 14px 20px; font-size: 16px; font-weight: 700; cursor: pointer;
  font-family: inherit; box-shadow: 0 4px 14px rgba(255,176,58,.18);
}
.btn-drink:hover { filter: brightness(1.08); transform: translateY(-1px); }
.btn-drink:active { transform: scale(.94); }

.btn-end {
  background: transparent; color: #8A6F4D; border: 1px solid #3A2B1C;
  border-radius: 10px; padding: 12px; cursor: pointer; font-family: inherit; font-size: 13px;
}
.btn-end:hover { color: #C9B08A; border-color: #6B4F2A; }
.btn-end:active { transform: translateY(1px); }

.btn-upload {
  background: #1C1510; color: #FFB03A; border: 1px dashed #6B4F2A;
  border-radius: 12px; padding: 16px; font-size: 15px; cursor: pointer; font-family: inherit;
}
.btn-upload:hover:not(:disabled) { border-color: #FFB03A; background: #241C14; }
.btn-upload:active:not(:disabled) { transform: scale(.98); }
.btn-upload:disabled { opacity: .5; cursor: wait; }

.btn-add {
  background: #FFB03A; color: #1C1005; border: none; border-radius: 10px;
  padding: 10px 18px; font-weight: 700; cursor: pointer; font-family: inherit;
}
.btn-add:hover { filter: brightness(1.08); }
.btn-add:active { transform: scale(.95); }

.btn-del {
  background: transparent; color: #FF4438; border: none; padding: 8px;
  font-size: 12px; cursor: pointer; font-family: inherit; opacity: .8;
}
.btn-del:hover { opacity: 1; text-decoration: underline; }

.btn-ack {
  background: #FF4438; color: #FFF3DC; border: none; border-radius: 12px;
  padding: 16px 32px; font-size: 16px; font-weight: 700; cursor: pointer;
  font-family: inherit; box-shadow: 0 0 24px rgba(255,68,56,.4);
}
.btn-ack:hover { box-shadow: 0 0 36px rgba(255,68,56,.55); transform: translateY(-1px); }
.btn-ack:active { transform: scale(.96); }

.tab {
  flex: 1; background: transparent; border: none; color: #8A6F4D;
  padding: 14px 0 16px; font-size: 13px; cursor: pointer; font-family: inherit;
  border-top: 2px solid transparent; margin-top: -1px;
}
.tab:hover { color: #C9B08A; }
.tab-on { color: #FFB03A; font-weight: 700; border-top-color: #FFB03A; }

/* 時差エントリ: 一斉マウントを避けて順に立ち上がる */
.stagger > *, .rise {
  animation: riseIn .45s cubic-bezier(.22,1,.36,1) both;
}
.stagger > *:nth-child(1) { animation-delay: .03s; }
.stagger > *:nth-child(2) { animation-delay: .09s; }
.stagger > *:nth-child(3) { animation-delay: .15s; }
.stagger > *:nth-child(4) { animation-delay: .21s; }
.stagger > *:nth-child(5) { animation-delay: .27s; }
.stagger > *:nth-child(6) { animation-delay: .33s; }
@keyframes riseIn {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* 証拠写真: わずかに傾いたポラロイド */
.evidence { transform: rotate(-2.5deg); animation: evidenceIn .5s cubic-bezier(.34,1.56,.64,1) both .15s; }
@keyframes evidenceIn {
  from { opacity: 0; transform: rotate(-8deg) scale(.85); }
  to   { opacity: 1; transform: rotate(-2.5deg) scale(1); }
}

.live-dot { animation: pulse 1.2s infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }

.load-lantern { animation: sway 1.6s ease-in-out infinite; box-shadow: 0 0 24px rgba(255,106,60,.45); }
@keyframes sway {
  0%,100% { transform: rotate(-4deg); box-shadow: 0 0 20px rgba(255,106,60,.35); }
  50%     { transform: rotate(4deg);  box-shadow: 0 0 40px rgba(255,106,60,.6); }
}

/* 警報: 赤フラッシュ→暗転 + 周辺減光(ビネット) */
.alert-flash {
  animation: flashIn .5s;
  background:
    radial-gradient(ellipse 80% 60% at 50% 45%, transparent 40%, rgba(0,0,0,.55) 100%),
    rgba(12,6,4,.96) !important;
}
@keyframes flashIn {
  0% { background: rgba(255,68,56,.85); }
  100% { background: rgba(12,6,4,.96); }
}

@media (prefers-reduced-motion: reduce) {
  .live-dot, .alert-flash, .stagger > *, .rise, .evidence, .load-lantern { animation: none; }
  .btn-start, .btn-drink, .btn-end, .btn-upload, .btn-add, .btn-del, .btn-ack, .tab { transition: none; }
}
`;

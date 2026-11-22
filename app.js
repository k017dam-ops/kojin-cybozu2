"use strict";
/* 個人サイボウズ2 - コアロジック + 画面
   仕様: 個人サイボウズ2_仕様書_2026-11-21.md
   データはこの端末の localStorage の中だけ。外部送信は一切しない。 */

/* ---------- CSV解析（テスト可能な純粋関数） ---------- */

// クォート・改行・カンマを含むCSV文字列を2次元配列にする
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; }
      else if (c === "\r") { /* CRは無視（CRLF対応） */ }
      else field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ""));
}

const CSV_HEADER = ["開始日付", "開始時刻", "終了日付", "終了時刻", "予定", "予定詳細", "メモ", "参加者", "施設"];

// "2026/11/1" -> "2026-11-01"
function normDate(s) {
  const m = String(s || "").trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  return m[1] + "-" + String(m[2]).padStart(2, "0") + "-" + String(m[3]).padStart(2, "0");
}
// "9:00" -> 540（0時からの分）。時刻として読めなければ null
function timeMin(t) {
  const m = String(t || "").trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// "9:00:00" -> "9:00"
function normTime(s) {
  const m = String(s || "").trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return "";
  return Number(m[1]) + ":" + m[2];
}

// CSVテキストを取り込み用データに変換する。
// 戻り値: {total, excludedWatanabe, entries, months, error}
function convertCybozuCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 1) return { error: "ファイルにデータがありませんでした" };
  const header = rows[0].map(v => String(v).trim());
  for (let i = 0; i < CSV_HEADER.length; i++) {
    if (header[i] !== CSV_HEADER[i]) return { error: "見出しが想定と違います（" + (header[i] || "空") + "）" };
  }
  const data = rows.slice(1);
  let excludedWatanabe = 0;
  const entries = [];
  const months = new Set();
  for (const r of data) {
    const detail = String(r[5] || "").trim();
    if (detail === "渡部") { excludedWatanabe++; continue; } // 仕様: 予定詳細が「渡部」だけの行は自動で除く
    const start = normDate(r[0]), end = normDate(r[2]) || start;
    if (!start) continue;
    months.add(start.slice(0, 7));
    entries.push({
      id: "w" + entries.length + "-" + start + "-" + Math.abs(hashStr(r.join("|"))),
      kind: "work", source: "csv",
      workType: String(r[4] || "").trim(),
      title: detail || String(r[4] || "").trim(),
      detail: detail,
      memo: String(r[6] || "").trim(),
      participants: String(r[7] || "").trim(),
      facility: String(r[8] || "").trim(),
      startDate: start, endDate: end,
      startTime: normTime(r[1]), endTime: normTime(r[3]),
      repeat: null
    });
  }
  return { total: data.length, excludedWatanabe, entries, months: Array.from(months).sort(), error: null };
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return h;
}

/* ---------- 日付ユーティリティ ---------- */
function dateAdd(ymd, days) {
  const d = new Date(ymd + "T00:00:00");
  d.setDate(d.getDate() + days);
  return toYMD(d);
}
function toYMD(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function cmpYMD(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// エントリが指定日に表示されるか（複数日はすべての日、繰り返しは展開）
function occursOn(e, ymd) {
  if (e.repeat && e.repeat.freq) {
    if (cmpYMD(ymd, e.startDate) < 0) return false;
    if (e.repeat.until && cmpYMD(ymd, e.repeat.until) > 0) return false;
    if (cmpYMD(e.startDate, ymd) <= 0 && e.endDate && e.startDate !== e.endDate) {
      // 繰り返しは単日予定だけに使う前提
    }
    if (e.repeat.freq === "weekly") {
      const diff = Math.round((new Date(ymd) - new Date(e.startDate)) / 86400000);
      return diff % 7 === 0;
    }
    if (e.repeat.freq === "monthly") {
      return ymd.slice(8) === e.startDate.slice(8);
    }
    return false;
  }
  return cmpYMD(e.startDate, ymd) <= 0 && cmpYMD(ymd, e.endDate || e.startDate) <= 0;
}

/* ---------- 毎月TODO（テスト可能な純粋関数） ---------- */
// 期限グループは4つ固定。営業日は「平日（月〜金）」で数える（祝日は数えない）。
// 検証済みの例: 2026年11月の第4営業日 = 2026-11-05。
const TODO_GROUPS = [
  { key: "biz4", label: "1日〜4営業日まで" },
  { key: "day5", label: "5日まで" },
  { key: "day7", label: "7日" },
  { key: "day15", label: "15日" }
];
const TODO_DEFAULTS = [
  { group: "biz4", title: "請求明細書と納品書をアートにメールする" },
  { group: "day5", title: "売上報告" },
  { group: "day5", title: "税理士資料提出" },
  { group: "day7", title: "AMEX支払確認" },
  { group: "day15", title: "給料支払予約" },
  { group: "day15", title: "AGBS支払予約" }
];

// ym ("YYYY-MM") の月の第n営業日（平日）を "YYYY-MM-DD" で返す
function nthBusinessDay(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  let count = 0;
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(y, m - 1, d);
    if (dt.getMonth() !== m - 1) break;
    const wd = dt.getDay();
    if (wd >= 1 && wd <= 5) { count++; if (count === n) return toYMD(dt); }
  }
  return null;
}

// グループのその月の実際の期限日を "YYYY-MM-DD" で返す
function todoDeadline(group, ym) {
  if (group === "biz4") return nthBusinessDay(ym, 4);
  if (group === "day5") return ym + "-05";
  if (group === "day7") return ym + "-07";
  if (group === "day15") return ym + "-15";
  return null;
}

/* ---------- ここからブラウザ専用 ---------- */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseCSV, convertCybozuCSV, normDate, normTime, occursOn, CSV_HEADER, timeMin, TODO_GROUPS, TODO_DEFAULTS, nthBusinessDay, todoDeadline };
}

if (typeof document !== "undefined") {
  const LS_KEY = "kojinCybozu2.v1";
  const UNLOCK_KEY = "kojinCybozu2.unlocked";
  let store = loadStore();
  let eventsWired = false;
  let viewMonth = toYMD(new Date()).slice(0, 7); // "YYYY-MM"
  let selectedDate = toYMD(new Date());
  let editingId = null;
  let todoMonth = toYMD(new Date()).slice(0, 7); // 毎月TODOで表示中の月 "YYYY-MM"

  function emptyStore() {
    // todoItems: null = まだ初期項目を入れていない（初回にTODOを開いたとき入れる）。
    // 空の配列は「本人が全部消した」状態として尊重し、初期項目を入れ直さない。
    // todoChecks: { "YYYY-MM": { itemId: true } } 月ごとのチェック状態。
    return { personal: [], work: [], snapshots: [], cybozuUrl: "", lastBackupExport: null, pwSalt: "", pwHash: "", todoItems: null, todoChecks: {}, viewMode: "month" };
  }
  async function hashPassword(pw, salt) {
    const msg = salt + "::" + pw;
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    }
    // フォールバック（簡易ハッシュ。httpsで開けば上の方式になる）
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < msg.length; i++) { const ch = msg.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
  }
  function isUnlocked() { return localStorage.getItem(UNLOCK_KEY) === "1"; }
  function showLock() {
    const has = !!store.pwHash;
    document.getElementById("lockTitle").textContent = has ? "パスワードを入れてください" : "パスワードを決めてください";
    document.getElementById("lockNote").textContent = has ? "このアプリを開くための鍵です。" : "最初に1回だけ決めます。このiPhoneが覚えるので、普段はそのまま開けます。パスワードはこのiPhoneの中にだけ保存されます。";
    document.getElementById("lockPw2row").style.display = has ? "none" : "block";
    show("scrLock");
  }
  async function submitLock() {
    const pw = document.getElementById("lockPw").value;
    if (!pw) { alert("パスワードを入れてください"); return; }
    if (!store.pwHash) {
      const pw2 = document.getElementById("lockPw2").value;
      if (pw !== pw2) { alert("2回目のパスワードが違います"); return; }
      store.pwSalt = uid() + uid();
      store.pwHash = await hashPassword(pw, store.pwSalt);
      saveStore(false);
    } else {
      const h = await hashPassword(pw, store.pwSalt);
      if (h !== store.pwHash) { alert("パスワードが違います"); return; }
    }
    localStorage.setItem(UNLOCK_KEY, "1");
    document.getElementById("lockPw").value = "";
    enterApp();
  }
  function lockNow() {
    localStorage.removeItem(UNLOCK_KEY);
    showLock();
  }
  async function changePassword() {
    const cur = document.getElementById("fPwCurrent").value;
    const nw = document.getElementById("fPwNew").value;
    if (!cur || !nw) { alert("今のパスワードと新しいパスワードを入れてください"); return; }
    const h = await hashPassword(cur, store.pwSalt);
    if (h !== store.pwHash) { alert("今のパスワードが違います"); return; }
    store.pwSalt = uid() + uid();
    store.pwHash = await hashPassword(nw, store.pwSalt);
    saveStore(false);
    document.getElementById("fPwCurrent").value = ""; document.getElementById("fPwNew").value = "";
    alert("パスワードを変えました");
  }
  function enterApp() {
    renderCalendar();
    show("scrCal");
  }
  function loadStore() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return emptyStore();
      const s = JSON.parse(raw);
      return Object.assign(emptyStore(), s);
    } catch (e) { return emptyStore(); }
  }
  function saveStore(withSnapshot) {
    if (withSnapshot) {
      store.snapshots.push({ ts: new Date().toISOString(), data: JSON.stringify({ personal: store.personal, work: store.work, todoItems: store.todoItems, todoChecks: store.todoChecks }) });
      while (store.snapshots.length > 10) store.snapshots.shift(); // 自動控えは最新10世代
    }
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  }
  function allEntries() { return store.personal.concat(store.work); }
  function entriesOn(ymd) {
    // スタート時間が早い順。時刻が無いものは後ろ。
    return allEntries().filter(e => occursOn(e, ymd)).sort((a, b) => {
      const ta = timeMin(a.startTime), tb = timeMin(b.startTime);
      return (ta === null ? 9999 : ta) - (tb === null ? 9999 : tb);
    });
  }
  // 予定詳細が担当名（小林／渡部）だけの仕事行は、名前では内容が分からないため種別で表示する。
  function isNameOnlyWork(e) {
    const t = (e.title || "").trim();
    return e.kind === "work" && (t === "小林" || t === "渡部");
  }
  function isDayOff(e) {
    return e.kind === "work" && (e.workType || "").trim() === "休み";
  }
  function monthLabel(e) {
    if (isNameOnlyWork(e)) {
      const memo1 = (e.memo || "").split("\n")[0].trim();
      return memo1 ? (e.workType + "：" + memo1) : (e.workType || e.title);
    }
    return (e.title || "").trim() || e.workType || "";
  }
  function dayTitle(e) {
    if (isNameOnlyWork(e)) return e.workType || e.title;
    return (e.title || "").trim() || e.workType || "";
  }
  // 月セルの中でだけ使う短い表示名。住所などの括弧書きを除き、※以降の区別情報は残す。
  function shortLabel(e) {
    const t = monthLabel(e).replace(/[（(][^（）()]*[）)]/g, "").replace(/\s+/g, " ").trim();
    return t || monthLabel(e);
  }
  function uid() { return "e" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
  function esc(s) { return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  /* ----- 最新版へ更新（古い版の残りを消して読み直す。データには触らない） ----- */
  async function forceUpdate() {
    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) await r.unregister();
      }
      if (window.caches) {
        const keys = await caches.keys();
        for (const k of keys) await caches.delete(k);
      }
    } catch (e) { /* 消せなくても読み直しはする */ }
    location.reload();
  }

  /* ----- 画面切り替え ----- */
  function show(id) {
    document.querySelectorAll(".screen").forEach(el => el.style.display = "none");
    document.getElementById(id).style.display = "block";
    window.scrollTo(0, 0);
  }

  /* ----- 月カレンダー ----- */
  function renderCalendar() {
    const todayYMD = toYMD(new Date());
    if (selectedDate.slice(0, 7) !== viewMonth) {
      selectedDate = (viewMonth === todayYMD.slice(0, 7)) ? todayYMD : viewMonth + "-01";
    }
    const [y, m] = viewMonth.split("-").map(Number);
    document.getElementById("monthTitle").textContent = y + "年" + m + "月";
    const listMode = store.viewMode !== "month";
    document.getElementById("btnViewList").classList.toggle("on", listMode);
    document.getElementById("btnViewMonth").classList.toggle("on", !listMode);
    document.getElementById("calendar").style.display = listMode ? "none" : "";
    document.getElementById("homeDayList").style.display = listMode ? "none" : "";
    if (listMode) {
      renderMonthList();
      renderBackupBanner();
      // リスト表示では、開いたら今日の枠まで自動でスクロールする（今月を見ているときだけ）。
      if (viewMonth === toYMD(new Date()).slice(0, 7)) {
        const tb = document.getElementById("todayBlock");
        if (tb && tb.scrollIntoView) tb.scrollIntoView({ block: "start" });
      }
      return;
    }
    document.getElementById("homeList").innerHTML = "";
    const first = new Date(y, m - 1, 1);
    const startDay = first.getDay(); // 日曜=0
    const daysInMonth = new Date(y, m, 0).getDate();
    const today = toYMD(new Date());
    let html = '<div class="dow"><span>日</span><span>月</span><span>火</span><span>水</span><span>木</span><span>金</span><span>土</span></div><div class="grid">';
    for (let i = 0; i < startDay; i++) html += '<div class="cell empty"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const ymd = y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
      const es = entriesOn(ymd);
      let lines = "";
      // 月のマスでは「○時集合」の行は出さない（現場名を優先。集合だけの日は集合を出す）。
      let shown = es.filter(e => !(e.kind === "work" && /集合/.test(e.title || "")));
      if (!shown.length) shown = es.slice(0, 1);
      shown.slice(0, 3).forEach(e => { lines += '<span class="' + (isDayOff(e) ? "ttl off" : "ttl " + e.kind) + '">' + esc(shortLabel(e)) + "</span>"; });
      if (shown.length > 3) lines += '<span class="ttl more">他' + (shown.length - 3) + "件</span>";
      const wd = (startDay + d - 1) % 7;
      const dcls = wd === 0 ? " sun" : wd === 6 ? " sat" : "";
      html += '<button class="cell' + (ymd === today ? " today" : "") + (ymd === selectedDate ? " sel" : "") + (es.length === 0 ? " offday" : "") + '" data-date="' + ymd + '"><span class="dnum' + dcls + '">' + d + "</span>" + lines + "</button>";
    }
    html += "</div>";
    document.getElementById("calendar").innerHTML = html;
    document.querySelectorAll(".cell[data-date]").forEach(el => {
      el.addEventListener("click", () => { selectedDate = el.getAttribute("data-date"); renderCalendar(); });
    });
    renderHomeDayList();
    renderBackupBanner();
  }

  /* ----- トップ画面のリスト表示（1か月分を日ごとに、現場名を全文で） ----- */
  function renderMonthList() {
    const box = document.getElementById("homeList");
    if (!box) return;
    const [y, m] = viewMonth.split("-").map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const today = toYMD(new Date());
    const dows = ["日", "月", "火", "水", "木", "金", "土"];
    let html = "";
    let any = false;
    let dayCount = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const ymd = y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
      const es = entriesOn(ymd);
      if (!es.length && ymd !== today) continue; // 今日は予定が無くても枠を出す（リストで今日を見失わないため）
      any = true;
      const wd = new Date(y, m - 1, d).getDay();
      const dcls = wd === 0 ? " sun" : wd === 6 ? " sat" : "";
      html += '<div class="lday-block' + (dayCount % 2 ? " alt" : "") + (ymd === today ? " today" : "") + '"' + (ymd === today ? ' id="todayBlock"' : "") + ">";
      html += '<div class="lday' + dcls + '"><span class="dnum">' + d + "</span>日（" + dows[wd] + "）" + (ymd === today ? '<span class="todaybadge">今日</span>' : "") + "</div>";
      html += es.length ? es.map(e => {
        const time = e.startTime ? e.startTime + (e.endTime ? "〜" + e.endTime : "〜") : "時間なし";
        return '<button class="hrow ' + e.kind + (isDayOff(e) ? " off" : "") + '" data-date="' + ymd + '"><span class="htime">' + esc(time) + '</span><span class="hname">' + esc(monthLabel(e)) + '</span><span class="hkind">' + (isDayOff(e) ? "休み" : (e.kind === "work" ? "仕事" : "個人")) + "</span></button>";
      }).join("") : '<p class="muted" style="margin:0">予定はありません。</p>';
      html += "</div>";
      dayCount++;
    }
    box.innerHTML = any ? html : '<p class="muted">この月の予定はありません。</p>';
    box.querySelectorAll(".hrow").forEach(r => r.addEventListener("click", () => { selectedDate = r.getAttribute("data-date"); renderDay(); show("scrDay"); }));
  }

  /* ----- カレンダー下の日のリスト（時間＋現場名） ----- */
  function renderHomeDayList() {
    const box = document.getElementById("homeDayList");
    if (!box) return;
    const es = entriesOn(selectedDate);
    const dt = new Date(selectedDate + "T00:00:00");
    const dow = ["日", "月", "火", "水", "木", "金", "土"][dt.getDay()];
    let html = '<div class="hdhead"><h2>' + (dt.getMonth() + 1) + "月" + dt.getDate() + "日（" + dow + '）の予定</h2><div class="spacer"></div><button class="mini" id="hdDetail">詳しく見る</button></div>';
    if (!es.length) {
      html += '<p class="emptyoff">この日の予定はありません。</p>';
    } else {
      html += es.map(e => {
        const time = e.startTime ? e.startTime + (e.endTime ? "〜" + e.endTime : "〜") : "時間なし";
        return '<button class="hrow ' + e.kind + (isDayOff(e) ? " off" : "") + '"><span class="htime">' + esc(time) + '</span><span class="hname">' + esc(monthLabel(e)) + '</span><span class="hkind">' + (isDayOff(e) ? "休み" : (e.kind === "work" ? "仕事" : "個人")) + "</span></button>";
      }).join("");
    }
    box.innerHTML = html;
    document.getElementById("hdDetail").addEventListener("click", () => { renderDay(); show("scrDay"); });
    box.querySelectorAll(".hrow").forEach(r => r.addEventListener("click", () => { renderDay(); show("scrDay"); }));
  }

  function renderBackupBanner() {
    const el = document.getElementById("backupBanner");
    const hasData = store.personal.length + store.work.length > 0;
    const last = store.lastBackupExport ? new Date(store.lastBackupExport) : null;
    const stale = !last || (Date.now() - last.getTime() > 30 * 86400000);
    if (hasData && stale) {
      el.style.display = "block";
      el.innerHTML = "控えファイルが古くなっています。<button id='bbBtn'>控えファイルを出す</button>";
      document.getElementById("bbBtn").addEventListener("click", exportBackup);
    } else el.style.display = "none";
  }

  /* ----- 毎月TODO ----- */
  function ensureTodoSeeded() {
    if (store.todoItems === null || store.todoItems === undefined) {
      store.todoItems = TODO_DEFAULTS.map(d => ({ id: uid(), group: d.group, title: d.title }));
      if (!store.todoChecks || typeof store.todoChecks !== "object") store.todoChecks = {};
      saveStore(false);
    }
  }
  function renderTodo() {
    ensureTodoSeeded();
    const [y, m] = todoMonth.split("-").map(Number);
    document.getElementById("todoTitle").textContent = y + "年" + m + "月の毎月TODO";
    const checks = (store.todoChecks && store.todoChecks[todoMonth]) || {};
    const items = store.todoItems || [];
    const done = items.filter(it => checks[it.id]).length;
    document.getElementById("todoProgress").textContent = items.length + "件中" + done + "件完了";
    const box = document.getElementById("todoList");
    box.innerHTML = TODO_GROUPS.map(g => {
      const dl = todoDeadline(g.key, todoMonth);
      const ddt = new Date(dl + "T00:00:00");
      const due = "期限：" + (ddt.getMonth() + 1) + "月" + ddt.getDate() + "日（" + ["日", "月", "火", "水", "木", "金", "土"][ddt.getDay()] + "）";
      const rows = items.filter(it => it.group === g.key).map(it =>
        '<div class="trow' + (checks[it.id] ? " done" : "") + '"><input type="checkbox" data-tcheck="' + it.id + '"' + (checks[it.id] ? " checked" : "") + '><span class="tt">' + esc(it.title) + '</span><button class="mini danger" data-tdel="' + it.id + '">消す</button></div>'
      ).join("");
      return '<div class="tgroup"><h3>' + esc(g.label) + '</h3><div class="tdue">' + due + "</div>" + (rows || '<p class="muted">項目はありません</p>') + "</div>";
    }).join("");
    box.querySelectorAll("[data-tcheck]").forEach(cb => cb.addEventListener("change", () => {
      if (!store.todoChecks || typeof store.todoChecks !== "object") store.todoChecks = {};
      if (!store.todoChecks[todoMonth]) store.todoChecks[todoMonth] = {};
      const id = cb.getAttribute("data-tcheck");
      if (cb.checked) store.todoChecks[todoMonth][id] = true;
      else delete store.todoChecks[todoMonth][id];
      saveStore(true);
      renderTodo();
    }));
    box.querySelectorAll("[data-tdel]").forEach(b => b.addEventListener("click", () => {
      if (!confirm("この項目を消しますか？（すべての月から消えます）")) return;
      store.todoItems = store.todoItems.filter(it => it.id !== b.getAttribute("data-tdel"));
      saveStore(true);
      renderTodo();
    }));
  }
  function addTodoItem() {
    const title = document.getElementById("tTitle").value.trim();
    if (!title) { alert("項目名を入れてください"); return; }
    ensureTodoSeeded();
    store.todoItems.push({ id: uid(), group: document.getElementById("tGroup").value, title });
    document.getElementById("tTitle").value = "";
    saveStore(true);
    renderTodo();
  }
  function shiftTodoMonth(delta) {
    const [y, m] = todoMonth.split("-").map(Number);
    todoMonth = toYMD(new Date(y, m - 1 + delta, 1)).slice(0, 7);
    renderTodo();
  }

  /* ----- 日の詳細 ----- */
  function renderDay() {
    const es = entriesOn(selectedDate);
    document.getElementById("dayTitle").textContent = selectedDate.replace(/-/g, "/") + " の予定";
    const box = document.getElementById("dayList");
    if (!es.length) { box.innerHTML = '<p class="muted">この日の予定はありません。</p>'; return; }
    box.innerHTML = es.map(e => {
      const time = e.startTime ? e.startTime + (e.endTime ? "〜" + e.endTime : "〜") : "時間なし";
      const span = e.endDate && e.endDate !== e.startDate ? '<div class="sub">' + e.startDate + " 〜 " + e.endDate + "</div>" : "";
      const memo = e.memo ? '<div class="memo">' + esc(e.memo).replace(/\n/g, "<br>") + "</div>" : "";
      const edit = '<button class="mini" data-edit="' + e.id + '">直す</button>' +
        (e.source === "csv" ? '<span class="tag">CSV</span>' : "");
      return '<div class="card ' + e.kind + (isDayOff(e) ? " off" : "") + '"><div class="cardhead"><span class="time">' + esc(time) + "</span>" +
        '<span class="kind">' + (isDayOff(e) ? "休み" : (e.kind === "work" ? "仕事" : "個人")) + "</span>" + edit + "</div>" +
        '<div class="title">' + esc(dayTitle(e)) + "</div>" + span + memo + "</div>";
    }).join("");
    box.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => openForm(b.getAttribute("data-edit"))));
  }

  /* ----- 追加・編集フォーム ----- */
  function openForm(id) {
    editingId = id || null;
    const e = id ? allEntries().find(x => x.id === id) : null;
    document.getElementById("fKind").value = e ? e.kind : "personal";
    document.getElementById("fTitle").value = e ? e.title : "";
    document.getElementById("fStart").value = e ? e.startDate : selectedDate;
    document.getElementById("fEnd").value = e ? (e.endDate || e.startDate) : selectedDate;
    document.getElementById("fStartTime").value = e ? e.startTime : "";
    document.getElementById("fEndTime").value = e ? e.endTime : "";
    document.getElementById("fMemo").value = e ? e.memo : "";
    document.getElementById("fRepeat").value = e && e.repeat ? e.repeat.freq : "";
    document.getElementById("fRepeatUntil").value = e && e.repeat ? (e.repeat.until || "") : "";
    document.getElementById("btnDelete").style.display = e ? "block" : "none";
    document.getElementById("formTitle").textContent = e ? "予定を直す" : "予定を足す";
    show("scrForm");
  }
  function submitForm() {
    const title = document.getElementById("fTitle").value.trim();
    const start = document.getElementById("fStart").value;
    const end = document.getElementById("fEnd").value || start;
    if (!title) { alert("内容（現場名や予定名）を入れてください"); return; }
    if (!start) { alert("日付を選んでください"); return; }
    if (end < start) { alert("終わりの日が始まりより前になっています"); return; }
    const freq = document.getElementById("fRepeat").value;
    const kind = document.getElementById("fKind").value;
    const orig = editingId ? allEntries().find(x => x.id === editingId) : null;
    // CSV由来の予定を直したときは出どころ（source）と種別を引き継ぐ。
    // これにより、同じ月のCSVを取り込み直すと編集分も含めて入れ替わる（仕様通り）。
    // 種類を変えた場合は本人の予定として扱い、source は manual にする。
    const keepCsv = !!(orig && orig.source === "csv" && orig.kind === kind);
    const entry = {
      id: editingId || uid(),
      kind,
      source: keepCsv ? "csv" : "manual",
      workType: keepCsv ? (orig.workType || "") : "",
      title, detail: title,
      memo: document.getElementById("fMemo").value.trim(),
      participants: keepCsv ? (orig.participants || "") : "", facility: keepCsv ? (orig.facility || "") : "",
      startDate: start, endDate: end,
      startTime: document.getElementById("fStartTime").value,
      endTime: document.getElementById("fEndTime").value,
      repeat: freq ? { freq, until: document.getElementById("fRepeatUntil").value || null } : null
    };
    if (editingId) {
      store.personal = store.personal.filter(x => x.id !== editingId);
      store.work = store.work.filter(x => x.id !== editingId);
    }
    (entry.kind === "work" ? store.work : store.personal).push(entry);
    saveStore(true);
    selectedDate = start;
    renderCalendar(); renderDay(); show("scrDay");
  }
  function deleteEditing() {
    if (!editingId) return;
    if (!confirm("この予定を消しますか？")) return;
    store.personal = store.personal.filter(x => x.id !== editingId);
    store.work = store.work.filter(x => x.id !== editingId);
    saveStore(true);
    renderCalendar(); show("scrCal");
  }

  /* ----- CSV取り込み ----- */
  function importCSVFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let text;
      try { text = new TextDecoder("shift_jis").decode(reader.result); }
      catch (err) { alert("ファイルを読めませんでした"); return; }
      const res = convertCybozuCSV(text);
      if (res.error) { alert(res.error); return; }
      // その月の仕事だけ入れ替え（個人には触らない）
      const months = new Set(res.months);
      store.work = store.work.filter(e => !(e.source === "csv" && months.has((e.startDate || "").slice(0, 7))));
      store.work = store.work.concat(res.entries.map(e => Object.assign({}, e, { id: uid() + Math.random().toString(36).slice(2, 6) })));
      saveStore(true);
      document.getElementById("importResult").textContent =
        res.total + "件読みました／渡部分" + res.excludedWatanabe + "件を除いて" + res.entries.length + "件入れました";
      renderCalendar();
    };
    reader.readAsArrayBuffer(file);
  }

  /* ----- バックアップ（2段がけの外側） ----- */
  function exportBackup() {
    const payload = JSON.stringify({ app: "kojin-cybozu2", version: 1, exportedAt: new Date().toISOString(), personal: store.personal, work: store.work, todoItems: store.todoItems, todoChecks: store.todoChecks }, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "kojin-cybozu2-backup-" + toYMD(new Date()).replace(/-/g, "") + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    store.lastBackupExport = new Date().toISOString();
    saveStore(false);
    renderBackupBanner();
  }
  function importBackupFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(reader.result);
        if (obj.app !== "kojin-cybozu2" || !Array.isArray(obj.personal) || !Array.isArray(obj.work)) throw new Error("bad");
        if (!confirm("控えファイルから戻しますか？今の予定は控え（自動保存）に残ります。")) return;
        saveStore(true); // 戻す前に現状を自動控えへ
        store.personal = obj.personal; store.work = obj.work;
        // 毎月TODOは、控えファイルに含まれているときだけ戻す（古い控えファイルでは今のTODOを消さない）
        if (Array.isArray(obj.todoItems)) store.todoItems = obj.todoItems;
        if (obj.todoChecks && typeof obj.todoChecks === "object") store.todoChecks = obj.todoChecks;
        saveStore(false);
        renderCalendar(); show("scrCal");
        alert("戻しました");
      } catch (e) { alert("このファイルからは戻せませんでした"); }
    };
    reader.readAsText(file);
  }

  /* ----- 設定・控え復元 ----- */
  function renderSettings() {
    document.getElementById("fCybozuUrl").value = store.cybozuUrl || "";
    document.getElementById("dataCounts").textContent =
      "個人予定 " + store.personal.length + "件／仕事予定 " + store.work.length + "件／毎月TODO " + (Array.isArray(store.todoItems) ? store.todoItems.length : 0) + "項目／自動控え " + store.snapshots.length + "世代";
    const box = document.getElementById("snapshotList");
    if (!store.snapshots.length) { box.innerHTML = '<p class="muted">自動控えはまだありません。</p>'; return; }
    box.innerHTML = store.snapshots.map((s, i) => {
      const d = JSON.parse(s.data);
      return '<div class="snap">' + esc(s.ts.replace("T", " ").slice(0, 16)) + "（個人" + d.personal.length + "／仕事" + d.work.length + '） <button class="mini" data-restore="' + i + '">ここに戻す</button></div>';
    }).join("");
    box.querySelectorAll("[data-restore]").forEach(b => b.addEventListener("click", () => {
      if (!confirm("この時点の控えに戻しますか？")) return;
      const d = JSON.parse(store.snapshots[Number(b.getAttribute("data-restore"))].data);
      saveStore(true);
      store.personal = d.personal; store.work = d.work;
      // 毎月TODOは、その控えに含まれているときだけ戻す（古い控えでは今のTODOを消さない）
      if (Array.isArray(d.todoItems)) store.todoItems = d.todoItems;
      if (d.todoChecks && typeof d.todoChecks === "object") store.todoChecks = d.todoChecks;
      saveStore(false);
      renderCalendar(); renderSettings();
      alert("戻しました");
    }));
  }

  /* ----- 初期化 ----- */
  document.addEventListener("DOMContentLoaded", () => {
    if (eventsWired) return;
    eventsWired = true;
    document.getElementById("btnLockSubmit").addEventListener("click", submitLock);
    document.getElementById("btnChangePw").addEventListener("click", changePassword);
    document.getElementById("btnLockNow").addEventListener("click", lockNow);
    document.getElementById("btnPrev").addEventListener("click", () => { const [y, m] = viewMonth.split("-").map(Number); const d = new Date(y, m - 2, 1); viewMonth = toYMD(d).slice(0, 7); renderCalendar(); });
    document.getElementById("btnNext").addEventListener("click", () => { const [y, m] = viewMonth.split("-").map(Number); const d = new Date(y, m, 1); viewMonth = toYMD(d).slice(0, 7); renderCalendar(); });
    document.getElementById("btnToday").addEventListener("click", () => { viewMonth = toYMD(new Date()).slice(0, 7); renderCalendar(); });
    document.getElementById("btnViewList").addEventListener("click", () => { store.viewMode = "list"; saveStore(false); renderCalendar(); });
    document.getElementById("btnViewMonth").addEventListener("click", () => { store.viewMode = "month"; saveStore(false); renderCalendar(); });
    document.getElementById("btnAdd").addEventListener("click", () => openForm(null));
    document.getElementById("btnTodo").addEventListener("click", () => { todoMonth = viewMonth; renderTodo(); show("scrTodo"); });
    document.getElementById("btnTodoBack").addEventListener("click", () => { renderCalendar(); show("scrCal"); });
    document.getElementById("btnTodoPrev").addEventListener("click", () => shiftTodoMonth(-1));
    document.getElementById("btnTodoNext").addEventListener("click", () => shiftTodoMonth(1));
    document.getElementById("btnTodoThis").addEventListener("click", () => { todoMonth = toYMD(new Date()).slice(0, 7); renderTodo(); });
    document.getElementById("btnTodoAddItem").addEventListener("click", addTodoItem);
    document.getElementById("btnBackCal").addEventListener("click", () => { renderCalendar(); show("scrCal"); });
    document.getElementById("btnDayAdd").addEventListener("click", () => openForm(null));
    document.getElementById("btnFormCancel").addEventListener("click", () => show("scrCal"));
    document.getElementById("btnFormSave").addEventListener("click", submitForm);
    document.getElementById("btnDelete").addEventListener("click", deleteEditing);
    document.getElementById("csvFile").addEventListener("change", ev => { if (ev.target.files[0]) importCSVFile(ev.target.files[0]); ev.target.value = ""; });
    document.getElementById("btnUpdate").addEventListener("click", forceUpdate);
    document.getElementById("btnSettings").addEventListener("click", () => { renderSettings(); show("scrSettings"); });
    document.getElementById("btnSettingsBack").addEventListener("click", () => { renderCalendar(); show("scrCal"); });
    document.getElementById("btnSaveUrl").addEventListener("click", () => { store.cybozuUrl = document.getElementById("fCybozuUrl").value.trim(); saveStore(false); alert("保存しました"); });
    document.getElementById("btnOpenCybozu").addEventListener("click", () => {
      if (store.cybozuUrl) window.open(store.cybozuUrl, "_blank");
      else { renderSettings(); show("scrSettings"); alert("先に設定でサイボウズのアドレスを入れてください"); }
    });
    document.getElementById("btnExport").addEventListener("click", exportBackup);
    document.getElementById("backupFile").addEventListener("change", ev => { if (ev.target.files[0]) importBackupFile(ev.target.files[0]); ev.target.value = ""; });
    if (!store.pwHash || !isUnlocked()) showLock();
    else enterApp();
    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  });
}

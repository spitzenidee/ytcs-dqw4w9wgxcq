/* YT Commenter Stats — all statistics computed in-browser from
 * window.YTCS_DATA on every filter change. No backend.
 *
 * Performance: every stat pass is O(n) over the filtered rows; ECharts runs
 * with animation disabled. Comfortable for ≤ ~50k comments.
 */
"use strict";

const DATA = window.YTCS_DATA;
if (!DATA) {
  document.body.innerHTML =
    "<h1 style='padding:2rem'>Missing data.js — open the folder produced by yt-commenter-stats.</h1>";
  throw new Error("window.YTCS_DATA not found");
}

/* ---------------- lookups ---------------- */
const commenterById = new Map(DATA.commenters.map((c) => [c.id, c]));
const videoById = new Map(DATA.videos.map((v) => [v.id, v]));
const capturedAt = DATA.captured_at ? new Date(DATA.captured_at) : new Date();

/* Account age in days as of the capture timestamp (deterministic). */
const ageDaysById = new Map();
for (const c of DATA.commenters) {
  if (!c.created_at) continue;
  const created = new Date(c.created_at + "T00:00:00Z");
  if (isNaN(created)) continue;
  ageDaysById.set(c.id, Math.max(0, Math.round((capturedAt - created) / 86400000)));
}

/* Account-age bins: 11 uniform 1-year bins ("<1y" .. "10y+"). 365.25 d/y is
 * used everywhere (bins, MIN/MAX filter, presets) so all age arithmetic
 * agrees. (Pre-existing bug fixed: bins 5–10 were 2 years wide while labeled
 * 1 year — the edges now match the labels.) */
const AGE_DAYS_PER_YEAR = 365.25;
const AGE_LABELS = ["<1y", "1–2y", "2–3y", "3–4y", "4–5y", "5–6y", "6–7y", "7–8y", "8–9y", "9–10y", "10y+"];
const AGE_EDGES = AGE_LABELS.map((_, i) => i * AGE_DAYS_PER_YEAR).concat(Infinity);
function ageBinOf(ageDays) {
  for (let i = 0; i < AGE_LABELS.length; i++) {
    if (ageDays >= AGE_EDGES[i] && ageDays < AGE_EDGES[i + 1]) return i;
  }
  return AGE_LABELS.length - 1;
}

/* ---------------- state ---------------- */
const state = {
  commenters: new Set(), // empty = all
  video: "all", // 'all' | 'input' | 'cross' | <videoId>
  from: null, // 'YYYY-MM-DD'
  to: null,
  gran: "day", // day | week | month | year
  minLikes: 0,
  repliesOnly: false,
  ageBin: null, // 0..10 — selected bin in the account-age chart
  hourBin: null, // 0..7 — selected 3-hour bin
  weekday: null, // 0..6 — Mon..Sun
  ageMinY: null, // account-age MIN (years, decimals allowed)
  ageMaxY: null, // account-age MAX (years, decimals allowed)
  page: 1,
  cSortKey: "comments",
  cSortDir: -1,
  sortKey: "ts",
  sortDir: -1,
};
const PAGE_SIZE = 50;

/* Badge for commenters whose channel 'who' metadata was not fetched
 * (enrichment cap reached). Shown wherever a bare channel id would
 * otherwise be displayed, so the gap is visible instead of looking like a
 * data bug. */
const UNENRICHED_BADGE =
  `<span class="badge unenriched" title="Channel metadata not fetched (enrichment cap). Re-run with a higher --max-commenters, or run --enrich-only to fill in.">not enriched</span>`;

/* Interaction state: time-chart category keys (for click/zoom mapping), a
 * re-entry flag for the slider-window re-application, and the shared refresh
 * timer (debounce). Discrete actions refresh immediately (delay 0); the
 * continuous slider drag is debounced so graphs update only after the user
 * pauses. */
let timeKeys = [];
let zoomReapplying = false;
let refreshTimer = null;
function scheduleRefresh(delayMs) {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (delayMs <= 0) {
    refresh(); // discrete action: immediate, no coalescing needed
  } else {
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, delayMs);
  }
}
function syncDateInputs() {
  $("#f-from").value = state.from || "";
  $("#f-to").value = state.to || "";
}

/* ---------------- helpers ---------------- */
function $(sel) {
  return document.querySelector(sel);
}
function fmtInt(n) {
  return n == null ? "—" : n.toLocaleString("en-US");
}
function fmtAge(days) {
  if (days == null) return "—";
  const y = Math.floor(days / 365.25);
  const d = Math.round(days % 365.25);
  return y > 0 ? `${y}y ${d}d` : `${d}d`;
}
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/* ---------------- filtering (O(n)) ---------------- */
/*
 * Single place where all filter dimensions combine (AND).
 * `exclude` names one dimension to skip — used to render the "source" chart
 * of an active selection at full distribution (see refresh()).
 */
function applyFilters(exclude) {
  const {
    commenters, video, from, to, minLikes, repliesOnly,
    ageBin, hourBin, weekday, ageMinY, ageMaxY,
  } = state;
  const hasCommenterSel = commenters.size > 0;
  return DATA.comments.filter((c) => {
    if (hasCommenterSel && !commenters.has(c.commenter)) return false;
    if (video !== "all") {
      const v = videoById.get(c.video);
      const isInput = v ? v.is_input : false;
      if (video === "input" && !isInput) return false;
      if (video === "cross" && isInput) return false;
      if (video !== "input" && video !== "cross" && c.video !== video) return false;
    }
    if (exclude !== "time" && (from || to)) {
      if (!c.ts) return false;
      const d = localDateStr(new Date(c.ts));
      if (from && d < from) return false;
      if (to && d > to) return false;
    }
    if (minLikes > 0 && (c.likes ?? 0) < minLikes) return false;
    if (repliesOnly && !c.is_reply) return false;
    if (exclude !== "ageBin" && ageBin != null) {
      const a = ageDaysById.get(c.commenter);
      if (a == null) return false;
      if (a < ageBin * AGE_DAYS_PER_YEAR || a >= (ageBin + 1) * AGE_DAYS_PER_YEAR) return false;
    }
    if (ageMinY != null || ageMaxY != null) {
      const a = ageDaysById.get(c.commenter);
      if (a == null) return false; // unknown age: excluded when a bound is set
      if (ageMinY != null && a < ageMinY * AGE_DAYS_PER_YEAR) return false;
      if (ageMaxY != null && a > ageMaxY * AGE_DAYS_PER_YEAR) return false;
    }
    if (exclude !== "hourBin" && hourBin != null) {
      if (!c.ts) return false;
      const d = new Date(c.ts);
      if (isNaN(d)) return false;
      if (Math.floor(d.getHours() / 3) !== hourBin) return false;
    }
    if (exclude !== "weekday" && weekday != null) {
      if (!c.ts) return false;
      const d = new Date(c.ts);
      if (isNaN(d)) return false;
      if ((d.getDay() + 6) % 7 !== weekday) return false;
    }
    return true;
  });
}

/* ---------------- KPIs ---------------- */
function renderKPIs(rows) {
  const cids = new Set();
  const vids = new Set();
  for (const c of rows) {
    cids.add(c.commenter);
    vids.add(c.video);
  }
  const ages = [...cids].map((id) => ageDaysById.get(id)).filter((a) => a != null);
  const kpis = [
    { label: "Commenters", value: fmtInt(cids.size) },
    { label: "Comments", value: fmtInt(rows.length) },
    { label: "Videos", value: fmtInt(vids.size) },
    { label: "Age min", value: fmtAge(ages.length ? Math.min(...ages) : null), sub: "account age" },
    { label: "Age max", value: fmtAge(ages.length ? Math.max(...ages) : null), sub: "account age" },
    { label: "Age mean", value: fmtAge(mean(ages)), sub: "account age" },
    { label: "Age median", value: fmtAge(median(ages)), sub: "account age" },
    {
      label: "Avg comments / commenter",
      value: cids.size ? (rows.length / cids.size).toFixed(2) : "—",
    },
  ];
  $("#kpis").innerHTML = kpis
    .map(
      (k) =>
        `<div class="kpi"><div class="kpi-label">${k.label}</div>` +
        `<div class="kpi-value">${k.value}</div>` +
        (k.sub ? `<div class="kpi-sub">${k.sub}</div>` : "") +
        `</div>`
    )
    .join("");
}

/* ---------------- charts ---------------- */
const charts = {};
function makeChart(id) {
  if (!charts[id]) {
    charts[id] = echarts.init(document.getElementById(id), null, { renderer: "canvas" });
  }
  return charts[id];
}
function baseOption() {
  return {
    animation: false,
    backgroundColor: "transparent",
    textStyle: { color: "#9aa3b2", fontSize: 11 },
    grid: { left: 46, right: 16, top: 24, bottom: 42 },
    tooltip: { trigger: "axis" },
  };
}

function bucketKey(d, gran) {
  const y = d.getFullYear();
  if (gran === "year") return String(y);
  if (gran === "month") return `${y}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  if (gran === "week") {
    // ISO week: Monday of the week.
    const mon = new Date(d);
    const day = (d.getDay() + 6) % 7;
    mon.setDate(d.getDate() - day);
    return localDateStr(mon);
  }
  return localDateStr(d); // day
}

/* Date span [from, to] (local 'YYYY-MM-DD') covered by a bucket key. */
function bucketSpan(key, gran) {
  if (gran === "year") return [`${key}-01-01`, `${key}-12-31`];
  if (gran === "month") {
    const [y, m] = key.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return [`${key}-01`, `${key}-${String(last).padStart(2, "0")}`];
  }
  if (gran === "week") {
    const mon = new Date(key + "T00:00:00");
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    return [localDateStr(mon), localDateStr(sun)];
  }
  return [key, key]; // day
}

function renderTimeChart(rows) {
  const counts = new Map();
  for (const c of rows) {
    if (!c.ts) continue;
    const d = new Date(c.ts);
    if (isNaN(d)) continue;
    const k = bucketKey(d, state.gran);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const keys = [...counts.keys()].sort();
  timeKeys = keys;
  // Buckets inside the active from/to range (set by a bar click, the slider,
  // or the date inputs) stay full-color; the rest are dimmed.
  const hasRange = state.from != null || state.to != null;
  const inRange = keys.map((k) => {
    const [s, e] = bucketSpan(k, state.gran);
    return (!state.from || e >= state.from) && (!state.to || s <= state.to);
  });
  const opt = baseOption();
  opt.xAxis = { type: "category", data: keys, axisLabel: { color: "#9aa3b2" } };
  opt.yAxis = { type: "value", name: "comments" };
  // No "inside" dataZoom: mouse-wheel zoom is intentionally disabled.
  opt.dataZoom = keys.length > 40 ? [{ type: "slider", height: 18, bottom: 8 }] : [];
  opt.series = [{
    type: "bar",
    data: keys.map((k, i) => ({
      value: counts.get(k),
      itemStyle: { color: "#4f8cff", opacity: hasRange && !inRange[i] ? 0.35 : 1 },
    })),
  }];
  const chart = makeChart("chart-time");
  // Re-apply the slider window so it stays put across re-renders. The flag
  // suppresses the dataZoom event fired by the re-application itself.
  zoomReapplying = true;
  chart.setOption(opt, true);
  if (keys.length > 40 && hasRange) {
    const n = keys.length;
    let i0 = 0;
    for (let i = 0; i < n; i++) {
      if (bucketSpan(keys[i], state.gran)[1] >= state.from) { i0 = i; break; }
    }
    let i1 = n - 1;
    for (let i = n - 1; i >= 0; i--) {
      if (bucketSpan(keys[i], state.gran)[0] <= state.to) { i1 = i; break; }
    }
    chart.dispatchAction({
      type: "dataZoom",
      start: Math.max(0, Math.min(100, (i0 / (n - 1)) * 100)),
      end: Math.max(0, Math.min(100, (i1 / (n - 1)) * 100)),
    });
  }
  zoomReapplying = false;
}

function render3hChart(rows) {
  const bins = new Array(8).fill(0);
  for (const c of rows) {
    if (!c.ts) continue;
    const d = new Date(c.ts);
    if (isNaN(d)) continue;
    bins[Math.min(7, Math.floor(d.getHours() / 3))] += 1;
  }
  const labels = ["00–03", "03–06", "06–09", "09–12", "12–15", "15–18", "18–21", "21–24"];
  const opt = baseOption();
  opt.xAxis = { type: "category", data: labels };
  opt.yAxis = { type: "value", name: "comments" };
  opt.series = [{
    type: "bar",
    data: bins.map((v, i) => ({
      value: v,
      itemStyle: { color: "#34d399", opacity: state.hourBin != null && i !== state.hourBin ? 0.35 : 1 },
    })),
  }];
  makeChart("chart-3h").setOption(opt, true);
}

function renderWeekdayChart(rows) {
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const counts = new Array(7).fill(0);
  for (const c of rows) {
    if (!c.ts) continue;
    const d = new Date(c.ts);
    if (isNaN(d)) continue;
    counts[(d.getDay() + 6) % 7] += 1;
  }
  const opt = baseOption();
  opt.xAxis = { type: "category", data: names };
  opt.yAxis = { type: "value", name: "comments" };
  opt.series = [{
    type: "bar",
    data: counts.map((v, i) => ({
      value: v,
      itemStyle: { color: "#f59e0b", opacity: state.weekday != null && i !== state.weekday ? 0.35 : 1 },
    })),
  }];
  makeChart("chart-weekday").setOption(opt, true);
}

function renderAgeChart(rows) {
  const cids = new Set(rows.map((c) => c.commenter));
  const ages = [...cids].map((id) => ageDaysById.get(id)).filter((a) => a != null);
  const counts = new Array(AGE_LABELS.length).fill(0);
  for (const a of ages) counts[ageBinOf(a)] += 1;
  const opt = baseOption();
  opt.xAxis = { type: "category", data: AGE_LABELS };
  opt.yAxis = { type: "value", name: "commenters" };
  opt.series = [{
    type: "bar",
    data: counts.map((v, i) => ({
      value: v,
      itemStyle: { color: "#a78bfa", opacity: state.ageBin != null && i !== state.ageBin ? 0.35 : 1 },
    })),
  }];
  makeChart("chart-age").setOption(opt, true);
}

function renderTopChart(rows) {
  const counts = new Map();
  for (const c of rows) counts.set(c.commenter, (counts.get(c.commenter) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).reverse();
  const names = top.map(([id]) => {
    const c = commenterById.get(id);
    return c && c.name ? c.name : id.slice(0, 10);
  });
  const opt = baseOption();
  opt.grid = { left: 110, right: 24, top: 12, bottom: 24 };
  opt.xAxis = { type: "value", name: "comments" };
  opt.yAxis = { type: "category", data: names, axisLabel: { width: 100, overflow: "truncate" } };
  opt.tooltip = { trigger: "axis" };
  opt.series = [{ type: "bar", data: top.map(([, n]) => n), itemStyle: { color: "#4f8cff" } }];
  makeChart("chart-top").setOption(opt, true);
}

/* ---------------- tables ---------------- */
function commenterAggregates(rows) {
  const agg = new Map();
  for (const c of rows) {
    let a = agg.get(c.commenter);
    if (!a) {
      a = { id: c.commenter, comments: 0, cross: 0 };
      agg.set(c.commenter, a);
    }
    a.comments += 1;
    if (c.source === "cross-video") a.cross += 1;
  }
  const out = [];
  for (const [id, a] of agg) {
    const c = commenterById.get(id) || {};
    out.push({
      id,
      name: c.name || id,
      country: c.country || "",
      created_at: c.created_at || "",
      age_days: ageDaysById.get(id) ?? null,
      comments: a.comments,
      cross_video_count: a.cross,
      subs: c.subs ?? null,
      // `enriched === false` = channel 'who' metadata not fetched (enrichment
      // cap). `undefined` (legacy data.js without the field) = treated as
      // enriched, so old payloads keep the old look.
      enriched: c.enriched !== false,
    });
  }
  return out;
}

function renderCommentersTable(rows) {
  let data = commenterAggregates(rows);
  const { cSortKey: k, cSortDir: dir } = state;
  data.sort((a, b) => {
    let va = a[k], vb = b[k];
    if (va == null) va = -Infinity;
    if (vb == null) vb = -Infinity;
    if (typeof va === "string") return dir * va.localeCompare(vb);
    return dir * (va - vb);
  });
  const tbody = $("#commenters-table tbody");
  tbody.innerHTML = data
    .map(
      (c) =>
        `<tr>
      <td>${escapeHtml(c.name)}${c.enriched ? "" : UNENRICHED_BADGE}</td>
      <td>${escapeHtml(c.country)}</td>
      <td>${c.created_at || "—"}</td>
      <td class="num">${c.age_days != null ? c.age_days.toLocaleString("en-US") : "—"}</td>
      <td class="num">${c.comments.toLocaleString("en-US")}</td>
      <td class="num">${c.cross_video_count.toLocaleString("en-US")}</td>
      <td class="num">${fmtInt(c.subs)}</td>
    </tr>`
    )
    .join("");
  $("#commenters-count").textContent = `(${data.length} in selection)`;
  updateSortArrows("commenters-table");
}

function renderCommentsTable(rows) {
  const { sortKey: k, sortDir: dir, page } = state;
  const sorted = [...rows].sort((a, b) => {
    let va, vb;
    switch (k) {
      case "author":
        va = (commenterById.get(a.commenter) || {}).name || "";
        vb = (commenterById.get(b.commenter) || {}).name || "";
        break;
      case "video":
        va = a.video_title || "";
        vb = b.video_title || "";
        break;
      default:
        va = a[k] ?? -Infinity;
        vb = b[k] ?? -Infinity;
    }
    if (typeof va === "string") return dir * va.localeCompare(vb);
    return dir * (va - vb);
  });
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const p = Math.min(page, pages);
  const slice = sorted.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
  const tbody = $("#comments-table tbody");
  tbody.innerHTML = slice
    .map((c) => {
      const cm = commenterById.get(c.commenter) || {};
      const v = videoById.get(c.video) || {};
      const badges =
        (c.is_reply ? `<span class="badge reply">reply</span>` : "") +
        (c.source === "cross-video" ? `<span class="badge cross">cross-video</span>` : "") +
        (cm.enriched === false ? UNENRICHED_BADGE : "");
      return `<tr>
      <td style="white-space:nowrap">${c.ts ? c.ts.replace("T", " ").replace("Z", "") : "—"}</td>
      <td>${escapeHtml(cm.name || c.commenter)}${badges}</td>
      <td>${escapeHtml(v.title || c.video_title || c.video)}</td>
      <td class="num">${c.len.toLocaleString("en-US")}</td>
      <td class="num">${fmtInt(c.likes)}</td>
      <td><div class="text-cell" title="${escapeHtml(c.text)}">${escapeHtml(c.text)}</div></td>
    </tr>`;
    })
    .join("");
  $("#comments-count").textContent = `(${sorted.length.toLocaleString("en-US")} in selection)`;
  renderPagination(p, pages, sorted.length);
  updateSortArrows("comments-table");
}

function renderPagination(page, pages, total) {
  const el = $("#comments-pagination");
  const start = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const end = Math.min(total, page * PAGE_SIZE);
  el.innerHTML = `
    <button id="pg-prev" ${page <= 1 ? "disabled" : ""}>‹</button>
    <span class="page-info">${start.toLocaleString("en-US")}–${end.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} · page ${page}/${pages}</span>
    <button id="pg-next" ${page >= pages ? "disabled" : ""}>›</button>`;
  $("#pg-prev").onclick = () => {
    state.page = Math.max(1, page - 1);
    renderCommentsTable(applyFilters());
  };
  $("#pg-next").onclick = () => {
    state.page = Math.min(pages, page + 1);
    renderCommentsTable(applyFilters());
  };
}

function updateSortArrows(tableId) {
  const key = tableId === "commenters-table" ? state.cSortKey : state.sortKey;
  const dir = tableId === "commenters-table" ? state.cSortDir : state.sortDir;
  for (const th of document.querySelectorAll(`#${tableId} thead th`)) {
    const arrow = th.dataset.sort === key ? (dir > 0 ? " ↑" : " ↓") : "";
    th.innerHTML = th.textContent.replace(/ [↑↓]$/, "") + (arrow ? ` <span class="arrow">${arrow.trim()}</span>` : "");
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

/* ---------------- header / footer ---------------- */
function renderHeader() {
  const v = DATA.input_video;
  const title = v.title || v.id;
  $("#video-title").innerHTML = v.url
    ? `<a href="${escapeHtml(v.url)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>`
    : escapeHtml(title);
  const urlEl = $("#video-url");
  urlEl.textContent = v.url || "";
  urlEl.style.display = v.url ? "" : "none";
  const nC = DATA.commenters.length;
  const nV = DATA.videos.length;
  const nU = DATA.commenters.filter((c) => c.enriched === false).length;
  $("#capture-meta").textContent = `captured ${DATA.captured_at ? DATA.captured_at.replace("T", " ").replace("Z", " UTC") : "—"}`;
  $("#totals").innerHTML =
    `<b>${fmtInt(DATA.comments.length)}</b> comments · <b>${fmtInt(nC)}</b> commenters` +
    (nU ? ` <span class="unenriched-note" title="These commenters were not enriched with channel metadata (enrichment cap). Re-run with a higher --max-commenters, or run --enrich-only to fill them in.">(${fmtInt(nU)} not enriched)</span>` : "") +
    ` · <b>${fmtInt(nV)}</b> videos`;
  $("#footer-meta").textContent = `yt-commenter-stats · input: ${v.title || v.id}`;
}

/* ---------------- filter UI ---------------- */
function buildVideoFilter() {
  const sel = $("#f-video");
  for (const v of DATA.videos) {
    if (v.is_input) continue;
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.title ? v.title.slice(0, 60) : v.id;
    sel.appendChild(opt);
  }
}

function buildCommenterList() {
  const list = $("#ms-list");
  const sorted = [...DATA.commenters].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  list.innerHTML = sorted
    .map(
      (c) =>
        `<label class="ms-item${c.enriched === false ? " ms-unenriched" : ""}" data-id="${c.id}">
      <input type="checkbox" value="${c.id}">
      <span>${escapeHtml(c.name || c.id)}${c.enriched === false ? " <span class='ms-dot' title='not enriched'></span>" : ""}</span>
      <span class="ms-country">${escapeHtml(c.country)}</span>
    </label>`
    )
    .join("");
  list.querySelectorAll("input").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) state.commenters.add(cb.value);
      else state.commenters.delete(cb.value);
      state.page = 1;
      updateMsLabel();
      scheduleRefresh(0);
    });
  });
  $("#ms-search").addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    list.querySelectorAll(".ms-item").forEach((item) => {
      const name = item.querySelector("span").textContent.toLowerCase();
      item.style.display = name.includes(q) ? "" : "none";
    });
  });
  $("#ms-all").addEventListener("click", () => {
    list.querySelectorAll("input").forEach((cb) => {
      if (cb.checked === false) {
        cb.checked = true;
        state.commenters.add(cb.value);
      }
    });
    state.page = 1;
    updateMsLabel();
    scheduleRefresh(0);
  });
  $("#ms-none").addEventListener("click", () => {
    state.commenters.clear();
    list.querySelectorAll("input").forEach((cb) => (cb.checked = false));
    state.page = 1;
    updateMsLabel();
    scheduleRefresh(0);
  });
}

function updateMsLabel() {
  const n = state.commenters.size;
  $("#ms-label").textContent = n === 0 ? "All" : `${n} selected`;
}

function bindFilterEvents() {
  const toggle = $("#ms-toggle");
  const panel = $("#ms-panel");
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target)) panel.hidden = true;
  });

  $("#f-video").addEventListener("change", (e) => {
    state.video = e.target.value;
    state.page = 1;
    scheduleRefresh(0);
  });
  $("#f-from").addEventListener("change", (e) => {
    state.from = e.target.value || null;
    state.page = 1;
    scheduleRefresh(0);
  });
  $("#f-to").addEventListener("change", (e) => {
    state.to = e.target.value || null;
    state.page = 1;
    scheduleRefresh(0);
  });
  $("#f-gran").addEventListener("change", (e) => {
    state.gran = e.target.value;
    refresh();
  });
  $("#f-likes").addEventListener("input", (e) => {
    state.minLikes = Math.max(0, parseInt(e.target.value, 10) || 0);
    state.page = 1;
    scheduleRefresh(0);
  });
  $("#f-replies").addEventListener("change", (e) => {
    state.repliesOnly = e.target.checked;
    state.page = 1;
    scheduleRefresh(0);
  });
  $("#f-age-min").addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    state.ageMinY = isNaN(v) ? null : v;
    state.page = 1;
    scheduleRefresh(0);
  });
  $("#f-age-max").addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    state.ageMaxY = isNaN(v) ? null : v;
    state.page = 1;
    scheduleRefresh(0);
  });
  document.querySelectorAll(".age-preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      const p = btn.dataset.agePreset;
      if (p === "fresh") { state.ageMinY = null; state.ageMaxY = 1; }
      else if (p === "mid") { state.ageMinY = 3; state.ageMaxY = 7; }
      else if (p === "old") { state.ageMinY = 10; state.ageMaxY = null; }
      $("#f-age-min").value = state.ageMinY ?? "";
      $("#f-age-max").value = state.ageMaxY ?? "";
      state.page = 1;
      scheduleRefresh(0);
    });
  });
  $("#f-reset").addEventListener("click", resetFilters);

  document.querySelectorAll(".preset").forEach((btn) => {
    if (btn.dataset.agePreset != null) return; // age presets bind separately above
    btn.addEventListener("click", () => {
      const preset = btn.dataset.preset;
      const now = new Date();
      if (preset === "all") {
        state.from = null;
        state.to = null;
      } else if (preset === "7d" || preset === "30d") {
        const days = preset === "7d" ? 7 : 30;
        const from = new Date(now);
        from.setDate(now.getDate() - days);
        state.from = localDateStr(from);
        state.to = localDateStr(now);
      } else if (preset === "year") {
        state.from = `${now.getFullYear()}-01-01`;
        state.to = localDateStr(now);
      }
      syncDateInputs();
      state.page = 1;
      scheduleRefresh(0);
    });
  });

  // Table sorting.
  for (const th of document.querySelectorAll("#commenters-table thead th")) {
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (state.cSortKey === k) state.cSortDir *= -1;
      else {
        state.cSortKey = k;
        state.cSortDir = k === "name" || k === "country" || k === "created_at" ? 1 : -1;
      }
      renderCommentersTable(applyFilters());
    });
  }
  for (const th of document.querySelectorAll("#comments-table thead th")) {
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (!k) return;
      if (state.sortKey === k) state.sortDir *= -1;
      else {
        state.sortKey = k;
        state.sortDir = k === "ts" ? -1 : 1;
      }
      renderCommentsTable(applyFilters());
    });
  }

  window.addEventListener("resize", () => {
    for (const id of Object.keys(charts)) charts[id].resize();
  });
}

function resetFilters() {
  state.commenters.clear();
  state.video = "all";
  state.from = null;
  state.to = null;
  state.minLikes = 0;
  state.repliesOnly = false;
  state.ageBin = null;
  state.hourBin = null;
  state.weekday = null;
  state.ageMinY = null;
  state.ageMaxY = null;
  state.page = 1;
  $("#f-video").value = "all";
  $("#f-from").value = "";
  $("#f-to").value = "";
  $("#f-likes").value = "";
  $("#f-replies").checked = false;
  $("#f-age-min").value = "";
  $("#f-age-max").value = "";
  document.querySelectorAll("#ms-list input").forEach((cb) => (cb.checked = false));
  updateMsLabel();
  scheduleRefresh(0);
}

/* ---------------- chart interactions (cross-filtering) ---------------- */
/*
 * The slider (dataZoom) is the continuous input: it is debounced so the
 * graphs update only after the user pauses (~1.2 s), preventing update
 * collisions while dragging. Discrete actions (bar clicks, selects, dates)
 * refresh immediately via scheduleRefresh(0).
 */
function onTimeZoom(params) {
  if (zoomReapplying) return; // re-applying the window fires this again
  const n = timeKeys.length;
  if (!n) return;
  const start = Math.max(0, Math.min(100, params.start ?? 0));
  const end = Math.max(0, Math.min(100, params.end ?? 100));
  if (start <= 0 && end >= 100) {
    state.from = null;
    state.to = null;
  } else {
    const i0 = Math.min(n - 1, Math.round((start / 100) * (n - 1)));
    const i1 = Math.min(n - 1, Math.max(i0, Math.round((end / 100) * (n - 1))));
    state.from = bucketSpan(timeKeys[i0], state.gran)[0];
    state.to = bucketSpan(timeKeys[i1], state.gran)[1];
  }
  syncDateInputs();
  state.page = 1;
  scheduleRefresh(1200);
}

function bindChartEvents() {
  const time = makeChart("chart-time");
  time.on("click", (p) => {
    if (p.dataIndex == null || !timeKeys[p.dataIndex]) return;
    const [f, t] = bucketSpan(timeKeys[p.dataIndex], state.gran);
    if (state.from === f && state.to === t) {
      state.from = null; // clicking the selected bucket again clears it
      state.to = null;
    } else {
      state.from = f;
      state.to = t;
    }
    syncDateInputs();
    state.page = 1;
    scheduleRefresh(0);
  });
  time.on("dataZoom", onTimeZoom);
  makeChart("chart-3h").on("click", (p) => {
    state.hourBin = state.hourBin === p.dataIndex ? null : p.dataIndex;
    state.page = 1;
    scheduleRefresh(0);
  });
  makeChart("chart-weekday").on("click", (p) => {
    state.weekday = state.weekday === p.dataIndex ? null : p.dataIndex;
    state.page = 1;
    scheduleRefresh(0);
  });
  makeChart("chart-age").on("click", (p) => {
    state.ageBin = state.ageBin === p.dataIndex ? null : p.dataIndex;
    state.page = 1;
    scheduleRefresh(0);
  });
}

/* ---------------- main ---------------- */
function refresh() {
  const rowsAll = applyFilters();
  renderKPIs(rowsAll);
  // "Exclude-self" rendering: a chart that is the source of an active
  // selection shows the full distribution (selection highlighted) so the
  // user can switch slices without losing context; everything else filters
  // down to the selection.
  const hasTimeSel = state.from != null || state.to != null;
  renderTimeChart(hasTimeSel ? applyFilters("time") : rowsAll);
  render3hChart(state.hourBin != null ? applyFilters("hourBin") : rowsAll);
  renderWeekdayChart(state.weekday != null ? applyFilters("weekday") : rowsAll);
  renderAgeChart(state.ageBin != null ? applyFilters("ageBin") : rowsAll);
  renderTopChart(rowsAll);
  renderCommentersTable(rowsAll);
  renderCommentsTable(rowsAll);
}

renderHeader();
buildVideoFilter();
buildCommenterList();
bindFilterEvents();
refresh();
bindChartEvents();

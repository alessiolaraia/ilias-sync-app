"use strict";

// ILIAS Sync – Web-App. Enthält keine Daten: liest alles über die GitHub-API
// aus dem privaten Repo und startet dort den Workflow „sync.yml“.

const LS_KEY = "ilias-sync:settings";
const API = "https://api.github.com";
const WORKFLOW = "sync.yml";
const POLL_MS = 5000;
const POLL_MAX = 24; // ca. 2 Minuten

const MODES = {
  new: { label: "Neues holen", start: "Neues wird geholt", done: "Neues geholt" },
  "goodnotes-all": { label: "Alles an GoodNotes", start: "Wird an GoodNotes geschickt", done: "An GoodNotes geschickt" },
  zip: { label: "ZIP an Telegram", start: "ZIP wird an Telegram geschickt", done: "Als ZIP an Telegram geschickt" },
};

const DEMO = new URLSearchParams(location.search).has("demo");

const app = {
  settings: null,
  config: null,
  status: {},
  runs: [],
  pending: null,
  pollTimer: null,
  sheetCourse: null,
};

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// Einstellungen (localStorage, immer mit try/catch)
// ---------------------------------------------------------------------------

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function storeSettings(s) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

function isConfigured(s) {
  return Boolean(s && s.owner && s.repo && s.branch && s.token);
}

// ---------------------------------------------------------------------------
// GitHub-API
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function gh(path, { method = "GET", body, raw = false, settings = app.settings } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${settings.token}`,
        Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new ApiError("Keine Verbindung zu GitHub. Bist du online?", 0);
  }
  if (res.status === 204) return null;
  if (!res.ok) {
    const msg = {
      401: "Token ungültig oder abgelaufen.",
      403: "Dem Token fehlen Rechte (Actions: Read and write, Contents: Read-only).",
      404: "Repo, Branch oder Datei nicht gefunden – oder der Token hat keinen Zugriff auf dieses Repo.",
      422: "GitHub hat die Anfrage abgelehnt. Stimmt der Branch?",
    }[res.status] || `GitHub antwortet mit Fehler ${res.status}.`;
    throw new ApiError(msg, res.status);
  }
  return raw ? res.text() : res.json();
}

function repoPath(s = app.settings) {
  return `/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}`;
}

async function readFile(path, s = app.settings) {
  return gh(`${repoPath(s)}/contents/${path}?ref=${encodeURIComponent(s.branch)}`, { raw: true, settings: s });
}

async function fetchRuns() {
  if (DEMO) return demoData().runs;
  const data = await gh(`${repoPath()}/actions/workflows/${WORKFLOW}/runs?per_page=5&branch=${encodeURIComponent(app.settings.branch)}`);
  return data.workflow_runs || [];
}

async function dispatch(course, mode) {
  if (DEMO) return;
  await gh(`${repoPath()}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    body: { ref: app.settings.branch, inputs: { course, mode } },
  });
}

// ---------------------------------------------------------------------------
// Laden
// ---------------------------------------------------------------------------

async function loadAll() {
  $("#loadError").hidden = true;
  if (DEMO) {
    const d = demoData();
    app.config = d.config;
    app.status = d.status;
    app.runs = d.runs;
    showDashboard();
    render();
    return;
  }
  if (!isConfigured(app.settings)) {
    $("#onboarding").hidden = false;
    $("#dashboard").hidden = true;
    return;
  }
  $("#onboarding").hidden = true;
  try {
    const [yamlText, statusText, runs] = await Promise.all([
      readFile("courses.yaml").catch((e) => (e.status === 404 ? "" : Promise.reject(e))),
      readFile("state/status.json").catch((e) => (e.status === 404 ? "{}" : Promise.reject(e))),
      fetchRuns().catch(() => []),
    ]);
    app.config = parseYaml(yamlText);
    try {
      app.status = JSON.parse(statusText || "{}");
    } catch {
      app.status = {};
    }
    app.runs = runs;
    showDashboard();
    render();
  } catch (e) {
    $("#dashboard").hidden = true;
    $("#loadError").hidden = false;
    $("#loadErrorText").textContent = e.message;
  }
}

function parseYaml(text) {
  if (!text) return null;
  if (!window.jsyaml) return null; // CDN nicht erreichbar → nur status.json nutzen
  try {
    return window.jsyaml.load(text);
  } catch {
    return null;
  }
}

function showDashboard() {
  $("#onboarding").hidden = true;
  $("#dashboard").hidden = false;
  const s = app.settings || { owner: "demo", repo: "ilias-sync" };
  $("#allRuns").href = `https://github.com/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}/actions/workflows/${WORKFLOW}`;
}

// ---------------------------------------------------------------------------
// Darstellung
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function ago(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (Number.isNaN(diff)) return "";
  if (diff < 60) return "gerade eben";
  if (diff < 3600) return `vor ${Math.round(diff / 60)} Min.`;
  if (diff < 86400) return `vor ${Math.round(diff / 3600)} Std.`;
  const days = Math.round(diff / 86400);
  if (days === 1) return "gestern";
  if (days < 30) return `vor ${days} Tagen`;
  return new Date(iso).toLocaleDateString("de-DE", { day: "numeric", month: "short" });
}

function plural(n, one, many) {
  return `${n.toLocaleString("de-DE")} ${n === 1 ? one : many}`;
}

function courses() {
  const list = (app.status.courses || []).map((c) => ({ ...c }));
  const known = new Set(list.map((c) => c.id));
  const cfgCourses = (app.config && Array.isArray(app.config.courses)) ? app.config.courses : [];
  for (const c of cfgCourses) {
    const real = c && c.target && !String(c.target).includes("XXXXXX");
    if (real && !known.has(c.id)) {
      list.push({ id: c.id, name: c.name || c.id, short: c.short || c.id, pending: true, active: true });
    }
  }
  return list;
}

function discoverOn() {
  const s = app.config && app.config.settings;
  return !s || s.discover !== false;
}

function courseLabel(id) {
  if (!id || id === "all") return "alle Fächer";
  const c = courses().find((x) => x.id === id);
  return c ? c.short : id;
}

function runInfo(run) {
  const title = run.display_title || run.name || "";
  let label = title;
  const m = title.match(/^(new|goodnotes-all|zip) · (.+)$/);
  if (run.event === "schedule") label = "Geplante Prüfung";
  else if (m) label = `${MODES[m[1]].label} · ${courseLabel(m[2])}`;
  let state = "wait", text = "wartet";
  if (run.status === "in_progress") { state = "run"; text = "läuft"; }
  else if (run.status === "completed") {
    if (run.conclusion === "success") { state = "ok"; text = "fertig"; }
    else if (run.conclusion === "skipped") { state = "ok"; text = "übersprungen"; }
    else if (run.conclusion === "cancelled") { state = "err"; text = "abgebrochen"; }
    else { state = "err"; text = "Fehler"; }
  }
  return { label, state, text };
}

function render() {
  renderStatus();
  renderCourses();
  renderRecent();
  renderRuns();
}

function renderStatus() {
  const dot = $("#statusDot"), title = $("#statusTitle"), meta = $("#statusMeta");
  const running = app.runs.find((r) => r.status !== "completed");
  const last = app.status.last_run;
  const newestDone = app.runs.find((r) => r.status === "completed");
  dot.className = "dot";
  if (running) {
    const info = runInfo(running);
    dot.classList.add("run");
    title.textContent = running.status === "in_progress" ? "Synchronisiert gerade …" : "Lauf wartet auf einen Runner …";
    meta.textContent = `${info.label} · gestartet ${ago(running.created_at)}`;
    return;
  }
  if (newestDone && newestDone.conclusion === "failure" &&
      (!last || new Date(newestDone.updated_at) > new Date(last.at || 0))) {
    dot.classList.add("err");
    title.textContent = "Letzter Lauf fehlgeschlagen";
    meta.textContent = `${ago(newestDone.updated_at)} · Details im Lauf auf GitHub`;
    return;
  }
  if (!last) {
    title.textContent = "Noch kein Lauf";
    meta.textContent = "Tippe auf „Jetzt synchronisieren“, um den ersten Abgleich zu starten.";
    return;
  }
  if (!last.ok) {
    dot.classList.add("err");
    title.textContent = "Letzter Lauf fehlgeschlagen";
    meta.textContent = `${ago(last.at)} · ${last.error || "unbekannter Fehler"}`;
    return;
  }
  dot.classList.add("ok");
  const checked = app.status.last_full_check || last.at;
  title.textContent = `Zuletzt geprüft ${ago(checked)}`;
  const parts = [];
  parts.push(last.new_files ? plural(last.new_files, "neue Datei", "neue Dateien") : "Nichts Neues");
  if (last.goodnotes_sent) parts.push(`${last.goodnotes_sent} an GoodNotes`);
  meta.textContent = parts.join(" · ");
}

function renderCourses() {
  const ul = $("#courses"), empty = $("#coursesEmpty");
  const list = courses();
  ul.replaceChildren();
  $("#courseCount").textContent = list.length ? plural(list.filter((c) => c.active !== false).length, "Fach", "Fächer") : "";
  if (!list.length) {
    empty.hidden = false;
    empty.replaceChildren(...(discoverOn()
      ? [el("b", {}, "Noch keine Fächer gefunden. "),
         "Tippe auf „Jetzt synchronisieren“ – alle Kurse aus „Meine Kurse und Gruppen“ (aktuelles Semester) werden automatisch gefunden. Fehlt ein Kurs, trag seinen Permanentlink in ",
         el("code", {}, "courses.yaml"), " eintragen."]
      : [el("b", {}, "Keine Fächer eingerichtet. "),
         "Trag die Permanentlinks deiner Kurse in ", el("code", {}, "courses.yaml"),
         " ein – du findest sie unten auf jeder Kursseite in ILIAS."]));
    return;
  }
  empty.hidden = true;
  for (const c of list) {
    let sub = c.pending
      ? "Noch nicht synchronisiert"
      : `${plural(c.files || 0, "Datei", "Dateien")} · ${plural(c.pdfs || 0, "PDF", "PDFs")}`;
    if (c.active === false) sub += " · nicht mehr auf dem Dashboard";
    else if (c.last_new_at) sub += ` · neu ${ago(c.last_new_at)}`;
    ul.append(el("li", {},
      el("button", { class: `row${c.active === false ? " inactive" : ""}`, type: "button", onclick: () => openCourse(c) },
        el("span", { class: "badge" }, c.short || "?"),
        el("span", { class: "row-main" },
          el("span", { class: "row-title", style: "display:block" }, c.name),
          el("span", { class: "row-sub", style: "display:block" }, sub)),
        chevron())));
  }
}

function chevron() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("class", "chev");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = '<path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
  return svg;
}

function renderRecent() {
  const ul = $("#recent");
  const recent = (app.status.recent || []).slice(0, 10);
  ul.replaceChildren();
  $("#recentEmpty").hidden = recent.length > 0;
  for (const r of recent) {
    const via = r.via === "goodnotes" ? "an GoodNotes" : "an Telegram";
    ul.append(el("li", {},
      el("div", { class: "row" },
        el("span", { class: "badge" }, r.short || "?"),
        el("span", { class: "row-main" },
          el("span", { class: "row-title", style: "display:block" }, r.file),
          el("span", { class: "row-sub", style: "display:block" }, `${via} · ${ago(r.at)}`)))));
  }
}

function renderRuns() {
  const ul = $("#runs");
  ul.replaceChildren();
  $("#runsEmpty").hidden = app.runs.length > 0;
  for (const run of app.runs.slice(0, 5)) {
    const info = runInfo(run);
    ul.append(el("li", {},
      el("a", { class: "row", href: run.html_url, target: "_blank", rel: "noopener", style: "color:inherit;text-decoration:none" },
        el("span", { class: "row-main" },
          el("span", { class: "row-title", style: "display:block" }, info.label),
          el("span", { class: "row-sub", style: "display:block" }, ago(run.created_at))),
        el("span", { class: `pill ${info.state}` }, info.text))));
  }
}

// ---------------------------------------------------------------------------
// Aktionen
// ---------------------------------------------------------------------------

let toastTimer = null;
function toast(text, kind = "") {
  const t = $("#toast");
  t.textContent = text;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
}

async function start(course, mode) {
  const btn = $("#syncAll");
  btn.disabled = true;
  try {
    await dispatch(course, mode);
    const isAll = course === "all" && mode === "new";
    toast(isAll ? "Synchronisierung gestartet" : `${MODES[mode].start} – Lauf gestartet`);
    app.pending = { course, mode, since: Date.now() - 15000 };
    poll();
  } catch (e) {
    toast(e.message, "err");
  } finally {
    setTimeout(() => { btn.disabled = false; }, 4000);
  }
}

function poll() {
  clearTimeout(app.pollTimer);
  let count = 0;
  const tick = async () => {
    count += 1;
    try {
      app.runs = await fetchRuns();
    } catch {
      /* nächster Versuch */
    }
    const p = app.pending;
    if (p) {
      const run = app.runs.find((r) => r.event === "workflow_dispatch" && new Date(r.created_at).getTime() >= p.since);
      if (run && run.status === "completed") {
        const ok = run.conclusion === "success";
        const isAll = p.course === "all" && p.mode === "new";
        toast(ok ? (isAll ? "Synchronisiert" : MODES[p.mode].done) : "Lauf fehlgeschlagen – Details auf GitHub", ok ? "" : "err");
        app.pending = null;
        if (!DEMO) {
          try {
            app.status = JSON.parse(await readFile("state/status.json"));
          } catch { /* egal */ }
        }
      }
    }
    render();
    if (app.pending && count < POLL_MAX) app.pollTimer = setTimeout(tick, POLL_MS);
  };
  app.pollTimer = setTimeout(tick, 1500);
}

function openCourse(c) {
  app.sheetCourse = c;
  $("#sheetShort").textContent = c.short || "?";
  $("#sheetTitle").textContent = c.name;
  $("#sheetMeta").textContent = c.pending
    ? "Noch nicht synchronisiert"
    : `${plural(c.files || 0, "Datei", "Dateien")} · ${plural(c.pdfs || 0, "PDF", "PDFs")}${c.last_checked ? ` · geprüft ${ago(c.last_checked)}` : ""}`;
  openDialog($("#courseSheet"));
}

function openDialog(d) {
  d.dataset.openedAt = String(Date.now());
  if (typeof d.showModal === "function") d.showModal();
  else d.setAttribute("open", "");
}

function closeDialog(d) {
  if (typeof d.close === "function") d.close();
  else d.removeAttribute("open");
}

// ---------------------------------------------------------------------------
// Einstellungen-Dialog
// ---------------------------------------------------------------------------

function formSettings() {
  const f = $("#settingsForm");
  return {
    owner: f.owner.value.trim(),
    repo: f.repo.value.trim(),
    branch: f.branch.value.trim() || "main",
    token: f.token.value.replace(/\s+/g, ""),
  };
}

function openSettings() {
  const f = $("#settingsForm");
  const s = app.settings || {};
  f.owner.value = s.owner || "";
  f.repo.value = s.repo || "";
  f.branch.value = s.branch || "main";
  f.token.value = s.token || "";
  setTestResult("");
  openDialog($("#settingsSheet"));
}

function setTestResult(text, kind = "") {
  const t = $("#testResult");
  t.textContent = text;
  t.className = `test-result ${kind}`;
}

async function testConnection() {
  const s = formSettings();
  if (!isConfigured(s)) {
    setTestResult("Bitte alle Felder ausfüllen.", "err");
    return;
  }
  setTestResult("Teste …");
  try {
    const repo = await gh(repoPath(s), { settings: s });
    await readFile("courses.yaml", s);
    await gh(`${repoPath(s)}/actions/workflows/${WORKFLOW}`, { settings: s });
    if (repo.private === false) {
      setTestResult("Verbindung klappt – aber das Repo ist öffentlich! Stell es auf privat (Kursmaterial).", "err");
    } else {
      setTestResult("Verbindung klappt: Repo, courses.yaml und Workflow gefunden.", "ok");
    }
  } catch (e) {
    setTestResult(e.message, "err");
  }
}

// ---------------------------------------------------------------------------
// Demo (?demo) – nur erfundene Beispieldaten, keine Netzwerkzugriffe
// ---------------------------------------------------------------------------

function demoData() {
  const t = (min) => new Date(Date.now() - min * 60000).toISOString();
  return {
    config: { settings: { discover: true }, courses: [] },
    status: {
      last_full_check: t(14),
      last_run: { at: t(14), ok: true, new_files: 3, goodnotes_sent: 2, mode: "new", course: "all" },
      courses: [
        { id: "linalg", name: "Lineare Algebra", short: "LA", files: 48, pdfs: 41, last_new_at: t(14), last_checked: t(14), active: true },
        { id: "aud", name: "Algorithmen und Datenstrukturen", short: "AuD", files: 63, pdfs: 37, last_new_at: t(60 * 26), last_checked: t(14), active: true },
        { id: "wi3", name: "Wirtschaftsinformatik III", short: "WI3", files: 22, pdfs: 22, last_new_at: t(60 * 24 * 3), last_checked: t(14), active: true },
        { id: "bwl3", name: "BWL 3 – Marketing", short: "BWL3", files: 31, pdfs: 29, last_new_at: t(60 * 24 * 6), last_checked: t(14), active: true },
        { id: "cpm", name: "Change- und Projektmanagement", short: "CPM", files: 17, pdfs: 15, last_checked: t(14), active: true },
      ],
      recent: [
        { at: t(14), short: "LA", file: "Blatt 05.pdf", via: "goodnotes" },
        { at: t(14), short: "LA", file: "VL 07 – Eigenwerte.pdf", via: "goodnotes" },
        { at: t(60 * 26), short: "AuD", file: "Übung 4 – Heaps.pdf", via: "goodnotes" },
        { at: t(60 * 24 * 3), short: "WI3", file: "Fallstudie ERP.pdf", via: "telegram" },
      ],
    },
    runs: [
      { event: "schedule", display_title: "Geplante Prüfung", status: "completed", conclusion: "success", created_at: t(14), updated_at: t(12), html_url: "#" },
      { event: "schedule", display_title: "Geplante Prüfung", status: "completed", conclusion: "success", created_at: t(44), updated_at: t(43), html_url: "#" },
      { event: "workflow_dispatch", display_title: "zip · aud", status: "completed", conclusion: "success", created_at: t(180), updated_at: t(178), html_url: "#" },
      { event: "schedule", display_title: "Geplante Prüfung", status: "completed", conclusion: "failure", created_at: t(60 * 9), updated_at: t(60 * 9), html_url: "#" },
      { event: "workflow_dispatch", display_title: "goodnotes-all · linalg", status: "completed", conclusion: "success", created_at: t(60 * 26), updated_at: t(60 * 26), html_url: "#" },
    ],
  };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Link wie …/#owner/repo füllt Owner und Repo vor (der Hash geht nie an einen Server)
function settingsFromHash() {
  const m = location.hash.match(/^#([\w.-]+)\/([\w.-]+)$/);
  return m ? { owner: m[1], repo: m[2], branch: "main", token: "" } : null;
}

function init() {
  app.settings = loadSettings();
  const fromHash = settingsFromHash();
  if (fromHash && !isConfigured(app.settings)) {
    app.settings = { ...fromHash, ...(app.settings || {}), owner: fromHash.owner, repo: fromHash.repo };
  }

  document.querySelectorAll("[data-open-settings]").forEach((b) => b.addEventListener("click", openSettings));
  $("#openSettings").addEventListener("click", openSettings);
  $("#retry").addEventListener("click", loadAll);
  $("#syncAll").addEventListener("click", () => start("all", "new"));

  document.querySelectorAll("dialog").forEach((d) => {
    // Klick auf den Hintergrund schließt – aber nicht der „Geister-Klick“ direkt nach dem Öffnen
    d.addEventListener("click", (e) => {
      if (e.target === d && Date.now() - Number(d.dataset.openedAt || 0) > 400) closeDialog(d);
    });
    d.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeDialog(d)));
  });

  $("#courseSheet").querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    const c = app.sheetCourse;
    closeDialog($("#courseSheet"));
    if (c) start(c.id, b.dataset.mode);
  }));

  $("#testConn").addEventListener("click", testConnection);
  $("#pasteToken").addEventListener("click", async () => {
    const input = $("#settingsForm").token;
    try {
      const text = (await navigator.clipboard.readText()).replace(/\s+/g, "");
      if (!text) throw new Error("leer");
      input.value = text;
      setTestResult(text.startsWith("github_pat_") || text.startsWith("ghp_")
        ? "Token eingefügt – jetzt „Verbindung testen“." : "Eingefügt – sieht aber nicht wie ein GitHub-Token aus.",
        text.startsWith("github_pat_") || text.startsWith("ghp_") ? "ok" : "err");
    } catch {
      input.focus();
      setTestResult("Einfügen nicht erlaubt – tippe lange ins Feld und wähle „Einsetzen“.", "err");
    }
  });
  $("#settingsForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const s = formSettings();
    if (!isConfigured(s)) {
      setTestResult("Bitte alle Felder ausfüllen.", "err");
      return;
    }
    app.settings = s;
    if (!storeSettings(s)) toast("Konnte nicht dauerhaft speichern (privater Modus?) – gilt nur bis zum Schließen.", "err");
    closeDialog($("#settingsSheet"));
    loadAll();
  });
  $("#clearToken").addEventListener("click", () => {
    const s = { ...(app.settings || formSettings()), token: "" };
    app.settings = s;
    storeSettings(s);
    $("#settingsForm").token.value = "";
    setTestResult("Token gelöscht.", "ok");
    $("#dashboard").hidden = true;
    $("#onboarding").hidden = false;
  });

  // Beim Zurückkehren in die App frisch laden
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && isConfigured(app.settings) && !app.pending) loadAll();
  });

  loadAll();
  // Erster Besuch über den Link: Einstellungen direkt öffnen, nur der Token fehlt noch
  if (fromHash && !isConfigured(app.settings) && !DEMO) {
    openSettings();
  }
}

init();

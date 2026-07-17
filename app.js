/* Totem — friend-finding compass (mobile PWA build).
   Fully client-side: no server. The crew lives in localStorage (seeded from
   DEFAULT_GROUP), shareable between phones via Export/Import crew JSON.
   GPS + device compass work with zero data connection; the demo sim
   animates everyone else. */

"use strict";

const DEMO_MS = 2000;
const STALE_MS = 90_000; // no update for 90s -> dim the LED

const DEFAULT_GROUP = {
  group: "MAINSTAGE CREW",
  festival: "Tomorrowland 2026 · Boom",
  meetup: { name: "The Flagpole", lat: 51.0894, lng: 4.3855 },
  members: [
    { id: "philip", name: "Philip", color: "#ff2ea6", lat: 51.0889, lng: 4.3846, ts: 0, demo: false },
    { id: "chloe",  name: "Chloe",  color: "#2ee6ff", lat: 51.0902, lng: 4.3861, ts: 0, demo: true },
    { id: "marco",  name: "Marco",  color: "#3dff7a", lat: 51.0879, lng: 4.3872, ts: 0, demo: true },
    { id: "jess",   name: "Jess",   color: "#ffb32e", lat: 51.0885, lng: 4.3828, ts: 0, demo: true },
    { id: "tom",    name: "Tom",    color: "#a06bff", lat: 51.0911, lng: 4.3839, ts: 0, demo: true },
    { id: "sam",    name: "Sam",    color: "#4d7bff", lat: 51.0872, lng: 4.3851, ts: 0, demo: true },
  ],
};

const state = {
  group: null,          // {group, festival, meetup, members[]}
  meId: localStorage.getItem("totem.me") || "philip",
  selectedId: null,     // member id or "__meetup__"
  heading: null,        // device compass heading (deg, 0 = north) or null
  radar: false,
  demo: localStorage.getItem("totem.demo") !== "off",
  gpsFix: false,
  sync: JSON.parse(localStorage.getItem("totem.sync") || "null"), // {url, code}
  lastSync: 0,
  online: false,
};

const SYNC_MS = 4000;
const seededIdentities = new Set(); // members whose name/color we pushed this session

// ---------- geo math ----------

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

function distanceM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function bearingDeg(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function fmtDist(m) {
  if (m < 1000) return Math.round(m) + " m";
  return (m / 1000).toFixed(2) + " km";
}

function fmtAgo(ts) {
  if (!ts) return "no fix yet";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "live";
  if (s < 60) return s + "s ago";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  return Math.round(m / 60) + "h ago";
}

// ---------- persistence ----------

function cacheGroup() {
  localStorage.setItem("totem.group", JSON.stringify(state.group));
}

function loadGroup() {
  const raw = localStorage.getItem("totem.group");
  state.group = raw ? JSON.parse(raw) : structuredClone(DEFAULT_GROUP);
}

// ---------- export / import crew (backup-sync between phones) ----------

function exportCrew() {
  const blob = new Blob([JSON.stringify(state.group, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "totem-crew.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

function importCrew(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let g;
    try {
      g = JSON.parse(reader.result);
    } catch {
      alert("Not a Totem crew file.");
      return;
    }
    const posOk = (m) =>
      (typeof m.lat === "number" && typeof m.lng === "number") ||
      (m.lat == null && m.lng == null);
    if (!g || !Array.isArray(g.members) ||
        !g.members.every((m) => m.id && m.name && m.color && posOk(m))) {
      alert("Not a Totem crew file.");
      return;
    }
    state.group = g;
    if (g.meetup) state.group.meetupLocal = true; // imported pin wins over server until pushed
    if (!g.members.some((m) => m.id === state.meId)) {
      state.meId = g.members[0].id;
      localStorage.setItem("totem.me", state.meId);
    }
    state.selectedId = null;
    cacheGroup();
    el("dots").innerHTML = "";
    el("chips").innerHTML = "";
    renderStatic();
    renderTotemBtn();
    render();
  };
  reader.readAsText(file);
}

// ---------- live sync (Cloudflare worker, opportunistic tiny payloads) ----------

function syncBase() {
  if (!state.sync?.url || !state.sync?.code) return null;
  return state.sync.url.replace(/\/+$/, "") + "/crew/" + encodeURIComponent(state.sync.code);
}

async function apiFetch(path, opts) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 3500);
  try {
    const res = await fetch(syncBase() + path, {
      ...opts,
      signal: ctl.signal,
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Server wins for other live members; local wins for me, for demo-simulated
// members while demo is on, and for a locally-dropped Totem pin not yet pushed.
function mergeServer(sg) {
  const local = state.group;
  const byId = Object.fromEntries(local.members.map((m) => [m.id, m]));
  for (const sm of Object.values(sg.members || {})) {
    const lm = byId[sm.id];
    if (!lm) {
      const nm = {
        id: sm.id, name: sm.name || sm.id, color: sm.color || "#8d82a8",
        ts: sm.ts || 0, demo: false,
      };
      if (typeof sm.lat === "number" && typeof sm.lng === "number") {
        nm.lat = sm.lat; nm.lng = sm.lng;
      }
      local.members.push(nm); // no fix yet -> no coords; targets() leaves them off the compass
    } else if (sm.id !== state.meId && !(state.demo && lm.demo)) {
      if (typeof sm.lat === "number") {
        lm.lat = sm.lat; lm.lng = sm.lng; lm.ts = sm.ts || lm.ts;
      }
    }
  }
  if (!local.meetupLocal) local.meetup = sg.meetup ?? null;
  return sg;
}

async function syncTick() {
  if (!syncBase()) return;
  try {
    const me = myMember();
    if (me && me.ts) {
      await apiFetch("/pos", {
        method: "POST",
        body: JSON.stringify({ id: me.id, name: me.name, color: me.color, lat: me.lat, lng: me.lng, ts: me.ts }),
      });
    }
    if (state.group.meetupLocal) {
      await apiFetch("/meetup", { method: "POST", body: JSON.stringify({ meetup: state.group.meetup }) });
      state.group.meetupLocal = false;
    }
    const server = await apiFetch("");
    // seed names/colors from the crew file for members the server only knows bare
    for (const m of state.group.members) {
      const sm = server.members?.[m.id];
      if ((!sm || !sm.color) && !seededIdentities.has(m.id)) {
        seededIdentities.add(m.id);
        await apiFetch("/member", {
          method: "POST",
          body: JSON.stringify({ id: m.id, name: m.name, color: m.color }),
        });
      }
    }
    mergeServer(server);
    state.online = true;
    state.lastSync = Date.now();
    renderTotemBtn();
    cacheGroup();
  } catch {
    state.online = false; // expected constantly at a festival — keep last-known
  }
  renderSyncPill();
}

// ---------- device sensors ----------

function myMember() {
  return state.group?.members.find((m) => m.id === state.meId);
}

function startGeolocation() {
  if (!("geolocation" in navigator)) return;
  navigator.geolocation.watchPosition(
    (pos) => {
      const me = myMember();
      if (!me) return;
      me.lat = pos.coords.latitude;
      me.lng = pos.coords.longitude;
      me.ts = Date.now();
      state.gpsFix = true;
      cacheGroup();
      renderSyncPill();
    },
    () => { state.gpsFix = false; renderSyncPill(); },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
}

function onOrientation(e) {
  if (typeof e.webkitCompassHeading === "number") {
    state.heading = e.webkitCompassHeading; // iOS: magnetic heading (magnetic-vs-true drift accepted)
  } else if (e.absolute && typeof e.alpha === "number") {
    state.heading = (360 - e.alpha) % 360;
  }
}

function startCompass() {
  const btn = document.getElementById("btnCompassPerm");
  if (typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function") {
    // iOS: needs a user gesture
    btn.hidden = false;
    btn.onclick = async () => {
      const ok = await DeviceOrientationEvent.requestPermission();
      if (ok === "granted") {
        window.addEventListener("deviceorientation", onOrientation);
        btn.hidden = true;
      }
    };
  } else if ("ondeviceorientationabsolute" in window) {
    window.addEventListener("deviceorientationabsolute", onOrientation);
  } else if ("ondeviceorientation" in window) {
    window.addEventListener("deviceorientation", onOrientation);
  }
}

// ---------- demo simulation ----------
// Demo friends wander between festival anchor points around the group's
// meetup pin: mainstage, side stage, food court, camping.

const demoTargets = {};

function demoAnchors() {
  const c = state.group.meetup || myMember() || { lat: 51.0894, lng: 4.3855 };
  return [
    { lat: c.lat + 0.0012, lng: c.lng + 0.0016 },
    { lat: c.lat - 0.0015, lng: c.lng + 0.0022 },
    { lat: c.lat - 0.0008, lng: c.lng - 0.0020 },
    { lat: c.lat + 0.0019, lng: c.lng - 0.0010 },
    { lat: c.lat, lng: c.lng },
  ];
}

function demoTick() {
  if (!state.demo || !state.group) return;
  const anchors = demoAnchors();
  for (const m of state.group.members) {
    if (!m.demo || m.id === state.meId) continue;
    let t = demoTargets[m.id];
    if (!t || (Math.abs(m.lat - t.lat) < 0.00008 && Math.abs(m.lng - t.lng) < 0.00008)) {
      t = demoTargets[m.id] = anchors[Math.floor(Math.random() * anchors.length)];
    }
    // amble toward target with a little crowd-drift noise
    m.lat += (t.lat - m.lat) * 0.08 + (Math.random() - 0.5) * 0.00005;
    m.lng += (t.lng - m.lng) * 0.08 + (Math.random() - 0.5) * 0.00005;
    m.ts = Date.now();
  }
  cacheGroup();
}

// ---------- rendering ----------

const el = (id) => document.getElementById(id);

function targets() {
  // everything the compass can point at: friends (not me) + meetup pin;
  // members without coords yet (synced in before any fix) can't be pointed at
  const list = state.group.members
    .filter((m) => m.id !== state.meId && typeof m.lat === "number" && typeof m.lng === "number")
    .map((m) => ({ ...m, kind: "friend" }));
  if (state.group.meetup) {
    list.push({
      id: "__meetup__", kind: "meetup", name: state.group.meetup.name || "Totem",
      color: "#ffd76a", lat: state.group.meetup.lat, lng: state.group.meetup.lng,
      ts: Date.now(),
    });
  }
  return list;
}

function renderStatic() {
  el("groupName").textContent = state.group.group;
  el("festival").textContent = state.group.festival;
}

function renderSyncPill() {
  const pill = el("syncPill");
  if (syncBase()) {
    if (state.online) {
      pill.className = "pill live";
      pill.textContent = "LIVE";
    } else if (state.lastSync) {
      pill.className = "pill syncing";
      pill.textContent = "SYNC " + fmtAgo(state.lastSync).toUpperCase();
    } else {
      pill.className = "pill offline";
      pill.textContent = "OFFLINE";
    }
  } else if (state.gpsFix) {
    pill.className = "pill live";
    pill.textContent = "GPS";
  } else if (state.demo) {
    pill.className = "pill syncing";
    pill.textContent = "DEMO";
  } else {
    pill.className = "pill offline";
    pill.textContent = "NO GPS";
  }
}

function ensureDots(list) {
  const holder = el("dots");
  const have = new Set([...holder.children].map((d) => d.dataset.id));
  for (const t of list) {
    if (have.has(t.id)) continue;
    const d = document.createElement("div");
    d.className = "dot" + (t.kind === "meetup" ? " meetup" : "");
    d.dataset.id = t.id;
    d.style.setProperty("--c", t.color);
    d.innerHTML = `<div class="led"></div><span class="tag"></span>`;
    d.onclick = (ev) => { ev.stopPropagation(); select(t.id); };
    holder.appendChild(d);
  }
  for (const child of [...holder.children]) {
    if (!list.some((t) => t.id === child.dataset.id)) child.remove();
  }
}

// Continuous heading for CSS rotations: the transforms transition, so jumping
// the absolute value 359° -> 1° animates the long way round. Accumulate the
// wrapped delta instead so crossing north is a 2° move, not a 358° spin.
let contHeading = 0;
let lastRawHeading = null;

function continuousHeading(raw) {
  if (lastRawHeading === null) contHeading = raw;
  else contHeading += ((raw - lastRawHeading + 540) % 360) - 180;
  lastRawHeading = raw;
  return contHeading;
}

function render() {
  if (!state.group) return;
  const me = myMember();
  if (!me) return;
  const list = targets();
  ensureDots(list);

  const heading = continuousHeading(state.heading ?? 0);
  el("dial").style.transform = `rotate(${-heading}deg)`;

  const wrap = el("compassWrap");
  const size = wrap.clientWidth;
  const maxDist = Math.max(60, ...list.map((t) => distanceM(me, t)));

  for (const d of el("dots").children) {
    const t = list.find((x) => x.id === d.dataset.id);
    const dist = distanceM(me, t);
    const brg = bearingDeg(me, t);
    // ring mode: fixed radius; radar mode: radius scales with distance,
    // floored so near dots never hide under the center readout
    const frac = state.radar ? 0.62 + 0.38 * Math.min(1, dist / maxDist) : 1;
    const r = size * 0.415 * frac;
    const a = rad(brg - 90);
    d.style.transform =
      `translate(${Math.cos(a) * r}px, ${Math.sin(a) * r}px) rotate(${heading}deg)`;
    d.classList.toggle("selected", d.dataset.id === state.selectedId);
    d.classList.toggle("near", dist < 75);
    d.classList.toggle("far", dist > 400);
    d.classList.toggle("stale", t.kind === "friend" && (!t.ts || Date.now() - t.ts > STALE_MS));
    d.querySelector(".tag").textContent = t.name;
  }

  // center readout
  const sel = list.find((t) => t.id === state.selectedId);
  el("centerReadout").classList.toggle("totem-set", !!state.group.meetup);
  if (sel) {
    el("targetName").textContent = sel.name;
    el("targetName").style.color = sel.color;
    el("targetDist").textContent = fmtDist(distanceM(me, sel));
    el("targetSeen").textContent = sel.kind === "meetup" ? "meet-up point" : fmtAgo(sel.ts);
  } else {
    el("targetName").textContent = "tap a light";
    el("targetName").style.color = "";
    el("targetDist").textContent = list.length + " nearby";
    el("targetSeen").textContent = state.heading == null ? "north-up (no compass)" : "compass on";
  }

  renderChips(list, me);
}

function renderChips(list, me) {
  const holder = el("chips");
  const wanted = [{ ...me, kind: "me" }, ...list];
  if (holder.children.length !== wanted.length) {
    holder.innerHTML = "";
    for (const t of wanted) {
      const b = document.createElement("button");
      b.className = "chip";
      b.dataset.id = t.id;
      b.style.setProperty("--c", t.color);
      b.innerHTML = `<span class="cled"></span><span class="cname"></span><span class="cdist"></span>`;
      b.onclick = () => select(t.id);
      holder.appendChild(b);
    }
  }
  for (const b of holder.children) {
    const t = wanted.find((x) => x.id === b.dataset.id);
    if (!t) continue;
    b.querySelector(".cname").textContent = t.id === me.id ? t.name + " (you)" : t.name;
    b.querySelector(".cdist").textContent = t.id === me.id ? "" : fmtDist(distanceM(me, t));
    b.classList.toggle("selected", t.id === state.selectedId);
    b.classList.toggle("me", t.id === me.id);
    b.classList.toggle("stale", t.kind === "friend" && (!t.ts || Date.now() - t.ts > STALE_MS));
  }
}

function select(id) {
  state.selectedId = state.selectedId === id || id === state.meId ? null : id;
  render();
}

// ---------- actions ----------

function toggleRadar() {
  state.radar = !state.radar;
  el("compassWrap").classList.toggle("radar", state.radar);
  el("btnView").textContent = state.radar ? "◉ Ring" : "◎ Radar";
  el("btnView").classList.toggle("on", state.radar);
  render();
}

function renderTotemBtn() {
  el("btnTotem").textContent = state.group.meetup ? "⚑ Clear Totem" : "⚑ Drop Totem";
  el("btnTotem").classList.toggle("on", !!state.group.meetup);
}

function dropTotem() {
  const me = myMember();
  if (state.group.meetup) {
    state.group.meetup = null;
  } else {
    state.group.meetup = { name: "Totem", lat: me.lat, lng: me.lng };
    state.selectedId = "__meetup__";
  }
  state.group.meetupLocal = true; // wins over server until pushed — even if sync isn't configured yet
  renderTotemBtn();
  cacheGroup();
  render();
  if (syncBase()) syncTick();
}

// ---------- sync settings ----------

function openSync() {
  el("syncUrl").value = state.sync?.url || "";
  el("syncCode").value = state.sync?.code || "";
  renderOtrUrls();
  el("syncDialog").showModal();
}

function randomCode() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let c = "";
  for (let i = 0; i < 16; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function renderOtrUrls() {
  const url = el("syncUrl").value.trim().replace(/\/+$/, "");
  const code = el("syncCode").value.trim();
  const holder = el("otrUrls");
  if (!url || !code) { holder.textContent = ""; return; }
  holder.innerHTML = "<p>OwnTracks URL per friend (Preferences → Connection → HTTP):</p>";
  for (const m of state.group.members) {
    const div = document.createElement("div");
    div.className = "otr-url";
    div.textContent = `${m.name}: ${url}/crew/${code}/otr/${m.id}`;
    holder.appendChild(div);
  }
}

function saveSync() {
  const url = el("syncUrl").value.trim().replace(/\/+$/, "");
  const code = el("syncCode").value.trim();
  state.sync = url && code ? { url, code } : null;
  localStorage.setItem("totem.sync", JSON.stringify(state.sync));
  state.online = false;
  state.lastSync = 0;
  seededIdentities.clear();
  if (state.sync && state.demo) toggleDemo(); // live sync: demo off by default
  el("syncDialog").close();
  renderSyncPill();
  if (state.sync) syncTick();
}

function toggleDemo() {
  state.demo = !state.demo;
  localStorage.setItem("totem.demo", state.demo ? "on" : "off");
  el("btnDemo").classList.toggle("on", state.demo);
  el("btnDemo").textContent = state.demo ? "▶ Demo" : "▷ Demo";
  renderSyncPill();
}

function openWho() {
  const holder = el("whoList");
  holder.innerHTML = "";
  for (const m of state.group.members) {
    const b = document.createElement("button");
    b.style.setProperty("--c", m.color);
    b.classList.toggle("current", m.id === state.meId);
    b.innerHTML = `<span class="cled"></span>${m.name}`;
    b.onclick = () => {
      state.meId = m.id;
      localStorage.setItem("totem.me", m.id);
      state.selectedId = null;
      el("whoDialog").close();
      el("dots").innerHTML = "";
      el("chips").innerHTML = "";
      render();
    };
    holder.appendChild(b);
  }
  el("whoDialog").showModal();
}

// ---------- boot ----------

function boot() {
  loadGroup();
  cacheGroup();

  renderStatic();
  renderSyncPill();
  renderTotemBtn();
  el("btnDemo").classList.toggle("on", state.demo);
  el("btnDemo").textContent = state.demo ? "▶ Demo" : "▷ Demo";

  el("compassWrap").onclick = toggleRadar;
  el("btnView").onclick = toggleRadar;
  el("btnTotem").onclick = dropTotem;
  el("btnDemo").onclick = toggleDemo;
  el("btnWho").onclick = openWho;
  el("btnSync").onclick = openSync;
  el("btnGenCode").onclick = () => { el("syncCode").value = randomCode(); renderOtrUrls(); };
  el("btnSaveSync").onclick = saveSync;
  el("syncUrl").oninput = renderOtrUrls;
  el("syncCode").oninput = renderOtrUrls;
  el("syncDialog").onclick = (e) => { if (e.target === el("syncDialog")) el("syncDialog").close(); };
  el("btnExport").onclick = exportCrew;
  el("btnImport").onclick = () => el("importFile").click();
  el("importFile").onchange = (e) => {
    if (e.target.files[0]) importCrew(e.target.files[0]);
    e.target.value = "";
  };
  el("whoDialog").onclick = (e) => { if (e.target === el("whoDialog")) el("whoDialog").close(); };

  startGeolocation();
  startCompass();

  setInterval(demoTick, DEMO_MS);
  setInterval(syncTick, SYNC_MS);
  setInterval(render, 1000);
  demoTick();
  syncTick();
  render();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js");
  }
}

boot();

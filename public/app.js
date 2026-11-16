import { PRIZES, CODE_RE, SEED_RE, randCode, makeCard, reachAt, idxOf, SMORFIA, clean } from "/core.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const S = {
  pid: null, code: null, name: "", seeds: [], hostToken: null,
  game: null, players: [], online: 0, isHost: false,
  ws: null, wantWs: false, retry: 0, retryT: null, connected: false, pending: false,
  seenLen: -1, seenRound: null, seenPrizes: null, voice: false, jCount: 1, hCount: 0,
};

// identificativo stabile di questo dispositivo
S.pid = LS.get("tombola:pid");
if (!S.pid || !/^[A-Za-z0-9]{8,32}$/.test(S.pid)) { S.pid = randCode(16); LS.set("tombola:pid", S.pid); }

function toast(t) { const el = $("toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove("show"), 3200); }
function showMsg(t) { const m = $("gMsg"); if (!t) { m.hidden = true; return; } m.textContent = t; m.hidden = false; }
function seg(id, from, to, key) {
  const el = $(id); el.innerHTML = "";
  for (let i = from; i <= to; i++) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = i;
    if (i === S[key]) b.className = "on";
    b.onclick = () => { S[key] = i; seg(id, from, to, key); };
    el.appendChild(b);
  }
}
function genSeeds(n) { const s = []; while (s.length < n) { const c = randCode(5); if (!s.includes(c)) s.push(c); } return s; }

/* ===== lobby ===== */
function initLobby() {
  seg("jCount", 1, 6, "jCount"); seg("hCount", 0, 6, "hCount");
  const last = LS.get("tombola:name"); if (last) { $("jName").value = last; $("hName").value = last; }
  const onlyCode = (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); };
  $("jCode").addEventListener("input", onlyCode);
  const h = (location.hash || "").slice(1).toUpperCase(); if (CODE_RE.test(h)) $("jCode").value = h;
  $("jGo").onclick = joinGame; $("hGo").onclick = createGame;
  // ripresa dell'ultima partita
  const lastCode = LS.get("tombola:last");
  if (lastCode && CODE_RE.test(lastCode) && LS.get("tombola:g:" + lastCode)) {
    const L = LS.get("tombola:g:" + lastCode);
    const p = $("resumePanel"); p.hidden = false;
    p.innerHTML = `<span>Rientra nella partita <b>${lastCode}</b>${L.hostToken ? " come banditore" : ""}</span>`;
    const b = document.createElement("button"); b.className = "btn primary sm"; b.textContent = "Rientra";
    b.onclick = () => enterGame(lastCode); p.appendChild(b);
  }
}
function joinGame() {
  const code = $("jCode").value.trim().toUpperCase(), name = clean($("jName").value);
  if (!CODE_RE.test(code)) return toast("Inserisci il codice di 4 caratteri che ti ha dato il banditore.");
  if (!name) return toast("Scrivi il tuo nome, così si sa chi vince!");
  LS.set("tombola:name", name);
  const prev = LS.get("tombola:g:" + code) || {};
  const seeds = Array.isArray(prev.seeds) && prev.seeds.length === S.jCount ? prev.seeds : genSeeds(S.jCount);
  LS.set("tombola:g:" + code, { ...prev, name, seeds });
  enterGame(code);
}
async function createGame() {
  const name = clean($("hName").value) || "Banditore"; LS.set("tombola:name", name);
  $("hGo").disabled = true; $("hostNote").textContent = "Creo la partita…";
  try {
    const r = await fetch("/api/create", { method: "POST" });
    if (!r.ok) throw new Error();
    const { code, hostToken } = await r.json();
    LS.set("tombola:g:" + code, { name, seeds: genSeeds(S.hCount), hostToken });
    $("hostNote").textContent = ""; enterGame(code);
  } catch {
    $("hostNote").textContent = "Non sono riuscito a creare la partita, riprova tra un attimo.";
  } finally { $("hGo").disabled = false; }
}

/* ===== connessione ===== */
function enterGame(code) {
  S.code = code; const L = LS.get("tombola:g:" + code) || {};
  S.name = clean(L.name) || ""; S.seeds = (Array.isArray(L.seeds) ? L.seeds : []).filter((s) => SEED_RE.test(s)).slice(0, 6);
  S.hostToken = typeof L.hostToken === "string" ? L.hostToken : null;
  S.game = null; S.players = []; S.isHost = !!S.hostToken; S.seenLen = -1; S.seenRound = null; S.seenPrizes = null;
  LS.set("tombola:last", code);
  $("lobby").hidden = true; $("game").hidden = false; $("gCode").textContent = code; $("shareCode").textContent = code;
  $("shareLink").textContent = shareUrl();
  try { if (location.hash.slice(1) !== code) history.replaceState(null, "", "#" + code); } catch {}
  buildBoard(); showMsg(""); renderAll();
  S.wantWs = true; S.retry = 0; connect();
}
function shareUrl() { return location.origin + "/#" + S.code; }
function connect() {
  clearTimeout(S.retryT);
  if (!S.wantWs) return;
  const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/" + S.code);
  S.ws = ws;
  ws.onopen = () => {
    S.connected = true; S.retry = 0; showMsg("");
    ws.send(JSON.stringify({ t: "hello", pid: S.pid, name: S.name, seeds: S.seeds, hostToken: S.hostToken }));
    renderAll();
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === "state") {
      S.game = m.game; S.players = Array.isArray(m.players) ? m.players : []; S.online = m.online || 0;
      S.isHost = !!m.isHost; S.pending = false;
      renderAll(); renderPeople();
    } else if (m.t === "error") {
      S.pending = false;
      if (m.code === "notfound") { S.wantWs = false; ws.close(); S.game = null; showMsg("Partita non trovata. Controlla il codice con il banditore."); renderAll(); }
      else if (m.code === "full") showMsg("La partita è piena.");
      else if (m.code === "started") toast("Le cartelle si possono cambiare solo prima del primo numero.");
      else if (m.code === "forbidden") toast("Solo il banditore può farlo.");
      updateCtl();
    }
  };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    S.connected = false; S.pending = false; renderAll();
    if (!S.wantWs) return;
    showMsg("Connessione persa, mi ricollego…");
    const d = Math.min(15000, 600 * 2 ** S.retry++);
    S.retryT = setTimeout(connect, d);
  };
  ws.onerror = () => {};
}
function send(msg) {
  if (!S.ws || S.ws.readyState !== 1) { toast("Non sei collegato, riprovo appena torna la connessione."); return false; }
  S.ws.send(JSON.stringify(msg)); return true;
}
function hostCmd(msg) { if (S.pending) return; if (send(msg)) { S.pending = true; updateCtl(); setTimeout(() => { S.pending = false; updateCtl(); }, 4000); } }
function leaveGame() {
  S.wantWs = false; clearTimeout(S.retryT);
  try { S.ws && S.ws.close(); } catch {}
  S.ws = null; S.game = null; S.code = null; S.connected = false;
  try { history.replaceState(null, "", location.pathname); } catch {}
  $("game").hidden = true; $("lobby").hidden = false;
  initLobby();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.wantWs && (!S.ws || S.ws.readyState > 1)) { S.retry = 0; connect(); }
});

/* ===== voce ===== */
function speak(n) {
  if (!S.voice) return;
  try { const u = new SpeechSynthesisUtterance(String(n)); u.lang = "it-IT"; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch {}
}

/* ===== render ===== */
function buildBoard() {
  const b = $("board"); if (b.children.length) return;
  for (let n = 1; n <= 90; n++) { const d = document.createElement("div"); d.className = "bc"; d.textContent = n; b.appendChild(d); }
}
function renderAll() {
  const g = S.game, host = S.isHost;
  $("gRole").textContent = host ? "🎙️ Banditore" : "🎟️ Giocatore";
  const on = $("gOnline");
  if (!S.connected) { on.className = "pill off"; on.textContent = "offline"; }
  else { on.className = "pill soft"; on.textContent = `👥 ${S.online} collegati`; }
  $("hostCtl").hidden = !host || !g; $("verifyPanel").hidden = !host || !g;
  const drawn = g ? g.drawn : [], last = drawn[drawn.length - 1];
  if (g) {
    if (S.seenRound !== null && S.seenRound !== g.round) { S.seenLen = -1; S.seenPrizes = null; }
    if (S.seenLen >= 0 && drawn.length > S.seenLen) { const b = $("ball"); b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop"); speak(last); }
    if (S.seenPrizes) for (const P of PRIZES) if (g.prizes[P.k] && !S.seenPrizes[P.k]) toast(`${P.label}! Vince ${g.prizes[P.k].winners.map((w) => w.name).join(", ")}`);
    S.seenLen = drawn.length; S.seenRound = g.round; S.seenPrizes = g.prizes;
  }
  $("ballNum").textContent = last || "?";
  $("smorfia").textContent = last ? `${last} · ${SMORFIA[last - 1]}` : g ? "In attesa della prima estrazione…" : "Collegamento alla partita…";
  $("count").textContent = g ? (g.prizes.tombola ? `Tombola! Partita finita dopo ${drawn.length} numeri.` : `Estratti ${drawn.length} su 90`) : "";
  $("prev").innerHTML = drawn.slice(-7, -1).reverse().map((n) => `<span>${n}</span>`).join("");
  const set = new Set(drawn);
  [...$("board").children].forEach((el, i) => { const n = i + 1; el.className = "bc" + (set.has(n) ? " on" : "") + (n === last ? " last" : ""); });
  const nextK = g ? (PRIZES.find((P) => !g.prizes[P.k]) || {}).k : null;
  $("prizes").innerHTML = PRIZES.map((P) => {
    const w = g && g.prizes[P.k];
    return `<div class="prize ${w ? "done" : P.k === nextK ? "next" : ""}"><div class="pl">${P.label}</div><div class="pw">${w ? esc(w.winners.map((x) => x.name).join(", ")) : "—"}</div></div>`;
  }).join("");
  if (g) { $("autoChk").checked = !!g.autoSec; if (g.autoSec) $("autoSec").value = String(g.autoSec); }
  renderCards(drawn, last); renderBanner(); updateCtl(); renderVerify();
  $("voiceBtn").hidden = !("speechSynthesis" in window);
  $("voiceBtn").textContent = S.voice ? "🔊 Voce attiva" : "🔈 Voce";
}
function renderCards(drawn, last) {
  const set = new Set(drawn);
  $("rerollBtn").hidden = !(S.game && !drawn.length && S.seeds.length);
  if (!S.seeds.length) { $("cards").innerHTML = `<div class="empty-cards">${S.isHost ? "Non hai cartelle: fai solo il banditore." : "Nessuna cartella."}</div>`; return; }
  $("cards").innerHTML = S.seeds.map((seed) => {
    const g = makeCard(seed); let rowMax = 0, hits = 0;
    g.forEach((r) => { const h = r.filter((n) => n != null && set.has(n)).length; rowMax = Math.max(rowMax, h); hits += h; });
    const cells = g.map((r) => r.map((n) => n == null ? '<div class="cell empty"></div>' : `<div class="cell num${set.has(n) ? " hit" : ""}${n === last ? " last" : ""}">${n}</div>`).join("")).join("");
    return `<div class="card"><div class="cardHead"><span>Cartella <b>${seed}</b></span><span>${hits}/15 · max ${rowMax} in riga</span></div><div class="grid">${cells}</div></div>`;
  }).join("");
}
function renderBanner() {
  const b = $("banner"), g = S.game; b.hidden = true; b.className = "banner";
  if (!g || !S.seeds.length || !g.drawn.length) return;
  const idx = idxOf(g.drawn), won = [], pending = [];
  for (const P of PRIZES) {
    const pr = g.prizes[P.k];
    for (const s of S.seeds) {
      const at = reachAt(makeCard(s), idx, P.n); if (at === Infinity) continue;
      if (pr && pr.winners.some((w) => w.code === s)) { won.push(P.label); break; }
      if (!pr || at <= pr.at) { pending.push({ P, s, tie: !!pr }); break; }
    }
  }
  if (pending.length) {
    const x = pending[pending.length - 1]; b.hidden = false;
    b.innerHTML = `${x.tie ? "Anche tu hai fatto" : "Hai fatto"} ${x.P.label.toUpperCase()}! 🎉<small>Cartella ${x.s}. Se il premio non ti viene assegnato tra poco, avvisa il banditore con questo codice.</small>`;
  } else if (won.length) { b.hidden = false; b.classList.add("win"); b.innerHTML = `Hai vinto: ${esc([...new Set(won)].join(", "))}! 🏆`; }
}
function updateCtl() {
  const g = S.game, busy = S.pending || !S.connected, over = !!(g && g.prizes.tombola);
  $("drawBtn").disabled = !g || busy || over || (g && g.drawn.length >= 90);
  $("drawBtn").textContent = over ? "Tombola fatta!" : "Estrai numero";
  $("undoBtn").disabled = !g || busy || !g.drawn.length;
  $("newBtn").disabled = !g || busy;
  $("autoChk").disabled = !g || !S.connected || over;
}
function renderPeople() {
  const el = $("people");
  const ps = [...S.players].sort((a, b) => (b.host - a.host) || (b.online - a.online) || a.name.localeCompare(b.name));
  el.innerHTML = ps.length ? ps.map((p) =>
    `<div class="person"><span><i class="dot${p.online ? " on" : ""}"></i>${p.host ? "🎙️ " : ""}${esc(p.name)}</span><span class="tag">${p.n} cartell${p.n === 1 ? "a" : "e"}</span></div>`
  ).join("") : '<p class="note">Ancora nessun giocatore.</p>';
}
function renderVerify() {
  const out = $("vOut"); if ($("verifyPanel").hidden) return;
  const code = $("vCode").value.trim().toUpperCase(), g = S.game;
  if (!code) { out.innerHTML = ""; return; }
  if (!SEED_RE.test(code)) { out.innerHTML = '<p class="note">Il codice della cartella ha 5 caratteri.</p>'; return; }
  const card = makeCard(code), set = new Set(g.drawn), idx = idxOf(g.drawn);
  const cells = card.map((r) => r.map((n) => n == null ? '<div class="cell empty"></div>' : `<div class="cell num${set.has(n) ? " hit" : ""}">${n}</div>`).join("")).join("");
  const btns = PRIZES.map((P) => {
    const at = reachAt(card, idx, P.n); if (at === Infinity) return "";
    const pr = g.prizes[P.k];
    if (pr && pr.winners.some((w) => w.code === code)) return `<span class="ok">✓ ${P.label} assegnato</span>`;
    if (pr && at > pr.at) return "";
    return `<button class="btn green sm" data-award="${P.k}">${pr ? "Aggiungi a pari merito: " : "Assegna "}${P.label}</button>`;
  }).join("");
  out.innerHTML = `<div class="card"><div class="cardHead"><span>Cartella <b>${code}</b></span></div><div class="grid">${cells}</div></div><div class="ctlRow">${btns || '<span class="note">Nessun premio da assegnare per questa cartella.</span>'}</div>`;
}

/* ===== eventi ===== */
$("drawBtn").onclick = () => hostCmd({ t: "draw" });
$("autoChk").onchange = (e) => send({ t: "auto", sec: e.target.checked ? Number($("autoSec").value) : 0 });
$("autoSec").onchange = () => { if ($("autoChk").checked) send({ t: "auto", sec: Number($("autoSec").value) }); };
$("undoBtn").onclick = () => hostCmd({ t: "undo" });
$("newBtn").onclick = () => { $("confirmNew").hidden = false; };
$("newNo").onclick = () => { $("confirmNew").hidden = true; };
$("newYes").onclick = () => { $("confirmNew").hidden = true; hostCmd({ t: "new" }); };
$("leaveBtn").onclick = leaveGame;
$("copyBtn").onclick = async () => {
  try { await navigator.clipboard.writeText(shareUrl()); toast("Link copiato!"); }
  catch { toast("Copia non riuscita: tieni premuto sul link per copiarlo."); }
};
$("vCode").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); renderVerify(); });
$("vOut").addEventListener("click", (e) => {
  const b = e.target.closest("[data-award]"); if (!b) return;
  const name = clean($("vName").value); if (!name) return toast("Scrivi il nome del giocatore.");
  send({ t: "award", k: b.dataset.award, code: $("vCode").value.trim().toUpperCase(), name });
});
$("voiceBtn").onclick = () => { S.voice = !S.voice; renderAll(); if (S.voice) speak(S.game && S.game.drawn.length ? S.game.drawn[S.game.drawn.length - 1] : "Voce attiva"); };
$("rerollBtn").onclick = () => {
  S.seeds = genSeeds(S.seeds.length);
  const L = LS.get("tombola:g:" + S.code) || {}; LS.set("tombola:g:" + S.code, { ...L, seeds: S.seeds });
  send({ t: "seeds", seeds: S.seeds, name: S.name }); renderAll(); toast("Cartelle nuove!");
};

/* ===== avvio ===== */
initLobby();
const h0 = (location.hash || "").slice(1).toUpperCase();
if (CODE_RE.test(h0) && LS.get("tombola:g:" + h0)) enterGame(h0);

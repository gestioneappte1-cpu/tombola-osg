import { DurableObject } from "cloudflare:workers";
import { PRIZES, CODE_RE, SEED_RE, randInt, randCode, makeCard, reachAt, idxOf, awardPrizes, clean } from "../public/core.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const MAX_PLAYERS = 300;
const PID_RE = /^[A-Za-z0-9]{8,32}$/;
const GAME_TTL_MS = 3 * 24 * 3600 * 1000; // le partite inattive si cancellano dopo 3 giorni

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/api/create" && req.method === "POST") {
      for (let i = 0; i < 8; i++) {
        const code = randCode(4);
        const stub = env.GAME.get(env.GAME.idFromName(code));
        const r = await stub.fetch("https://game/init", { method: "POST", body: JSON.stringify({ code }) });
        if (r.status === 200) return json(await r.json());
      }
      return json({ error: "busy" }, 503);
    }

    const m = url.pathname.match(/^\/ws\/([A-Z0-9]{4})$/);
    if (m && CODE_RE.test(m[1])) {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      const stub = env.GAME.get(env.GAME.idFromName(m[1]));
      return stub.fetch(req);
    }

    return env.ASSETS.fetch(req);
  },
};

export class Game extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.game = null;
    ctx.blockConcurrencyWhile(async () => {
      this.game = (await ctx.storage.get("game")) || null;
    });
  }

  async save() {
    this.game.touchedAt = Date.now();
    await this.ctx.storage.put("game", this.game);
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/init") {
      if (this.game) return new Response("exists", { status: 409 });
      const { code } = await req.json();
      const hostToken = randCode(12) + randCode(12);
      this.game = { code, hostToken, round: 1, drawn: [], prizes: {}, status: "attesa", autoSec: 0, players: {}, createdAt: Date.now() };
      await this.save();
      await this.scheduleAlarm();
      return json({ code, hostToken });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid: null, host: false });
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  publicState(isHost) {
    const g = this.game;
    const online = new Set();
    let sockets = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== 1) continue;
      const a = ws.deserializeAttachment() || {};
      sockets++;
      if (a.pid) online.add(a.pid);
    }
    const players = Object.entries(g.players).map(([pid, p]) => ({
      name: p.name, n: p.seeds.length, host: !!p.host, online: online.has(pid),
    }));
    return {
      t: "state",
      isHost,
      game: { code: g.code, round: g.round, drawn: g.drawn, prizes: g.prizes, status: g.status, autoSec: g.autoSec },
      players,
      online: sockets,
    };
  }

  broadcast(except) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment() || {};
      this.send(ws, this.publicState(!!a.host));
    }
  }

  candidates() {
    return Object.entries(this.game.players)
      .filter(([, p]) => p.seeds.length)
      .map(([pid, p]) => ({ key: pid, name: p.name, seeds: p.seeds }));
  }

  /* assegna i premi automaticamente, salva e invia lo stato a tutti */
  async commit() {
    const g = this.game;
    if (g.drawn.length && !g.prizes.tombola) {
      const np = awardPrizes(g.drawn, g.prizes, this.candidates());
      if (np !== g.prizes) g.prizes = np;
    }
    g.status = g.prizes.tombola ? "finita" : g.drawn.length ? "in corso" : "attesa";
    if (g.prizes.tombola) g.autoSec = 0;
    await this.save();
    this.broadcast();
  }

  drawOne() {
    const g = this.game;
    if (g.prizes.tombola) return false;
    const left = [];
    for (let n = 1; n <= 90; n++) if (!g.drawn.includes(n)) left.push(n);
    if (!left.length) return false;
    g.drawn = [...g.drawn, left[randInt(left.length)]];
    return true;
  }

  async scheduleAlarm() {
    const g = this.game;
    const next = g && g.autoSec ? Date.now() + g.autoSec * 1000 : Date.now() + GAME_TTL_MS;
    await this.ctx.storage.setAlarm(next);
  }

  async alarm() {
    const g = this.game;
    if (!g) return;
    if (g.autoSec) {
      if (this.drawOne()) await this.commit();
      else { g.autoSec = 0; await this.commit(); }
      await this.scheduleAlarm();
      return;
    }
    // pulizia delle partite abbandonate
    if (Date.now() - (g.touchedAt || 0) > GAME_TTL_MS && this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      this.game = null;
    } else {
      await this.scheduleAlarm();
    }
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 4000) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== "object") return;
    const g = this.game;
    if (!g) return this.send(ws, { t: "error", code: "notfound" });
    const att = ws.deserializeAttachment() || {};

    if (m.t === "hello") {
      att.host = typeof m.hostToken === "string" && m.hostToken === g.hostToken;
      att.pid = typeof m.pid === "string" && PID_RE.test(m.pid) ? m.pid : null;
      ws.serializeAttachment(att);
      if (att.pid) {
        const seeds = validSeeds(m.seeds);
        const name = clean(m.name) || (att.host ? "Banditore" : "Giocatore");
        const p = g.players[att.pid];
        if (p) {
          p.name = name;
          p.host = att.host;
          if (!g.drawn.length) p.seeds = seeds; // le cartelle si cambiano solo prima del primo numero
        } else if (seeds.length) {
          if (Object.keys(g.players).length >= MAX_PLAYERS) this.send(ws, { t: "error", code: "full" });
          else g.players[att.pid] = { name, seeds, host: att.host };
        }
      }
      await this.commit();
      return;
    }

    if (m.t === "seeds") {
      const p = att.pid && g.players[att.pid];
      if (g.drawn.length) return this.send(ws, { t: "error", code: "started" });
      const seeds = validSeeds(m.seeds);
      if (p) p.seeds = seeds;
      else if (att.pid && seeds.length) g.players[att.pid] = { name: clean(m.name) || "Giocatore", seeds, host: att.host };
      await this.commit();
      return;
    }

    // da qui in poi solo il banditore
    if (!att.host) return this.send(ws, { t: "error", code: "forbidden" });

    switch (m.t) {
      case "draw":
        if (this.drawOne()) await this.commit();
        break;
      case "undo": {
        if (!g.drawn.length) break;
        g.drawn = g.drawn.slice(0, -1);
        const kept = {};
        for (const k in g.prizes) if (g.prizes[k].at < g.drawn.length) kept[k] = g.prizes[k];
        g.prizes = kept;
        await this.commit();
        break;
      }
      case "new":
        g.round += 1; g.drawn = []; g.prizes = {}; g.autoSec = 0;
        await this.commit();
        await this.scheduleAlarm();
        break;
      case "auto": {
        const sec = Number(m.sec);
        g.autoSec = [5, 8, 12, 20].includes(sec) && !g.prizes.tombola ? sec : 0;
        if (g.autoSec && this.drawOne()) await this.commit();
        else await this.commit();
        await this.scheduleAlarm();
        break;
      }
      case "award": {
        const P = PRIZES.find((x) => x.k === m.k);
        const code = String(m.code || "").toUpperCase();
        const name = clean(m.name);
        if (!P || !SEED_RE.test(code) || !name) break;
        const at = reachAt(makeCard(code), idxOf(g.drawn), P.n);
        if (at === Infinity) break;
        const pr = g.prizes[P.k];
        if (!pr) g.prizes = { ...g.prizes, [P.k]: { at, winners: [{ name, code }] } };
        else if (at <= pr.at && !pr.winners.some((w) => w.code === code)) pr.winners.push({ name, code });
        await this.commit();
        break;
      }
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch {}
    this.broadcast(ws);
  }

  async webSocketError(ws) {
    this.broadcast(ws);
  }
}

function validSeeds(s) {
  if (!Array.isArray(s)) return [];
  return [...new Set(s.filter((x) => typeof x === "string" && SEED_RE.test(x)))].slice(0, 6);
}

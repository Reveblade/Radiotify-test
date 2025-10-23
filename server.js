import express from "express";
import fetch from "node-fetch";
import http from "http";
import path from "path";
import querystring from "querystring";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { Server as SocketIOServer } from "socket.io";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// !!! PROD'da .env kullanılmalı
const CLIENT_ID = "6cc17458211a4aaa8bb64a875b0d0da2";
const CLIENT_SECRET = "5abd1bccdeed4778abe5b1beed877305";
const REDIRECT_URI = "http://127.0.0.1:3000/callback";

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: "*" } });

app.use(express.static("public"));
app.use(express.json());

let accessToken = null;
let refreshToken = null;
let tokenExpiresAt = 0;
let lastTrackId = null;
let autoCheckerStarted = false;
let lastBroadcast = null;

// ---------- Token yenileme ----------
async function refreshAccessTokenIfNeeded() {
  const now = Date.now();
  if (accessToken && now < tokenExpiresAt - 30000) return;
  if (!refreshToken) return;

  const body = querystring.stringify({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();

  if (data.access_token) {
    accessToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    console.log("🔄 Token yenilendi.");
  } else {
    console.error("⚠️ Token yenilenemedi:", data);
  }
}

async function spotifyFetch(url, init = {}) {
  await refreshAccessTokenIfNeeded();
  const headers = {
    ...(init.headers || {}),
    Authorization: `Bearer ${accessToken}`,
  };
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    await refreshAccessTokenIfNeeded();
    return fetch(url, { ...init, headers: { ...headers, Authorization: `Bearer ${accessToken}` } });
  }
  return res;
}

// ---------- OAuth ----------
app.get("/login", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  const scope = [
    "user-read-playback-state",
    "user-modify-playback-state",
    "streaming",
    "user-read-private",
    "playlist-read-private",
  ].join(" ");

  const authUrl =
    "https://accounts.spotify.com/authorize?" +
    querystring.stringify({
      response_type: "code",
      client_id: CLIENT_ID,
      scope,
      redirect_uri: REDIRECT_URI,
      state,
    });

  res.redirect(authUrl);
});

app.get("/callback", async (req, res) => {
  const code = req.query.code;
  const body = querystring.stringify({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokenJson = await tokenRes.json();

  if (!tokenJson.access_token) {
    console.error("❌ OAuth başarısız:", tokenJson);
    return res.status(500).send("OAuth başarısız");
  }

  accessToken = tokenJson.access_token;
  refreshToken = tokenJson.refresh_token || refreshToken;
  tokenExpiresAt = Date.now() + (tokenJson.expires_in ?? 3600) * 1000;

  console.log("✅ Spotify giriş başarılı.");
  res.sendFile(path.join(__dirname, "public", "host.html"));

  if (!autoCheckerStarted) startAutoChecker();
});

// ---------- Listener token exchange ----------
app.post("/exchange_token", async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Code yok" });

    const scope = [
      "user-read-playback-state",
      "user-modify-playback-state",
      "streaming",
      "user-read-private",
      "playlist-read-private"
    ].join(" ");

    const body = querystring.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://127.0.0.1:3000/listener.html",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope
    });

    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await tokenRes.json();
    if (!data.access_token) return res.status(400).json({ error: data });
    console.log("🎟️ Listener token exchange başarılı.");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Auto Checker ----------
function startAutoChecker() {
  autoCheckerStarted = true;
  setInterval(async () => {
    try {
      const r = await spotifyFetch("https://api.spotify.com/v1/me/player");
      if (r.status === 204) return;
      const j = await r.json();
      if (!j?.item) return;

      const payload = {
        item: {
          name: j.item.name,
          artists: j.item.artists.map(a => a.name),
          duration_ms: j.item.duration_ms,
          uri: j.item.uri,
        },
        progress_ms: j.progress_ms ?? 0,
        is_playing: !!j.is_playing,
        server_sent_at: Date.now(),
      };

      if (j.item.id !== lastTrackId) {
        lastTrackId = j.item.id;
        console.log(`🎵 Yeni şarkı: ${j.item.name} — ${j.item.artists.map(a => a.name).join(", ")}`);
      }

      lastBroadcast = payload;
      io.emit("track_update", payload);
    } catch (e) {
      console.error("⚠️ Auto-check hata:", e.message);
    }
  }, 3000);
}

// ---------- Socket.io ----------
io.on("connection", (socket) => {
  console.log("🔌 Listener bağlandı:", socket.id);
  if (lastBroadcast) socket.emit("track_update", lastBroadcast);

  // listener -> cihaz listesini server'dan isteyebilir
  socket.on("get_devices", async (_, cb) => {
    try {
      const r = await spotifyFetch("https://api.spotify.com/v1/me/player/devices");
      const j = await r.json();
      cb(j.devices || []);
    } catch (e) {
      console.error("get_devices hata:", e);
      cb([]);
    }
  });

  // listener ayrıldığında logla
  socket.on("disconnect", () => console.log("❌ Listener ayrıldı:", socket.id));
});


// ---------- Cihazlar & Kontroller ----------
app.get("/devices", async (req, res) => {
  try {
    const r = await spotifyFetch("https://api.spotify.com/v1/me/player/devices");
    const j = await r.json();
    res.json({ devices: j?.devices || [] });
  } catch (e) {
    console.error("devices error:", e);
    res.status(500).json({ error: "Cihazlar alınamadı" });
  }
});

app.post("/transfer", async (req, res) => {
  try {
    const { device_id, play = true } = req.body || {};
    if (!device_id) return res.status(400).json({ error: "device_id gerekli" });

    const r = await spotifyFetch("https://api.spotify.com/v1/me/player", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_ids: [device_id], play }),
    });

    if (!r.ok) {
      const t = await r.text();
      console.error("transfer error:", t);
      return res.status(r.status).send(t);
    }

    console.log(`🔌 Playback ${device_id} cihazına aktarıldı.`);
    res.sendStatus(204);
  } catch (e) {
    console.error("transfer error:", e);
    res.status(500).send("Transfer başarısız");
  }
});

// ---------- Playback ----------
app.get("/checkMixState", async (req, res) => {
  try {
    const r = await spotifyFetch("https://api.spotify.com/v1/me/player");
    if (r.status === 204) {
      const payload = {
        isPlaying: false,
        reason: "Aktif cihaz yok.",
        server_sent_at: Date.now(),
      };
      lastBroadcast = payload;
      io.emit("track_update", payload);
      return res.json(payload);
    }

    const j = await r.json();
    const payload = {
      isPlaying: !!j?.is_playing,
      currentTrack: j?.item?.name || null,
      artist: j?.item?.artists?.map(a => a.name).join(", ") || null,
      progressMs: j?.progress_ms ?? 0,
      durationMs: j?.item?.duration_ms ?? 0,
      server_sent_at: Date.now(),
    };

    lastBroadcast = payload;
    io.emit("track_update", payload);
    res.json(payload);
  } catch (e) {
    console.error("/checkMixState error:", e);
    res.status(500).json({ error: "Durum alınamadı" });
  }
});

// ---------- Basic Playback Controls ----------
app.post("/playback/pause", async (_, res) => {
  await spotifyFetch("https://api.spotify.com/v1/me/player/pause", { method: "PUT" });
  console.log("⏸️ Duraklatıldı."); res.sendStatus(204);
});
app.post("/playback/resume", async (_, res) => {
  await spotifyFetch("https://api.spotify.com/v1/me/player/play", { method: "PUT" });
  console.log("▶️ Devam ettirildi."); res.sendStatus(204);
});
app.post("/playback/seekForward", async (_, res) => {
  const r = await spotifyFetch("https://api.spotify.com/v1/me/player");
  const j = await r.json();
  if (!j?.item) return res.status(400).send("Parça yok");
  let target = (j.progress_ms ?? 0) + 30000;
  const end = (j.item.duration_ms ?? 0) - 1000;
  if (target >= end) {
    await spotifyFetch("https://api.spotify.com/v1/me/player/next", { method: "POST" });
    console.log("⏭️ Sonraki şarkı."); return res.sendStatus(204);
  }
  await spotifyFetch(`https://api.spotify.com/v1/me/player/seek?position_ms=${target}`, { method: "PUT" });
  console.log(`⏩ +30s (${target} ms).`); res.sendStatus(204);
});
app.post("/playback/seekBackward", async (_, res) => {
  const r = await spotifyFetch("https://api.spotify.com/v1/me/player");
  const j = await r.json();
  if (!j?.item) return res.status(400).send("Parça yok");
  const target = Math.max((j.progress_ms ?? 0) - 30000, 0);
  await spotifyFetch(`https://api.spotify.com/v1/me/player/seek?position_ms=${target}`, { method: "PUT" });
  console.log(`⏪ -30s (${target} ms).`); res.sendStatus(204);
});
app.post("/next", async (_, res) => { await spotifyFetch("https://api.spotify.com/v1/me/player/next", { method: "POST" }); res.sendStatus(204); });
app.post("/previous", async (_, res) => { await spotifyFetch("https://api.spotify.com/v1/me/player/previous", { method: "POST" }); res.sendStatus(204); });

app.get("/", (_, res) => res.redirect("/host.html"));

server.listen(3000, () => console.log("🚀 Radiotify Host aktif — http://127.0.0.1:3000/login"));

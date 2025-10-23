// Radiotify Jam Queue Rotation System v1
// Author: Mert Yıldız (Radiotify)

import express from "express";
import fetch from "node-fetch";
import http from "http";
import querystring from "querystring";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { Server as SocketIOServer } from "socket.io";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_ID = "6cc17458211a4aaa8bb64a875b0d0da2";
const CLIENT_SECRET = "5abd1bccdeed4778abe5b1beed877305";
const REDIRECT_URI = "http://127.0.0.1:3000/callback";

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: "*" } });

app.use(express.static("public"));
app.use(express.json());

// Spotify Token Vars
let accessToken = null;
let refreshToken = null;
let tokenExpiresAt = 0;

// Radiotify Config
const PRIVATE_PLAYLIST_ID = "7aXbThVjGu2UEsy3Htxhvb"; // senin gizli playlist'in
const PUBLIC_PLAYLIST_ID = "3rguvxYnBaifQJw4BJJVWy";   // mix aktif public playlist
const REPEAT_COUNT = 20; // queue'ya kaç kez eklenecek
let queueCounter = 0;
let lastTrackId = null;
let privatePlaylistUris = [];

// ---------- Helper Functions ----------
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
    console.error("⚠️ Token yenileme hatası:", data);
  }
}

async function spotifyFetch(url, init = {}) {
  await refreshAccessTokenIfNeeded();
  const headers = {
    ...(init.headers || {}),
    Authorization: `Bearer ${accessToken}`,
  };
  return fetch(url, { ...init, headers });
}

// ---------- Auth Flow ----------
app.get("/login", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  const scope = [
    "user-read-playback-state",
    "user-modify-playback-state",
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
  console.log("✅ Spotify bağlantısı tamamlandı.");

  res.sendFile(path.join(__dirname, "public", "index.html"));
  await loadPrivatePlaylist();
  await fillQueue();
  startPlaybackWatcher();
});

// ---------- Spotify Operations ----------
async function loadPrivatePlaylist() {
  console.log("📥 Gizli playlist yükleniyor...");
  const res = await spotifyFetch(
    `https://api.spotify.com/v1/playlists/${PRIVATE_PLAYLIST_ID}/tracks`
  );
  const data = await res.json();
  privatePlaylistUris = data.items.map((item) => item.track.uri);
  console.log(`🎶 ${privatePlaylistUris.length} şarkı alındı (private).`);
}

async function addTrackToQueue(uri) {
  const res = await spotifyFetch(
    `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`,
    { method: "POST" }
  );
  if (res.ok) return true;
  console.warn("⚠️ Queue ekleme hatası:", res.status);
  return false;
}

async function fillQueue() {
  console.log(`🧱 Queue dolduruluyor (${REPEAT_COUNT}x)...`);
  queueCounter = 0;
  for (let i = 0; i < REPEAT_COUNT; i++) {
    for (const uri of privatePlaylistUris) {
      await addTrackToQueue(uri);
      queueCounter++;
      await new Promise((r) => setTimeout(r, 250)); // rate limit
    }
  }
  console.log(`✅ ${queueCounter} şarkı queue'ya eklendi.`);
}

// ---------- Playback Watcher ----------
async function getPlaybackState() {
  const res = await spotifyFetch("https://api.spotify.com/v1/me/player/currently-playing");
  if (!res.ok) return null;
  return await res.json();
}

function startPlaybackWatcher() {
  console.log("👂 Playback watcher başlatıldı...");
  setInterval(async () => {
    const data = await getPlaybackState();
    if (!data?.item) return;

    const currentId = data.item.id;
    if (lastTrackId && currentId !== lastTrackId) {
      queueCounter--;
      io.emit("queue_counter_update", { remaining: queueCounter });
      console.log(`🎵 Yeni şarkı başladı (${data.item.name}) | Kalan: ${queueCounter}`);

      if (queueCounter <= 0) {
        console.log("🛑 Queue sıfırlandı — Jam sona erdi, yeni Jam hazırlanıyor...");
        io.emit("jam_expired");
        await restartJamCycle();
      }
    }
    lastTrackId = currentId;
  }, 10000);
}

async function restartJamCycle() {
  console.log("♻️ Yeni Jam hazırlığı başlıyor...");
  // Playback'i durdur
  await spotifyFetch("https://api.spotify.com/v1/me/player/pause", { method: "PUT" });
  // Yeni queue doldur
  await fillQueue();
  // Host’a yeni Jam linkini oluşturması için bilgi ver
  console.log("✅ Yeni Jam oluşturulmaya hazır (manuel adım).");
  io.emit("jam_ready_for_restart");
}

// ---------- Socket ----------
io.on("connection", (socket) => {
  console.log("🔌 Yeni client bağlandı:", socket.id);
  socket.emit("status", { connected: true });
});

// ---------- Routes ----------
app.get("/", (_, res) => res.redirect("/login"));

// ---------- Start Server ----------
server.listen(3000, () => {
  console.log("🚀 Radiotify Jam Queue System aktif: http://127.0.0.1:3000/login");
});

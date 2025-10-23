// server.js — Radiotify Mix Kontrol (Spotify App üzerinden)
import express from "express";
import fetch from "node-fetch";
import http from "http";
import path from "path";
import querystring from "querystring";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_ID = "6cc17458211a4aaa8bb64a875b0d0da2";
const CLIENT_SECRET = "5abd1bccdeed4778abe5b1beed877305";
const REDIRECT_URI = "http://127.0.0.1:3000/callback";

// 🎵 Test etmek istediğin Mix playlist
const MIX_PLAYLIST_URI = "spotify:playlist:7IwTBQ60J3dWD4R1sjjWQF";

const app = express();
const server = http.createServer(app);

app.use(express.static("public"));
app.use(express.json());

let accessToken = null;
let refreshToken = null;
let tokenExpiresAt = 0;
let chosenDeviceId = null;

// ------------------ yardımcılar ------------------
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

  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json();
  if (j.access_token) {
    accessToken = j.access_token;
    tokenExpiresAt = Date.now() + (j.expires_in ?? 3600) * 1000;
    console.log("🔄 Access token yenilendi.");
  } else {
    console.error("⚠️ Token yenileme hatası:", j);
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
    return fetch(url, {
      ...init,
      headers: { ...headers, Authorization: `Bearer ${accessToken}` },
    });
  }
  return res;
}

// ------------------ OAuth ------------------
app.get("/login", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  const scope =
    "user-read-playback-state user-modify-playback-state streaming user-read-private playlist-read-private";
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
    console.error("Token hatası:", tokenJson);
    return res.status(500).send("OAuth başarısız");
  }

  accessToken = tokenJson.access_token;
  refreshToken = tokenJson.refresh_token || refreshToken;
  tokenExpiresAt = Date.now() + (tokenJson.expires_in ?? 3600) * 1000;

  console.log("✅ Giriş başarılı. Access token alındı.");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ------------------ Spotify API ------------------

// Cihaz listesi
app.get("/devices", async (req, res) => {
  try {
    const r = await spotifyFetch("https://api.spotify.com/v1/me/player/devices");
    const j = await r.json();
    res.json(j);
  } catch (e) {
    console.error(e);
    res.status(500).send("Cihazlar alınamadı");
  }
});

// Cihaz seç
app.post("/chooseDevice", async (req, res) => {
  chosenDeviceId = req.body.device_id;
  if (!chosenDeviceId) return res.status(400).send("device_id gerekli");
  res.sendStatus(204);
});

// Mix playlisti çal
app.post("/playMix", async (req, res) => {
  if (!chosenDeviceId) return res.status(400).send("Önce cihaz seçin");
  try {
    // 1️⃣ playback'i seçilen cihaza transfer et
    await spotifyFetch("https://api.spotify.com/v1/me/player", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_ids: [chosenDeviceId], play: true }),
    });

    await new Promise((r) => setTimeout(r, 1000)); // 1sn bekle

    // 2️⃣ playlisti çal
    await spotifyFetch("https://api.spotify.com/v1/me/player/play", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context_uri: MIX_PLAYLIST_URI }),
    });

    console.log("▶️ Mix playlist başlatıldı.");
    res.sendStatus(204);
  } catch (e) {
    console.error("playMix error:", e);
    res.status(500).send("playMix başarısız");
  }
});

// 30 saniye ileri sar
app.post("/seekForward", async (req, res) => {
  try {
    const stateRes = await spotifyFetch("https://api.spotify.com/v1/me/player");
    const state = await stateRes.json();
    if (!state?.item) return res.status(400).send("Çalan parça yok");

    const current = state.progress_ms ?? 0;
    const target = Math.min(state.item.duration_ms - 1000, current + 30000);

    await spotifyFetch(
      `https://api.spotify.com/v1/me/player/seek?position_ms=${target}`,
      { method: "PUT" }
    );

    console.log(`⏩ 30 saniye ileri sarıldı (${target} ms).`);
    res.sendStatus(204);
  } catch (e) {
    console.error("seekForward error:", e);
    res.status(500).send("seekForward başarısız");
  }
});

app.get("/", (req, res) => res.redirect("/index.html"));

server.listen(3000, () => {
  console.log("🚀 3000 portu açık — http://127.0.0.1:3000/login");
});

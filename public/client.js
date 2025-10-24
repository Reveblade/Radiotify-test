// client.js — Radiotify Listener Logic v2 (auto-refresh + active device highlight)
/* global io */

// === Config ===
const API_BASE = "http://127.0.0.1:3000";
const CLIENT_ID = "6cc17458211a4aaa8bb64a875b0d0da2";
const REDIRECT_URI = API_BASE + "/listener.html";
const SCOPES = [
  "user-read-private",
  "user-read-email",
  "user-read-playback-state",
  "user-modify-playback-state",
  "streaming"
];

// === Auth Helpers ===
function getAccessToken() {
  const token = localStorage.getItem("listener_token");
  const exp = Number(localStorage.getItem("listener_token_exp") || 0);
  if (token && Date.now() < exp) return token;
  return null;
}

async function exchangeCodeForToken(code) {
  const res = await fetch(`${API_BASE}/exchange_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code })
  });
  const data = await res.json();
  if (data.access_token) {
    const expAt = Date.now() + (data.expires_in || 3600) * 1000;
    localStorage.setItem("listener_token", data.access_token);
    localStorage.setItem("listener_token_exp", String(expAt));
    return data.access_token;
  }
  throw new Error("Token alınamadı: " + JSON.stringify(data));
}

export async function ensureAuth() {
  const params = new URLSearchParams(window.location.search);
  if (params.has("code")) {
    const code = params.get("code");
    const token = await exchangeCodeForToken(code);
    window.history.replaceState({}, "", window.location.pathname);
    return token;
  }
  let token = getAccessToken();
  if (!token) {
    const url = new URL("https://accounts.spotify.com/authorize");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("scope", SCOPES.join(" "));
    window.location.href = url.toString();
    return new Promise(() => {}); // redirect
  }
  return token;
}

// === Spotify yardımcıları ===
export async function getDevices(token) {
  const res = await fetch("https://api.spotify.com/v1/me/player/devices", {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.json();
}

export async function transferToDevice(token, deviceId) {
  const res = await fetch("https://api.spotify.com/v1/me/player", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ device_ids: [deviceId], play: false })
  });
  if (!res.ok) console.warn("Transfer hatası", await res.text());
}

// === Socket bağlantısı ===
export function connectSocket(onUpdate, onMix) {
  const socket = io(API_BASE, { transports: ["websocket"] });
  socket.on("connect", () => console.log("🔌 Socket bağlandı"));
  socket.on("disconnect", () => console.log("❌ Socket koptu"));
  socket.on("track_update", (payload) => onUpdate?.(payload));
  socket.on("mix_transition", (payload) => onMix?.(payload));
  return socket;
}

// === Host'tan gelen playback senkronu ===
let lastSyncedUri = null;
let lastSyncedPos = 0;

export async function syncWithHost(payload, token) {
  if (!payload?.item?.uri) return;
  const { item, progress_ms, server_sent_at } = payload;
  const drift = Date.now() - (server_sent_at || Date.now());
  const hostPos = (progress_ms || 0) + drift;

  try {
    // listener'ın mevcut oynatıcısını sorgula
    const res = await fetch("https://api.spotify.com/v1/me/player", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      console.warn("⚠️ /me/player alınamadı:", await res.text());
      return;
    }

    const j = await res.json();
    const currentUri = j?.item?.uri;
    const currentPos = j?.progress_ms ?? 0;

    const diff = Math.abs(currentPos - hostPos);
    const threshold = 5000; // 5 saniye

    // 🎯 Şarkı aynı ve fark 5 sn'den küçükse => SYNC YAPMA
    if (currentUri === item.uri && diff < threshold) {
      console.log(
        `✅ Skip sync: ${item.name} (fark ${Math.round(diff / 1000)} sn)`
      );
      return;
    }

    // Şarkı değişti veya fark büyükse => SYNC ET
    console.log(
      `🔁 Sync: ${item.name} — fark ${Math.round(diff / 1000)} sn`
    );

    const devicesRes = await fetch(
      "https://api.spotify.com/v1/me/player/devices",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const devices = await devicesRes.json();
    const active = devices.devices?.find((d) => d.is_active);
    if (!active) {
      console.warn("⚠️ Aktif Spotify cihazı yok.");
      return;
    }

    // PLAYBACK'i güncelle
    const playRes = await fetch(
      `https://api.spotify.com/v1/me/player/play?device_id=${active.id}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          uris: [item.uri],
          position_ms: Math.floor(hostPos),
        }),
      }
    );

    if (!playRes.ok) {
      console.warn("❌ Play hata:", await playRes.text());
    } else {
      console.log(
        `▶️ Synced ${item.name} — ${Math.round(hostPos / 1000)} s`
      );
      lastSyncedUri = item.uri;
      lastSyncedPos = hostPos;
    }
  } catch (err) {
    console.error("syncWithHost hata:", err);
  }
}


// === Ek: Auto-refresh cihaz listesi ===
export async function connectAndRefresh(token, deviceId, onLog, onRefresh) {
  await transferToDevice(token, deviceId);
  onLog?.("🔗 Cihaza bağlanıldı, liste yenileniyor...");
  setTimeout(async () => {
    await onRefresh();
    onLog?.("🎛️ Cihaz listesi güncellendi.");
  }, 2000);
}

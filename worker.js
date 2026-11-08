// Carl's Personal Hub: login gate.
// Every request runs through here first. Nothing in public/ is served
// until the visitor has a valid session, which needs the password AND a
// 6-digit code from an authenticator app (TOTP, RFC 6238).
//
// Secrets (set in Cloudflare: personal-hub > Settings > Variables and Secrets):
//   HUB_PASSWORD  Carl's password, at least 10 characters.
//   TOTP_SECRET   Base32 authenticator secret. Leave unset on first run:
//                 after a correct password the site shows a QR code and the
//                 secret to save here.
// Optional binding: LOGIN_LIMITER (Workers rate limiting), see wrangler.toml.

const enc = new TextEncoder();
const PUBLIC_FILES = new Set(["/robots.txt", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png"]);
const COOKIE = "hub_session";
const SESSION_DAYS = 14;
const ISSUER = "Carl Jones Hub";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBackup(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // Not private: the browser fetches these to install the hub on a home screen.
    if (PUBLIC_FILES.has(url.pathname)) return env.ASSETS.fetch(request);

    if (!env.HUB_PASSWORD || env.HUB_PASSWORD.length < 10) {
      return html(notReadyPage(), 503);
    }

    if (url.pathname === "/logout") {
      return new Response(null, {
        status: 303,
        headers: { Location: "/", "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` },
      });
    }

    if (url.pathname === "/login" && request.method === "POST") {
      return handleLogin(request, env);
    }

    const authed = env.TOTP_SECRET && (await hasValidSession(request, env));

    if (url.pathname.startsWith("/api/")) {
      if (!authed) return json({ error: "Not logged in" }, 401);
      return handleApi(request, env, url);
    }

    if (authed) {
      const res = await env.ASSETS.fetch(request);
      const headers = new Headers(res.headers);
      headers.set("Cache-Control", "private, no-store");
      addSecurityHeaders(headers);
      return new Response(res.body, { status: res.status, headers });
    }

    return html(loginPage({ setup: !env.TOTP_SECRET }), 401);
  },
};

async function handleLogin(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (env.LOGIN_LIMITER) {
    const { success } = await env.LOGIN_LIMITER.limit({ key: "login:" + ip });
    if (!success) return html(loginPage({ setup: !env.TOTP_SECRET, error: "Too many tries. Wait a minute and try again." }), 429);
  }

  let form;
  try { form = await request.formData(); } catch { form = new FormData(); }
  const password = String(form.get("password") || "");
  const code = String(form.get("code") || "").replace(/\s+/g, "");

  const passwordOk = await safeEqual(password, env.HUB_PASSWORD);

  // First run: no authenticator yet. A correct password shows the setup screen, nothing else.
  if (!env.TOTP_SECRET) {
    if (!passwordOk) return html(loginPage({ setup: true, error: "Wrong password." }), 401);
    return html(setupPage(randomBase32(20)), 200);
  }

  const codeOk = /^\d{6}$/.test(code) && (await verifyTotp(env.TOTP_SECRET, code));
  if (!passwordOk || !codeOk) {
    return html(loginPage({ setup: false, error: "Password or code is wrong. Check both and try again." }), 401);
  }

  const cookie = await makeSession(env);
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": `${COOKIE}=${cookie}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Strict`,
    },
  });
}

// ---------- Sessions ----------
// Cookie = expiry.signature. The signing key comes from both secrets, so
// changing the password or the authenticator logs out every device.

async function sessionKey(env) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode("session|" + env.HUB_PASSWORD + "|" + env.TOTP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function makeSession(env) {
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400);
  const sig = await crypto.subtle.sign("HMAC", await sessionKey(env), enc.encode(exp));
  return exp + "." + b64url(new Uint8Array(sig));
}

async function hasValidSession(request, env) {
  const raw = getCookie(request.headers.get("Cookie") || "", COOKIE);
  if (!raw) return false;
  const [exp, sig] = raw.split(".");
  if (!/^\d+$/.test(exp || "") || !sig) return false;
  if (Number(exp) < Date.now() / 1000) return false;
  let sigBytes;
  try { sigBytes = fromB64url(sig); } catch { return false; }
  return crypto.subtle.verify("HMAC", await sessionKey(env), sigBytes, enc.encode(exp));
}

function getCookie(header, name) {
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// ---------- TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ----------

export async function totpAt(secretB32, counter) {
  const key = await crypto.subtle.importKey("raw", base32Decode(secretB32), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) { msg[i] = Number(c & 0xffn); c >>= 8n; }
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = h[h.length - 1] & 0xf;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 1000000).padStart(6, "0");
}

export async function verifyTotp(secretB32, code, now = Date.now()) {
  const counter = Math.floor(now / 1000 / 30);
  let ok = false;
  for (const d of [-1, 0, 1]) {
    if (await safeEqual(await totpAt(secretB32, counter + d), code)) ok = true;
  }
  return ok;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(s) {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

function randomBase32(bytes) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let bits = 0, value = 0, out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}


// ---------- Data API (D1) ----------
// One table. Each record belongs to a collection and holds its fields as JSON.
// Only reachable with a valid session (checked in fetch above).

const COLLECTIONS = new Set([
  "bills", "renewals", "dog_profile", "dog_tasks", "dog_log",
  "home_suppliers", "home_tasks", "home_trades", "home_log", "home_meters",
  "health_appts", "health_meds", "health_contacts",
  "travel_trips", "travel_docs",
  "cal_events",
  "cases", "case_log",
  "cars", "car_log",
]);
const MAX_BODY = 20000;
let schemaReady = false;

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, col TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS items_col ON items (col)"),
  ]);
  schemaReady = true;
}

export async function handleApi(request, env, url) {
  if (!env.DB) return json({ error: "Database not connected" }, 503);
  if (url.pathname === "/api/backup" && request.method === "GET") {
    await ensureSchema(env.DB);
    const body = JSON.stringify(await exportAll(env.DB), null, 1);
    const day = new Date().toISOString().slice(0, 10);
    const headers = new Headers({ "Content-Type": "application/json", "Content-Disposition": `attachment; filename="hub-backup-${day}.json"`, "Cache-Control": "no-store" });
    addSecurityHeaders(headers);
    return new Response(body, { headers });
  }
  const parts = url.pathname.split("/").filter(Boolean); // ["api", col, id?]
  const col = parts[1];
  const id = parts[2];
  if (!COLLECTIONS.has(col) || parts.length > 3) return json({ error: "Unknown list" }, 404);

  const method = request.method;
  if (method !== "GET") {
    // Writes must come from the hub's own pages.
    if (request.headers.get("X-Hub") !== "1") return json({ error: "Refused" }, 403);
  }

  await ensureSchema(env.DB);
  const now = new Date().toISOString();

  if (method === "GET" && !id) {
    const { results } = await env.DB.prepare("SELECT id, data, updated_at FROM items WHERE col = ? ORDER BY created_at").bind(col).all();
    return json(results.map((r) => ({ ...safeParse(r.data), id: r.id, updated_at: r.updated_at })));
  }

  if ((method === "POST" && !id) || (method === "PUT" && id)) {
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: "Too much data" }, 413);
    const body = safeParse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Bad data" }, 400);
    delete body.id; delete body.updated_at;
    const data = JSON.stringify(body);
    if (method === "POST") {
      const newId = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO items (id, col, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(newId, col, data, now, now).run();
      return json({ ...body, id: newId, updated_at: now }, 201);
    }
    const r = await env.DB.prepare("UPDATE items SET data = ?, updated_at = ? WHERE id = ? AND col = ?").bind(data, now, id, col).run();
    if (!r.meta || r.meta.changes === 0) return json({ error: "Not found" }, 404);
    return json({ ...body, id, updated_at: now });
  }

  if (method === "DELETE" && id) {
    await env.DB.prepare("DELETE FROM items WHERE id = ? AND col = ?").bind(id, col).run();
    return json({ ok: true });
  }

  return json({ error: "Not allowed" }, 405);
}

async function exportAll(db) {
  const { results } = await db.prepare("SELECT id, col, data, created_at, updated_at FROM items ORDER BY col, created_at").all();
  return { exported_at: new Date().toISOString(), count: results.length, items: results.map((r) => ({ ...r, data: safeParse(r.data) })) };
}

// Nightly backup to R2 (cron in wrangler.toml). Keeps the last 30 days.
export async function runBackup(env) {
  if (!env.DB || !env.BACKUPS) return "skipped";
  await ensureSchema(env.DB);
  const dump = await exportAll(env.DB);
  const key = "backup-" + dump.exported_at.slice(0, 10) + ".json";
  await env.BACKUPS.put(key, JSON.stringify(dump), { httpMetadata: { contentType: "application/json" } });
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const list = await env.BACKUPS.list({ prefix: "backup-" });
  const old = list.objects.map((o) => o.key).filter((k) => k.slice(7, 17) < cutoff);
  if (old.length) await env.BACKUPS.delete(old);
  return key;
}

function safeParse(t) { try { return JSON.parse(t); } catch { return null; } }

function json(obj, status = 200) {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  addSecurityHeaders(headers);
  return new Response(JSON.stringify(obj), { status, headers });
}

// ---------- Helpers ----------

async function safeEqual(a, b) {
  // Compare HMACs of both values so the time taken does not depend on where they differ.
  const k = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const [x, y] = await Promise.all([
    crypto.subtle.sign("HMAC", k, enc.encode(String(a))),
    crypto.subtle.sign("HMAC", k, enc.encode(String(b))),
  ]);
  const ax = new Uint8Array(x), by = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < ax.length; i++) diff |= ax[i] ^ by[i];
  return diff === 0;
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function addSecurityHeaders(h) {
  h.set("X-Frame-Options", "DENY");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Robots-Tag", "noindex, nofollow");
}

function html(body, status) {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  addSecurityHeaders(headers);
  return new Response(body, { status, headers });
}

// ---------- Pages ----------

const STYLE = `
:root{--head:#0f1217;--head-mid:#232a34;--copper:#f2a93b;--copper-light:#f6c271;--bg:#12161c;--paper:#1a2028;--ink:#eef1f4;--muted:#8a95a3;--line:#2a313b;--red:#ff7a6b;--redbg:rgba(239,91,76,.14);color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:radial-gradient(120% 60% at 50% 0%,#26303c 0%,#151a21 55%,#0f1217 100%) fixed,#0f1217;color:var(--ink);font-family:Inter,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased;display:grid;place-items:center;min-height:100vh;padding:24px max(16px,env(safe-area-inset-right,0px)) 24px max(16px,env(safe-area-inset-left,0px))}
.box{width:100%;max-width:380px;background:var(--paper);border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.45)}
.top{background:var(--head);padding:22px 24px;display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--line)}
.crest{width:44px;height:44px;border-radius:50%;border:2px solid var(--copper);background:var(--head-mid);display:grid;place-items:center;font-family:Saira,sans-serif;font-weight:700;color:var(--ink)}
.name{font-family:Saira,sans-serif;font-weight:700;color:#fff;letter-spacing:.3px}
.tag{font-size:11px;color:var(--copper);margin-top:2px;letter-spacing:1.5px;text-transform:uppercase;font-weight:600}
form,.body{padding:24px;display:grid;gap:14px}
label{display:grid;gap:6px;font-size:13px;font-weight:600;color:var(--muted)}
input{font:inherit;font-size:17px;padding:12px 14px;border-radius:10px;border:1.5px solid var(--line);background:var(--bg);color:var(--ink);width:100%}
input:focus{outline:none;border-color:var(--copper)}
#code{letter-spacing:6px;font-variant-numeric:tabular-nums}
button{font:inherit;font-weight:700;font-size:16px;padding:13px;border:0;border-radius:10px;background:var(--copper);color:#14171c;cursor:pointer}
button:hover{background:var(--copper-light)}
button:focus-visible{outline:3px solid var(--copper);outline-offset:2px}
.err{background:var(--redbg);color:var(--red);border-radius:8px;padding:10px 12px;font-size:14px}
p{margin:0;font-size:14px;line-height:1.5;color:var(--muted)}
ol{margin:0;padding-left:20px;font-size:14px;line-height:1.6}
.secret{font-family:ui-monospace,Menlo,monospace;font-size:15px;word-break:break-all;background:var(--bg);border:1px dashed var(--line);border-radius:8px;padding:10px 12px;user-select:all}
#qr{background:#fff;padding:12px;border-radius:8px;justify-self:center}
#qr img,#qr canvas{display:block}
`;

const HEAD = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=2"><link rel="icon" type="image/png" href="/icon-192.png?v=2"><meta name="theme-color" content="#151a21"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black"><meta name="apple-mobile-web-app-title" content="My Hub"><title>Carl Jones Hub</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Saira:wght@700&family=Inter:wght@400;600;700&display=swap"><style>${STYLE}</style></head><body><main class="box"><div class="top"><div class="crest">CJ</div><div><div class="name">CARL JONES</div><div class="tag">Personal Hub</div></div></div>`;
const FOOT = `</main></body></html>`;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function loginPage({ setup, error }) {
  return HEAD + `<form method="post" action="/login" autocomplete="on">
${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
${setup ? `<p>First-time setup. Enter your password to set up your authenticator app.</p>` : ""}
<label for="password">Password<input id="password" name="password" type="password" autocomplete="current-password" required autofocus></label>
${setup ? "" : `<label for="code">6-digit code from your authenticator app<input id="code" name="code" inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" autocomplete="one-time-code" required></label>`}
<button type="submit">${setup ? "Continue" : "Log in"}</button>
</form>` + FOOT;
}

function setupPage(secret) {
  const uri = `otpauth://totp/${encodeURIComponent(ISSUER)}:carl?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`;
  return HEAD + `<div class="body">
<p><b>Set up your authenticator app.</b> This screen only shows because no code is set yet.</p>
<ol>
<li>In Microsoft or Google Authenticator, add an account and scan this QR code. On the same phone, type in the key below instead.</li>
<li>In Cloudflare, open <b>personal-hub</b>, then <b>Settings</b>, then <b>Variables and Secrets</b>, then <b>Add</b>. Type: <b>Secret</b>. Name: <b>TOTP_SECRET</b>. Value: the key below.</li>
<li>Save, wait a few seconds, then reload this page and log in with your password and the 6-digit code.</li>
</ol>
<div id="qr" aria-label="QR code for your authenticator app"></div>
<div class="secret">${esc(secret)}</div>
<p>Do not share this key. If you reload before saving it, you get a new key. That's fine, just use the newest one in both places.</p>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>try{new QRCode(document.getElementById("qr"),{text:${JSON.stringify(uri)},width:200,height:200,correctLevel:QRCode.CorrectLevel.M})}catch(e){document.getElementById("qr").hidden=true}</script>` + FOOT;
}

function notReadyPage() {
  return HEAD + `<div class="body"><p><b>Locked.</b> The hub is waiting for its password to be set in Cloudflare (secret <b>HUB_PASSWORD</b>, at least 10 characters).</p></div>` + FOOT;
}

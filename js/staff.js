// Staff / User Management — local-first operator directory and session identity.
// Staff records are kept in IndexedDB so the POS can identify the operator offline.
// PINs are stored only as PBKDF2 hashes; plaintext PINs are never persisted.
import { idb } from "./data/idb.js";
import { getConfig, saveConfig } from "./data/backend.js";
import { uid } from "./data/logic.js";
import { $, esc, hydrateIcons, icon, openModal, toast, confirmDialog, setButtonBusy } from "./ui.js";

const KEY = "staff.users.v1";
const SESSION_KEY = "staff.session.v1";
const ITERATIONS = 120000;
const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const OFFLINE_AUTH_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const PIN_MAX_FAILED = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;
const DEVICE_KEY = "marvels.auth.device";
const LEGACY_DEVICE_KEY = ["fresh", "mart.auth.device"].join("");
const CRYPTO_KEY = "staff.crypto.key.v1";
const SERVER_SYNC_KEY = "staff.server-sync.pending.v1";
const SERVER_AUTH_COOLDOWN_KEY = "marvels.auth.server-cooldown.v1";
const LEGACY_SERVER_AUTH_COOLDOWN_KEY = ["fresh", "mart.auth.server-cooldown.v1"].join("");
const OFFLINE_AUTH_KEY = "marvels.auth.offline";
const LEGACY_OFFLINE_AUTH_KEY = ["fresh", "mart.auth.offline"].join("");

function migrateLegacyStaffKeys() {
  try {
    if (!localStorage.getItem(DEVICE_KEY) && localStorage.getItem(LEGACY_DEVICE_KEY)) {
      localStorage.setItem(DEVICE_KEY, localStorage.getItem(LEGACY_DEVICE_KEY));
    }
    if (!localStorage.getItem(SERVER_AUTH_COOLDOWN_KEY) && localStorage.getItem(LEGACY_SERVER_AUTH_COOLDOWN_KEY)) {
      localStorage.setItem(SERVER_AUTH_COOLDOWN_KEY, localStorage.getItem(LEGACY_SERVER_AUTH_COOLDOWN_KEY));
    }
    if (!sessionStorage.getItem(OFFLINE_AUTH_KEY) && sessionStorage.getItem(LEGACY_OFFLINE_AUTH_KEY)) {
      sessionStorage.setItem(OFFLINE_AUTH_KEY, sessionStorage.getItem(LEGACY_OFFLINE_AUTH_KEY));
    }
    localStorage.removeItem(LEGACY_DEVICE_KEY);
    localStorage.removeItem(LEGACY_SERVER_AUTH_COOLDOWN_KEY);
    sessionStorage.removeItem(LEGACY_OFFLINE_AUTH_KEY);
  } catch { /* Storage may be unavailable in restricted contexts. */ }
}
function clearOfflineAuthFlag() {
  try { sessionStorage.removeItem(OFFLINE_AUTH_KEY); } catch {}
  try { sessionStorage.removeItem(LEGACY_OFFLINE_AUTH_KEY); } catch {}
}
migrateLegacyStaffKeys();
let serverSyncTimer = null;

function localDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = "DEV-" + uid();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export const ROLES = {
  admin: {
    label: "Super Admin",
    description: "Full access including staff, settings and all operational controls.",
    permissions: ["pos","inventory","sales","customers","labels","procurement","returns","cashDrawer","closing","audit","lowStock","reports","loyalty","settings","staff"],
  },
  manager: {
    label: "Manager",
    description: "Operational management access; staff and system settings remain restricted.",
    permissions: ["pos","inventory","sales","customers","labels","procurement","returns","cashDrawer","closing","audit","lowStock","reports","loyalty"],
  },
  cashier: {
    label: "Cashier",
    description: "Sales-counter access with customer, invoice and loyalty functions.",
    permissions: ["pos","sales","customers","labels","loyalty"],
  },
};

let users = [];
let currentId = "";
let root = null;
let filter = "";
let statusFilter = "active";
let ready = null;

const now = () => new Date().toISOString();
const clean = (v, max = 120) => String(v ?? "").trim().slice(0, max);
const initials = name => clean(name, 60).split(/\s+/).filter(Boolean).slice(0,2).map(x => x[0]).join("").toUpperCase() || "?";
const normalizeRole = role => ROLES[role] ? role : "cashier";
const safeUser = u => ({ id: clean(u.id,80), name: clean(u.name,80), username: clean(u.username,60).toLowerCase(), phone: clean(u.phone,30), role: normalizeRole(u.role), active: u.active !== false, createdAt: u.createdAt || now(), updatedAt: u.updatedAt || now(), lastLoginAt: u.lastLoginAt || null, pinSalt: u.pinSalt || "", pinHash: u.pinHash || "", pinIterations: Number(u.pinIterations) || ITERATIONS, serverKnown: !!u.serverKnown, pendingDirectoryEdit: !!u.pendingDirectoryEdit, pendingPinChange: !!u.pendingPinChange, mustChangePin: !!u.mustChangePin, failedAttempts: Number(u.failedAttempts) || 0, lockedUntil: u.lockedUntil || null, lastOnlineAuthAt: u.lastOnlineAuthAt || null });

function bytesToB64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
function b64ToBytes(s) { const bin = atob(s); return Uint8Array.from(bin, c => c.charCodeAt(0)); }
function randomBytes(n=16) { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
async function hashPin(pin, saltBytes) {
  if (!globalThis.crypto?.subtle) throw new Error("Secure PIN hashing is not available in this browser.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name:"PBKDF2", salt:saltBytes, iterations:ITERATIONS, hash:"SHA-256" }, key, 256);
  return bytesToB64(bits);
}
export async function derivePinHash(pin, saltB64, iterations = ITERATIONS) {
  const salt = b64ToBytes(saltB64);
  if (!globalThis.crypto?.subtle) throw new Error("Secure PIN hashing is not available in this browser.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name:"PBKDF2", salt, iterations:Number(iterations)||ITERATIONS, hash:"SHA-256" }, key, 256);
  return bytesToB64(bits);
}
async function makePin(pin) {
  const salt = randomBytes();
  return { pinSalt: bytesToB64(salt), pinHash: await hashPin(pin, salt), pinIterations: ITERATIONS };
}
async function getPinVerifier(user, pin) {
  if (!user?.pinHash || !user.pinSalt) return "";
  return derivePinHash(pin, user.pinSalt, user.pinIterations || ITERATIONS);
}
async function verifyPin(user, pin) {
  const hash = await getPinVerifier(user, pin);
  return !!hash && hash === user.pinHash;
}

export function activeUsers() { return users.filter(u => u.active); }
function getUser(id) { return users.find(u => u.id === id) || null; }
export function currentStaff() { return getUser(currentId) || null; }
export function can(permission, user = currentStaff()) { return !!user && (ROLES[normalizeRole(user.role)]?.permissions || []).includes(permission); }
export function permissionLabel(role) { return ROLES[normalizeRole(role)]?.label || "Cashier"; }

async function getCryptoKey() {
  if (!globalThis.crypto?.subtle) throw new Error("Secure local credential storage is not available in this browser.");
  const existing = await idb.get(CRYPTO_KEY).catch(() => null);
  if (existing instanceof CryptoKey) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await idb.set(CRYPTO_KEY, key);
  return key;
}

async function encryptUsers(value) {
  const key = await getCryptoKey();
  const iv = randomBytes(12);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { encrypted: true, version: 1, iv: bytesToB64(iv), data: bytesToB64(ciphertext) };
}

async function decryptUsers(saved) {
  if (!saved) return [];
  if (!saved.encrypted) return Array.isArray(saved.users) ? saved.users : [];
  const key = await getCryptoKey();
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(saved.iv) }, key, b64ToBytes(saved.data));
  const value = JSON.parse(new TextDecoder().decode(plaintext));
  return Array.isArray(value?.users) ? value.users : [];
}

async function persist() {
  users = users.map(safeUser);
  await idb.set(KEY, await encryptUsers({ users }));
  window.dispatchEvent(new CustomEvent("staff:changed"));
}
async function persistSession() {
  await idb.set(SESSION_KEY, { userId: currentId, deviceId: localDeviceId(), signedInAt: now(), lastActivityAt: now() });
}
async function touchSession() {
  if (!currentId) return;
  const s = await idb.get(SESSION_KEY).catch(() => null);
  if (!s?.userId || s.userId !== currentId) return;
  await idb.set(SESSION_KEY, { ...s, lastActivityAt: now() });
}
function sessionValid(s) {
  if (!s?.userId) return false;
  const t = Date.now(), signed = new Date(s.signedInAt || s.at || 0).getTime(), idle = new Date(s.lastActivityAt || s.at || 0).getTime();
  return Number.isFinite(signed) && Number.isFinite(idle) && t - signed < SESSION_MAX_MS && t - idle < SESSION_IDLE_MS;
}

async function load() {
  const saved = await idb.get(KEY).catch(() => null);
  users = (await decryptUsers(saved).catch(() => [])).map(safeUser).filter(u => u.id && u.name && u.username);
  // Migrate away the legacy hard-coded bootstrap identity only when its known default
  // PIN verifier also matches. This prevents an old phantom "Anand Ibrahim" account
  // from surviving upgrades while avoiding deletion of unrelated real staff records.
  if (users.length === 1) {
    const legacy = users[0];
    if (legacy.name === "Anand Ibrahim" && legacy.username === "admin" && legacy.role === "admin" && legacy.mustChangePin) {
      const legacyPin = await getPinVerifier(legacy, "1234").catch(() => "");
      if (legacyPin && legacyPin === legacy.pinHash) {
        users = [];
        await idb.del(SESSION_KEY).catch(() => {});
        await idb.del(KEY).catch(() => {});
      }
    }
  }
  const session = await idb.get(SESSION_KEY).catch(() => null);
  currentId = sessionValid(session) && session.deviceId === localDeviceId() && getUser(session.userId)?.active ? session.userId : "";
  if (!currentId && session?.userId) await idb.del(SESSION_KEY).catch(() => {});
  // Never invent a privileged account when this browser has no local staff records.
  // Existing-store imports must authenticate against the Sheet's real staff directory;
  // a fresh installation creates its first Super Admin through the explicit installer.
  // In particular, never silently create a hard-coded "Anand Ibrahim" Super Admin.
  if (!users.length) currentId = "";
}

export async function initStaff() {
  if (!ready) ready = load();
  await ready;
  if (localStorage.getItem(SERVER_SYNC_KEY) && navigator.onLine) scheduleServerStaffSync();
  return currentStaff();
}

async function adoptServerStaff(serverUser, pin) {
  const existing=getUser(serverUser.id);
  // The successful server challenge derived this verifier from the PIN entered here.
  const verifier = serverUser.pinHash && serverUser.pinSalt ? { pinHash: serverUser.pinHash, pinSalt: serverUser.pinSalt, pinIterations: serverUser.pinIterations || ITERATIONS } : await makePin(String(pin));
  const user = safeUser({
    id: serverUser.id, name: serverUser.name, username: serverUser.username, phone: serverUser.phone || existing?.phone || "",
    role: serverUser.role, active: true, createdAt: existing?.createdAt || now(), updatedAt: now(), lastLoginAt: now(),
    ...verifier, serverKnown: true, lastOnlineAuthAt: now(), mustChangePin: !!serverUser.mustChangePin, failedAttempts: 0, lockedUntil: null
  });
  users = [user, ...users.filter((u) => u.id !== user.id && u.username !== user.username)];
  await persist();
  currentId = user.id;
  await persistSession();
  return user;
}

export async function provisionInitialAdmin({ id = "", name, username, phone = "", pin }) {
  await initStaff();
  if (!/^\d{4,12}$/.test(String(pin || ""))) throw new Error("Super Admin PIN must contain 4–12 digits.");
  const active = activeUsers();
  if (users.length > 1 || (active.length && !(users.length === 1 && users[0].role === "admin" && users[0].name === "Anand Ibrahim"))) {
    throw new Error("This device already has staff accounts. Installation cannot replace them.");
  }
  const target = users[0] || { id: id || uid() };
  const verifier = await makePin(String(pin));
  Object.assign(target, {
    id: id || target.id, name: clean(name,80), username: clean(username,60).toLowerCase(), phone: clean(phone,30),
    role: "admin", active: true, createdAt: target.createdAt || now(), updatedAt: now(), lastLoginAt: null,
    ...verifier, mustChangePin: false, failedAttempts: 0, lockedUntil: null, lastOnlineAuthAt: null,
  });
  if (!target.name || !target.username) throw new Error("Super Admin name and username are required.");
  users = [safeUser(target)];
  currentId = target.id;
  await persist();
  await persistSession();
  return target;
}

async function signIn(user, pin) {
  user=getUser(user?.id)||user;
  if (!user?.active) throw new Error("This staff account is inactive.");
  if (!user.pinHash || !user.pinSalt) {
    if (!navigator.onLine || getConfig().mode === "local") throw new Error("This staff member must sign in online on this counter before using offline sign-in.");
    const { onlineLogin, clearAuthToken } = await import("./auth.js");
    const serverUser = await onlineLogin(user.username, pin, { cacheVerifier: true });
    if (serverUser.id !== user.id) { clearAuthToken(); throw new Error("Server staff identity does not match this counter."); }
    const signed = await adoptServerStaff(serverUser, pin);
    clearOfflineAuthFlag();
    window.dispatchEvent(new CustomEvent("staff:server-auth", { detail: { ok: true } }));
    window.dispatchEvent(new CustomEvent("sync:status"));
    toast(`Signed in as ${signed.name}`);
    return signed;
  }
  const lockedUntil = new Date(user.lockedUntil || 0).getTime();
  if (Number.isFinite(lockedUntil) && lockedUntil > Date.now()) {
    const minutes = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 60000));
    throw new Error(`Too many incorrect PIN attempts on this PC. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  }
  if (user.lockedUntil) { user.lockedUntil = null; user.failedAttempts = 0; await persist(); }
  const localHash = await getPinVerifier(user, pin);
  if (!localHash || localHash !== user.pinHash) {
    user.failedAttempts = (Number(user.failedAttempts) || 0) + 1;
    if (user.failedAttempts >= PIN_MAX_FAILED) {
      user.failedAttempts = 0;
      user.lockedUntil = new Date(Date.now() + PIN_LOCK_MS).toISOString();
      await persist();
      throw new Error("Too many incorrect PIN attempts on this PC. Try again in 15 minutes.");
    }
    const remaining = PIN_MAX_FAILED - user.failedAttempts;
    await persist();
    throw new Error(`Incorrect PIN. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`);
  }
  user.failedAttempts = 0;
  user.lockedUntil = null;
  const cfg = (() => { try { return JSON.parse(localStorage.getItem("pos.backend.v1") || "{}"); } catch { return {}; } })();

  // Establish the local-first session immediately. When cloud mode is configured,
  // use the PIN entered in this interactive sign-in to authenticate against the
  // server's own salt/verifier. Reusing the local PIN hash silently fails whenever
  // the local and server salts differ, leaving every protected action unauthenticated.
  currentId = user.id;
  user.lastLoginAt = now();
  user.updatedAt = now();
  await persist();
  await persistSession();

  let cloudAuthError = "";
  if (navigator.onLine && cfg.mode && cfg.mode !== "local" && cfg.url) {
    try {
      clearServerAuthCooldown();
      const { onlineLogin, clearAuthToken } = await import("./auth.js");
      const serverUser = await onlineLogin(user.username, pin, { cacheVerifier: true });
      if (serverUser.id !== user.id) {
        clearAuthToken();
        throw new Error("The Google Sheets staff account does not match this device's staff record. Use the one-time setup-code repair to reconcile staff accounts.");
      }
      // The server is authoritative for roles. Refresh the local role before route
      // authorization so a stale/promoted local record cannot retain extra access.
      // persist() normalizes/replaces the directory array; update the current record,
      // not the stale object captured before the local session was persisted.
      const stored = getUser(user.id);
      Object.assign(stored, { role: normalizeRole(serverUser.role), serverKnown: true, lastOnlineAuthAt: now(),
        ...(serverUser.pinHash ? { pinHash: serverUser.pinHash, pinSalt: serverUser.pinSalt, pinIterations: serverUser.pinIterations } : {}) });
      await persist();
      clearOfflineAuthFlag();
      window.dispatchEvent(new CustomEvent("staff:server-auth", { detail: { ok: true } }));
      window.dispatchEvent(new CustomEvent("sync:status"));
    } catch (error) {
      cloudAuthError = String(error?.message || error || "Google Sheets authentication failed.");
      window.dispatchEvent(new CustomEvent("staff:server-auth", { detail: { ok: false, message: cloudAuthError } }));
      window.dispatchEvent(new CustomEvent("sync:status"));
    }
  }

  if (cloudAuthError) {
    // A definitive server rejection means the local directory is stale (for example,
    // the Super Admin was deleted or disabled in the Sheet). Do not leave a local
    // session alive after the server has rejected this identity.
    const definitiveRejection = /Invalid username or PIN|staff account does not match|identity does not match|credential.*out of sync|temporarily locked|account is inactive/i.test(cloudAuthError);
    if (definitiveRejection) {
      const { clearAuthToken } = await import("./auth.js");
      clearAuthToken();
      currentId = "";
      await idb.del(SESSION_KEY).catch(() => {});
      clearOfflineAuthFlag();
      window.dispatchEvent(new CustomEvent("staff:changed"));
      window.dispatchEvent(new CustomEvent("sync:status"));
      if (/Invalid username or PIN|staff account does not match|identity does not match|credential.*out of sync/i.test(cloudAuthError)) {
        throw new Error("Google Sheets staff credentials are out of sync. This account has been signed out on this PC. Use the one-time setup-code repair below.");
      }
      throw new Error(cloudAuthError);
    }
    toast("Signed in on this PC, but Google Sheets sign-in failed: " + cloudAuthError, "warn");
  } else {
    toast(`Signed in as ${user.name}`);
  }
  return getUser(user.id)||user;
}

async function syncServerStaff(setupCode = "") {
  if (!navigator.onLine) throw new Error("Connect to the internet first.");
  const cfg = (() => { try { return JSON.parse(localStorage.getItem("pos.backend.v1") || "{}"); } catch { return {}; } })();
  if (!cfg.url || cfg.mode === "local") throw new Error("Connect Google Sheets first.");
  const { syncStaffToServer } = await import("./auth.js");
  // Normal sync sends unsynced local accounts and explicitly edited records.
  // Never overwrite a remote PIN or role merely because its metadata was cached.
  const outgoing = users.filter(u => u.pendingDirectoryEdit || u.pendingPinChange || (!u.serverKnown && u.pinHash && u.pinSalt) || (setupCode && u.pinHash && u.pinSalt)).map(u => {
    const row = safeUser(u);
    if (u.serverKnown && !u.pendingPinChange && !setupCode) { row.pinHash = ""; row.pinSalt = ""; }
    return row;
  });
  if (!outgoing.length) { if(!(await refreshStaffDirectory()))throw new Error("Google Sheets sign-in is required to refresh staff."); return {ok:true,count:0}; }
  const result = await syncStaffToServer(outgoing, setupCode);
  for (const sent of outgoing) {
    const user = getUser(sent.id);
    if (user && user.updatedAt === sent.updatedAt) { user.pendingDirectoryEdit = false; user.pendingPinChange = false; user.serverKnown = true; }
  }
  await persist();
  return result;
}
let directoryRequest = null;
export async function refreshStaffDirectory() {
  await initStaff();
  const cfg = getConfig(), me = currentStaff();
  if (!me || !navigator.onLine || cfg.mode === "local" || !cfg.url) return false;
  if (directoryRequest) return directoryRequest;
  const identity = currentId, previousRole = me.role;
  directoryRequest = (async () => {
    const { fetchStaffDirectory, getAuthToken } = await import("./auth.js");
    if (!getAuthToken()) return false;
    const result = await fetchStaffDirectory();
    if (currentId !== identity || getConfig().url !== cfg.url || !Array.isArray(result.staff)) return false;
    const byId = new Map(users.map(u => [u.id, u]));
    for (const remote of result.staff) {
      const existing = byId.get(remote.id);
      if (existing?.pendingDirectoryEdit || existing?.pendingPinChange || (existing && !existing.serverKnown && existing.pinHash && localStorage.getItem(SERVER_SYNC_KEY))) continue;
      byId.set(remote.id, safeUser({ ...existing, ...remote, phone: previousRole === "admin" ? (remote.phone || "") : (existing?.phone || ""),
        pinSalt: existing?.pinSalt || "", pinHash: existing?.pinHash || "",
        pinIterations: existing?.pinIterations || ITERATIONS, serverKnown: true }));
    }
    const returnedIds = new Set(result.staff.map(u => u.id));
    const returnedNames = new Set(result.staff.map(u => u.username));
    users = [...byId.values()].map(u => !u.pendingDirectoryEdit && !u.pendingPinChange && !returnedIds.has(u.id) && (u.serverKnown || returnedNames.has(u.username)) ? { ...u, active: false } : u);
    if (!getUser(currentId)?.active) { currentId = ""; await idb.del(SESSION_KEY); }
    await persist();
    if(currentId && getUser(currentId)?.role!==previousRole)window.dispatchEvent(new CustomEvent("staff:switched"));
    return true;
  })().finally(() => { directoryRequest = null; });
  return directoryRequest;
}

async function repairServerBootstrap(setupCode) {
  const code = clean(setupCode, 80);
  if (!code) throw new Error("Enter the one-time setup code.");
  await syncServerStaff(code);
}
async function askPin(user, title = "Switch operator") {
  return new Promise(resolve => {
    const m = openModal({
      title, sub: `${user.name} · ${permissionLabel(user.role)}`,
      size: "sm",
      body: `<div class="field"><label for="staffPin">PIN</label><input class="input" id="staffPin" type="password" inputmode="numeric" autocomplete="off" maxlength="12" placeholder="Enter PIN" /></div><div class="staff-pin-error" id="staffPinError"></div>`,
      footer: `<button class="btn btn-outline" data-close>Cancel</button><button class="btn btn-primary" id="staffPinGo">${icon("check")} Continue</button>`,
      onClose: () => resolve(false),
    });
    const input = m.$("#staffPin"), err = m.$("#staffPinError"), go = m.$("#staffPinGo");
    const submit = async () => {
      const pin = input.value.trim();
      if (!pin) { err.textContent = "Enter the staff PIN."; return; }
      if (go.disabled) return; err.textContent = "";
      const restore=setButtonBusy(go,"Signing in…");
      try { await signIn(user, pin); m.close(); window.dispatchEvent(new CustomEvent("staff:switched")); resolve(true); }
      catch (e) { err.textContent = e.message; input.select(); }
      finally { restore(); }
    };
    input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
    go.onclick = submit;
    input.focus({preventScroll:true});
  });
}


export async function verifyStaffPin(user, pin) {
  if (!user?.active) return false;
  return verifyPin(user, pin);
}

let onlineAuthPromise = null;

function serverAuthCooldown(user) {
  if (!user?.username) return 0;
  try {
    const data = JSON.parse(localStorage.getItem(SERVER_AUTH_COOLDOWN_KEY) || "{}");
    return String(data.username || "").toLowerCase() === String(user.username).toLowerCase() ? Number(data.until) || 0 : 0;
  } catch {
    return 0;
  }
}
function setServerAuthCooldown(user, ms) {
  if (!user?.username) return;
  try {
    localStorage.setItem(SERVER_AUTH_COOLDOWN_KEY, JSON.stringify({
      username: String(user.username).toLowerCase(),
      until: Date.now() + ms,
    }));
  } catch {}
}
function clearServerAuthCooldown() {
  try { localStorage.removeItem(SERVER_AUTH_COOLDOWN_KEY); } catch {}
}

async function authenticateServer(user = currentStaff()) {
  await initStaff();
  const cfg = getConfig();
  if (!user || !navigator.onLine || cfg.mode === "local" || !cfg.url) return false;
  const cooldown = serverAuthCooldown(user);
  if (cooldown > Date.now()) return false;
  if (onlineAuthPromise) return onlineAuthPromise;
  const { getAuthToken, clearAuthToken, setAuthToken } = await import("./auth.js");
  if (onlineAuthPromise) return onlineAuthPromise;
  // A token can survive a tab close after its server session expires or is revoked.
  if (getAuthToken()) clearAuthToken();
  onlineAuthPromise = (async () => {
    const localHash = user.pinHash || "";
    if (!localHash) throw new Error("The local staff credential is unavailable.");
    const { onlineLogin } = await import("./auth.js");
    try {
      const serverUser = await onlineLogin(user.username, "", {
        pinHash: localHash,
        pinSalt: user.pinSalt,
        pinIterations: user.pinIterations || ITERATIONS,
        deferToken: true,
      });
      if (serverUser.id !== user.id) throw new Error("Server staff identity does not match this counter.");
      if (currentId !== user.id) return false;
      setAuthToken(serverUser.authToken);
      clearServerAuthCooldown();
      clearOfflineAuthFlag();
      return true;
    } catch (e) {
      const message = String(e?.message || e || "");
      // Never hammer Apps Script after a credential mismatch/lockout. The server itself
      // counts failed PIN attempts, so automatic retries can make a valid account look
      // maliciously abusive and extend the lockout. Transport failures get a shorter backoff.
      if (/Invalid username or PIN|temporarily locked|identity does not match/i.test(message)) {
        setServerAuthCooldown(user, 15 * 60 * 1000);
      } else if (/took too long|Couldn't reach Google Sheets|Failed to fetch|NetworkError|Load failed|non-JSON/i.test(message)) {
        setServerAuthCooldown(user, 60 * 1000);
      } else {
        setServerAuthCooldown(user, 5 * 60 * 1000);
      }
      throw e;
    }
  })().finally(() => { onlineAuthPromise = null; });
  return onlineAuthPromise;
}

export async function ensureOnlineStaffAuth() {
  return authenticateServer(currentStaff());
}
export async function refreshStaffSession() { await initStaff(); const s = await idb.get(SESSION_KEY).catch(() => null); if (!sessionValid(s)) { currentId = ""; await idb.del(SESSION_KEY).catch(() => {}); window.dispatchEvent(new CustomEvent("staff:changed")); return null; } await touchSession(); return currentStaff(); }
export async function logoutStaff() {
  const hadOnlineAuth = navigator.onLine && getConfig().mode !== "local";
  // End local access first. Server revocation runs in the background so a slow Apps
  // Script response cannot keep the operator signed in or hold the logout UI open.
  currentId = "";
  await idb.del(SESSION_KEY).catch(() => {});
  window.dispatchEvent(new CustomEvent("staff:changed"));
  if (hadOnlineAuth) {
    import("./auth.js").then(({ onlineLogout }) => onlineLogout()).catch((e) => {
      toast("Signed out on this counter. Server revocation could not be confirmed: " + (e.message || e), "warn");
    });
  } else {
    import("./auth.js").then(({ clearAuthToken }) => clearAuthToken()).catch(() => {});
  }
  return true;
}

export async function openOperatorMenu() {
  await initStaff();
  const me = currentStaff();
  if (!me) return loginStaff();
  const m = openModal({
    title: me.name,
    sub: `${permissionLabel(me.role)} · Counter 1`,
    size: "sm",
    body: `<div class="choice-list"><button class="choice" data-op="switch">${icon("user")}<b>Switch operator</b><span>Sign in as another staff member.</span></button><button class="choice" data-op="logout"><span style="color:var(--red)">${icon("log-out")}</span><b>Logout</b><span>End this operator session on this counter.</span></button></div>`,
    footer: `<button class="btn btn-outline" data-close>Cancel</button>`,
  });
  m.body.addEventListener("click", async (e) => {
    const action = e.target.closest("[data-op]")?.dataset.op;
    if (!action) return;
    if (action === "switch") { m.close(); await switchOperator(); return; }
    if (action === "logout") {
      const ok = await confirmDialog({ title: "Logout?", message: `Sign out ${me.name} from this counter?`, confirmText: "Logout", danger: true });
      if (!ok) return;
      m.close();
      await logoutStaff();
      window.dispatchEvent(new CustomEvent("staff:changed"));
      location.hash = "#/dashboard";
      await loginStaff();
      window.dispatchEvent(new CustomEvent("staff:changed"));
    }
  });
}

async function recoverConnection(m) {
  const cfg = getConfig();
  const body = `<div class="field"><label for="loginSheetUrl">Google Sheets Web App URL</label><input class="input" id="loginSheetUrl" spellcheck="false" autocomplete="off" value="${esc(cfg.url || "")}" placeholder="https://script.google.com/macros/s/…/exec"></div><div class="field" style="margin-top:12px"><label for="loginSheetKey">Access key <span class="muted">(only if configured)</span></label><input class="input" id="loginSheetKey" type="password" autocomplete="off" value="${esc(cfg.key || "")}"></div><div class="staff-pin-error" id="loginConnError"></div><p class="muted" style="font-size:12px;margin-top:10px">The URL is tested with the POS API before it replaces the saved connection.</p>`;
  const cm = openModal({ title:"Reconnect Google Sheets", sub:"Repair the counter connection without signing in first.", size:"sm", body, footer:`<button class="btn btn-outline" data-close>Cancel</button><button class="btn btn-primary" id="loginConnGo">${icon("check")} Test &amp; save</button>` });
  cm.$("#loginConnGo").onclick = async () => {
    const b=cm.$("#loginConnGo"), err=cm.$("#loginConnError");
    const url=cm.$("#loginSheetUrl").value.trim(), key=cm.$("#loginSheetKey").value.trim();
    if (!/^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[^/]+\/exec$/.test(url)) { err.textContent="Enter the deployed Apps Script Web App URL ending in /exec."; return; }
    b.disabled=true; err.textContent="";
    try {
      const { createSheetsAdapter } = await import("./data/sheets-adapter.js");
      const api=createSheetsAdapter({url,key});
      const result=await api.ping();
      if (!result?.ok) throw new Error("The Web App did not return a valid POS API response.");
      saveConfig({ ...cfg, mode: cfg.mode === "local" ? "sheets" : cfg.mode, url, key });
      cm.close();
      toast("Google Sheets connection updated.");
    } catch(e) {
      err.textContent=e.message || "Could not connect to the Google Sheets Web App.";
      b.disabled=false;
    }
  };
}
export async function loginStaff(force = false) {
  await initStaff();
  if (!force && currentStaff()) return currentStaff();
  return new Promise((resolve) => {
    let completed = false;
    let repairUser = null;
    let repairPin = "";
    const m = openModal({
      title: "Staff sign in",
      sub: "Enter your POS username and PIN to continue.",
      size: "sm",
      body: `<div class="field"><label for="loginUsername">Username</label><input class="input" id="loginUsername" autocomplete="username" maxlength="60" placeholder="Username"></div><div class="field" style="margin-top:12px"><label for="loginPin">PIN</label><input class="input" id="loginPin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="12" placeholder="PIN"></div><div class="staff-pin-error" id="loginError"></div><div id="loginRepair" style="display:none;margin-top:12px;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2)"><div class="muted" style="margin-bottom:8px">Your local PIN is valid, but the Google Sheets staff credential is out of sync. Run <b>getAuthSetupCode()</b> in Apps Script and paste the one-time code below.</div><div class="field"><label for="loginSetupCode">One-time setup code</label><input class="input" id="loginSetupCode" autocomplete="off" maxlength="32" placeholder="Setup code"></div><button class="btn btn-outline" id="loginRepairGo" style="width:100%;margin-top:8px">${icon("sync")} Repair server sign-in</button></div>`,
      footer: `<button class="btn btn-ghost" id="loginConnection">${icon("settings")} Connection</button><button class="btn btn-primary login-submit" id="loginGo">${icon("log-in")}<span>Sign in</span></button>`,
      onClose: () => { if (!completed) resolve(null); },
    });
    const submit = async () => {
      const username = m.$("#loginUsername").value.trim().toLowerCase();
      const pin = m.$("#loginPin").value.trim();
      const err = m.$("#loginError");
      if (!username || !pin) { err.textContent = "Enter username and PIN."; return; }
       let user = users.find((u) => u.username === username && u.active);
       // Legacy bootstrap recovery: accept only the exact single default-admin identity.
       if (!user && username === "admin") {
         const bootstrapAdmins = users.filter((u) => u.active && u.role === "admin" && u.name === "Anand Ibrahim");
         if (bootstrapAdmins.length === 1 && users.length === 1) user = bootstrapAdmins[0];
       }
       const btn = m.$("#loginGo"); if(btn.disabled)return;const restore=setButtonBusy(btn,"Signing in…"); err.textContent = "";
      repairUser = user;
      repairPin = pin;
      try {
        if (!user && navigator.onLine && getConfig().mode !== "local") {
          const { onlineLogin } = await import("./auth.js");
          const serverUser = await onlineLogin(username, pin, { cacheVerifier: true });
          const signed = await adoptServerStaff(serverUser, pin);
          completed = true;
          document.body.classList.remove("auth-locked");
          window.dispatchEvent(new CustomEvent("staff:changed"));
          m.close(); resolve(signed); return;
        }
        if (!user) throw new Error("Invalid username or PIN.");
        const signed = await signIn(user, pin);
        completed = true;
        document.body.classList.remove("auth-locked");
        window.dispatchEvent(new CustomEvent("staff:changed"));
        m.close(); resolve(signed);
      } catch (e) {
        const message = e.message || "Sign-in failed.";
        if (user && (/^(Invalid username or PIN\.?|This account is temporarily locked\b)/.test(message) || /Google Sheets staff credentials are out of sync/i.test(message)) && getConfig().mode !== "local") {
          // Do not attempt an unauthenticated server staff sync here. authSyncStaff
          // is intentionally protected and would create a circular recovery path.
          // Instead, expose the explicit one-time setup-code recovery.
          err.textContent = message;
          m.$("#loginRepair").style.display = "block";
          m.$("#loginSetupCode")?.focus({preventScroll:true});
        } else {
          err.textContent = message;
          m.$("#loginPin").select();
        }
      } finally { restore(); }
    };
    m.$("#loginConnection").onclick = async () => { m.close(); await recoverConnection(m); };
    m.$("#loginRepairGo").onclick = async () => {
      const b = m.$("#loginRepairGo"), code = m.$("#loginSetupCode").value.trim();
      const username = m.$("#loginUsername").value.trim().toLowerCase();
      const pin = m.$("#loginPin").value.trim();
      const repairTarget = repairUser || users.find((u) => u.username === username);
      b.disabled = true; m.$("#loginError").textContent = "";
      try {
        if (!repairTarget || !pin) throw new Error("Enter the same username and PIN, then run the repair.");
        await repairServerBootstrap(code);
        const signed = await signIn(repairTarget, pin);
        completed = true;
        document.body.classList.remove("auth-locked");
        window.dispatchEvent(new CustomEvent("staff:changed"));
        m.close(); resolve(signed);
      } catch (e) {
        m.$("#loginError").textContent = e.message || "Server repair failed.";
        b.disabled = false;
      }
    };
    m.$("#loginGo").onclick = submit;
    m.$("#loginPin").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    m.$("#loginUsername").addEventListener("blur", () => {
      const username = m.$("#loginUsername").value.trim().toLowerCase();
      if (!username || !navigator.onLine || getConfig().mode === "local" || !getConfig().url) return;
      import("./auth.js").then(({ prefetchAuthChallenge }) => prefetchAuthChallenge(username)).catch(() => {});
    });
    m.$("#loginUsername").addEventListener("keydown", (e) => { if (e.key === "Enter") m.$("#loginPin").focus(); });
    // The modal is already attached. Delayed autofocus can steal focus from
    // the PIN field after a cashier begins typing (including scanner input).
    m.$("#loginUsername").focus({preventScroll:true});
  });
}

export async function switchOperator() {
  await initStaff();
  if (navigator.onLine && getConfig().mode !== "local") {
    const loading = openModal({ title: "Switch operator", sub: "Loading staff accounts…", size: "sm", body: '<p role="status">Checking the staff directory in Google Sheets…</p>', footer: '<button class="btn btn-outline" data-close>Cancel</button>' });
    try { await refreshStaffDirectory(); }
    catch (e) { toast("Could not refresh staff: " + e.message, "warn"); }
    if (!loading.el.isConnected) return;
    loading.close();
  }
  const list = activeUsers();
  if (!currentId && list.length === 1) return loginStaff();
  if (list.length <= 1) {
    if (getConfig().mode !== "local" && navigator.onLine) {
      const before=currentId, signed=await loginStaff(true);
      if(signed && signed.id!==before)window.dispatchEvent(new CustomEvent("staff:switched"));
      return signed;
    }
    return toast("No other active staff accounts are available.", "warn");
  }
  const m = openModal({
    title: "Switch operator",
    sub: "Select the staff member who is operating this counter.",
    size: "sm",
    body: `<div class="staff-switch-list">${list.map(u => `<button class="staff-switch-row ${u.id===currentId?"active":""}" data-id="${esc(u.id)}"><span class="staff-avatar">${esc(initials(u.name))}</span><span class="grow"><b>${esc(u.name)}</b><small>${esc(permissionLabel(u.role))} · @${esc(u.username)}</small></span>${u.id===currentId?'<span class="badge badge-green">Current</span>':""}</button>`).join("")}</div>`,
    footer: `<button class="btn btn-outline" data-close>Cancel</button>`,
  });
  m.body.addEventListener("click", async e => {
    const row = e.target.closest("[data-id]"); if (!row) return;
    const user = getUser(row.dataset.id); if (!user) return;
    m.close();
    if (user.id !== currentId) await askPin(user);
  });
}

function filtered() {
  const q = filter.toLowerCase();
  return users.filter(u => {
    if (statusFilter === "active" && !u.active) return false;
    if (statusFilter === "inactive" && u.active) return false;
    return !q || [u.name,u.username,u.phone,permissionLabel(u.role)].join(" ").toLowerCase().includes(q);
  });
}

function render() {
  if (!root?.isConnected) return;
  const me = currentStaff();
  const rows = filtered();
  const active = activeUsers();
  root.innerHTML = `
    <div class="view-enter staff-page">
      <div class="staff-toolbar">
        <div><h2>Staff & User Management</h2><p>Manage POS operators, roles and secure PIN access on this counter.</p></div>
        <div class="actions"><button class="btn btn-outline" id="staffSwitch">${icon("user")} Switch operator</button><button class="btn btn-outline" id="staffLogout">${icon("log-out")} Logout</button>${can("staff") ? `<button class="btn btn-outline" id="staffAuth">Server auth</button><button class="btn btn-primary" id="staffAdd">${icon("plus")} Add staff</button>` : ""}</div>
      </div>
      <div class="staff-stats">
        <div class="card stat"><div class="stat-top">Active staff</div><div class="stat-value">${active.length}</div><div class="stat-foot">Accounts allowed to sign in</div></div>
        <div class="card stat"><div class="stat-top">Administrators</div><div class="stat-value">${users.filter(u=>u.active&&u.role==="admin").length}</div><div class="stat-foot">Full system access</div></div>
        <div class="card stat"><div class="stat-top">Managers</div><div class="stat-value">${users.filter(u=>u.active&&u.role==="manager").length}</div><div class="stat-foot">Operational management</div></div>
        <div class="card stat"><div class="stat-top">Current operator</div><div class="stat-value staff-current">${esc(me?.name || "—")}</div><div class="stat-foot">${esc(me ? permissionLabel(me.role) : "No active operator")}</div></div>
      </div>
      <section class="card mt-16 staff-card">
        <div class="card-head"><div><h3>Staff accounts</h3><div class="sub">PINs are stored as salted PBKDF2 hashes and never shown in the UI.</div></div>${getConfig().mode !== "local" ? `<button class="btn btn-outline btn-sm" id="staffRefresh">${icon("sync")} Refresh staff</button>` : ""}</div>
        <div class="staff-filters"><div class="staff-search"><span class="staff-search-icon">${icon("search","sm")}</span><input class="input" id="staffSearch" placeholder="Search name, username or role..." value="${esc(filter)}"></div><select class="input staff-status" id="staffStatus"><option value="active" ${statusFilter==="active"?"selected":""}>Active staff</option><option value="inactive" ${statusFilter==="inactive"?"selected":""}>Inactive staff</option><option value="all" ${statusFilter==="all"?"selected":""}>All staff</option></select></div>
        <div class="table-wrap staff-table"><table class="table"><thead><tr><th>STAFF</th><th>USERNAME</th><th>ROLE</th><th>STATUS</th><th>LAST LOGIN</th><th></th></tr></thead><tbody>${rows.length ? rows.map(u => `<tr><td><div class="staff-person"><span class="staff-avatar">${esc(initials(u.name))}</span><div><b>${esc(u.name)}</b>${u.id===me?.id?'<span class="staff-you">Current operator</span>':""}</div></div></td><td><b>@${esc(u.username)}</b>${u.phone?`<div class="muted">${esc(u.phone)}</div>`:""}</td><td><span class="badge ${u.role==="admin"?"badge-violet":u.role==="manager"?"badge-blue":"badge-green"}">${esc(permissionLabel(u.role))}</span></td><td><span class="badge ${u.active?"badge-green":"badge-gray"}">${u.active?"Active":"Inactive"}</span></td><td>${u.lastLoginAt?new Date(u.lastLoginAt).toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):"Never"}</td><td class="staff-actions">${can("staff")?`<button class="icon-btn" data-edit="${esc(u.id)}" title="Edit">${icon("edit")}</button><button class="icon-btn" data-pin="${esc(u.id)}" title="Reset PIN">${icon("key")}</button>${u.id!==me?.id?`<button class="icon-btn ${u.active?"danger":""}" data-toggle="${esc(u.id)}" title="${u.active?"Deactivate":"Activate"}">${icon(u.active?"x":"check")}</button>`:""}`:"—"}</td></tr>`).join("") : `<tr><td colspan="6"><div class="empty"><div class="big">${icon("user")}</div><h4>No staff accounts found</h4><p>Adjust the filter or add a staff member.</p></div></td></tr>`}</tbody></table></div>
      </section>
      <div class="staff-security-note"><b>Security boundary:</b> this phase provides local operator identity and PIN protection. Google Sheets enforces protected server actions. Staff who have not signed in on this counter must authenticate online before offline sign-in is available.</div>
    </div>`;
  hydrateIcons(root);
  $("#staffSearch",root).oninput = e => { filter=e.target.value; render(); const i=$("#staffSearch",root); i?.focus(); i?.setSelectionRange(filter.length,filter.length); };
  $("#staffStatus",root).onchange = e => { statusFilter=e.target.value; render(); };
  $("#staffAdd",root)?.addEventListener("click",()=>openEditor());
  $("#staffRefresh",root)?.addEventListener("click",async e=>{const restore=setButtonBusy(e.currentTarget,"Refreshing…");try{if(await refreshStaffDirectory()){if(location.hash==="#/staff"&&can("staff"))render();toast("Staff directory refreshed");}else toast("Connect and sign in to Google Sheets first.","warn");}catch(error){toast(error.message,"error");}finally{restore();}});
  $("#staffAuth",root)?.addEventListener("click", openServerAuth);
  $("#staffSwitch",root)?.addEventListener("click",switchOperator);
  $("#staffLogout",root)?.addEventListener("click", logoutStaff);
  root.querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>openEditor(getUser(b.dataset.edit)));
  root.querySelectorAll("[data-pin]").forEach(b=>b.onclick=()=>resetPin(getUser(b.dataset.pin)));
  root.querySelectorAll("[data-toggle]").forEach(b=>b.onclick=()=>toggleUser(getUser(b.dataset.toggle)));
}

async function syncServerStaffIfInitialized() {
  if (!navigator.onLine || !can("staff") || !localStorage.getItem(SERVER_SYNC_KEY)) return false;
  const cfg = (() => { try { return JSON.parse(localStorage.getItem("pos.backend.v1") || "{}"); } catch { return {}; } })();
  if (!cfg.url || cfg.mode === "local") return false;
  try {
    const { authStatus } = await import("./auth.js");
    if (!(await authStatus()).initialized) return false;
    await syncServerStaff();
    localStorage.removeItem(SERVER_SYNC_KEY);
    if (serverSyncTimer) { clearTimeout(serverSyncTimer); serverSyncTimer = null; }
    return true;
  } catch (e) {
    // Staff is already durable in IndexedDB. Keep server reconciliation pending and retry
    // silently; never interrupt the operator with a sync toast.
    localStorage.setItem(SERVER_SYNC_KEY, new Date().toISOString());
    if (!serverSyncTimer) {
      serverSyncTimer = setTimeout(() => {
        serverSyncTimer = null;
        syncServerStaffIfInitialized();
      }, 30000);
    }
    return false;
  }
}

function scheduleServerStaffSync() {
  clearTimeout(serverSyncTimer);
  serverSyncTimer = setTimeout(() => {
    serverSyncTimer = null;
    syncServerStaffIfInitialized();
  }, 1500);
}

window.addEventListener("online", () => {
  if (can("staff") && localStorage.getItem(SERVER_SYNC_KEY)) scheduleServerStaffSync();
});
window.addEventListener("staff:switched", () => { if(can("staff") && localStorage.getItem(SERVER_SYNC_KEY))scheduleServerStaffSync(); });

async function openServerAuth() {
  if (!can("staff")) return toast("Only Admin users can configure server authentication.", "error");
  try {
    const { authStatus } = await import("./auth.js");
    const status = await authStatus();
    if (status.initialized) {
      const body = "<p class=\"muted\">Online mutations now require a valid server session. Re-sync this counter staff directory after staff changes.</p>";
      const footer = '<button class="btn btn-outline" data-close>Close</button><button class="btn btn-primary" id="authResync">' + icon("sync") + " Sync staff</button>";
      const m = openModal({ title: "Server authentication", sub: status.staffCount + " staff account(s) are provisioned on Google Sheets.", size: "sm", body, footer });
      m.$("#authResync").onclick = async () => { const b=m.$("#authResync"); b.disabled=true; try { await syncServerStaff(); m.close(); toast("Staff directory synchronized with Google Sheets."); } catch(e) { toast(e.message,"error"); b.disabled=false; } };
      return;
    }
    const body = "<p class=\"muted\">In Apps Script, run <b>getAuthSetupCode()</b> once and copy its returned value here. This setup code is used only during initial provisioning.</p><div class=\"field\"><label>Setup code</label><input class=\"input\" id=\"authSetupCode\" autocomplete=\"off\" maxlength=\"32\" placeholder=\"Paste setup code\"></div><div class=\"staff-pin-error\" id=\"authSetupError\"></div>";
    const footer = '<button class="btn btn-outline" data-close>Cancel</button><button class="btn btn-primary" id="authSetupGo">' + icon("check") + " Initialize</button>";
    const m = openModal({ title: "Initialize server authentication", sub: "One-time provisioning of the existing local staff directory.", size: "sm", body, footer });
    m.$("#authSetupGo").onclick = async () => { const b=m.$("#authSetupGo"); b.disabled=true; try { await syncServerStaff(m.$("#authSetupCode").value.trim()); m.close(); toast("Server staff directory initialized. Online sign-in is now enforced when connected."); render(); } catch(e) { m.$("#authSetupError").textContent=e.message; b.disabled=false; } };
    m.$("#authSetupCode").focus({preventScroll:true});
  } catch (e) { toast(e.message || "Could not open server authentication.", "error"); }
}
async function openEditor(existing=null) {
  if (!can("staff")) return toast("Only Admin users can manage staff accounts.", "error");
  const editing = !!existing;
  const m = openModal({
    title: editing ? "Edit staff member" : "Add staff member",
    sub: editing ? `Update ${existing.name}'s role and account details.` : "Create an operator account for this POS.",
    size: "md",
    body: `<div class="form-grid"><div class="field"><label>Full name</label><input class="input" id="sfName" maxlength="80" value="${esc(existing?.name||"")}"></div><div class="field"><label>Username</label><input class="input" id="sfUser" maxlength="60" value="${esc(existing?.username||"")}" ${editing?"readonly":""}></div><div class="field"><label>Role</label><select class="input" id="sfRole">${Object.entries(ROLES).map(([k,r])=>`<option value="${k}" ${(existing?.role||"cashier")===k?"selected":""}>${r.label}</option>`).join("")}</select><span class="hint" id="sfRoleHint"></span></div><div class="field"><label>Phone <span class="muted">(optional)</span></label><input class="input" id="sfPhone" maxlength="30" value="${esc(existing?.phone||"")}"></div>${editing?`<div class="field span-2"><label>New PIN <span class="muted">(optional)</span></label><input class="input" id="sfPin" type="password" inputmode="numeric" maxlength="12" placeholder="Leave blank to keep current PIN"><span class="hint">Leave blank to keep the current PIN. A new PIN will require the staff member to change it after sign-in.</span></div>`:`<div class="field span-2"><label>Initial PIN</label><input class="input" id="sfPin" type="password" inputmode="numeric" maxlength="12" placeholder="4–12 digits"><span class="hint">The PIN is immediately converted to a salted PBKDF2 hash.</span></div>`}</div>`,
    footer: `<button class="btn btn-outline" data-close>Cancel</button><button class="btn btn-primary" id="sfSave">${icon("check")} ${editing?"Save changes":"Create staff"}</button>`,
  });
  const roleHint=()=>{m.$("#sfRoleHint").textContent=ROLES[m.$("#sfRole").value].description;}; roleHint(); m.$("#sfRole").onchange=roleHint;
  m.$("#sfSave").onclick=async()=>{
    const name=clean(m.$("#sfName").value,80), username=clean(m.$("#sfUser").value,60).toLowerCase().replace(/[^a-z0-9._-]/g,""), role=normalizeRole(m.$("#sfRole").value), phone=clean(m.$("#sfPhone").value,30);
    if(name.length<2)return toast("Enter the staff member's name.","error");
    if(username.length<2)return toast("Enter a valid username.","error");
    if(!editing && users.some(u=>u.username===username))return toast("That username is already in use.","error");
    const btn=m.$("#sfSave");if(btn.disabled)return;const restore=setButtonBusy(btn,editing?"Saving changes…":"Creating staff…");
    try{
      if(editing){
        const newPin=m.$("#sfPin").value.trim();
        if(newPin && !/^\d{4,12}$/.test(newPin)){return toast("Use a numeric PIN with 4–12 digits.","error");}
        const hashes=newPin ? await makePin(newPin) : {};
        const target=getUser(existing.id);if(!target)throw new Error("Staff record no longer exists.");
        Object.assign(target,{name,role,phone,updatedAt:now(),pendingDirectoryEdit:true,pendingPinChange:!!newPin||target.pendingPinChange,...hashes,...(newPin?{mustChangePin:true,failedAttempts:0,lockedUntil:null,lastOnlineAuthAt:null}:{})});
        await persist();
        const cfg=getConfig(); let serverSynced=false;
        if(cfg.mode!=="local"&&cfg.url)localStorage.setItem(SERVER_SYNC_KEY,now());
        if(navigator.onLine && cfg.mode && cfg.mode!=="local" && cfg.url){
          try { await syncServerStaff(); serverSynced=true; localStorage.removeItem(SERVER_SYNC_KEY); }
          catch(syncError) { localStorage.setItem(SERVER_SYNC_KEY,new Date().toISOString()); scheduleServerStaffSync(); }
        }
        m.close(); render();
        if(serverSynced) toast(newPin?"Staff account and new PIN synchronized with Google Sheets":"Staff account updated and synchronized with Google Sheets");
        else toast("Staff changes are saved on this PC, but Google Sheets has not confirmed them. Sync staff before relying on these changes on other counters.","warn");
      } else {
        const pin=m.$("#sfPin").value.trim();
        if(!/^\d{4,12}$/.test(pin)){return toast("Use a numeric PIN with 4–12 digits.","error");}
        const hashes=await makePin(pin);
        users.push({id:uid(),name,username,role,phone,active:true,createdAt:now(),updatedAt:now(),lastLoginAt:null,...hashes,mustChangePin:true});
        await persist();
        const cfg = (() => { try { return JSON.parse(localStorage.getItem("pos.backend.v1") || "{}"); } catch { return {}; } })();
        if(cfg.mode!=="local"&&cfg.url)localStorage.setItem(SERVER_SYNC_KEY,now());
        let serverSynced = false;
        if (navigator.onLine && cfg.mode && cfg.mode !== "local" && cfg.url) {
          try {
            await syncServerStaff();
            serverSynced = true;
            localStorage.removeItem(SERVER_SYNC_KEY);
          } catch (syncError) {
            // Keep the local account, but persist a retry marker and never imply that
            // Google Sheets has the account until the server confirms the directory sync.
            localStorage.setItem(SERVER_SYNC_KEY, new Date().toISOString());
            scheduleServerStaffSync();
            toast("Staff account saved on this PC only; Google Sheets did not confirm the update: " + (syncError.message || syncError), "warn");
          }
        }
        m.close(); render();
        if (serverSynced) toast("Staff account created and synchronized with Google Sheets");
        else if (!navigator.onLine || !cfg.url || cfg.mode === "local") toast("Staff account created on this PC only. Connect Google Sheets to sync it.", "warn");
      }
    }catch(e){toast(e.message||"Could not save staff account.","error");}finally{restore();}
  };
}

async function resetPin(user) {
  if(!can("staff") || !user) return toast("Only Admin users can reset staff PINs.","error");
  const m=openModal({title:"Reset staff PIN",sub:user.name, size:"sm",body:`<div class="field"><label>New PIN</label><input class="input" id="newStaffPin" type="password" inputmode="numeric" maxlength="12" placeholder="4–12 digits"></div>`,footer:`<button class="btn btn-outline" data-close>Cancel</button><button class="btn btn-primary" id="pinSave">${icon("check")} Reset PIN</button>`});
  m.$("#pinSave").onclick=async()=>{
    const b=m.$("#pinSave"), pin=m.$("#newStaffPin").value.trim();
    if(!/^\d{4,12}$/.test(pin))return toast("Use a numeric PIN with 4–12 digits.","error");
    if(b.disabled)return;const restore=setButtonBusy(b,"Resetting PIN…");
    try {
      const hashes=await makePin(pin);
      const target=getUser(user.id);if(!target)throw new Error("Staff record no longer exists.");
      Object.assign(target,hashes,{mustChangePin:true,failedAttempts:0,lockedUntil:null,lastOnlineAuthAt:null,updatedAt:now(),pendingDirectoryEdit:true,pendingPinChange:true});
      await persist();
      const cfg=getConfig(); let serverSynced=false;
      if(cfg.mode!=="local"&&cfg.url)localStorage.setItem(SERVER_SYNC_KEY,now());
      if(navigator.onLine && cfg.mode && cfg.mode!=="local" && cfg.url){
        try { await syncServerStaff(); serverSynced=true; localStorage.removeItem(SERVER_SYNC_KEY); }
        catch(syncError) { localStorage.setItem(SERVER_SYNC_KEY,new Date().toISOString()); scheduleServerStaffSync(); }
      }
      m.close(); render();
      if(serverSynced) toast(`PIN reset for ${user.name} and synchronized with Google Sheets`);
      else toast(`PIN reset on this PC for ${user.name}; Google Sheets has not confirmed the change. Reconnect or sync staff before using this PIN on other counters.`,"warn");
    } catch(e) { toast(e.message||"Could not reset staff PIN.","error"); } finally { restore(); }
  };
}

async function toggleUser(user) {
  if(!can("staff") || !user || user.id===currentId) return;
  const action=user.active?"Deactivate":"Activate";
  if(!(await confirmDialog({title:`${action} staff account?`,message:`${action} ${user.name}'s POS sign-in account?`,confirmText:action,danger:user.active})))return;
  user=getUser(user.id);if(!user||user.id===currentId)return;
  user.active=!user.active;user.updatedAt=now();user.pendingDirectoryEdit=true;await persist();localStorage.setItem(SERVER_SYNC_KEY,now());scheduleServerStaffSync();render();toast(`${user.name} is now ${user.active?"active":"inactive"} on this counter`);
}

export async function mount(el) { root=el; await initStaff(); render(); if(navigator.onLine && getConfig().mode !== "local"){try{const changed=await refreshStaffDirectory();if(changed && root===el && location.hash==="#/staff" && can("staff"))render();}catch(e){if(root===el && location.hash==="#/staff")toast("Showing cached staff: "+e.message,"warn");}} }
export function unmount(){root=null;}
window.addEventListener("staff:changed",()=>{if(root?.isConnected)render();});

// Core inventory refreshes must not trigger another staff-directory network read.
export function refresh(){if(location.hash==="#/staff"&&can("staff"))render();}

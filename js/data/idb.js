// Marvels POS IndexedDB key/value store.
// Old installs used a prior database name. We migrate data lazily, before the first read/write,
// only when the browser can enumerate databases. The original DB stays intact until data is copied.
const DB_NAME = "marvels-pos";
const LEGACY_DB_NAME = ["fresh", "mart-pos"].join("");
const STORE = "kv";
let dbPromise = null;
let migrationPromise = null;

function openNamedDatabase(name, createStore) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      if (createStore && !req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error("Couldn't open offline storage"));
    req.onblocked = () => reject(new Error("Offline storage is blocked by another window of this app"));
  });
}

async function migrateLegacyDatabase() {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    if (!("indexedDB" in window) || typeof indexedDB.databases !== "function") return false;
    const databases = await indexedDB.databases();
    if (!databases.some((entry) => entry.name === LEGACY_DB_NAME)) return false;

    const legacy = await openNamedDatabase(LEGACY_DB_NAME, false);
    if (!legacy.objectStoreNames.contains(STORE)) {
      legacy.close();
      return false;
    }
    let entries;
    try {
      entries = await new Promise((resolve, reject) => {
        const tx = legacy.transaction(STORE, "readonly");
        const store = tx.objectStore(STORE);
        let keys = [];
        let values = [];
        const keyReq = store.getAllKeys();
        const valueReq = store.getAll();
        keyReq.onsuccess = () => { keys = keyReq.result || []; };
        valueReq.onsuccess = () => { values = valueReq.result || []; };
        tx.oncomplete = () => resolve(keys.map((key, index) => [key, values[index]]));
        tx.onerror = tx.onabort = () => reject(tx.error || new Error("Couldn't read previous local data"));
      });
    } finally {
      legacy.close();
    }
    if (!entries.length) return false;

    const current = await openNamedDatabase(DB_NAME, true);
    try {
      await new Promise((resolve, reject) => {
        const tx = current.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const getReq = store.getAllKeys();
        getReq.onsuccess = () => {
          const existingKeys = new Set(getReq.result || []);
          for (const [key, value] of entries) {
            if (!existingKeys.has(key)) store.put(value, key);
          }
        };
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = () => reject(tx.error || new Error("Couldn't migrate previous local data"));
      });
    } finally {
      current.close();
    }

    // Delete old IndexedDB only after the new database committed copied values.
    const oldState = (await indexedDB.databases()).find((entry) => entry.name === LEGACY_DB_NAME);
    if (oldState) {
      await new Promise((resolve) => {
        const del = indexedDB.deleteDatabase(LEGACY_DB_NAME);
        del.onsuccess = del.onerror = del.onblocked = () => resolve();
      });
    }
    return true;
  })().catch((error) => {
    migrationPromise = null;
    throw error;
  });
  return migrationPromise;
}

function open() {
  if (!dbPromise) {
    dbPromise = migrateLegacyDatabase()
      .then(() => openNamedDatabase(DB_NAME, true))
      .catch((error) => {
        dbPromise = null;
        throw error;
      });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let result;
        const req = fn(store);
        if (req) req.onsuccess = () => (result = req.result);
        t.oncomplete = () => resolve(result);
        t.onerror = t.onabort = () => reject(t.error || new Error("Offline storage error"));
      }),
  );
}

export const idb = {
  get: (key) => tx("readonly", (s) => s.get(key)),
  set: (key, value) => tx("readwrite", (s) => s.put(value, key)),
  del: (key) => tx("readwrite", (s) => s.delete(key)),
  /** Writes several keys in ONE transaction (all-or-nothing). */
  setMany: (entries) =>
    tx("readwrite", (s) => {
      for (const [k, v] of entries) s.put(v, k);
    }),
};

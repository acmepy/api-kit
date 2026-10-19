// idb-keyval's UseStore API accepts a transaction callback. Manage the
// database schema here because createStore() cannot add stores to an
// existing database.
const databases = new WeakMap();

export function sharedDatabaseStore(factory, dbName, storeName) {
  let byName = databases.get(factory);
  if (!byName) databases.set(factory, byName = new Map());
  let state = byName.get(dbName);
  if (!state) byName.set(dbName, state = { db: null, queue: Promise.resolve() });

  return (mode, callback) => {
    const task = state.queue.then(async () => {
      const db = await ensureStore(factory, dbName, storeName, state);
      const transaction = db.transaction(storeName, mode);
      const completed = new Promise((resolve, reject) => {
        transaction.addEventListener("complete", resolve, { once: true });
        transaction.addEventListener("abort", () => reject(transaction.error || new Error("Transaccion IndexedDB cancelada")), { once: true });
      });
      try {
        const [result] = await Promise.all([callback(transaction.objectStore(storeName)), completed]);
        return result;
      } catch (error) {
        // A callback may fail synchronously before Promise.all observes the
        // transaction promise. Always handle its rejection as well.
        completed.catch(() => {});
        try { transaction.abort(); } catch { /* Already completed. */ }
        throw error;
      }
    });
    state.queue = task.catch(() => {});
    return task;
  };
}

async function ensureStore(factory, dbName, storeName, state) {
  while (true) {
    const db = state.db || await openDatabase(factory, dbName, storeName, state);
    if (db.objectStoreNames.contains(storeName)) return db;
    const version = db.version + 1;
    db.close();
    state.db = null;
    try {
      await openDatabase(factory, dbName, storeName, state, version);
    } catch (error) {
      // Another tab may have added a store first. Reopen the current
      // version and check again rather than replacing the database.
      if (error.name !== "VersionError") throw error;
    }
  }
}

function openDatabase(factory, dbName, storeName, state, version) {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = version === undefined ? factory.open(dbName) : factory.open(dbName, version);
    request.onblocked = () => {
      blocked = true;
      reject(new Error(`La actualizacion de IndexedDB "${dbName}" esta bloqueada por otra conexion. Cierra las otras pestanas y reintenta.`));
    };
    request.onupgradeneeded = () => {
      if (blocked) {
        request.transaction.abort();
        return;
      }
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      state.db = db;
      const close = () => {
        db.close();
        if (state.db === db) state.db = null;
      };
      db.onversionchange = close;
      db.onclose = close;
      resolve(db);
    };
  });
}

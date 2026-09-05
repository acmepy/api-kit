# Tareas de corrección — api-kit

Instrucciones para corregir los issues encontrados en el análisis del proyecto.
Cada tarea es independiente. Ejecutarlas en el orden indicado (de mayor a menor severidad).
Antes de cada cambio, verificar que el fragmento `TARGET` siga existiendo tal cual en el archivo.
Después de todas las correcciones, ejecutar `npm test` y asegurarse de que pase sin errores.

---

## TAREA 1 — 🔴 Secret JWT hardcodeado

**Archivo:** `src/server/utils/normalize.js`  
**Línea:** 38  
**Problema:** Si `IAM_SECRET` no está definida, el JWT se firma con `"api-dev-secret"`, un secreto público del repo que permite forjar tokens.

**TARGET (texto exacto a reemplazar):**
```js
  return {loginPath: "/login", sessionPath: "/session", logoutPath: "/logout", secret: process.env.IAM_SECRET || "api-dev-secret", tokenExpiresIn: auth?.tokenExpiresIn || "1h", adapter: auth?.adapter, models: auth?.models, ...auth};
```

**REEMPLAZO:**
```js
  const secret = process.env.IAM_SECRET;
  if (!secret) throw new Error("La variable de entorno IAM_SECRET es requerida para firmar tokens JWT");
  return {loginPath: "/login", sessionPath: "/session", logoutPath: "/logout", secret, tokenExpiresIn: auth?.tokenExpiresIn || "1h", adapter: auth?.adapter, models: auth?.models, ...auth};
```

> ⚠️ IMPORTANTE: Los tests que llaman a `normalizeAuthBackendConfig` sin `IAM_SECRET` definida van a fallar. Revisar `tests/auth.test.js` y establecer `process.env.IAM_SECRET = "test-secret"` en el setup de esos tests.

---

## TAREA 2 — 🟠 `update` devuelve datos incorrectos

**Archivo:** `src/server/base/base-service.js`  
**Líneas:** 93–102  
**Problema:** `Model.update()` retorna `[affectedCount]`. `instance` siempre es un número, `instance?.toJSON()` siempre es `undefined`. La respuesta devuelve el `payload` crudo (incluyendo `__uniqueId`) en lugar del registro real actualizado.

**TARGET:**
```js
  async update({ params, query, body, transaction = null } = {}) {
    const context = getContext();
    const { masterBody, include, hasDetails } = this.#masterDetailsContext(body);
    //const pk = this.#primaryKeyAttribute();
    const pk = this.#model.primaryKeyAttribute;
    const data = await this.#schemas.update.validate({ ...masterBody, __uniqueId: params.id });
    const payload = hasDetails ? { ...(body || {}), ...data, [pk]: params.id } : data;
    const [instance] = await this.#model.update(payload, { where: { [pk]: params.id }, ...(hasDetails && { include }), ...(transaction && { transaction }) });
    return { data: instance?.toJSON() || payload };
  }
```

**REEMPLAZO:**
```js
  async update({ params, query, body, transaction = null } = {}) {
    const { masterBody, include, hasDetails } = this.#masterDetailsContext(body);
    const pk = this.#model.primaryKeyAttribute;
    const data = await this.#schemas.update.validate({ ...masterBody, __uniqueId: params.id });
    const payload = hasDetails ? { ...(body || {}), ...data, [pk]: params.id } : data;
    await this.#model.update(payload, { where: { [pk]: params.id }, ...(hasDetails && { include }), ...(transaction && { transaction }) });
    const updated = await this.#model.findByPk(params.id, { plain: true, ...(transaction && { transaction }) });
    if (!updated) throw new NotFoundError(params.id || this.#model.modelName);
    return { data: updated };
  }
```

---

## TAREA 3 — 🟠 `updateDetail` devuelve `data: undefined`

**Archivo:** `src/server/base/base-service.js`  
**Líneas:** 123–133  
**Problema:** Mismo problema que TAREA 2. `target.update()` retorna `[affectedCount]`. `instance` es un número, `instance?.toJSON()` es `undefined`.

**TARGET:**
```js
  async updateDetail({ params, query, body, transaction = null } = {}) {
    const context = getContext();
    //const {name, target, primaryKey, foreignKey} = this.#detailDescriptor(params.detail);
    const { model: target, foreignKey } = this.#model.getAssociationIncludes().find(a => a.as == params.detail)
    const data = await target.resourceSchemas.update.validate(body)
    const [name, primaryKey] = [params.detail, target?.primaryKeyAttribute || "id"];
    const where = { [primaryKey]: params.detailId || body[primaryKey], [foreignKey]: params.id }
    const [instance] = await target.update(data, { where, ...(transaction && { transaction }) })
    if (!instance) throw new NotFoundError(name);
    return { data: instance?.toJSON() }
  }
```

**REEMPLAZO:**
```js
  async updateDetail({ params, query, body, transaction = null } = {}) {
    const { model: target, foreignKey } = this.#model.getAssociationIncludes().find(a => a.as == params.detail)
    const data = await target.resourceSchemas.update.validate(body)
    const [name, primaryKey] = [params.detail, target?.primaryKeyAttribute || "id"];
    const where = { [primaryKey]: params.detailId || body[primaryKey], [foreignKey]: params.id }
    const [affectedCount] = await target.update(data, { where, ...(transaction && { transaction }) })
    if (!affectedCount) throw new NotFoundError(name);
    const updated = await target.findOne({ where, plain: true, ...(transaction && { transaction }) });
    return { data: updated }
  }
```

---

## TAREA 4 — 🟠 `IndexedDbAdapter` no implementa el contrato de `BaseAdapter`

**Archivo:** `src/client/adapters/indexed-db-adapter.js`  
**Problema:** El adapter tiene `set/remove` en lugar de `put/delete`, y no implementa `getAll`, `add` ni `clear`. El contrato de `BaseAdapter` define `getAll`, `get`, `add`, `put`, `delete`, `clear`.

**Reemplazar el archivo completo con:**
```js
import { BaseAdapter } from "./base-adapter.js";

export class IndexedDbAdapter extends BaseAdapter {
  #dbName;
  #storeName;
  #indexedDB;
  #dbPromise = null;

  constructor(options = {}) {
    super();
    this.#indexedDB = options.indexedDB || globalThis.indexedDB;
    if (!this.#indexedDB) throw new Error("IndexedDbAdapter requiere indexedDB");
    this.#dbName = options.dbName || "api";
    this.#storeName = options.storeName || "session";
  }

  async getAll() {
    return this.#transaction("readonly", (store) => store.getAll());
  }

  async get(key) {
    return this.#transaction("readonly", (store) => store.get(key));
  }

  async add(value) {
    if (Array.isArray(value)) {
      for (const item of value) await this.put(item?.id, item);
      return value;
    }
    await this.put(value?.id, value);
    return value;
  }

  async put(key, value) {
    await this.#transaction("readwrite", (store) => store.put(value, key));
    return value;
  }

  async delete(key) {
    await this.#transaction("readwrite", (store) => store.delete(key));
  }

  async clear() {
    await this.#transaction("readwrite", (store) => store.clear());
  }

  async #transaction(mode, action) {
    const db = await this.#db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.#storeName, mode);
      const request = action(tx.objectStore(this.#storeName));
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  #db() {
    if (this.#dbPromise) return this.#dbPromise;
    this.#dbPromise = new Promise((resolve, reject) => {
      const request = this.#indexedDB.open(this.#dbName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(this.#storeName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.#dbPromise;
  }
}
```

---

## TAREA 5 — 🟡 Header `x-user-id` confiado para auditoría

**Archivo:** `src/server/context/request-context.js`  
**Línea:** 12  
**Problema:** Si no hay sesión autenticada, el `userId` del audit se toma del header HTTP que envía el cliente — cualquiera puede falsificarlo.

**TARGET:**
```js
      userId: req.user?.id || req.headers["x-user-id"] || req.headers["x-usuario-id"] || null,
```

**REEMPLAZO:**
```js
      userId: req.user?.id || null,
```

---

## TAREA 6 — 🟡 CORS permisivo por defecto

**Archivo:** `src/server/api.js`  
**Línea:** 40  
**Problema:** Si el usuario no configura `cors`, se permite automáticamente `localhost:5173`. El default seguro es `false`.

**TARGET:**
```js
    cors: conf.cors ?? { origin: "http://localhost:5173" },
```

**REEMPLAZO:**
```js
    cors: conf.cors ?? false,
```

---

## TAREA 7 — 🔵 Variables `context` declaradas sin usar

**Archivo:** `src/server/base/base-service.js`  
**Problema:** `const context = getContext()` se declara en 7 métodos pero sólo se consume en `list`. En los demás es ruido que genera advertencias de linter.  
**Métodos afectados:** `get` (L70), `create` (L85), `update` (ya eliminada en TAREA 2), `remove` (L105), `createDetail` (L114), `updateDetail` (ya eliminada en TAREA 3), `removeDetail` (L136).

Para cada uno de los siguientes, eliminar la línea `const context = getContext();`:

### 7a — `get`
**TARGET:**
```js
  async get({ params, query, body, transaction = null } = {}) {
    const context = getContext();
    const instance = await this.#model.findByPk(params.id, { plain: true, ...(transaction && { transaction }) });
```
**REEMPLAZO:**
```js
  async get({ params, query, body, transaction = null } = {}) {
    const instance = await this.#model.findByPk(params.id, { plain: true, ...(transaction && { transaction }) });
```

### 7b — `create`
**TARGET:**
```js
  async create({ params, query, body, transaction = null } = {}) {
    const context = getContext();
    const { masterBody, include, hasDetails } = this.#masterDetailsContext(body);
```
**REEMPLAZO:**
```js
  async create({ params, query, body, transaction = null } = {}) {
    const { masterBody, include, hasDetails } = this.#masterDetailsContext(body);
```

### 7c — `remove`
**TARGET:**
```js
  async remove({ params, query, body, transaction = null } = {}) {
    const context = getContext();
    const instance = await this.#model.findByPk(params.id, { ...(transaction && { transaction }) });
```
**REEMPLAZO:**
```js
  async remove({ params, query, body, transaction = null } = {}) {
    const instance = await this.#model.findByPk(params.id, { ...(transaction && { transaction }) });
```

### 7d — `createDetail`
**TARGET:**
```js
  async createDetail({ params, query, body, transaction = null } = {}) {
    const context = getContext();
    //const {target, foreignKey} = this.#detailDescriptor(params.detail);
```
**REEMPLAZO:**
```js
  async createDetail({ params, query, body, transaction = null } = {}) {
    //const {target, foreignKey} = this.#detailDescriptor(params.detail);
```

### 7e — `removeDetail`
**TARGET:**
```js
  async removeDetail({ params, query, body, transaction = null } = {}) {
    const context = getContext();
    //const {name, target, primaryKey, foreignKey} = this.#detailDescriptor(params.detail);
```
**REEMPLAZO:**
```js
  async removeDetail({ params, query, body, transaction = null } = {}) {
    //const {name, target, primaryKey, foreignKey} = this.#detailDescriptor(params.detail);
```

Después de eliminar los usos, verificar si `getContext` sigue siendo importado desde algún otro uso en el mismo archivo. Si no queda ninguna referencia a `getContext`, eliminar también la línea de import:
```js
import { getContext } from "../context/request-context.js";
```

---

## TAREA 8 — 🔵 Eliminar función muerta `#parseFilterKey`

**Archivo:** `src/server/base/base-service.js`  
**Problema:** Método privado nunca invocado.

**TARGET (eliminar este bloque completo):**
```js
  #parseFilterKey(key) {
    const normalizedKey = String(key);
    const bracket = normalizedKey.match(/^(.+)\[([^\]]+)\]$/);
    const dotted = normalizedKey.match(/^(.+)\.([^.]+)$/);
    const underscored = normalizedKey.match(/^(.+)__([^_]+)$/);
    const match = bracket || dotted || underscored;
    const field = match ? match[1] : normalizedKey;
    const operatorName = match ? match[2] : "eq";
    const operator = FILTER_OPERATORS[operatorName];

    if (!operator) throw new ValidationError(`Operador de filtro "${operatorName}" no está soportado`);
    return { field, operator };
  }
```

**REEMPLAZO:** _(nada — eliminar el bloque completo)_

---

## TAREA 9 — 🔵 Eliminar función muerta `buildYepSchemas`

**Archivo:** `src/client/services/base-service.js`  
**Problema:** Función no exportada, no referenciada en ningún lado.

**TARGET (eliminar este bloque completo):**
```js
function buildYepSchemas(schemas) {
  return Object.fromEntries(
    Object.entries(schemas || {}).map(([name, schema]) => [name, yep.fromJsonSchema(schema)]),
  );
}
```

**REEMPLAZO:** _(nada — eliminar el bloque completo)_

---

## TAREA 10 — ⚪ Typo en `BaseAdapter.delete`

**Archivo:** `src/client/adapters/base-adapter.js`  
**Línea:** 20

**TARGET:**
```js
    throw new Error("BaseAdapter.det debe implementarse");
```

**REEMPLAZO:**
```js
    throw new Error("BaseAdapter.delete debe implementarse");
```

---

## TAREA 11 — ⚪ Variable `tmp` sin nombre semántico en `#buildWhere`

**Archivo:** `src/server/base/base-service.js`  
**Línea:** 280  
**Problema:** La variable `tmp` capture el match completo del regex pero nunca se usa.

**TARGET:**
```js
      const [tmp, attribute, operator = 'eq'] = key.match(/^([a-zA-Z0-9_]+)\[([a-zA-Z0-9_]+)\]$/) || ['', key];
```

**REEMPLAZO:**
```js
      const [, attribute, operator = 'eq'] = key.match(/^([a-zA-Z0-9_]+)\[([a-zA-Z0-9_]+)\]$/) || ['', key];
```

---

## TAREA 12 — ⚪ `update` en `client/base-service` lanza objeto crudo como error

**Archivo:** `src/client/services/base-service.js`  
**Línea:** 62  
**Problema:** `throw ret` lanza el objeto resultado (sin `instanceof Error`), rompiendo el contrato de error estándar de JS.

**TARGET:**
```js
    const ret = await this.pushOne(data);
    if(!ret.ok) throw ret;
    return { ok: true, data };
```

**REEMPLAZO:**
```js
    const ret = await this.pushOne(data);
    if (!ret.ok) {
      const error = new Error(ret.error || "Error al sincronizar operación pendiente");
      error.errors = ret.errors || null;
      error.response = ret;
      throw error;
    }
    return { ok: true, data };
```

---

## Verificación final

Una vez aplicadas todas las correcciones:

```bash
npm test
```

Todos los tests deben pasar. Si algún test falla por la TAREA 1 (IAM_SECRET), buscar en los archivos de test llamadas a `normalizeAuthBackendConfig` o a `createApi` con `auth` configurado, y agregar `process.env.IAM_SECRET = "test-secret"` en el setup correspondiente.

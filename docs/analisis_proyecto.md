# Análisis del Proyecto api-kit

> Revisión de errores, código duplicado y problemas de seguridad.

---

## 1. Código muerto / funciones no utilizadas

### `#parseFilterKey` — método privado nunca llamado
**Archivo:** [`base-service.js`](file:///c:/tmp/api-kit/src/server/base/base-service.js#L314-L326)

El método `#parseFilterKey` existe pero nunca se invoca. El código que lo usaba fue reemplazado por lógica inline en `#buildWhere`, pero el método se quedó huérfano.

```js
// Nunca invocado (L314–L326)
#parseFilterKey(key) {
  const normalizedKey = String(key);
  const bracket = normalizedKey.match(/^(.+)\[([^\]]+)\]$/);
  ...
}
```

---

### `buildYepSchemas` — función no exportada ni usada
**Archivo:** [`client/services/base-service.js`](file:///c:/tmp/api-kit/src/client/services/base-service.js#L287-L291)

Definida al final del archivo, no se exporta ni se referencia en ningún otro lado.

```js
// Código muerto (L287–L291)
function buildYepSchemas(schemas) {
  return Object.fromEntries(
    Object.entries(schemas || {}).map(([name, schema]) => [name, yep.fromJsonSchema(schema)]),
  );
}
```

---

### Variables `context` declaradas pero nunca usadas (×6)
**Archivo:** [`base-service.js`](file:///c:/tmp/api-kit/src/server/base/base-service.js)

En los métodos `get`, `create`, `update`, `remove`, `createDetail`, `updateDetail` y `removeDetail` se declara `const context = getContext()` pero la variable nunca se utiliza dentro de esos métodos (sólo `list` la usa para `context?.baseUrl`).

```js
async get({ params, query, body, transaction = null } = {}) {
  const context = getContext(); // ← no se usa
  ...
}
async create({ ... }) {
  const context = getContext(); // ← no se usa
  ...
}
// idem en update, remove, createDetail, updateDetail, removeDetail
```

---

### Código comentado extenso (ruido de mantenimiento)
**Archivo:** [`base-service.js`](file:///c:/tmp/api-kit/src/server/base/base-service.js#L167-L250)

Hay ~80 líneas de código comentado (`#detailDescriptors`, `#detailDescriptor`, `#association`, `#enrichJsonSchema`, `#enrichPropertySchema`, `#resourceName`). Esto no es un error per se, pero aumenta la deuda de mantenimiento y puede confundir a futuros colaboradores.

---

## 2. Funciones duplicadas / lógica repetida

### `normalizeAuth` duplicada en dos módulos
La misma lógica de normalización de `auth` existe en dos lugares con implementaciones casi idénticas:

| Archivo | Función |
|---|---|
| [`config-normalizer.js:58`](file:///c:/tmp/api-kit/src/server/config/config-normalizer.js#L58-L68) | `function normalizeAuth(auth)` (privada) |
| [`schema.services.js:42`](file:///c:/tmp/api-kit/src/server/install/schema.services.js#L42-L47) | `export function normalizeRouteAuth(auth)` |
| [`utils/normalize.js:29`](file:///c:/tmp/api-kit/src/server/utils/normalize.js#L29-L34) | `export function normalizeGlobalAuth(auth)` |

Las tres funciones hacen esencialmente lo mismo: colapsar `auth` a `{ required, strategies }`. La diferencia es que `normalizeGlobalAuth` añade `tokenExpiresIn: "1h"` cuando `auth === true`. Se podría unificar en una sola función con un parámetro de opciones.

---

## 3. Errores de lógica

### `update` devuelve el payload en vez del registro actualizado cuando `Model.update` retorna un número
**Archivo:** [`base-service.js:100-101`](file:///c:/tmp/api-kit/src/server/base/base-service.js#L100-L101)

```js
const [instance] = await this.#model.update(payload, { ... });
return { data: instance?.toJSON() || payload };
```

En Sequelize, `Model.update()` devuelve `[affectedCount]` (un número entero), **no** un array de instancias. Por lo tanto `instance` siempre es un número, `instance?.toJSON()` es siempre `undefined`, y la respuesta siempre devuelve el `payload` crudo (sin procesar) en lugar del registro real de la base de datos. Esto puede exponer campos que deberían filtrarse (p.ej. `__uniqueId`).

El comportamiento correcto sería hacer un `findByPk` después del `update` para devolver el registro actualizado, o usar `returning: true` (solo PostgreSQL).

---

### `updateDetail` — el mismo problema
**Archivo:** [`base-service.js:130-132`](file:///c:/tmp/api-kit/src/server/base/base-service.js#L130-L132)

```js
const [instance] = await target.update(data, { where, ... });
if (!instance) throw new NotFoundError(name);
return { data: instance?.toJSON() }
```

Mismo problema: `instance` es el `affectedCount`. Si ninguna fila matchea, `affectedCount === 0` (falsy), y lanza `NotFoundError` correctamente por accidente, pero si sí hay match, `instance` es `1` (truthy), y se intenta llamar `(1)?.toJSON()` que retorna `undefined`. La respuesta `data` siempre es `undefined`.

---

### `IndexedDbAdapter` no implementa la interfaz de `BaseAdapter`
**Archivo:** [`indexed-db-adapter.js`](file:///c:/tmp/api-kit/src/client/adapters/indexed-db-adapter.js) vs [`base-adapter.js`](file:///c:/tmp/api-kit/src/client/adapters/base-adapter.js)

`BaseAdapter` define: `getAll`, `get`, `add`, `put`, `delete`, `clear`.
`IndexedDbAdapter` implementa: `get`, `set`, `remove` — con **nombres distintos** a los del contrato.

| BaseAdapter | IndexedDbAdapter |
|---|---|
| `add()` | ❌ no existe |
| `put()` | ❌ no existe — tiene `set()` |
| `delete()` | ❌ no existe — tiene `remove()` |
| `getAll()` | ❌ no existe |
| `clear()` | ❌ no existe |

El adapter actúa como silo de sesión y no parece usarse directamente a través del contrato `BaseAdapter`, pero la inconsistencia es un error de diseño que puede causar bugs si alguien lo usa en otro contexto.

---

### Typo en `BaseAdapter.delete`
**Archivo:** [`base-adapter.js:20`](file:///c:/tmp/api-kit/src/client/adapters/base-adapter.js#L19-L21)

```js
async delete() {
  throw new Error("BaseAdapter.det debe implementarse"); // ← "det" en vez de "delete"
}
```

---

### `normalizeTimeout` no acepta `0` como valor válido
**Archivo:** [`client/utils.js:13-16`](file:///c:/tmp/api-kit/src/client/utils.js#L13-L16)

```js
export function normalizeTimeout(value, fallback) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : fallback;
}
```

`timeout > 0` descarta `0`. Si alguien quiere desactivar un timeout poniendo `0`, caería al fallback. Comparar con `normalizeCacheTimeout` en `api-client.js` que sí acepta `>= 0`.

---

### `schemas` mutado a nivel de instancia vía `#yepSchema`
**Archivo:** [`client/services/base-service.js:249-254`](file:///c:/tmp/api-kit/src/client/services/base-service.js#L249-L254)

```js
async #yepSchema(operation) {
  if (!this.schemas) {
    ...
    this.schemas = schemas; // ← mutación directa de propiedad pública
  }
  ...
}
```

`this.schemas` es una propiedad pública (no privada). Esto puede sobrescribirse desde fuera de la instancia accidentalmente. Debería usarse una propiedad privada (`#schemas`). Además el comentario en la línea 12 (`//this.schemas = schemas;`) muestra que ya hubo inconsistencia aquí.

---

## 4. Problemas de seguridad

### 🔴 SECRET por defecto hardcodeado en el código fuente
**Archivo:** [`utils/normalize.js:38`](file:///c:/tmp/api-kit/src/server/utils/normalize.js#L38)

```js
secret: process.env.IAM_SECRET || "api-dev-secret",
```

Si `IAM_SECRET` no está definida en producción, el JWT se firma con `"api-dev-secret"` — un secreto conocido públicamente dentro del repositorio. Cualquiera que conozca el código puede forjar tokens JWT válidos. Debería fallar explícitamente en lugar de usar un fallback:

```js
// Mejor:
secret: process.env.IAM_SECRET ?? (() => { throw new Error("IAM_SECRET es requerido"); })(),
```

---

### 🟡 Confianza en headers `x-user-id` / `x-usuario-id` para el audit
**Archivo:** [`request-context.js:12`](file:///c:/tmp/api-kit/src/server/context/request-context.js#L12)

```js
userId: req.user?.id || req.headers["x-user-id"] || req.headers["x-usuario-id"] || null,
```

Si `req.user?.id` no está disponible (request sin autenticación), el userId del audit se toma del header HTTP enviado por el cliente. Cualquier cliente puede enviar `x-user-id: admin` y falsificar la identidad en el log de auditoría. Esta rama debería eliminarse o restringirse a proxies confiables.

---

### 🟡 CORS abierto a `localhost:5173` por defecto
**Archivo:** [`api.js:40`](file:///c:/tmp/api-kit/src/server/api.js#L40)

```js
cors: conf.cors ?? { origin: "http://localhost:5173" },
```

El default de CORS debería ser `false` (restrictivo) y requerir configuración explícita, no permitir `localhost:5173` si el usuario no configura nada. En producción esto es un vector si el valor por defecto no se sobreescribe.

---

### 🟡 Stack trace expuesto en errores en no-producción
**Archivo:** [`error-handler.js:16`](file:///c:/tmp/api-kit/src/server/http/error-handler.js#L16)

```js
if (process.env.NODE_ENV !== "production") body.stack = err.stack;
```

Esto es intencional para desarrollo, pero vale documentarlo: en entornos de staging que no declaren `NODE_ENV=production`, el stack trace completo se envía al cliente.

---

### 🟡 `temporaryStorage` es estado global compartido entre instancias
**Archivo:** [`client/services/base-service.js:4`](file:///c:/tmp/api-kit/src/client/services/base-service.js#L4)

```js
let temporaryStorage; // módulo-nivel, compartido por todas las instancias
```

Si se crean múltiples instancias de `BaseService` (distintos prefijos, distintos clientes), todas comparten el mismo `temporaryStorage`. Un ID temporal generado para el cliente A podría colisionar con el del cliente B, especialmente en SSR o testing.

---

### 🟡 Path traversal mitigado pero dependiente de `path.relative`
**Archivo:** [`install.services.js:300-303`](file:///c:/tmp/api-kit/src/server/install/install.services.js#L300-L303)

```js
function assertInside(target, root, message) {
  const relative = path.relative(root, target);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return;
  throw new ValidationError(message);
}
```

La protección contra path traversal es correcta, pero depende de que `root` y `target` sean paths resueltos absolutamente. Si por algún bug alguno llegara relativo, la comparación fallaría. Estaría bien agregar `path.resolve` explícito antes de `path.relative`.

---

## 5. Otras observaciones menores

| # | Archivo | Observación |
|---|---|---|
| 1 | [`base-service.js:280`](file:///c:/tmp/api-kit/src/server/base/base-service.js#L280) | La variable `tmp` en la destructuración de `match` (`const [tmp, attribute, ...]`) nunca se usa. Debería nombrarse `_` o eliminarse. |
| 2 | [`install.services.js:29-30`](file:///c:/tmp/api-kit/src/server/install/install.services.js#L29-L30) | Hay dos rutas registradas para `/install` y `/install/` con handlers idénticos. Podría consolidarse en una. |
| 3 | [`base-service.js`](file:///c:/tmp/api-kit/src/server/base/base-service.js) | El parámetro `params` en `schema()` no existe (firma `async schema()` sin parámetros), pero la llamada desde `BaseRouter` le pasa `args = { params, query, body }`. No causa error porque se ignora, pero es inconsistente. |
| 4 | [`client/services/base-service.js:62`](file:///c:/tmp/api-kit/src/client/services/base-service.js#L62) | En `update`, cuando la operación está pendiente: `if(!ret.ok) throw ret;` lanza el objeto resultado entero como error, en vez de lanzar un `Error` estándar. Esto rompe el contrato de `instanceof Error`. |

---

## Resumen de severidad

| Severidad | Cantidad | Items |
|---|---|---|
| 🔴 Crítico | 1 | Secret JWT hardcodeado |
| 🟠 Error de lógica | 3 | `update`/`updateDetail` retorno incorrecto, `IndexedDbAdapter` no implementa interfaz |
| 🟡 Seguridad/Diseño | 5 | Header userId, CORS default, stack trace, temporaryStorage global, path traversal |
| 🔵 Código muerto | 4 | `#parseFilterKey`, `buildYepSchemas`, variables `context`, código comentado |
| ⚪ Menor | 4 | Typo en BaseAdapter, `tmp` sin uso, rutas duplicadas, `throw ret` |

# Análisis de Código: api-kit

> Documento generado para ejecución por agente. Cada sección es accionable: incluye el archivo afectado, el problema y la corrección propuesta.

---

## 1. Funciones y Código Sin Usar (Dead Code)

### 1.1 `setContextValue` — nunca llamada fuera de su módulo

**Archivo:** [`src/server/context/request-context.js`](file:///c:/tmp/proyectos/api-kit/src/server/context/request-context.js#L23-L26)

`setContextValue` está exportada pero ningún archivo dentro de `src/` ni `tests/` la importa o invoca.

**Acción:** Eliminar la función o remover el `export` si se decide conservarla como interna de emergencia.

```diff
-export function setContextValue(key, value) {
-  const ctx = getContext();
-  if (ctx) ctx[key] = value;
-}
```

---

### 1.2 `mergeConfig` — nunca usada

**Archivo:** [`src/server/utils/merge-config.js`](file:///c:/tmp/proyectos/api-kit/src/server/utils/merge-config.js)

El módulo completo existe y exporta `mergeConfig`, pero ningún otro archivo del proyecto la importa.

**Acción:** Eliminar el archivo `merge-config.js` por completo.

```bash
del "c:\tmp\proyectos\api-kit\src\server\utils\merge-config.js"
```

---

### 1.3 `loadModules` — wrapper redundante sin consumidores externos

**Archivo:** [`src/server/config/config-loader.js`](file:///c:/tmp/proyectos/api-kit/src/server/config/config-loader.js#L6-L8)

`loadModules` es un wrapper de una sola línea sobre `loadModuleBundle`. Ningún archivo fuera de este módulo la importa. `api.js` importa directamente `loadModuleBundle`.

**Acción:** Eliminar `loadModules`.

```diff
-export async function loadModules(input, baseDir) {
-  return (await loadModuleBundle(input, baseDir)).modules;
-}
```

---

### 1.4 Funciones en `naming.js` sin consumidores

**Archivo:** [`src/server/utils/naming.js`](file:///c:/tmp/proyectos/api-kit/src/server/utils/naming.js)

Las siguientes funciones están definidas y exportadas pero ningún archivo del proyecto las importa:

| Función | Línea |
|---|---|
| `snakeCase` | 5 |
| `kebabCase` | 14 |
| `fileName` | 18 |
| `applyNamingConvention` | 22 |

Solo `camelCase` y `pascalCase` tienen consumidores reales.

**Acción:** Eliminar las 4 funciones no usadas de `naming.js`.

```diff
-export function snakeCase(str) {
-  return String(str).replace(/([a-z])([A-Z])/g, "$1_$2").replace(...).toLowerCase();
-}

 export function pascalCase(str) { ... }

-export function kebabCase(str) { ... }
-export function fileName(base, suffix, ext = "js") { ... }
-export function applyNamingConvention(name, naming = {}) { ... }
```

---

### 1.5 Bloques de código comentado (dead code comentado)

Múltiples bloques de código comentado agregan ruido:

**Archivo:** [`src/server/base/base-service.js`](file:///c:/tmp/proyectos/api-kit/src/server/base/base-service.js)
- Líneas 61, 91, 109, 118, 130, 153–154, 160–233 (`#detailDescriptor`, `#enrichJsonSchema`, `#resourceName`, etc.)

**Archivo:** [`src/client/services/base-service.js`](file:///c:/tmp/proyectos/api-kit/src/client/services/base-service.js)
- Líneas 224–235 (`#applyPushedRecord`)

**Acción:** Eliminar todos los bloques comentados. El historial de git preserva el código anterior.

---

## 2. Funciones Duplicadas / Lógica Repetida

### 2.1 `normalizeAuth` está triplicada con variantes ligeramente distintas

Hay **3 implementaciones** de normalización de auth con semántica casi idéntica:

| Función | Archivo | Diferencia |
|---|---|---|
| `normalizeAuth` (privada) | [`config-normalizer.js:58`](file:///c:/tmp/proyectos/api-kit/src/server/config/config-normalizer.js#L58) | Usa `strategies || strategy` |
| `normalizeGlobalAuth` | [`normalize.js:29`](file:///c:/tmp/proyectos/api-kit/src/server/utils/normalize.js#L29) | Agrega `tokenExpiresIn: "1h"` |
| `normalizeRouteAuth` | [`schema.services.js:42`](file:///c:/tmp/proyectos/api-kit/src/server/install/schema.services.js#L42) | Idéntica a `normalizeAuth` privada |

**Problema:** `normalizeRouteAuth` en `schema.services.js` es funcionalmente idéntica a la función privada `normalizeAuth` de `config-normalizer.js`.

**Acción:** Mover una versión canónica a `normalize.js` y usarla en ambos sitios.

```diff
// normalize.js — agregar función canónica exportada
+export function normalizeAuth(auth) {
+  if (!auth) return { required: false, strategies: [] };
+  if (auth === true) return { required: true, strategies: ["bearer", "basic"] };
+  const strategies = auth.strategies || auth.strategy || ["bearer", "basic"];
+  return { ...auth, required: auth.required ?? true, strategies: Array.isArray(strategies) ? strategies : [strategies] };
+}

// schema.services.js
-export function normalizeRouteAuth(auth) { ... }
+import { normalizeAuth } from "../utils/normalize.js";
// reemplazar normalizeRouteAuth(x) por normalizeAuth(x) en todo el archivo
```

---

### 2.2 Lógica de detección de modelo de auditoría duplicada

**Archivo:** [`src/server/install/audit.services.js`](file:///c:/tmp/proyectos/api-kit/src/server/install/audit.services.js)

`findAuditModel` (línea 305) e `isAuditModule` (línea 426) buscan el módulo de auditoría con lógicas ligeramente distintas. `isAuditTableName` (línea 262) es la función canónica pero `isAuditModule` no la usa de forma centralizada.

**Acción:** Unificar. `isAuditModule` debería delegar completamente en `isAuditTableName`.

```diff
 function isAuditModule(moduleConfig) {
-  return isAuditTableName(moduleConfig?.name) || isAuditTableName(moduleConfig?.resource?.options?.tableName) || isAuditTableName(moduleConfig?.resource?.options?.modelName);
+  return [moduleConfig?.name, moduleConfig?.resource?.options?.tableName, moduleConfig?.resource?.options?.modelName]
+    .some(isAuditTableName);
 }
```

---

## 3. Problemas de Seguridad

### 3.1 CRITICAL — JWT decodificado sin verificación de firma

**Archivo:** [`src/server/install/audit.services.js`](file:///c:/tmp/proyectos/api-kit/src/server/install/audit.services.js#L241-L253)

```js
function decodeJwtPayload(token) {
  try {
    const [, payload] = token.split(".");
    return JSON.parse(Buffer.from(base64UrlToBase64(payload), "base64").toString("utf8"));
  } catch { return null; }
}
```

Este código decodifica el payload del JWT **sin verificar la firma**. Se usa para obtener `exp` y programar el cierre de conexiones SSE. Un atacante puede manipular el payload para mantener conexiones SSE abiertas indefinidamente enviando un JWT con `exp` falso.

**Acción:** Pasar `authContext` al handler de SSE y usar la librería `iam` para verificar el token antes de leer `exp`, o usar el timeout de sesión desde la configuración sin confiar en el token no verificado.

```diff
-function bearerTokenExpiresAt(req) {
+function bearerTokenExpiresAt(req, authContext) {
+  if (!authContext?.secret) return null;
   const token = bearerToken(req);
   if (!token) return null;
-  const payload = decodeJwtPayload(token);
+  try {
+    const payload = authContext.verifyToken?.(token); // usar método de iam
     const exp = Number(payload?.exp);
     return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
+  } catch { return null; }
 }
```

---

### 3.2 HIGH — `errorHandler` expone stack trace si `NODE_ENV` no está definido

**Archivo:** [`src/server/http/error-handler.js`](file:///c:/tmp/proyectos/api-kit/src/server/http/error-handler.js#L16)

```js
if (process.env.NODE_ENV !== "production") body.stack = err.stack;
```

Si `NODE_ENV` es `undefined`, la condición es `true` y se expone el stack trace. Un servidor mal configurado filtra información interna.

**Acción:**

```diff
-if (process.env.NODE_ENV !== "production") body.stack = err.stack;
+if (process.env.NODE_ENV === "development") body.stack = err.stack;
```

---

### 3.3 HIGH — Mensaje de error revela estado de configuración interna

**Archivo:** [`src/server/install/auth.services.js`](file:///c:/tmp/proyectos/api-kit/src/server/install/auth.services.js#L44)

```js
if (!authContext) return res.status(401).json({ ok: false, message: "Auth no configurado" });
```

El mensaje "Auth no configurado" distingue el estado de ausencia de config de autenticación incorrecta.

**Acción:**

```diff
-return res.status(401).json({ ok: false, message: "Auth no configurado" });
+return res.status(401).json({ ok: false, code: "UNAUTHORIZED", message: "No autorizado" });
```

---

### 3.4 MEDIUM — Path traversal potencial en `assertInside` en Windows

**Archivo:** [`src/server/install/install.services.js`](file:///c:/tmp/proyectos/api-kit/src/server/install/install.services.js#L300-L303)

```js
function assertInside(target, root, message) {
  const relative = path.relative(root, target);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return;
  throw new ValidationError(message);
}
```

En Windows, `path.relative` devuelve `..\\subdir` con backslash, que no empieza con `"../"`pero sí sale del root. Además, si `target === root`, `relative` es `""` (falsy) y lanza error incorrecto.

**Acción:**

```diff
 function assertInside(target, root, message) {
   const relative = path.relative(root, target);
-  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return;
+  const normalized = relative.replace(/\\/g, "/");
+  if (!path.isAbsolute(relative) && !normalized.startsWith("../") && normalized !== "..") return;
   throw new ValidationError(message);
 }
```

---

### 3.5 MEDIUM — `auditWriter` creado pero no expuesto ni usado

**Archivo:** [`src/server/api.js`](file:///c:/tmp/proyectos/api-kit/src/server/api.js#L77)

```js
const auditWriter = createAuditWriter(config.audit, auditResource?.model);
```

`auditWriter` se crea pero no se incluye en el objeto devuelto por `createApi`. Los consumidores no pueden hacer escrituras manuales de auditoría.

**Acción — Opción A (exponer):**
```diff
-return { app, router: mainRouter, ..., auth: authContext, close: ... };
+return { app, router: mainRouter, ..., auth: authContext, auditWriter, close: ... };
```

**Acción — Opción B (eliminar si no se necesita):**
```diff
-const auditWriter = createAuditWriter(config.audit, auditResource?.model);
```

---

### 3.6 MEDIUM — `temporaryStorage` es variable de módulo compartida entre instancias

**Archivo:** [`src/client/services/base-service.js`](file:///c:/tmp/proyectos/api-kit/src/client/services/base-service.js#L4)

```js
let temporaryStorage;
```

Esta variable de módulo es compartida entre todas las instancias de `BaseService`. Con múltiples instancias de `ApiClient` con prefijos distintos, el storage del primero se reutiliza por todos los posteriores, ignorando el `prefix`.

**Acción:**

```diff
-let temporaryStorage;
 
 export class BaseService {
+  #temporaryStorage = null;
+
   async nextTemporaryId() {
-    if (!temporaryStorage) temporaryStorage = defaultAdapter({ prefix: this.prefix, service: "temporaryKey" });
-    const record = await temporaryStorage.get("temporaryKey");
+    if (!this.#temporaryStorage) this.#temporaryStorage = defaultAdapter({ prefix: this.prefix, service: "temporaryKey" });
+    const record = await this.#temporaryStorage.get("temporaryKey");
     const value = Number(record?.value || 0) + 1;
-    await temporaryStorage.put("temporaryKey", { id: "temporaryKey", value });
+    await this.#temporaryStorage.put("temporaryKey", { id: "temporaryKey", value });
```

---

## 4. Optimizaciones

### 4.1 `normalizeModel` en `model-loader.js` — función trivialmente redundante

**Archivo:** [`src/server/loaders/model-loader.js`](file:///c:/tmp/proyectos/api-kit/src/server/loaders/model-loader.js#L32-L39)

```js
function normalizeModel(exported, name) {
  if (typeof exported === "function") {
    if (exported.prototype && typeof exported.define === "function") return exported;
    if (exported.prototype && exported.prototype.constructor) return exported;
  }
  if (typeof exported === "function" && !exported.prototype?.define) return exported;
  return exported;  // todas las ramas retornan exported
}
```

Las 3 ramas siempre retornan `exported`. La función es redundante.

**Acción:** Eliminar la función e inlinear:

```diff
-const modelClass = normalizeModel(exported, pascal);
+const modelClass = exported;
```

---

### 4.2 `fileExists` re-importa `node:fs/promises` dinámicamente en cada llamada

**Archivo:** [`src/server/utils/import-module.js`](file:///c:/tmp/proyectos/api-kit/src/server/utils/import-module.js#L17-L25)

```js
export async function fileExists(filePath) {
  const { access } = await import("node:fs/promises");
  ...
}
```

**Acción:** Mover al top-level del módulo.

```diff
+import { access } from "node:fs/promises";
 import { pathToFileURL } from "node:url";
 import path from "node:path";

 export async function fileExists(filePath) {
-  const { access } = await import("node:fs/promises");
   try {
     await access(filePath);
```

---

### 4.3 `#buildWhere` — array de un elemento en loop

**Archivo:** [`src/server/base/base-service.js`](file:///c:/tmp/proyectos/api-kit/src/server/base/base-service.js#L275-L286)

```js
const filters = [{ field: attribute, operator: FILTER_OPERATORS[operator], value }]
for (const filter of filters) { ... }
```

`filters` siempre tiene exactamente 1 elemento. El array y el `for...of` son superfluos.

**Acción:** Eliminar el array intermedio y usar la variable directamente.

---

### 4.4 Ruta `/install/` duplicada

**Archivo:** [`src/server/install/install.services.js`](file:///c:/tmp/proyectos/api-kit/src/server/install/install.services.js#L29-L30)

```js
mainRouter.get("/install", ...handlers, (_req, res) => { ... });
mainRouter.get("/install/", ...handlers, (_req, res) => { ... });  // duplicada
```

Express 5 normaliza rutas automáticamente. La doble declaración es redundante.

**Acción:**

```diff
 mainRouter.get("/install", ...handlers, (_req, res) => {res.type("html").send(renderInstallHtml(apps));});
-mainRouter.get("/install/", ...handlers, (_req, res) => {res.type("html").send(renderInstallHtml(apps))});
```

---

### 4.5 `copyDir` bloquea el event loop con operaciones síncronas

**Archivo:** [`src/server/install/install.services.js`](file:///c:/tmp/proyectos/api-kit/src/server/install/install.services.js#L245-L256)

`copyDir` usa `fs.mkdirSync`, `fs.readdirSync`, `fs.statSync`, `fs.copyFileSync`. Bloquea el event loop durante la instalación de frontends.

**Acción:** Reemplazar con `fs.promises.cp` (disponible desde Node.js 16.7):

```diff
-function copyDir(src, dest) {
-  fs.mkdirSync(dest, { recursive: true });
-  for (const file of fs.readdirSync(src)) {
-    const stat = fs.statSync(path.join(src, file));
-    if (stat.isDirectory()) copyDir(path.join(src, file), path.join(dest, file));
-    else fs.copyFileSync(path.join(src, file), path.join(dest, file));
-  }
-}
+async function copyDir(src, dest) {
+  await fs.promises.cp(src, dest, { recursive: true });
+}
```

> [!NOTE]
> Verificar que la versión mínima de Node.js del proyecto es >= 16.7 antes de aplicar.

---

## 5. Mejoras de Calidad y Mantenibilidad

### 5.1 Inconsistencia de espaciado en el prefijo del logger

**Archivo:** [`src/server/logger/index.js`](file:///c:/tmp/proyectos/api-kit/src/server/logger/index.js#L12)

```js
if (_logging === true)    return console[level]?.("[api] ["+path+"]", ...args);
if (typeof _logging === "function") return _logging("[api] [ "+path+"]", level, ...args);
//                                                          ^^^ espacio extra
```

**Acción:**

```diff
-if (typeof _logging === "function") return _logging("[api] [ "+path+"]", level, ...args);
+if (typeof _logging === "function") return _logging("[api] ["+path+"]", level, ...args);
```

---

### 5.2 `ApiClient.disconnect()` es alias de `destroy()` sin diferenciación

**Archivo:** [`src/client/api-client.js`](file:///c:/tmp/proyectos/api-kit/src/client/api-client.js#L373-L375)

```js
disconnect() {
  this.destroy();
}
```

Dos métodos públicos con el mismo comportamiento confunden a los consumidores del SDK.

**Acción:** Agregar un comentario JSDoc que documente la relación, o eliminar el alias si no hay plan de diferenciación.

---

### 5.3 Copia redundante de `modelsMap` en `createApi`

**Archivo:** [`src/server/api.js`](file:///c:/tmp/proyectos/api-kit/src/server/api.js#L102-L105)

```js
const models = new Map();
for (const mod of modelsMap) models.set(mod[0], mod[1]);
```

`modelsMap` ya es un `Map`. Se puede copiar directamente.

**Acción:**

```diff
-const models = new Map();
-for (const mod of modelsMap) models.set(mod[0], mod[1]);
+const models = new Map(modelsMap);
```

---

### 5.4 `numberPrecision` y `numberScale` son wrappers triviales de acceso a propiedad

**Archivo:** [`src/server/config/config-resource.js`](file:///c:/tmp/proyectos/api-kit/src/server/config/config-resource.js#L86-L92)

```js
function numberPrecision(definition) { return definition.precision; }
function numberScale(definition) { return definition.scale; }
```

**Acción:** Inlinear y eliminar las funciones:

```diff
-  decimal: (definition) => DataTypes.DECIMAL(numberPrecision(definition), numberScale(definition)),
-  number: (definition) => DataTypes.NUMBER(numberPrecision(definition), numberScale(definition)),
+  decimal: (definition) => DataTypes.DECIMAL(definition.precision, definition.scale),
+  number: (definition) => DataTypes.NUMBER(definition.precision, definition.scale),

-function numberPrecision(definition) { return definition.precision; }
-function numberScale(definition) { return definition.scale; }
```

---

## 6. Resumen de Prioridades

| Severidad | ID | Archivo | Problema |
|---|---|---|---|
| CRITICAL | 3.1 | `audit.services.js` | JWT decodificado sin verificar firma |
| HIGH | 3.2 | `error-handler.js` | Stack trace expuesto si `NODE_ENV` no definido |
| HIGH | 3.3 | `auth.services.js` | Mensaje de error revela estado de config |
| MEDIUM | 3.6 | `client/base-service.js` | `temporaryStorage` compartido entre instancias |
| MEDIUM | 3.4 | `install.services.js` | Path traversal en Windows (`assertInside`) |
| MEDIUM | 3.5 | `api.js` | `auditWriter` creado pero no expuesto ni usado |
| LOW | 2.1 | múltiples | `normalizeAuth` triplicada |
| LOW | 1.x | múltiples | Dead code: funciones sin consumidores |
| LOW | 4.x | múltiples | Optimizaciones de rendimiento y claridad |
| LOW | 5.x | múltiples | Calidad y consistencia de código |

---

## 7. Orden de Ejecución para el Agente

```
1. Fix 3.1 (JWT sin verificar)      — cambio funcional crítico, requiere análisis de API iam
2. Fix 3.2 (NODE_ENV)               — 1 línea, cero riesgo
3. Fix 3.3 (mensaje auth)           — 1 línea, cero riesgo
4. Fix 3.6 (temporaryStorage)       — client-side, bajo riesgo
5. Fix 3.4 (assertInside Windows)   — verificar con test path traversal
6. Fix 3.5 (auditWriter)            — requiere decisión de API pública
7. Fix 1.1–1.4 (dead code)          — correr `npm test` después de cada grupo
8. Fix 2.1 (normalizeAuth)          — refactor con tests existentes como red de seguridad
9. Fix 4.x y 5.x                    — optimizaciones y calidad
10. `npm test` final completo
```

# api

`api` arma APIs REST sobre Express a partir de modulos declarativos, modelos de `seq`, validaciones, IAM, auditoria, OpenAPI/Postman y apps estaticas. Tambien incluye un cliente browser/Node con cache local, operaciones pendientes, actualizaciones incrementales via `changes` e instantaneas por SSE.

## Instalacion

```bash
npm install
```

Para correr el ejemplo:

```bash
npm run dev
```

El server queda en `http://localhost:3000`:

- `http://localhost:3000/basic`: ejemplo simple que usa `fetch` directo.
- `http://localhost:3000/client`: ejemplo con `api/client`, cache local, pending, push, changes y SSE.
- `http://localhost:3000/api`: API generada.
- `http://localhost:3000/api/openapi.json`: OpenAPI.
- `http://localhost:3000/api/schema.json`: manifiesto de servicios y schemas para el cliente.
- `http://localhost:3000/api/postman.json`: coleccion Postman.

Usuario del ejemplo:

```txt
admin / 1234
```

## Entrypoints

El paquete se importa por subpath explicito:

```js
import { createApi } from "api/server";
import { SeqAdapter } from "iam/adapters";
import { createLogger, logger, LEVELS } from "logger";
import { createApiClient } from "api/client";
import { runApiKitCli } from "api/cli";
```

El import raiz `api` no exporta API publica.

## Server Basico

```js
import { createApi } from "api/server";
import { Seq, SQLiteAdapter } from "seq";

const adapter = new SQLiteAdapter({
  database: "./data/app.sqlite",
  naming: {
    tables: "snake_case",
    columns: "snake_case",
  },
});

const seq = new Seq({ adapter, logging: false });
const iamAdapter = new SeqAdapter({ seq });

createLogger({ name: "[api]", displayConsole: true, level: LEVELS.INFO });

const api = await createApi({
  seq,
  basePath: "/api",
  modules: "./example/modules.js",
  auth: {
    adapter: iamAdapter,
    secret: process.env.IAM_SECRET || "dev-secret",
    strategies: ["bearer", "basic"],
    tokenExpiresIn: process.env.IAM_TOKEN_EXPIRES_IN || "1h",
  },
  audit: true,
  openapi: true,
  schema: true,
  postman: true,
  logging: logger,
});

await seq.authenticate();
await seq.sync();

api.app.listen(3000);
```

`createApi()` devuelve:

- `app`: instancia Express.
- `router`: router principal montado.
- `errorHandler`: middleware de errores.
- `modules`, `models`, `services`, `schemas`: mapas internos generados.
- `routes`: registro de rutas.
- `events`: `EventEmitter` de audit.
- `audit.sseClients()`: lista basica de clientes SSE activos.
- `auth`: contexto IAM, si auth esta habilitado.
- `close()`: limpia listeners internos.

Si pasas `app`, `api` usa tu instancia Express. Si no, crea una. `json` esta activo por defecto y monta `express.json()`.

## Seq

`api` usa `seq` como ORM. La configuracion de naming pertenece al adapter de `seq`, no a `createApi`.

```js
const adapter = new SQLiteAdapter({
  database: ":memory:",
  naming: {
    tables: "snake_case",
    columns: "snake_case",
  },
});

const seq = new Seq({ adapter, logging: false });
```

Los modelos creados desde modulos declarativos se registran en `seq`, se sincronizan con `seq.sync()` y se usan para generar CRUD, schemas, audit y relaciones maestro-detalle.

## IAM

La autenticacion se delega a `iam`. Con `auth` habilitado, `api` registra bajo `basePath`:

- `POST /login`
- `GET /session`
- `POST /logout`

Con `basePath: "/api"`, quedan como:

```http
POST /api/login
GET /api/session
POST /api/logout
```

Configuracion tipica:

```js
auth: {
  secret: process.env.IAM_SECRET || "dev-secret",
  strategies: ["bearer", "basic"],
  tokenExpiresIn: process.env.IAM_TOKEN_EXPIRES_IN || "1h",
}
```

`tokenExpiresIn` controla la vigencia del Bearer JWT. Las rutas protegidas usan permisos generados por ruta, por ejemplo `clientes.list`, `clientes.create` o `audit.sse`.

## Logger

`logging` puede ser `false`, `true`, una funcion o un objeto tipo logger. Cuando `auth` esta habilitado, el mismo logger se reenvia a `iam`; se puede sobrescribir solo para autenticacion con `auth.logging`.

```js
const logger = {
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

const api = await createApi({
  seq,
  modules,
  logging: logger,
});
```

Con `true`, `api` usa `console`. Con objeto, llama `logger.info`, `logger.warn` y `logger.error` cuando existan.

## Modulos

`modules` define recursos REST y apps estaticas.

```js
export const modules = [
  {
    mountPath: "/client",
    path: "./example/public/client",
  },
  {
    modelName: "Cliente",
    tableName: "clientes",
    timestamps: true,
    attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      ruc: { type: "string", maxLength: 20, unique: true },
      nombre: { type: "string", maxLength: 100, allowNull: false },
      email: { type: "string", maxLength: 150, allowNull: true, unique: true, email: true },
      activo: { type: "boolean", defaultValue: true },
    },
  },
];
```

Para un recurso `clientes`, se generan:

| Metodo | Path | Accion |
| --- | --- | --- |
| `GET` | `/api/clientes` | Listar |
| `GET` | `/api/clientes/:id` | Obtener por ID |
| `POST` | `/api/clientes` | Crear |
| `PUT` | `/api/clientes/:id` | Actualizar |
| `DELETE` | `/api/clientes/:id` | Eliminar |
| `GET` | `/api/clientes/schema` | Schema |

Los bodies de `POST` y `PUT` se validan con schemas generados desde `attributes`. Los campos no declarados se rechazan.

## Maestro Detalle

El ejemplo incluye `ventas` con detalles `items`.

```js
{
  modelName: "Venta",
  tableName: "ventas",
  timestamps: true,
  attributes: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    cliente: { type: "string", allowNull: false },
    fecha: { type: "date", allowNull: false },
    total: { type: "decimal", precision: 12, scale: 2, allowNull: false, defaultValue: 0 },
  },
  details: [
    {
      name: "items",
      foreignKey: "ventaId",
      modelName: "VentaItem",
      tableName: "venta_items",
      attributes: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        ventaId: { type: "integer", allowNull: false, create: false, update: false },
        producto: { type: "string", allowNull: false },
        cantidad: { type: "integer", allowNull: false, min: 1 },
        precio: { type: "decimal", precision: 12, scale: 2, allowNull: false, min: 0 },
      },
      removeMissing: true,
    },
  ],
}
```

Al crear o actualizar el maestro puedes enviar los detalles en el mismo body. Si `removeMissing: true`, los detalles omitidos en update se eliminan.

```http
POST /api/ventas
Content-Type: application/json

{
  "cliente": "Ana",
  "fecha": "2026-08-04T12:00:00.000Z",
  "total": 150000,
  "items": [
    { "producto": "Mouse", "cantidad": 1, "precio": 50000 }
  ],
  "cobros": [
    { "medio": "efectivo", "monto": 150000 }
  ]
}
```

Tambien se generan endpoints de detalle:

```http
POST /api/ventas/1/items
PUT /api/ventas/1/items/1
DELETE /api/ventas/1/items/1
```

## Filtros y Paginacion

`GET /api/clientes` soporta paginacion y filtros por query string.

```http
GET /api/clientes?page=1&limit=20
GET /api/clientes?activo=true
GET /api/clientes?nombre[in]=Ana,Jose
GET /api/clientes?createdAt[between]=2026-01-01,2026-01-31
```

Operadores soportados:

| Operador | Alias | Uso |
| --- | --- | --- |
| `eq` | `equal`, `igual` | Igualdad |
| `gt` | `greater`, `mayor` | Mayor que |
| `gte` | `greaterOrEqual`, `mayorIgual` | Mayor o igual |
| `lt` | `less`, `menor` | Menor que |
| `lte` | `lessOrEqual`, `menorIgual` | Menor o igual |
| `in` | `incluido` | Lista separada por comas |
| `between` | - | Rango con dos valores |

Tambien se aceptan variantes:

```http
GET /api/productos?precio[mayor]=10
GET /api/productos?precio.mayor=10
GET /api/productos?precio__mayor=10
```

## Audit, Changes y SSE

Con `audit: true`, `api` registra cambios de recursos auditables en la tabla `audit`.

Rutas generadas:

- `GET /api/changes?since=ISO_DATE`
- `GET /api/sse`

`changes` devuelve cambios desde una fecha. `sse` mantiene una conexion `text/event-stream` y envia eventos en vivo:

```txt
event: audit
data: {"tableName":"clientes","rowId":"1","action":"update","old":{},"new":{}}
```

Si auth esta habilitado:

- `changes` y `sse` requieren permisos (`audit.changes`, `audit.sse`).
- Cada cambio se filtra por permisos de lectura del recurso, por ejemplo `clientes.list`.
- Las conexiones SSE autenticadas se cierran si expira el Bearer JWT o si la sesion IAM queda inactiva.

Puedes inspeccionar clientes SSE activos con informacion basica:

```js
api.audit.sseClients();
```

Devuelve:

```js
[
  {
    id: 1,
    sessionId: "session-id",
    closed: false,
    connectedAt: "2026-08-04T12:00:00.000Z",
    expiresAt: "2026-08-04T13:00:00.000Z",
    hasHeartbeat: true,
    hasExpirationTimer: true,
  },
]
```

## Cliente

`api/client` descubre servicios desde `schema.json`, guarda sesion local, usa Bearer token y mantiene cache local mediante adapters.

```js
import { createApiClient, LocalStorageAdapter } from "api/client";

const client = createApiClient({
  url: "http://localhost:3000/api",
  adapter: new LocalStorageAdapter(),
  pingInterval: 5000,
  pingTimeout: 3000,
  sseWatchdogTimeout: 25000,
  syncCacheTimeout: 5 * 60_000,
  changes: true,
  sse: true,
});

client.onChange((event) => {
  console.log(event.type, event);
});

await client.login({ username: "admin", password: "1234" });

const clientes = client.service("clientes");
const ventas = client.service("ventas");
const pending = client.service("pending");
```

Metodos publicos principales:

- `login(credentials)`: login server, guarda sesion, sincroniza servicios, trae changes y abre SSE.
- `logout()`: llama `POST /logout`, limpia sesion/cache/pending local y vuelve a ping.
- `session()`: carga sesion local.
- `clearSession()`: limpia solo sesion local.
- `discover()`: descubre servicios desde `schema.json`.
- `service(name)`: obtiene un servicio descubierto.
- `services()`: devuelve un `Map` de servicios.
- `syncServices(force = false)`: descubre servicios, hace pull de caches faltantes y empuja pending.
- `connected()`: estado online.
- `getSession()`: sesion en memoria.
- `token()`: Bearer token actual.
- `lastReceivedAt()`: ultimo timestamp recibido por `changes` o SSE.
- `onChange(listener)` / `offChange(listener)`: eventos del cliente.
- `changes(since?)`: consulta `/changes`.

`changes` y `sse` estan activados por defecto. Configuralos como `false` para desactivar, respectivamente, la descarga automatica de cambios y la conexion SSE.

`syncCacheTimeout` define por cuantos milisegundos se reutilizan el manifiesto de schemas y los datos locales sin consultar la red. Su valor por defecto es 5 minutos; al vencer, el cliente restaura la cache y la actualiza en segundo plano. Usa `syncServices(true)` para forzar una actualizacion inmediata.
- `request(path, options)`: request autenticado.
- `url(path, query?)`: arma URL absoluta.

Si `syncServices()` o `changes()` reciben `401`, el cliente hace logout local por expiracion: limpia sesion, caches y pending, cierra SSE, marca offline y vuelve a ping. No llama `POST /logout` en ese caso.

## Vue

`api/vue` conecta un `ApiClient` con Composition API. Vue es una peer dependency opcional: solo es necesaria si importas este subpath.

```bash
npm install vue
```

El cliente mantiene cache, operaciones pendientes, `changes` y SSE; los composables exponen esos datos de forma reactiva.

### Instalación

```js
import { createApp } from "vue";
import { createApiClient } from "api/client";
import { createApiVue } from "api/vue";
import App from "./App.vue";

const client = createApiClient({ url: "http://localhost:3000/api" });
const api = createApiVue(client);

createApp(App).use(api).mount("#app");
```

Instala el plugin una sola vez. `createApiVue(client)` devuelve `api`, con refs de `connected`, `session`, `event`, `lastReceivedAt`, `error` y `ready`; los métodos `login()`, `logout()` y `sync()`; la promesa `initialized`; y `dispose()` para retirar su listener global.

Dentro de un componente:

```js
import { useApi, useApiService } from "api/vue";

const api = useApi();
const { records: clientes, loading, error, create, update, remove, pull } = useApiService("clientes");

await api.login({ username: "admin", password: "1234" });
// `clientes` se actualiza automáticamente ante cambios locales, changes y SSE.
```

`useApi()` expone refs de `connected`, `session`, `event`, `error` y `ready`, además de `login()`, `logout()` y `sync()`. `useApiService(nombre)` expone `records` (también `data`), `loading`, `error`, `empty`, `refresh()` para releer cache y las operaciones `pull`, `create`, `update`, `remove` y `push`.

Para formularios usa `useApiForm()`. Sus `data` y `errors` son reactivos; al modificar un campo valida con debounce, incluidas las reglas `unique` disponibles en la cache local.

```js
import { useApiForm } from "api/vue";

const clienteForm = useApiForm("clientes", {
  operation: "create",
  initial: { ruc: "", nombre: "", email: "" },
  debounce: 250,
});

await clienteForm.submit();
```

```html
<input v-model="clienteForm.data.ruc">
<small v-if="clienteForm.errors.ruc">{{ clienteForm.errors.ruc }}</small>
```

`useApiService(nombre)` maneja una colección reactiva: expone `records`/`data`, `loading`, `error`, `empty`, `refresh()`/`list()` para cache local, `pull()`/`pullOne()` para el servidor y CRUD (`create`, `update`, `remove`, `push`). Vuelve a leer la cache cuando el cliente recibe cambios locales, `changes` o SSE.

`useApiForm(nombre, opciones)` expone `data`, `errors`, `validating`, `submitting`, `valid`, `validateField()`, `validate()`, `submit()`, `reset()` y `clearErrors()`. Los errores devueltos durante `submit()` quedan disponibles en `errors` por campo.

Para editar, configura `operation: "update"` e indica el ID (valor o `ref`):

```js
const clienteForm = useApiForm("clientes", {
  operation: "update",
  id: clienteId,
  initial: { nombre: "" },
});
```

Las reglas `unique` se comprueban en el cliente contra su cache local. Son una validación de experiencia de usuario; el servidor y la restricción de base de datos siguen siendo la autoridad final.

## Servicios del Cliente

Cada recurso descubierto se usa como servicio:

```js
const productos = client.service("productos");
```

Metodos locales:

```js
await productos.list();              // lee cache local
await productos.get(id);             // lee cache local por id
await productos.create(data);        // crea local + pending create
await productos.update(id, data);    // actualiza local + pending update
await productos.remove(id);          // elimina local + pending remove
```

Metodos remotos:

```js
await productos.pull(query);         // GET remoto list -> reemplaza cache local
await productos.pullOne(id, query);  // GET remoto by id -> actualiza cache local
await productos.push();              // envia pending del servicio
await productos.push(pendingId);     // envia un pending puntual
await productos.request("list", { query });
await productos.schema();
await productos.validate(data);
await productos.validateAt("nombre", data);
await productos.permissions("list");
```

`create`, `update` y `remove` del cliente son offline-first: primero escriben cache local y pending. Si el cliente esta online, intentan enviar automaticamente ese pending al server; si falla, queda guardado para reintentar con `push()`.

## Pending

`pending` es un servicio mas:

```js
const pending = client.service("pending");

await pending.list();
await pending.get(id);
await pending.update(id, { status: "pending" });
await pending.remove(id);
await pending.push();
```

Tambien puedes empujar pendientes desde el servicio real:

```js
await clientes.push();
await clientes.push(pendingId);
```

El ejemplo `/client` muestra:

- creacion local con ID temporal negativo;
- edicion local;
- eliminacion local;
- lista de pendientes;
- reintento de pendientes;
- errores de validacion/persistencia guardados en pending.

## Adapters del Cliente

Exports disponibles:

```js
import {
  BaseAdapter,
  MapAdapter,
  LocalStorageAdapter,
  IndexedDbAdapter,
} from "api/client";
```

El adapter guarda:

- `api:session`
- caches por servicio, por ejemplo `api:clientes`
- `api:pending`
- `api:temporaryId`

Puedes cambiar el prefijo con `prefix`.

## Apps Estaticas

Las apps estaticas tambien van dentro de `modules`.

```js
export const modules = [
  {
    mountPath: "/basic",
    path: "./example/public/basic",
  },
  {
    mountPath: "/client",
    path: "./example/public/client",
  },
];
```

Opciones:

- `mountPath`: path publico.
- `root`, `path`, `dir` o `directory`: carpeta local.
- `appName`: alternativa para resolver `./public/{appName}` y `/{appName}`.
- `spa`: fallback a `index.html`; default `true`.
- `index`: archivo de fallback; default `index.html`.
- `options`: opciones para `express.static`.

No uses `staticFiles` ni exports `static` dentro de modules: `createApi` los ignora.

## Instalador de Frontends

Un modulo estatico se vuelve instalable si declara `repo`.

```js
export const modules = [
  {
    mountPath: "/portal",
    root: "./public/portal",
    repo: "github:acmepy/sifen-portal",
    version: "latest",
    dist: "www",
  },
];
```

`repo` usa formato `provider:owner/repo`. Actualmente el proveedor soportado es `github`; el formato explicito deja lugar para agregar otros proveedores mas adelante.

Si existe al menos una app instalable, se habilitan:

- `GET /install/`
- `POST /install/:app`

El token de GitHub se toma de `process.env.GITHUB_TOKEN` o del body `{ "token": "..." }`.

## Middlewares HTTP

Opciones soportadas:

```js
const api = await createApi({
  seq,
  cors: { origin: "https://app.example.com" },
  helmet: true,
  compression: { threshold: 0 },
  rateLimit: {
    windowMs: 60_000,
    limit: 100,
  },
  trustProxy: 1,
  json: { limit: "1mb" },
  text: {
    type: "text/plain",
    limit: "10mb",
  },
});
```

`cors`, `helmet`, `compression` y `rateLimit` son dependencias peer opcionales. Si las activas, deben estar instaladas.

## OpenAPI y Postman

```js
const api = await createApi({
  seq,
  basePath: "/api",
  modules: "./example/modules.js",
  openapi: true,
  schema: true,
  postman: true,
});
```

Rutas:

- `GET /api/openapi.json`
- `GET /api/schema.json`
- `GET /api/postman.json`

`schema` es independiente de `openapi` y se activa con `schema: true` (o con su propia configuracion, por ejemplo `schema: { auth: true }`). El cliente usa `schema.json` para descubrir servicios, operaciones y schemas de validacion en una sola solicitud. El documento solo incluye operaciones y schemas que el usuario puede utilizar. OpenAPI permanece disponible para documentacion.

## Scripts

```bash
npm test
npm run dev
```

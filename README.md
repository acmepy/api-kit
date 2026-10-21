# api

`api` arma APIs REST sobre Express a partir de modulos declarativos, modelos de `seq`, validaciones, IAM, auditoria, OpenAPI/Postman y apps estaticas. Tambien incluye un cliente browser/Node con cache local, operaciones pendientes, actualizaciones incrementales via `changes` e instantaneas por SSE.

## Instalacion

Para usar solamente `api/client`:

```bash
npm install api
```

Las dependencias directas son `yep` e `idb-keyval`. Las dependencias del servidor son peers opcionales y se instalan explicitamente al usar `api/server`:

```bash
npm install api express adm-zip github:acmepy/seq github:acmepy/iam
```

`vue`, `logger`, `compression`, `cors`, `express-rate-limit` y `helmet` tambien son peers opcionales: instala los que utilice tu aplicacion. Si falta una dependencia importada por una entrada, Node informa `ERR_MODULE_NOT_FOUND`.

Para desarrollar este repositorio (incluye las dependencias de desarrollo):

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

## Visor de logs

El visor es un middleware independiente de IAM, seq y de la configuracion de `createApi`. La interfaz utiliza Bootstrap 5.3.8 servido localmente y conserva la paleta oscura del visor. Las paginas estan en `src/log-viewer/assets/log-index.html` y `log-view.html`, con estilos propios en `viewer.css`. El build copia estos archivos y el CSS y la licencia de Bootstrap a `dist/assets`; el visor no necesita un CDN ni instalar Bootstrap en produccion. Se puede importar desde `api/log-viewer` o `api/server`:

```js
import express from "express";
import { createLogViewer } from "api/log-viewer";

const app = express();
app.use("/logs", createLogViewer({
  directory: "./log",
  pageSize: 200,
}));
```

`/logs/` lista los archivos `.log` del directorio; al abrir uno se muestra el visor con filtros combinables por nivel, origen y `txId`. El filtro de transaccion compara el identificador completo, sin distinguir mayusculas. Hacer clic en un `txId` aplica ese filtro; se puede copiar el identificador, expandir el texto original y exportar las entradas de la pagina actual. Los filtros permanecen en la URL para compartir la consulta.

El resumen muestra la cantidad de entradas de cada nivel en todo el archivo, incluidos ERROR, INFO y TRACE; hacer clic en un contador aplica o quita ese filtro. Los totales no cambian con los filtros ni con la paginacion. La barra lateral lista los txId por su ultima aparicion, con cantidad de entradas e indicador de errores (ERROR o FATAL). Permite buscar por parte del identificador, mostrar solo transacciones con errores y seleccionar una para aplicar el filtro exacto. La lista muestra inicialmente 100 transacciones y permite cargar mas. Las entradas sin txId se contabilizan aparte. En movil, la barra lateral se presenta como un panel desplegable.

El parser usa regex para entradas como `[2026-10-20 11:38:52] [ERROR] [api] [http.error] ...`. Reconoce UUID suelto o entre corchetes y el campo `"txId"` dentro de JSON. El origen es el primer bloque, por ejemplo `api` o `IAM`; el segundo, como `request`, se muestra como detalle. Agrupa stack traces y continuaciones con su entrada anterior, y conserva el texto sin formato. Las entradas sin txId no se atribuyen a otra transaccion por proximidad.

La lectura se hace en streaming, con paginas de hasta 500 entradas y orden desde las mas recientes. `pageSize` vale 200 por defecto. `directory` es obligatorio y se resuelve desde el directorio de trabajo. Para otro formato se puede proporcionar `parseLine(line)`, que devuelve `{ timestamp, level, source, scope, txId, message }` o `null` si la linea continua la entrada anterior. Tambien se exporta `parseLogLine` para reutilizar el parser predeterminado.

El host aplica su autenticacion y permisos antes de montar este router; eso protege tanto las paginas como los endpoints y assets del visor. El middleware solo permite leer archivos dentro del directorio configurado y muestra el contenido como texto.

Para probarlo con el archivo de `log/` de este repositorio:

```bash
npm run dev:logs
```

Abre `http://127.0.0.1:3001/logs/`. El ejemplo escucha solo en localhost; el puerto se puede elegir con `LOG_VIEWER_PORT`.

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
    secret: process.env.IAM_SECRET,
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
  secret: process.env.IAM_SECRET,
  strategies: ["bearer", "basic"],
  tokenExpiresIn: process.env.IAM_TOKEN_EXPIRES_IN || "1h",
}
```

`IAM_SECRET` es obligatorio cuando `auth` esta habilitado. `tokenExpiresIn` controla la vigencia del Bearer JWT. Las rutas protegidas usan permisos generados por ruta, por ejemplo `clientes.list`, `clientes.create` o `audit.sse`.

## Logger

`logging` puede ser `false`, `true`, una funcion o un objeto tipo logger. Cuando `auth` esta habilitado, el mismo logger se reenvia a `iam`; se puede sobrescribir solo para autenticacion con `auth.logging`. `api-kit` tambien pasa `getContext` a IAM para que sus logs incluyan el `txId` de la peticion, sin modificar el logger.

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

La creacion maestro/detalle valida cada registro anidado con el schema `create` del detalle, incluidas reglas como `min`, `regexp`, `unique` y validaciones personalizadas. Tambien se validan los detalles nuevos que reemplazan a los anteriores en una actualizacion anidada. La validacion ocurre despues de asignar la FK del maestro y dentro de la misma transaccion; sus valores normalizados se usan al insertar. Si un detalle es invalido, la respuesta es `400` y se revierte toda la operacion, sin conservar una cabecera ni detalles parciales. Las comprobaciones `unique` utilizan esa misma transaccion.

```http
POST /api/ventas/1/items
PUT /api/ventas/1/items/1
DELETE /api/ventas/1/items/1
```

Las rutas de detalle admiten una PK simple o una PK compuesta por la FK del maestro y un atributo adicional. En el segundo caso, `:detailId` identifica ese atributo adicional: para `{ codListaPrecio, codArticulo }`, la ruta `/api/listasPrecios/001/detalles/A1` usa ambos campos para actualizar o eliminar. La FK se toma de la ruta al crear y se valida segun el tipo declarado; un codigo de texto como `"001"` conserva sus ceros iniciales y no necesita repetirse en el body. Las rutas de escritura actuales requieren una FK simple y un unico componente identificador del detalle fuera de esa FK.

## Filtros y Paginacion

### Claves primarias compuestas

En recursos principales con varios atributos `primaryKey: true`, las rutas `GET`, `PUT` y `DELETE` usan `:id` para el primer componente (segun el orden de declaracion) y query params para los restantes. Para una PK `{ id, codSucursal }`:

```http
GET /api/parametros/1?codSucursal=001
PUT /api/parametros/1?codSucursal=001
DELETE /api/parametros/1?codSucursal=001
```

`POST` recibe los componentes de la clave en el body. Las claves se validan segun sus tipos; los strings conservan ceros iniciales. Una clave incompleta se rechaza y `PUT` no permite cambiar componentes de una PK compuesta. Al llamar directamente al servicio tambien se puede pasar `params.id: { id: 1, codSucursal: "001" }`. Este contrato no cambia las rutas individuales de detalles ni el CRUD de claves simples.

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
  serviceSyncDelay: 1000,
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

- `login(credentials, { sync = true } = {})`: login server y guarda sesion. Por defecto sincroniza servicios, trae changes y abre SSE. Con `{ sync: false }` solo autentica y guarda la sesion: no descarga schemas ni datos, no trae changes, no abre SSE y detiene el ping y las precargas programadas. Leer `session()` o `token()` tampoco inicia una sincronizacion en ese modo.
- `logout()`: llama `POST /logout`; tanto ante una respuesta exitosa como ante `401`, limpia sesion, token, caches y pending locales, cierra SSE y su watchdog, cancela changes en curso y las precargas programadas, y reinicia el ping. Ante `401` devuelve `{ ok: true, data: null }`, porque el cierre local se completo; otros errores del servidor o de red se propagan.
- `session()`: carga sesion local.
- `clearSession()`: limpia solo sesion local.
- `discover()`: descubre servicios desde `schema.json`.
- `logging: true` (o un objeto con `log()`): muestra en consola el uso y la actualizacion de cache de `schema.json`.
- `serviceSyncDelay`: demora la precarga de datos de los servicios para no bloquear el render inicial; por defecto es `1000` ms. Usa `0` para iniciarla enseguida o `false` para desactivarla.
- `service(name)`: obtiene un servicio descubierto.
- `services()`: devuelve un `Map` de servicios.
- `syncServices(force = false)`: descubre servicios, restaura caches y programa descargas de datos segun `serviceSyncDelay`. No envia pending; para enviarlos usa `push()` del servicio. Tambien permite iniciar explicitamente el descubrimiento despues de un login con `{ sync: false }`.
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

Si cualquier peticion autenticada recibe `401`, incluidas las descargas de servicios en segundo plano y la apertura de SSE, el cliente invalida el token, cierra SSE y su watchdog, cancela changes en curso y las precargas programadas, emite `auth-expired` y marca offline. Conserva los servicios registrados, schemas, caches, pending y `lastReceivedAt`. Guarda la identidad de la sesion expirada sin su token para comprobar el usuario al reconectar, incluso despues de reiniciar el cliente; `session()` devuelve `{}` y `token()` devuelve `null` mientras la sesion esta expirada. El ping publico puede continuar, pero no marca online ni reanuda la sincronizacion hasta iniciar sesion. Las peticiones autenticadas quedan bloqueadas localmente con `401` mientras la sesion esta expirada.

Los `401` simultaneos comparten la invalidacion; un `401` tardio de una sesion anterior no cierra una nueva sesion. Las respuestas exitosas tardias de una sesion anterior se descartan con `AbortError` para impedir que sobrescriban los datos conservados. No llama `POST /logout` al expirar. Las peticiones realizadas con `request()` propagan el error `401`; las actualizaciones en segundo plano y SSE lo manejan internamente. Las peticiones con `auth: false`, como login y ping, y los errores `403` no invalidan la sesion.

Para un modal de reconexion usa `login(credentials, { sync: false })`. Si la sesion expirada contiene `user.id`, el nuevo login debe devolver el mismo `user.id`; otra cuenta se rechaza con `409` y codigo `SESSION_USER_MISMATCH`, sin sustituir la identidad anterior ni borrar datos. Las credenciales incorrectas tambien conservan el trabajo local. `logout()` explicito mantiene la limpieza completa de sesion, caches y pending, incluso si el servidor responde `401`.

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

`useApi()` expone refs de `connected`, `session`, `event`, `error` y `ready`, además de `login(credentials, options)`, `logout()` y `sync()`. `login` admite `{ sync: false }` para renovar la sesion desde un modal sin descargar datos ni enviar pendientes. `useApiService(nombre)` expone `records` (también `data`), `loading`, `error`, `empty`, `refresh()` para releer cache y las operaciones `pull`, `create`, `update`, `remove` y `push`.

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

`useApiService(nombre)` maneja una colección reactiva: expone `records`/`data`, `loading`, `error`, `empty`, `refresh()`/`list()` para cache local, `pull()`/`pullOne()` para el servidor y CRUD (`create`, `update`, `remove`, `push`) y operaciones de detalle (`createDetail`, `updateDetail`, `removeDetail`). Vuelve a leer la cache cuando el cliente recibe cambios locales, `changes` o SSE.

`useApiForm(nombre, opciones)` expone `data`, `errors`, `validating`, `submitting`, `valid`, `validateField()`, `validate()`, `submit()`, `reset()` y `clearErrors()`. Los errores devueltos durante `submit()` quedan disponibles en `errors` por campo.

Para editar, configura `operation: "update"` e indica el ID (valor o `ref`):

```js
const clienteForm = useApiForm("clientes", {
  operation: "update",
  id: clienteId,
  initial: { nombre: "" },
});
```

Para caches que pueden superar el limite habitual de `localStorage`, usa IndexedDB:

```js
const client = createApiClient({
  url: "http://localhost:3000/api",
  storage: "indexedDB",
});
```

El adapter IndexedDB usa `idb-keyval` y conserva la misma interfaz de almacenamiento que `LocalStorageAdapter`.

Usa una sola base de datos por `prefix` (`api` por defecto), con un almacen por servicio (`session`, `schema`, `clientes`, etc.). Con `prefix: "vue"`, todos esos almacenes aparecen dentro de la base `vue`. Puedes indicar `dbName` para elegir otro nombre de base. Al descubrir nuevos servicios, el adaptador actualiza la version de IndexedDB y agrega sus almacenes sin borrar los existentes. Las conexiones del adaptador se cierran cuando otra pestana cambia la version y se reabren en el siguiente acceso. Si una conexion externa impide la actualizacion, la operacion informa el bloqueo para poder reintentar. No se trasladan automaticamente datos desde bases separadas por servicio creadas por una configuracion anterior.

El cliente descubre las claves primarias y los nombres de detalle desde `schema.json`. La cache conserva los campos originales, sin agregar un `id` a recursos que usan otra clave. Para una clave compuesta, `get`, `pullOne`, `update`, `remove` y `push` reciben un objeto con todos sus componentes. `useApiForm` puede obtener esa clave de los datos iniciales al editar.

La validacion de la cabecera conserva los detalles anidados al crear o actualizar, incluidos los pendientes locales. Las reglas de los detalles se ejecutan en el servidor al enviar; los errores de envio quedan disponibles en `useApiForm.errors` con los nombres de campo que devuelve el servidor.

Las operaciones individuales de detalle envian directamente al servidor y requieren conexion. Por ejemplo: `await listas.createDetail("001", "items", { articulo: "A2", cantidad: 4 })`, `await listas.updateDetail("001", "items", "A2", { cantidad: 5 })` y `await listas.removeDetail("001", "items", "A2")`. Actualizan los detalles de una cabecera ya cargada en cache. En Vue se usan los mismos metodos sobre `useApiService("listas")`.

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

Sin conexion, `create`, `update` y `remove` guardan el registro en cache local como pendiente y devuelven `{ ok: true, data }`, sin intentar enviarlo. El envio posterior se realiza con `push()` sobre ese mismo pendiente, sin repetir `create()`. Con conexion, por defecto envian directamente al servidor y actualizan la cache local. Si ese envio falla por un error de red como `Failed to fetch`, el cliente marca offline y la operacion guarda el registro como pendiente local, sin repetir inmediatamente el envio. Un error de red al descargar datos tambien marca offline, de modo que el siguiente guardado se realiza localmente. Los errores HTTP y las cancelaciones no activan esa conversion a pendiente. Con `{ pending: true }`, primero guardan localmente y, si hay conexion, intentan enviar el pendiente; si el envio falla, la operacion lanza un error y conserva el pendiente para reintentar con `push()`. `{ pending: false }` fuerza el envio directo incluso si el cliente figura sin conexion y propaga los errores de red sin crear pendientes.

## Pending

`pending` es un servicio mas:

```js
const pending = client.service("pending");

await pending.list();
const result = await pending.push();
// { ok, results, errors }
```

`pending.push()` envia secuencialmente los pendientes de todos los servicios de recursos. Cada resultado incluye `service`, la clave `id`, la `operation` y su respuesta o error; si un servicio falla antes de procesar registros, su error incluye `service` sin clave ni operacion. Los registros rechazados conservan su estado pendiente para reintentar. Las actualizaciones exitosas quedan sin marcas de pendiente y los borrados exitosos salen de la cache. Las llamadas simultaneas a `pending.push()` comparten el mismo envio. `pending.get()`, `pending.update()` y `pending.remove()` no estan implementados.

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

`cors`, `helmet`, `compression` y `rateLimit` son dependencias peer opcionales. CORS esta desactivado por defecto; si activas cualquiera de ellas, debe estar instalada.

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

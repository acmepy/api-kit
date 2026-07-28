# api-kit

`api-kit` es un middleware para Express que arma APIs REST a partir de modulos declarativos, modelos de `seq`, schemas de validacion, auth, auditoria, OpenAPI y apps estaticas.

## Instalacion

```bash
npm install
```

Para correr el ejemplo local:

```bash
npm run dev
```

La demo queda disponible en `http://localhost:3000`.

## Uso Basico

```js
import { createApiKit } from "api-kit";
import { Seq, SQLiteAdapter } from "seq";

const adapter = new SQLiteAdapter({
  database: ":memory:",
  naming: {
    tables: "snake_case",
    columns: "snake_case",
  },
});
const seq = new Seq({ adapter });

const logger = {
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

const api = await createApiKit({
  seq,
  basePath: "/api",
  modules: "./example/modules.js",
  auth: {
    secret: process.env.IAM_SECRET || "dev-secret",
    strategies: ["bearer", "basic"],
    tokenExpiresIn: process.env.IAM_TOKEN_EXPIRES_IN || "1h",
  },
  audit: true,
  openapi: true,
  postman: true,
  logging: logger,
});

await seq.authenticate();
await seq.sync();

api.app.listen(3000);
```

`naming` pertenece al adapter de `seq`; no es una opcion de `createApiKit`.
`createApiKit` crea una instancia de Express si no recibe `app`, monta las rutas y el `errorHandler`, e instala `express.json()` por defecto. Se puede pasar una app existente con `app` y desactivar o configurar JSON con `json: false` u opciones en `json`.
El `basePath` responde con un saludo del backend usando el `name` del `package.json`; por ejemplo `GET /api`.

## Middlewares HTTP

`createApiKit` puede instalar middlewares comunes de Express desde la configuracion. Cada opcion acepta `true` para usar defaults, un objeto con opciones del middleware, o `false` para desactivar.

```js
const api = await createApiKit({
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

Notas:

- `json` esta activo por defecto y monta `express.json()`.
- `text: true` monta `express.text()` con `{ type: "text/plain", limit: "10mb" }`.
- `cors`, `helmet`, `compression` y `rateLimit` estan desactivados por defecto.
- `trustProxy` configura `app.set("trust proxy", value)` cuando se recibe un valor distinto de `false`.

## Modulos

`modules` es el punto de entrada para recursos API y apps estaticas.

```js
export const modules = [
  {
    modelName: "Cliente",
    tableName: "clientes",
    timestamps: true,
    attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      nombre: { type: "string", maxLength: 100, allowNull: false },
      activo: { type: "boolean", defaultValue: true },
    },
  },
];
```

## CRUD Generado

Cada modulo declarativo crea un CRUD REST bajo `basePath` usando el nombre de la tabla o del modulo.

Para el ejemplo anterior, con `basePath: "/api"` y `tableName: "clientes"`, se exponen:

| Metodo | Path | Accion |
| --- | --- | --- |
| `GET` | `/api/clientes` | Lista registros |
| `GET` | `/api/clientes/:id` | Obtiene un registro por ID |
| `POST` | `/api/clientes` | Crea un registro |
| `PUT` | `/api/clientes/:id` | Actualiza un registro |
| `DELETE` | `/api/clientes/:id` | Elimina un registro |
| `GET` | `/api/clientes/schema` | Devuelve los schemas del recurso |

`POST` y `PUT` validan el body contra los schemas generados desde los attributes del modulo. Los campos no declarados se rechazan por defecto.

### Query De List

`GET /api/clientes` soporta paginacion y filtros por query string.

Paginacion:

- `page`: pagina actual; default `1`.
- `limit`: cantidad por pagina; default `20`; maximo `100` salvo configuracion del recurso.

Ejemplos:

```http
GET /api/clientes?page=1&limit=20
GET /api/clientes?activo=true
GET /api/clientes?nombre[in]=Ana,Jose
GET /api/clientes?createdAt[between]=2026-01-01,2026-01-31
```

Los operadores se pueden escribir con cualquiera de estas formas:

```http
GET /api/productos?precio[mayor]=10
GET /api/productos?precio.mayor=10
GET /api/productos?precio__mayor=10
```

Operadores soportados:

| Operador | Alias | Uso |
| --- | --- | --- |
| `eq` | `equal`, `igual` | Igualdad. Tambien es el default: `?activo=true` |
| `gt` | `greater`, `mayor` | Mayor que |
| `gte` | `greaterOrEqual`, `mayorIgual` | Mayor o igual |
| `lt` | `less`, `menor` | Menor que |
| `lte` | `lessOrEqual`, `menorIgual` | Menor o igual |
| `in` | `incluido` | Valor incluido en una lista separada por comas |
| `between` | - | Rango con dos valores separados por coma |

Los valores se convierten segun el tipo del atributo (`integer`, `number`, `decimal`, `boolean`, `date`, `string`). Los operadores de rango (`gt`, `gte`, `lt`, `lte`, `between`) solo aplican a tipos comparables como numeros, fechas y strings.

## Apps Estaticas

Las apps estaticas tambien se declaran dentro de `modules`.

```js
export const modules = [
  {
    mountPath: "/admin",
    root: "./public/admin",
    spa: true,
  },
];
```

Opciones soportadas:

- `mountPath`: path publico donde se monta la app.
- `root`, `path`, `dir` o `directory`: carpeta local de archivos.
- `appName`: alternativa para resolver `./public/{appName}` y `/{appName}`.
- `spa`: habilita fallback al `index.html`; default `true`.
- `index`: archivo usado para el fallback SPA; default `index.html`.
- `options`: opciones pasadas a `express.static`.

`staticFiles` y `static` no son parametros soportados en `createApiKit`; usar siempre `modules`.

## Instalador de Frontends

Un modulo estatico se vuelve instalable cuando declara `repo`.

```js
export const modules = [
  {
    mountPath: "/portal",
    root: "./public/portal",
    spa: true,
    repo: "acmepy/sifen-portal",
    version: "latest",
    dist: "www",
  },
];
```

Reglas:

- `repo` debe tener formato `owner/repo`.
- `version` es opcional; default `latest`.
- `dist` es opcional; default `www`.
- El target debe resolver dentro de `public/`.
- El token de GitHub se toma de `process.env.GITHUB_TOKEN`.
- `POST /install/:app` acepta `{ "token": "..." }` para una ejecucion puntual, sin devolverlo en la respuesta.

Si hay al menos una app instalable, `api-kit` habilita:

- `GET /install/`: pagina HTML con todas las apps instalables y un boton para actualizar cada una.
- `POST /install/:app`: instala una app especifica.

El id `:app` sale del `mountPath`:

- `/portal` -> `portal`
- `/admin/portal` -> `admin-portal`

Respuesta de instalacion:

```json
{
  "ok": true,
  "data": {
    "mountPath": "/portal",
    "app": "portal",
    "repo": "acmepy/sifen-portal",
    "tag": "v1.2.0",
    "target": "public/portal",
    "status": "updated"
  }
}
```

Estados posibles:

- `updated`: se descargo y reemplazo la app.
- `skipped`: el tag instalado ya coincide con el remoto.
- `failed`: la instalacion fallo; la respuesta incluye `error`.

La pagina HTML de `/install/` consume el JSON de `POST /install/:app` y muestra `status`, `tag` y `error` por fila.

## Auth y OpenAPI

La autenticacion y autorizacion se delegan al middleware Express de `iam`: `auth()` valida Basic/Bearer y maneja sesiones, y `can()` valida permisos por ruta. Cuando `auth.required` esta habilitado, `api-kit` auto registra las rutas de IAM bajo el `basePath`: `POST /login`, `GET /session` y `POST /logout`. Con `basePath: "/api"`, quedan en `/api/login`, `/api/session` y `/api/logout`.

Si `auth` global esta habilitado, las rutas del instalador tambien requieren auth.

Si `openapi` esta habilitado y existen apps instalables, `/install/{app}` aparece en el documento OpenAPI.

Si `postman` esta habilitado, `api-kit` expone una coleccion Postman en `/postman.json` dentro del `basePath`.

```js
const api = await createApiKit({
  seq,
  basePath: "/api",
  modules: "./example/modules.js",
  openapi: true,
  postman: true,
});
```

La coleccion queda disponible en `/api/postman.json` y agrupa las rutas como `api > modulo > endpoints`.

## Scripts

```bash
npm test
npm run dev
```

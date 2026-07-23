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
import express from "express";
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

const api = await createApiKit({
  seq,
  basePath: "/api",
  modules: "./example/modules.js",
  auth: { secret: process.env.IAM_SECRET || "dev-secret" },
  audit: true,
  openapi: true,
});

await seq.authenticate();
await seq.sync();

const app = express();
app.use(express.json());
app.use(api.router);
app.use(api.errorHandler);
app.listen(3000);
```

`naming` pertenece al adapter de `seq`; no es una opcion de `createApiKit`.

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

Si `auth` global esta habilitado, las rutas del instalador tambien requieren auth.

Si `openapi` esta habilitado y existen apps instalables, `/install/{app}` aparece en el documento OpenAPI.

## Scripts

```bash
npm test
npm run dev
```

# Changes y SSE

Este ejemplo usa `example/app.js`, que ya habilita `audit: true`. Eso expone:

- `GET /api/changes?since=<fecha ISO>` para traer cambios desde una fecha.
- `GET /api/sse` para escuchar cambios en vivo por Server-Sent Events.

Primero levanta el servidor:

```bash
npm run dev
```

En otra terminal escucha eventos SSE:

```bash
node example/cli.js sse --basic admin:1234
```

En una tercera terminal genera cambios:

```bash
node example/cli.js create-cliente "Ana" --basic admin:1234
node example/cli.js demo --basic admin:1234
```

Tambien puedes consultar los cambios desde una fecha:

```bash
node example/cli.js changes 2026-07-20T00:00:00.000Z --basic admin:1234
```

Para probar Bearer token:

```bash
node example/cli.js login admin 1234
node example/cli.js changes 2026-07-20T00:00:00.000Z --token <token>
```

Si el servidor esta en otra URL:

```bash
node example/cli.js sse --url http://localhost:3000/api
```

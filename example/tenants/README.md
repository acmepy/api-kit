# Ejemplo independiente de tenants

Desde la raíz de api-kit:

```sh
node example/tenants/app.js
```

Abrir **http://127.0.0.1:3001**. Usuario **demo**, clave **1234**.
Requiere las dependencias de desarrollo instaladas y los bundles de `dist` actualizados.
Los recursos del navegador se sirven localmente; no necesita CDN.

El ejemplo original no cambia. Este utiliza su propia base
`example/data/tenants/tenants.sqlite` y el prefijo de caché `tenant-example`.
Conserva los datos al reiniciar y crea los usuarios, empresas y permisos que falten.
`TENANT_PORT` permite cambiar el puerto y `TENANT_SECRET` el secreto de desarrollo.

## Recorrido

1. Ingresar con `demo / 1234`. La empresa inicial es **Empresa Norte**.
2. Crear una factura indicando cliente y una o más líneas de artículo/cantidad.
3. Editar el cliente, agregar detalles, cambiar cantidades o eliminar líneas.
4. Seleccionar **Empresa Sur** y pulsar **Cambiar empresa**. La lista queda vacía
   hasta crear facturas para esa empresa.
5. Crear otra factura y regresar a **Empresa Norte**: reaparecen sus datos.
6. **Usar como predeterminada** guarda la empresa seleccionada para los próximos
   logins. No cambia la empresa de la sesión actual.
7. Para eliminar una factura, eliminar primero sus detalles.

Un cambio de empresa reemplaza los servicios y sus cachés. Si existen operaciones
pendientes, api-kit rechaza el cambio y conserva los datos locales.

## Archivos y flujo

- `app.js`: servidor, SQLite y altas iniciales de IAM.
- `modules.js`: factura y detalles, ambos con `tenant: true` y `codEmpresa` entero.
- `index.html` y `browser.js`: login, selector de empresa y operaciones CRUD.
- `check.js`: comprobación ejecutable con una base SQLite en memoria.

IAM utiliza `tenantId`; Seq y api-kit utilizan `codEmpresa` en los modelos de
negocio. Ambos reciben el mismo `getContext`. El servidor obtiene la selección
de la sesión autenticada; el formulario no envía `codEmpresa` al crear registros.
La auditoría también queda protegida por tenant.

Las llamadas principales del navegador son:

```js
await client.login({ username: "demo", password: "1234" });
const empresas = await client.getTenants();
await client.setSessionTenant(2); // cambia esta sesión y recarga la caché
await client.setUserTenant(2);    // predeterminada del usuario para nuevos logins

// Obtener nuevamente el servicio después de cambiar de tenant.
const facturas = client.service("facturas");
const { data: factura } = await facturas.create({
  cliente: "Cliente Sur",
  items: [{ articulo: "Artículo A", cantidad: 2 }],
});
await facturas.update(factura.id, { cliente: "Cliente editado" });
const { data: item } = await facturas.createDetail(factura.id, "items", {
  articulo: "Artículo B", cantidad: 1,
});
await facturas.updateDetail(factura.id, "items", item.id, { cantidad: 3 });
await facturas.removeDetail(factura.id, "items", item.id);
await facturas.pull(); // la lista del servidor incluye los detalles
const registros = await facturas.list(); // lee la caché local
```

## Verificación

```sh
node example/tenants/check.js
```

Inicia el servidor real en un puerto libre y comprueba login, empresas permitidas,
creación anidada, edición y borrado de maestro/detalle, aislamiento entre empresas,
rechazo de una empresa no permitida, empresa predeterminada para un nuevo login
y disponibilidad de los archivos del navegador. Cierra el servidor al terminar y
no modifica la base persistente del ejemplo.

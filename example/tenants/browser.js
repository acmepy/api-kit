import { createApiClient } from "api/client";

// Separate prefix: this example never shares the original example's cache.
const client = createApiClient({ url: `${location.origin}/api`, prefix: "tenant-example",
  storage: "localStorage", sse: false, changes: false, serviceSyncDelay: false });
const $ = id => document.getElementById(id);
// Reacquire the service after every tenant switch: old instances are invalidated.
const facturas = () => client.service("facturas");

async function run(action) {
  const buttons = [...document.querySelectorAll("button")];
  buttons.forEach(button => { button.disabled = true; });
  try {
    const result = await action();
    if (result !== undefined) $("result").textContent = JSON.stringify(result, null, 2);
    $("message").className = "alert alert-success";
    $("message").textContent = "Operación completada.";
  } catch (error) {
    $("message").className = "alert alert-danger";
    $("message").textContent = `${error.code || "ERROR"}: ${error.message}`;
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

function addLine() {
  const row = document.createElement("div");
  row.className = "row g-2 mb-2";
  row.innerHTML = '<div class="col-7"><input class="form-control" name="articulo" placeholder="Artículo" aria-label="Artículo" required maxlength="100"></div><div class="col-3"><input class="form-control" name="cantidad" type="number" value="1" min="1" step="1" aria-label="Cantidad" required></div><div class="col-2"><button type="button" class="btn btn-outline-danger" aria-label="Quitar línea">×</button></div>';
  row.querySelector("button").onclick = () => row.remove();
  $("lines").append(row);
}

async function showSession() {
  const session = await client.session();
  $("login").hidden = Boolean(session?.token);
  $("session").hidden = $("workspace").hidden = !session?.token;
  if (!session?.token) return;
  const tenants = await client.getTenants();
  $("tenant").replaceChildren(...tenants.data.map(tenant => new Option(tenant.name, tenant.id)));
  $("tenant").value = String(session.tenantId);
  $("identity").textContent = `Usuario: ${session.user?.id || "demo"} · tenantId de IAM: ${session.tenantId} · campo de negocio: codEmpresa`;
}

function button(label, action, danger = false) {
  const element = document.createElement("button");
  element.className = `btn btn-sm ${danger ? "btn-outline-danger" : "btn-outline-secondary"} me-1 mb-1`;
  element.textContent = label;
  element.onclick = () => run(async () => { const result = await action(); await refresh(); return result; });
  return element;
}

async function refresh() {
  await facturas().pull();
  const { data } = await facturas().list();
  const blocks = [];
  for (const invoice of data) {
    const card = document.createElement("article");
    card.className = "border rounded p-3 mb-2";
    const title = document.createElement("h3"); title.className = "h6";
    title.textContent = `#${invoice.id} · ${invoice.cliente} · empresa ${invoice.codEmpresa}`;
    card.append(title);
    card.append(button("Editar cliente", async () => {
      const cliente = prompt("Cliente", invoice.cliente);
      if (cliente === null) return;
      return facturas().update(invoice.id, { cliente });
    }), button("Eliminar factura", () => {
      if (invoice.items?.length) throw new Error("Elimina primero los detalles de la factura.");
      return facturas().remove(invoice.id);
    }, true));
    const list = document.createElement("ul"); list.className = "list-group list-group-flush mb-2";
    for (const item of invoice.items || []) {
      const li = document.createElement("li"); li.className = "list-group-item px-0";
      const text = document.createElement("span"); text.textContent = `${item.articulo} × ${item.cantidad} `;
      li.append(text, button("Editar", () => {
        const quantity = prompt("Cantidad", item.cantidad);
        if (quantity === null) return;
        return facturas().updateDetail(invoice.id, "items", item.id, { cantidad: Number(quantity) });
      }), button("Eliminar", () => facturas().removeDetail(invoice.id, "items", item.id), true));
      list.append(li);
    }
    card.append(list, button("Agregar detalle", () => {
      const articulo = prompt("Artículo");
      if (!articulo) return;
      return facturas().createDetail(invoice.id, "items", { articulo, cantidad: 1 });
    }));
    blocks.push(card);
  }
  $("invoices").replaceChildren(...blocks);
  if (!blocks.length) $("invoices").textContent = "Esta empresa todavía no tiene facturas.";
}

$("login").onsubmit = event => {
  event.preventDefault();
  run(async () => {
    await client.login({ username: $("username").value, password: $("password").value });
    await showSession(); await refresh();
  });
};
$("change").onclick = () => run(async () => {
  await client.setSessionTenant(Number($("tenant").value));
  await showSession(); await refresh();
});
$("defaultTenant").onclick = () => run(() => client.setUserTenant(Number($("tenant").value)));
$("logout").onclick = () => run(async () => { await client.logout(); await showSession(); $("invoices").replaceChildren(); });
$("refresh").onclick = () => run(refresh);
$("addLine").onclick = addLine;
$("create").onsubmit = event => {
  event.preventDefault();
  run(async () => {
    const items = [...$("lines").children].map(row => ({ articulo: row.querySelector('[name="articulo"]').value,
      cantidad: Number(row.querySelector('[name="cantidad"]').value) }));
    const result = await facturas().create({ cliente: $("customer").value, items });
    $("create").reset(); $("lines").replaceChildren(); addLine();
    await refresh(); return result;
  });
};
addLine();
if ((await client.session())?.token) {
  run(async () => { await client.refreshSession(); await showSession(); await refresh(); });
}

import { createApiClient, LocalStorageAdapter } from "api/client";

const client = createApiClient({
  url: `${window.location.origin}/api`,
  schemaPath: "/schema.json",
  serviceSyncDelay: 1000,
  adapter: new LocalStorageAdapter(),
  createAdapter: (options = {}) => new LocalStorageAdapter(options),
  pingInterval: 5000,
  pingTimeout: 3000,
  sseWatchdogTimeout: 25000,
});

const state = {
  user: null,
  clientes: [],
  ventas: [],
  pending: [],
  loading: false,
  error: "",
  hasToken: false,
  status: "Sin sesion",
  connectionSource: "inicio",
  editingClienteId: null,
  editingPendingId: null,
  clienteErrors: {},
  clienteForm: {},
};

const services = {
  clientes: null,
  ventas: null,
  pending: client.service("pending"),
};

const app = document.querySelector("#app");

client.onChange((event) => {
  state.connectionSource = event.source || event.type;
  if (event.type === "sync") refreshFromClient({ background: true }).catch(() => {});
  if (event.type === "cache" || event.type === "changes" || event.type === "sse") {
    tryAssignServices();
    refreshLocalState().then(() => renderFromBackground()).catch(() => {});
  }
  updateStatusIndicators();
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.matches("[data-login-form]")) {
    event.preventDefault();
    await login(form);
  }
  if (form.matches("[data-session-form]")) {
    event.preventDefault();
    await loadSession();
  }
  if (form.matches("[data-cliente-form]")) {
    event.preventDefault();
    await createCliente(form);
  }
  if (form.matches("[data-venta-form]")) {
    event.preventDefault();
    await createVenta(form);
  }
});

document.addEventListener("click", async (event) => {
  const action = event.target.closest("[data-action]");
  if (!action) return;
  event.preventDefault();

  if (action.dataset.action === "logout") await logout();
  if (action.dataset.action === "session") await loadSession();
  if (action.dataset.action === "clientes") await loadClientes();
  if (action.dataset.action === "ventas") await loadVentas();
  if (action.dataset.action === "add-item") addDetailRow("items");
  if (action.dataset.action === "add-cobro") addDetailRow("cobros");
  if (action.dataset.action === "remove-detail") removeDetailRow(action);
  if (action.dataset.action === "edit-cliente") editCliente(action);
  if (action.dataset.action === "cancel-cliente") cancelCliente();
  if (action.dataset.action === "save-cliente") await saveCliente(action);
  if (action.dataset.action === "delete-cliente") await deleteCliente(action);
  if (action.dataset.action === "edit-pending") editPending(action);
  if (action.dataset.action === "cancel-pending") cancelPending();
  if (action.dataset.action === "save-pending") await savePending(action);
  if (action.dataset.action === "send-pending") await sendPending(action);
  if (action.dataset.action === "send-all-pending") await sendAllPending();
  if (action.dataset.action === "delete-pending") await deletePending(action);
});

init();

async function render() {
  state.hasToken = Boolean(await client.token());
  app.innerHTML = `
    <header class="topbar">
      <div>
        <span class="eyebrow">api</span>
        <h1>Client demo</h1>
      </div>
      <div class="badges">
        <span class="session ${state.hasToken ? "on" : "off"}" data-token-badge>${state.hasToken ? "Token persistido" : "Sin token"}</span>
        <span class="session ${client.connected() ? "on" : "off"}" data-connection-badge>
          ${client.connected() ? "Servidor conectado" : "Servidor offline"}
        </span>
      </div>
    </header>
    <main class="layout">
      <section class="panel">${loginPanel()}</section>
      <section class="panel">${sessionPanel()}</section>
      <section class="panel wide">${clientesPanel()}</section>
      <section class="panel wide">${ventasPanel()}</section>
      <section class="panel wide">${pendingPanel()}</section>
    </main>
  `;
}

function loginPanel() {
  return `
    <div class="section-row">
      <h2>Login</h2>
      ${state.hasToken ? `<button type="button" data-action="logout">Logout</button>` : ""}
    </div>
    <form data-login-form>
      <label>
        Usuario
        <input name="username" value="admin" autocomplete="username" required>
      </label>
      <label>
        Password
        <input name="password" value="1234" type="password" autocomplete="current-password" required>
      </label>
      <button type="submit" ${state.loading ? "disabled" : ""}>Login</button>
    </form>
    ${message()}
  `;
}

function sessionPanel() {
  return `
    <div class="section-row">
      <h2>Session</h2>
      <button type="button" data-action="session" ${!state.hasToken || state.loading ? "disabled" : ""}>Leer session</button>
    </div>
    <dl>
      <dt>Estado</dt>
      <dd>${escapeHtml(state.status)}</dd>
      <dt>Usuario</dt>
      <dd>${escapeHtml(state.user?.id || "-")}</dd>
      <dt>Token</dt>
      <dd>${state.hasToken ? "Si" : "No"}</dd>
      <dt>Conexion</dt>
      <dd data-connection-source>${escapeHtml(state.connectionSource)}</dd>
    </dl>
  `;
}

function clientesPanel() {
  return `
    <div class="section-row">
      <h2>Clientes</h2>
      <button type="button" data-action="clientes" ${!ready() || state.loading ? "disabled" : ""}>Actualizar</button>
    </div>
    <form class="inline-form" data-cliente-form>
      <div>
        <input name="ruc" placeholder="RUC" value="${escapeHtml(state.clienteForm.ruc || "")}">
        ${fieldError("ruc")}
      </div>
      <div>
        <input name="nombre" placeholder="Nombre" value="${escapeHtml(state.clienteForm.nombre || "")}" required>
        ${fieldError("nombre")}
      </div>
      <div>
        <input name="email" placeholder="Email" type="email" value="${escapeHtml(state.clienteForm.email || "")}">
        ${fieldError("email")}
      </div>
      <button type="submit" ${!ready() || state.loading ? "disabled" : ""}>Crear cliente</button>
    </form>
    ${clientesTable()}
  `;
}

function ventasPanel() {
  return `
    <div class="section-row">
      <h2>Ventas maestro/detalle</h2>
      <button type="button" data-action="ventas" ${!ready() || state.loading ? "disabled" : ""}>Actualizar</button>
    </div>
    <form data-venta-form>
      <div class="inline-form">
        <input name="cliente" placeholder="Cliente" required>
        <input name="fecha" type="datetime-local" value="${defaultDateTimeLocal()}" required>
        <input name="total" type="number" min="0" step="0.01" value="0" required>
      </div>
      <div class="detail-block">
        <div class="section-row">
          <strong>Items</strong>
          <button type="button" data-action="add-item">Agregar item</button>
        </div>
        <div data-detail-list="items">${itemRow()}</div>
      </div>
      <div class="detail-block">
        <div class="section-row">
          <strong>Cobros</strong>
          <button type="button" data-action="add-cobro">Agregar cobro</button>
        </div>
        <div data-detail-list="cobros">${cobroRow()}</div>
      </div>
      <button type="submit" ${!ready() || state.loading ? "disabled" : ""}>Crear venta</button>
    </form>
    ${ventasTable()}
  `;
}

function clientesTable() {
  if (!state.clientes.length) return `<p class="muted">Sin clientes.</p>`;
  return `
    <table>
      <thead><tr><th>ID</th><th>RUC</th><th>Nombre</th><th>Email</th><th>Acciones</th></tr></thead>
      <tbody>
        ${state.clientes.map((cliente) => state.editingClienteId === String(cliente.id) ? clienteEditRow(cliente) : `
          <tr>
            <td>${escapeHtml(cliente.id)}</td>
            <td>${escapeHtml(cliente.ruc || "")}</td>
            <td>${escapeHtml(cliente.nombre || "")}</td>
            <td>${escapeHtml(cliente.email || "")}</td>
            <td>
              <div class="actions">
                <button type="button" data-action="edit-cliente" data-id="${escapeHtml(cliente.id)}" ${state.loading ? "disabled" : ""}>Editar</button>
                <button class="danger" type="button" data-action="delete-cliente" data-id="${escapeHtml(cliente.id)}" ${state.loading ? "disabled" : ""}>Eliminar</button>
              </div>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function clienteEditRow(cliente) {
  return `
    <tr data-cliente-edit-row data-id="${escapeHtml(cliente.id)}">
      <td>${escapeHtml(cliente.id)}</td>
      <td><input name="ruc" value="${escapeHtml(cliente.ruc || "")}" placeholder="RUC">${fieldError("ruc")}</td>
      <td><input name="nombre" value="${escapeHtml(cliente.nombre || "")}" placeholder="Nombre" required>${fieldError("nombre")}</td>
      <td><input name="email" value="${escapeHtml(cliente.email || "")}" placeholder="Email" type="email">${fieldError("email")}</td>
      <td>
        <div class="actions">
          <button type="button" data-action="save-cliente" data-id="${escapeHtml(cliente.id)}" ${state.loading ? "disabled" : ""}>Guardar</button>
          <button class="secondary" type="button" data-action="cancel-cliente" ${state.loading ? "disabled" : ""}>Cancelar</button>
        </div>
      </td>
    </tr>
  `;
}

function ventasTable() {
  if (!state.ventas.length) return `<p class="muted">Sin ventas.</p>`;
  return `
    <table>
      <thead><tr><th>ID</th><th>Cliente</th><th>Fecha</th><th>Total</th><th>Items</th><th>Cobros</th></tr></thead>
      <tbody>
        ${state.ventas.map((venta) => `
          <tr>
            <td>${escapeHtml(venta.id)}</td>
            <td>${escapeHtml(venta.cliente)}</td>
            <td>${escapeHtml(formatDate(venta.fecha))}</td>
            <td>${escapeHtml(formatNumber(venta.total))}</td>
            <td>${escapeHtml(String((venta.items || []).length))}</td>
            <td>${escapeHtml(String((venta.cobros || []).length))}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function pendingPanel() {
  return `
    <div class="section-row">
      <h2>Pendientes</h2>
      <button type="button" data-action="send-all-pending" ${!state.pending.length || state.loading ? "disabled" : ""}>Reenviar todos</button>
    </div>
    ${pendingTable()}
  `;
}

function pendingTable() {
  if (!state.pending.length) return `<p class="muted">Sin pendientes.</p>`;
  return `
    <div class="table-scroll">
    <table>
      <thead><tr><th>ID</th><th>Servicio</th><th>Operacion</th><th>Estado</th><th>Mensaje</th><th>Datos</th><th>Acciones</th></tr></thead>
      <tbody>
        ${state.pending.map((item) => state.editingPendingId === String(item.id) ? pendingEditRow(item) : `
          <tr>
            <td>${escapeHtml(item.id)}</td>
            <td>${escapeHtml(item.service)}</td>
            <td>${escapeHtml(item.operation)}</td>
            <td>${escapeHtml(item.status || "")}</td>
            <td>${escapeHtml(item.message || "")}</td>
            <td><code>${escapeHtml(JSON.stringify(item.data || {}))}</code></td>
            <td>
              <div class="actions">
                <button type="button" data-action="send-pending" data-id="${escapeHtml(item.id)}" ${state.loading ? "disabled" : ""}>Enviar</button>
                <button type="button" data-action="edit-pending" data-id="${escapeHtml(item.id)}" ${state.loading ? "disabled" : ""}>Editar</button>
                <button class="danger" type="button" data-action="delete-pending" data-id="${escapeHtml(item.id)}" ${state.loading ? "disabled" : ""}>Eliminar</button>
              </div>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    </div>
  `;
}

function pendingEditRow(item) {
  return `
    <tr data-pending-edit-row data-id="${escapeHtml(item.id)}">
      <td>${escapeHtml(item.id)}</td>
      <td>${escapeHtml(item.service)}</td>
      <td>${escapeHtml(item.operation)}</td>
      <td>${escapeHtml(item.status || "")}</td>
      <td>${escapeHtml(item.message || "")}</td>
      <td><textarea name="data" rows="4">${escapeHtml(JSON.stringify(item.data || {}, null, 2))}</textarea></td>
      <td>
        <div class="actions">
          <button type="button" data-action="save-pending" data-id="${escapeHtml(item.id)}" ${state.loading ? "disabled" : ""}>Guardar</button>
          <button class="secondary" type="button" data-action="cancel-pending" ${state.loading ? "disabled" : ""}>Cancelar</button>
        </div>
      </td>
    </tr>
  `;
}

function itemRow() {
  return `
    <div class="detail-row" data-detail-row>
      <input name="itemProducto" placeholder="Producto" required>
      <input name="itemCantidad" type="number" min="1" step="1" value="1" required>
      <input name="itemPrecio" type="number" min="0" step="0.01" value="0" required>
      <button type="button" data-action="remove-detail">Quitar</button>
    </div>
  `;
}

function cobroRow() {
  return `
    <div class="detail-row" data-detail-row>
      <input name="cobroMedio" placeholder="Medio" value="efectivo" required>
      <input name="cobroMonto" type="number" min="0" step="0.01" value="0" required>
      <button type="button" data-action="remove-detail">Quitar</button>
    </div>
  `;
}

async function login(form) {
  await run(async () => {
    const response = await client.login(Object.fromEntries(new FormData(form)));
    state.user = response.data?.user || null;
    state.hasToken = Boolean(await client.token());
    state.status = state.hasToken ? "Login OK" : "Login sin token";
    assignServices();
    await loadCachedLists();
  });
}

async function init() {
  render();

  await run(async () => {
    const session = await client.session();
    if (!session?.token) {
      state.hasToken = false;
      state.status = "Sin sesion";
      return;
    }

    state.user = session.user || null;
    state.hasToken = true;
    state.status = "Session local OK";
    if (!tryAssignServices()) {
      state.status = "Sincronizando servicios...";
      return;
    }
    await loadCachedLists();
  });
}

async function loadSession() {
  await run(async () => {
    const session = await client.session();
    state.user = session?.user || null;
    state.hasToken = Boolean(session?.token);
    state.status = state.hasToken ? "Session local OK" : "Sin sesion";
  });
}

async function logout() {
  await run(async () => {
    if (await client.token()) await client.logout();
    state.user = null;
    state.hasToken = false;
    state.clientes = [];
    state.ventas = [];
    state.pending = [];
    services.clientes = null;
    services.ventas = null;
    services.pending = client.service("pending");
    state.status = "Logout OK";
  });
}

function assignServices() {
  services.clientes = client.service("clientes");
  services.ventas = client.service("ventas");
  services.pending = client.service("pending");
}

function tryAssignServices() {
  try {
    assignServices();
    return true;
  } catch {
    return false;
  }
}

async function loadClientes(wrap = true) {
  const task = async () => {
    assignServices();
    await services.clientes.pull();
    await loadCachedLists();
  };
  return wrap ? run(task) : task();
}

async function createCliente(form) {
  await run(async () => {
    try {
      state.clienteErrors = {};
      const formData = Object.fromEntries(new FormData(form));
      state.clienteForm = formData;
      const body = {
        nombre: formData.nombre,
        ruc : formData.ruc,
        email : formData.email,
        activo: true
      };
      const response = await services.clientes.create(body);
      //if (response.ok === false) throw response;
      form.reset();
      state.clienteForm = {};
      state.clientes = (await services.clientes.list()).data;
      state.pending = (await services.pending.list()).data;
    } catch (error) {
      state.clienteErrors = error.errors || {};
      throw error;
    }
  });
}

function editCliente(button) {
  state.clienteErrors = {};
  state.editingClienteId = button.dataset.id;
  render();
}

function cancelCliente() {
  state.clienteErrors = {};
  state.editingClienteId = null;
  render();
}

async function saveCliente(button) {
  const row = button.closest("[data-cliente-edit-row]");
  if (!row) return;

  await run(async () => {
    try {
      state.clienteErrors = {};
      const id = row.dataset.id;
      const body = {
        ruc: row.querySelector('[name="ruc"]').value,
        nombre: row.querySelector('[name="nombre"]').value,
        email: row.querySelector('[name="email"]').value,
      };
      if (!body.ruc) delete body.ruc;
      if (!body.email) delete body.email;
      await services.clientes.update(id, body);
      state.editingClienteId = null;
      state.clientes = (await services.clientes.list()).data;
      state.pending = (await services.pending.list()).data;
    } catch (error) {
      state.clienteErrors = error.errors || {};
      throw error;
    }
  });
}

async function deleteCliente(button) {
  await run(async () => {
    await services.clientes.remove(button.dataset.id);
    if (state.editingClienteId === button.dataset.id) state.editingClienteId = null;
    state.clientes = (await services.clientes.list()).data;
    state.pending = (await services.pending.list()).data;
  });
}

function editPending(button) {
  state.editingPendingId = button.dataset.id;
  render();
}

function cancelPending() {
  state.editingPendingId = null;
  render();
}

async function savePending(button) {
  const row = button.closest("[data-pending-edit-row]");
  if (!row) return;

  await run(async () => {
    const id = Number(row.dataset.id);
    const pending = state.pending.find((item) => Number(item.id) === id);
    if (!pending) return;
    const data = JSON.parse(row.querySelector('[name="data"]').value);
    await services.pending.update(id, { data, status: "pending", message: "", errors: null });
    state.editingPendingId = null;
    await refreshLocalState();
  });
}

async function sendPending(button) {
  await run(async () => {
    const pending = state.pending.find((item) => Number(item.id) === Number(button.dataset.id));
    const service = pending ? client.service(pending.service) : null;
    if (service) await service.push(Number(button.dataset.id));
    await refreshLocalState();
  });
}

async function sendAllPending() {
  await run(async () => {
    if (services.clientes) await services.clientes.push();
    if (services.ventas) await services.ventas.push();
    await refreshLocalState();
  });
}

async function deletePending(button) {
  await run(async () => {
    const id = Number(button.dataset.id);
    const pending = state.pending.find((item) => Number(item.id) === id);
    if (pending) await services.pending.remove(id);
    if (state.editingPendingId === button.dataset.id) state.editingPendingId = null;
    await refreshLocalState();
  });
}

async function loadVentas(wrap = true) {
  const task = async () => {
    assignServices();
    await services.ventas.pull();
    await loadCachedLists();
  };
  return wrap ? run(task) : task();
}

async function loadCachedLists() {
  state.clientes = services.clientes ? (await services.clientes.list()).data : [];
  state.ventas = services.ventas ? (await services.ventas.list()).data : [];
  state.pending = (await services.pending.list()).data;
}

async function createVenta(form) {
  await run(async () => {
    const formData = new FormData(form);
    const body = {
      cliente: formData.get("cliente"),
      fecha: new Date(formData.get("fecha")).toISOString(),
      total: Number(formData.get("total")),
      items: collectItems(formData),
      cobros: collectCobros(formData),
    };
    const created = await services.ventas.create(body);
    form.reset();
    const ventas = (await services.ventas.list()).data;
    if (created?.data?.id !== undefined) {
      const existingIndex = ventas.findIndex((item) => String(item.id) === String(created.data.id));
      if (existingIndex === -1) ventas.unshift(created.data);
      else ventas[existingIndex] = created.data;
    }
    state.ventas = ventas;
    state.pending = (await services.pending.list()).data;
  });
}

async function refreshLists() {
  if (!ready()) return;
  try {
    await loadClientes(false);
    await loadVentas(false);
    state.pending = (await services.pending.list()).data;
    render();
  } catch {
  }
}

async function refreshLocalState() {
  state.clientes = services.clientes ? (await services.clientes.list()).data : [];
  state.ventas = services.ventas ? (await services.ventas.list()).data : [];
  state.pending = (await services.pending.list()).data;
}

async function refreshFromClient(options = {}) {
  tryAssignServices();
  await refreshLocalState();
  if (options.background) renderFromBackground();
  else render();
}

function renderFromBackground() {
  render();
}

async function run(task) {
  state.loading = true;
  state.error = "";
  try {
    await task();
  } catch (error) {
    state.error = error.message;
    state.status = "Error";
  } finally {
    state.loading = false;
    render();
  }
}

function ready() {
  return Boolean(state.hasToken && services.clientes && services.ventas);
}

function updateStatusIndicators() {
  const tokenBadge = document.querySelector("[data-token-badge]");
  if (tokenBadge) {
    tokenBadge.className = `session ${state.hasToken ? "on" : "off"}`;
    tokenBadge.textContent = state.hasToken ? "Token persistido" : "Sin token";
  }

  const connectionBadge = document.querySelector("[data-connection-badge]");
  if (connectionBadge) {
    connectionBadge.className = `session ${client.connected() ? "on" : "off"}`;
    connectionBadge.textContent = client.connected() ? "Servidor conectado" : "Servidor offline";
  }

  const connectionSource = document.querySelector("[data-connection-source]");
  if (connectionSource) connectionSource.textContent = state.connectionSource;
}

function collectItems(formData) {
  const productos = formData.getAll("itemProducto");
  const cantidades = formData.getAll("itemCantidad");
  const precios = formData.getAll("itemPrecio");
  return productos
    .map((producto, index) => ({
      producto,
      cantidad: Number(cantidades[index]),
      precio: Number(precios[index]),
    }))
    .filter((item) => item.producto);
}

function collectCobros(formData) {
  const medios = formData.getAll("cobroMedio");
  const montos = formData.getAll("cobroMonto");
  return medios
    .map((medio, index) => ({
      medio,
      monto: Number(montos[index]),
    }))
    .filter((cobro) => cobro.medio);
}

function addDetailRow(detail) {
  const list = document.querySelector(`[data-detail-list="${detail}"]`);
  if (!list) return;
  list.insertAdjacentHTML("beforeend", detail === "cobros" ? cobroRow() : itemRow());
}

function removeDetailRow(button) {
  const row = button.closest("[data-detail-row]");
  const list = row?.parentElement;
  if (!row || !list || list.querySelectorAll("[data-detail-row]").length <= 1) return;
  row.remove();
}

function message() {
  if (state.error) return `<p class="alert">${escapeHtml(state.error)}</p>`;
  if (state.loading) return `<p class="muted">Procesando...</p>`;
  return "";
}

function fieldError(name) {
  const error = state.clienteErrors[name];
  return error ? `<small class="field-error">${escapeHtml(error)}</small>` : "";
}

function defaultDateTimeLocal() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("es-PY", { dateStyle: "short", timeStyle: "short" });
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value ?? "";
  return number.toLocaleString("es-PY", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

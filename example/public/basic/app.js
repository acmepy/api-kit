const API_BASE = "/api";

const state = {
  token: "",
  user: null,
  clientes: [],
  ventas: [],
  loading: false,
  error: "",
  status: "Sin sesion",
};

const app = document.querySelector("#app");

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
});

render();

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <span class="eyebrow">api</span>
        <h1>Basic fetch demo</h1>
      </div>
      <span class="session ${state.token ? "on" : "off"}">${state.token ? "Token en memoria" : "Sin token"}</span>
    </header>
    <main class="layout">
      <section class="panel">${loginPanel()}</section>
      <section class="panel">${sessionPanel()}</section>
      <section class="panel wide">${clientesPanel()}</section>
      <section class="panel wide">${ventasPanel()}</section>
    </main>
  `;
}

function loginPanel() {
  return `
    <div class="section-row">
      <h2>Login</h2>
      ${state.token ? `<button type="button" data-action="logout">Logout</button>` : ""}
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
      <button type="button" data-action="session" ${!state.token || state.loading ? "disabled" : ""}>Leer session</button>
    </div>
    <dl>
      <dt>Estado</dt>
      <dd>${escapeHtml(state.status)}</dd>
      <dt>Usuario</dt>
      <dd>${escapeHtml(state.user?.id || "-")}</dd>
    </dl>
  `;
}

function clientesPanel() {
  return `
    <div class="section-row">
      <h2>Clientes</h2>
      <button type="button" data-action="clientes" ${!state.token || state.loading ? "disabled" : ""}>Actualizar</button>
    </div>
    <form class="inline-form" data-cliente-form>
      <input name="ruc" placeholder="RUC">
      <input name="nombre" placeholder="Nombre" required>
      <input name="email" placeholder="Email" type="email">
      <button type="submit" ${!state.token || state.loading ? "disabled" : ""}>Crear cliente</button>
    </form>
    ${clientesTable()}
  `;
}

function ventasPanel() {
  return `
    <div class="section-row">
      <h2>Ventas maestro/detalle</h2>
      <button type="button" data-action="ventas" ${!state.token || state.loading ? "disabled" : ""}>Actualizar</button>
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
      <button type="submit" ${!state.token || state.loading ? "disabled" : ""}>Crear venta</button>
    </form>
    ${ventasTable()}
  `;
}

function clientesTable() {
  if (!state.clientes.length) return `<p class="muted">Sin clientes.</p>`;
  return `
    <table>
      <thead><tr><th>ID</th><th>RUC</th><th>Nombre</th><th>Email</th></tr></thead>
      <tbody>
        ${state.clientes.map((cliente) => `
          <tr>
            <td>${escapeHtml(cliente.id)}</td>
            <td>${escapeHtml(cliente.ruc || "")}</td>
            <td>${escapeHtml(cliente.nombre || "")}</td>
            <td>${escapeHtml(cliente.email || "")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function ventasTable() {
  if (!state.ventas.length) return `<p class="muted">Sin ventas.</p>`;
  return `
    <table>
      <thead><tr><th>ID</th><th>Cliente</th><th>Fecha</th><th>Total</th></tr></thead>
      <tbody>
        ${state.ventas.map((venta) => `
          <tr>
            <td>${escapeHtml(venta.id)}</td>
            <td>${escapeHtml(venta.cliente)}</td>
            <td>${escapeHtml(formatDate(venta.fecha))}</td>
            <td>${escapeHtml(formatNumber(venta.total))}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
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
    const response = await apiFetch("/login", {
      method: "POST",
      auth: false,
      body: Object.fromEntries(new FormData(form)),
    });
    state.token = response.data?.token || "";
    state.user = response.data?.user || null;
    state.status = state.token ? "Login OK" : "Login sin token";
    await loadClientes(false);
    await loadVentas(false);
  });
}

async function loadSession() {
  await run(async () => {
    const response = await apiFetch("/session");
    state.user = response.data?.user || null;
    state.status = "Session OK";
  });
}

async function logout() {
  await run(async () => {
    if (state.token) await apiFetch("/logout", { method: "POST" });
    state.token = "";
    state.user = null;
    state.clientes = [];
    state.ventas = [];
    state.status = "Logout OK";
  });
}

async function loadClientes(wrap = true) {
  const task = async () => {
    const response = await apiFetch("/clientes");
    state.clientes = response.data || [];
  };
  return wrap ? run(task) : task();
}

async function createCliente(form) {
  await run(async () => {
    const formData = Object.fromEntries(new FormData(form));
    const body = {
      nombre: formData.nombre,
      activo: true,
    };
    if (formData.ruc) body.ruc = formData.ruc;
    if (formData.email) body.email = formData.email;
    await apiFetch("/clientes", { method: "POST", body });
    form.reset();
    await loadClientes(false);
  });
}

async function loadVentas(wrap = true) {
  const task = async () => {
    const response = await apiFetch("/ventas");
    state.ventas = response.data || [];
  };
  return wrap ? run(task) : task();
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
    await apiFetch("/ventas", { method: "POST", body });
    form.reset();
    await loadVentas(false);
  });
}

async function apiFetch(path, options = {}) {
  const headers = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.auth !== false && state.token) headers.Authorization = `Bearer ${state.token}`;

  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.message || response.statusText);
  return payload;
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

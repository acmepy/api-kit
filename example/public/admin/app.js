const API_BASE = "/api";
const APP_BASE = "/admin";
const TOKEN_KEY = "api-kit-admin-token";

const state = {
  token: sessionStorage.getItem(TOKEN_KEY) || "",
  user: null,
  clientes: [],
  loading: false,
  error: "",
};

const app = document.querySelector("#app");

window.addEventListener("popstate", render);

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-route]");
  if (!link) return;
  event.preventDefault();
  navigate(link.getAttribute("href"));
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.matches("[data-login-form]")) {
    event.preventDefault();
    await login(form);
  }
  if (form.matches("[data-cliente-form]")) {
    event.preventDefault();
    await createCliente(form);
  }
});

document.addEventListener("click", async (event) => {
  const refresh = event.target.closest("[data-refresh]");
  if (refresh) {
    event.preventDefault();
    await renderClientes();
    return;
  }

  const logoutButton = event.target.closest("[data-logout]");
  if (!logoutButton) return;
  event.preventDefault();
  await logout();
});

render();

async function render() {
  const route = currentRoute();
  app.innerHTML = shell(route);

  if (route === "/clientes") await renderClientes();
}

function shell(route) {
  return `
    <header class="topbar">
      <a class="brand" href="${APP_BASE}/" data-route>api-kit</a>
      <nav class="nav">
        <a href="${APP_BASE}/" data-route class="${route === "/" ? "active" : ""}">Inicio</a>
        <a href="${APP_BASE}/clientes" data-route class="${route === "/clientes" ? "active" : ""}">Clientes</a>
        <a href="${API_BASE}/openapi.json">OpenAPI</a>
      </nav>
      ${state.token ? `<button class="ghost" type="button" data-logout>Salir</button>` : ""}
    </header>
    <main class="page">
      ${route === "/clientes" ? clientesView() : homeView()}
    </main>
  `;
}

function homeView() {
  return `
    <section class="hero">
      <div>
        <p class="eyebrow">Demo admin</p>
        <h1>Clientes</h1>
      </div>
      <a class="button" href="${APP_BASE}/clientes" data-route>Ver clientes</a>
    </section>
    <section class="panel metrics">
      <article>
        <span>API</span>
        <strong>${API_BASE}</strong>
      </article>
      <article>
        <span>SPA</span>
        <strong>${APP_BASE}</strong>
      </article>
      <article>
        <span>Sesion</span>
        <strong>${state.token ? "Activa" : "Pendiente"}</strong>
      </article>
    </section>
  `;
}

function clientesView() {
  if (!state.token) return loginView();

  return `
    <section class="section-title">
      <div>
        <p class="eyebrow">Modulo</p>
        <h1>Clientes</h1>
      </div>
      <button class="ghost" type="button" data-refresh>Actualizar</button>
    </section>
    ${state.error ? `<p class="alert">${escapeHtml(state.error)}</p>` : ""}
    <section class="grid">
      <form class="panel form" data-cliente-form>
        <label>
          <span>RUC</span>
          <input name="ruc" autocomplete="off">
        </label>
        <label>
          <span>Nombre</span>
          <input name="nombre" required autocomplete="name">
        </label>
        <label>
          <span>Email</span>
          <input name="email" type="email" autocomplete="email">
        </label>
        <label class="check">
          <input name="activo" type="checkbox" checked>
          <span>Activo</span>
        </label>
        <button class="button" type="submit" ${state.loading ? "disabled" : ""}>Guardar</button>
      </form>
      <section class="panel table-panel">
        ${state.loading ? `<p class="muted">Cargando...</p>` : clientesTable()}
      </section>
    </section>
  `;
}

function loginView() {
  return `
    <section class="login-wrap">
      <form class="panel login" data-login-form>
        <div>
          <p class="eyebrow">Sesion</p>
          <h1>Ingresar</h1>
        </div>
        ${state.error ? `<p class="alert">${escapeHtml(state.error)}</p>` : ""}
        <label>
          <span>Usuario</span>
          <input name="username" value="admin" autocomplete="username" required>
        </label>
        <label>
          <span>Password</span>
          <input name="password" value="1234" type="password" autocomplete="current-password" required>
        </label>
        <button class="button" type="submit" ${state.loading ? "disabled" : ""}>Entrar</button>
      </form>
    </section>
  `;
}

function clientesTable() {
  if (!state.clientes.length) return `<p class="muted">Sin clientes.</p>`;

  return `
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>RUC</th>
          <th>Nombre</th>
          <th>Email</th>
          <th>Estado</th>
        </tr>
      </thead>
      <tbody>
        ${state.clientes.map((cliente) => `
          <tr>
            <td>${escapeHtml(cliente.id)}</td>
            <td>${escapeHtml(cliente.ruc || "")}</td>
            <td>${escapeHtml(cliente.nombre || "")}</td>
            <td>${escapeHtml(cliente.email || "")}</td>
            <td><span class="status ${cliente.activo ? "on" : "off"}">${cliente.activo ? "Activo" : "Inactivo"}</span></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

async function renderClientes() {
  if (!state.token) return;

  state.loading = true;
  state.error = "";
  app.innerHTML = shell("/clientes");

  try {
    const response = await apiFetch("/clientes");
    state.clientes = response.data || [];
  } catch (error) {
    state.error = error.message;
    if (error.status === 401 || error.status === 403) clearSession();
  } finally {
    state.loading = false;
    app.innerHTML = shell("/clientes");
  }
}

async function login(form) {
  state.loading = true;
  state.error = "";
  app.innerHTML = shell("/clientes");

  try {
    const response = await fetchJson(`${API_BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    state.token = response.data.token;
    state.user = response.data.user;
    sessionStorage.setItem(TOKEN_KEY, state.token);
    await renderClientes();
  } catch (error) {
    state.error = error.message;
    state.loading = false;
    app.innerHTML = shell("/clientes");
  }
}

async function logout() {
  try {
    if (state.token) await apiFetch("/logout", { method: "POST" });
  } catch {
  } finally {
    clearSession();
    navigate(`${APP_BASE}/clientes`);
  }
}

async function createCliente(form) {
  const data = Object.fromEntries(new FormData(form));
  const body = {
    nombre: data.nombre,
    activo: data.activo === "on",
  };
  if (data.ruc) body.ruc = data.ruc;
  if (data.email) body.email = data.email;

  state.loading = true;
  state.error = "";
  app.innerHTML = shell("/clientes");

  try {
    await apiFetch("/clientes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await renderClientes();
  } catch (error) {
    state.error = error.message;
    state.loading = false;
    app.innerHTML = shell("/clientes");
  }
}

async function apiFetch(path, options = {}) {
  return fetchJson(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${state.token}`,
    },
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    const message = body.message || response.statusText || "Error";
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

function navigate(path) {
  history.pushState({}, "", path);
  render();
}

function currentRoute() {
  const path = window.location.pathname;
  if (!path.startsWith(APP_BASE)) return "/";
  const route = path.slice(APP_BASE.length).replace(/\/+$/g, "") || "/";
  return route;
}

function clearSession() {
  state.token = "";
  state.user = null;
  sessionStorage.removeItem(TOKEN_KEY);
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

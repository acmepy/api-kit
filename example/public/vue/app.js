import { createApp, reactive, ref } from "vue";
import { createApiClient, LocalStorageAdapter } from "api/client";
import { createApiVue, useApi, useApiForm, useApiService } from "api/vue";

const client = createApiClient({
  url: `${window.location.origin}/api`,
  adapter: new LocalStorageAdapter(),
  createAdapter: (options = {}) => new LocalStorageAdapter(options),
  pingInterval: 5000,
  pingTimeout: 3000,
  sseWatchdogTimeout: 25000,
});

const api = createApiVue(client);

createApp({
  setup() {
    const loginForm = reactive({ username: "admin", password: "1234" });
    const clienteForm = useApiForm("clientes", {
      operation: "create",
      initial: { ruc: "", nombre: "", email: "", activo: true },
    });
    const ventaForm = reactive({
      cliente: "",
      fecha: localDateTime(),
      total: 0,
      items: [{ producto: "", cantidad: 1, precio: 0 }],
      cobros: [{ medio: "efectivo", monto: 0 }],
    });
    const editing = ref(null);
    const formError = ref("");
    const clienteErrors = ref({});
    const clientes = useApiService("clientes");
    const ventas = useApiService("ventas");
    const pending = useApiService("pending");

    const run = async (action) => {
      formError.value = "";
      try {
        return await action();
      } catch (error) {
        formError.value = error.message || "No se pudo completar la operación";
        return null;
      }
    };

    const login = () => run(async () => {
      await api.login({ ...loginForm });
      await Promise.all([clientes.refresh(), ventas.refresh(), pending.refresh()]);
    });

    const logout = () => run(() => api.logout());
    const createCliente = () => run(async () => {
      await clienteForm.submit();
      clienteForm.reset();
    });
    const startEdit = (cliente) => {
      clienteErrors.value = {};
      editing.value = { ...cliente };
    };
    const saveEdit = () => run(async () => {
      try {
        clienteErrors.value = {};
        await clientes.update(editing.value.id, editing.value);
        editing.value = null;
      } catch (error) {
        clienteErrors.value = error.errors || error.response?.errors || {};
        throw error;
      }
    });
    const removeCliente = (id) => run(() => clientes.remove(id));
    const fieldError = (name) => formatFieldError(clienteErrors.value?.[name]);
    const createVenta = () => run(async () => {
      await ventas.create({
        ...ventaForm,
        total: Number(ventaForm.total),
        items: ventaForm.items.map((item) => ({ ...item, cantidad: Number(item.cantidad), precio: Number(item.precio) })),
        cobros: ventaForm.cobros.map((cobro) => ({ ...cobro, monto: Number(cobro.monto) })),
      });
      Object.assign(ventaForm, {
        cliente: "", fecha: localDateTime(), total: 0,
        items: [{ producto: "", cantidad: 1, precio: 0 }], cobros: [{ medio: "efectivo", monto: 0 }],
      });
    });
    const addItem = () => ventaForm.items.push({ producto: "", cantidad: 1, precio: 0 });
    const removeItem = (index) => ventaForm.items.length > 1 && ventaForm.items.splice(index, 1);
    const addCobro = () => ventaForm.cobros.push({ medio: "efectivo", monto: 0 });
    const removeCobro = (index) => ventaForm.cobros.length > 1 && ventaForm.cobros.splice(index, 1);
    const refreshAll = () => run(async () => {
      await Promise.all([clientes.pull(), ventas.pull(), pending.refresh()]);
    });
    const sendPending = (item) => run(async () => {
      await client.service(item.service).push(item.id);
      await pending.refresh();
    });
    const sendAllPending = () => run(async () => {
      for (const service of client.services().values()) {
        if (service.name && service.name !== "pending" && typeof service.push === "function") await service.push();
      }
      await pending.refresh();
    });

    return {
      api,
      clientes,
      ventas,
      pending,
      loginForm,
      clienteForm,
      ventaForm,
      editing,
      formError,
      clienteErrors,
      login,
      logout,
      createCliente,
      startEdit,
      saveEdit,
      removeCliente,
      fieldError,
      createVenta,
      addItem,
      removeItem,
      addCobro,
      removeCobro,
      refreshAll,
      sendPending,
      sendAllPending,
    };
  },
  template: `
    <header class="topbar">
      <div><span class="eyebrow">api / vue</span><h1>Vue client demo</h1></div>
      <div class="badges">
        <span class="session" :class="api.session.value?.token ? 'on' : 'off'">{{ api.session.value?.token ? 'Token persistido' : 'Sin token' }}</span>
        <span class="session" :class="api.connected.value ? 'on' : 'off'">{{ api.connected.value ? 'Servidor conectado' : 'Servidor offline' }}</span>
      </div>
    </header>
    <main class="layout">
      <section class="panel">
        <div class="section-row"><h2>Login</h2><button v-if="api.session.value?.token" @click="logout">Logout</button></div>
        <form v-if="!api.session.value?.token" @submit.prevent="login">
          <label>Usuario <input v-model="loginForm.username" autocomplete="username" required></label>
          <label>Password <input v-model="loginForm.password" type="password" autocomplete="current-password" required></label>
          <button>Login</button>
        </form>
        <dl v-else><dt>Usuario</dt><dd>{{ api.session.value?.user?.id || '-' }}</dd><dt>Último evento</dt><dd>{{ api.event.value?.type || '-' }}</dd></dl>
      </section>
      <section class="panel">
        <div class="section-row"><h2>Sincronización</h2><button :disabled="!api.session.value?.token" @click="refreshAll">Actualizar</button></div>
        <dl><dt>Servicios</dt><dd>{{ clientServices }}</dd><dt>Último cambio</dt><dd>{{ api.lastReceivedAt.value || '-' }}</dd><dt>Pendientes</dt><dd>{{ pending.records.value.length }}</dd></dl>
        <p v-if="formError || api.error.value" class="alert">{{ formError || api.error.value?.message }}</p>
      </section>
      <section class="panel wide">
        <div class="section-row"><h2>Clientes</h2><button :disabled="!api.session.value?.token" @click="clientes.pull()">Actualizar</button></div>
        <form class="inline-form" @submit.prevent="createCliente">
          <div><input v-model="clienteForm.data.ruc" placeholder="RUC"><small v-if="clienteForm.errors.ruc" class="field-error">{{ clienteForm.errors.ruc }}</small></div><div><input v-model="clienteForm.data.nombre" placeholder="Nombre" required><small v-if="clienteForm.errors.nombre" class="field-error">{{ clienteForm.errors.nombre }}</small></div><div><input v-model="clienteForm.data.email" placeholder="Email" type="email"><small v-if="clienteForm.errors.email" class="field-error">{{ clienteForm.errors.email }}</small></div>
          <button :disabled="!api.session.value?.token || clienteForm.submitting.value">Crear cliente</button>
        </form>
        <p v-if="clientes.loading.value" class="muted">Leyendo cache local…</p>
        <div v-else-if="clientes.empty.value" class="muted">Sin clientes.</div>
        <div v-else class="table-scroll"><table><thead><tr><th>ID</th><th>RUC</th><th>Nombre</th><th>Email</th><th>Acciones</th></tr></thead><tbody>
          <tr v-for="cliente in clientes.records.value" :key="cliente.id">
            <template v-if="editing?.id === cliente.id"><td>{{ cliente.id }}</td><td><input v-model="editing.ruc"><small v-if="fieldError('ruc')" class="field-error">{{ fieldError('ruc') }}</small></td><td><input v-model="editing.nombre"><small v-if="fieldError('nombre')" class="field-error">{{ fieldError('nombre') }}</small></td><td><input v-model="editing.email"><small v-if="fieldError('email')" class="field-error">{{ fieldError('email') }}</small></td><td class="actions"><button @click="saveEdit">Guardar</button><button class="secondary" @click="clienteErrors = {}; editing = null">Cancelar</button></td></template>
            <template v-else><td>{{ cliente.id }}</td><td>{{ cliente.ruc }}</td><td>{{ cliente.nombre }}</td><td>{{ cliente.email }}</td><td class="actions"><button @click="startEdit(cliente)">Editar</button><button class="danger" @click="removeCliente(cliente.id)">Eliminar</button></td></template>
          </tr>
        </tbody></table></div>
      </section>
      <section class="panel wide">
        <div class="section-row"><h2>Ventas maestro/detalle</h2><button :disabled="!api.session.value?.token" @click="ventas.pull()">Actualizar</button></div>
        <form @submit.prevent="createVenta">
          <div class="inline-form"><input v-model="ventaForm.cliente" placeholder="Cliente" required><input v-model="ventaForm.fecha" type="datetime-local" required><input v-model.number="ventaForm.total" type="number" min="0" step="0.01" required><button :disabled="!api.session.value?.token">Crear venta</button></div>
          <div class="detail-block"><div class="section-row"><strong>Items</strong><button type="button" @click="addItem">Agregar item</button></div><div v-for="(item, index) in ventaForm.items" :key="index" class="detail-row"><input v-model="item.producto" placeholder="Producto" required><input v-model.number="item.cantidad" type="number" min="1" required><input v-model.number="item.precio" type="number" min="0" step="0.01" required><button type="button" @click="removeItem(index)">Quitar</button></div></div>
          <div class="detail-block"><div class="section-row"><strong>Cobros</strong><button type="button" @click="addCobro">Agregar cobro</button></div><div v-for="(cobro, index) in ventaForm.cobros" :key="index" class="detail-row"><input v-model="cobro.medio" placeholder="Medio" required><input v-model.number="cobro.monto" type="number" min="0" step="0.01" required><button type="button" @click="removeCobro(index)">Quitar</button></div></div>
        </form>
        <div v-if="ventas.empty.value" class="muted">Sin ventas.</div>
        <div v-else class="table-scroll"><table><thead><tr><th>ID</th><th>Cliente</th><th>Fecha</th><th>Total</th><th>Items</th><th>Cobros</th></tr></thead><tbody><tr v-for="venta in ventas.records.value" :key="venta.id"><td>{{ venta.id }}</td><td>{{ venta.cliente }}</td><td>{{ venta.fecha }}</td><td>{{ venta.total }}</td><td>{{ venta.items?.length || 0 }}</td><td>{{ venta.cobros?.length || 0 }}</td></tr></tbody></table></div>
      </section>
      <section class="panel wide">
        <div class="section-row"><h2>Pendientes</h2><button :disabled="pending.empty.value" @click="sendAllPending">Reenviar todos</button></div>
        <div v-if="pending.empty.value" class="muted">Sin pendientes.</div>
        <div v-else class="table-scroll"><table><thead><tr><th>ID</th><th>Servicio</th><th>Operación</th><th>Estado</th><th>Mensaje</th><th>Acciones</th></tr></thead><tbody><tr v-for="item in pending.records.value" :key="item.id"><td>{{ item.id }}</td><td>{{ item.service }}</td><td>{{ item.operation }}</td><td>{{ item.status }}</td><td>{{ item.message }}</td><td><button @click="sendPending(item)">Enviar</button></td></tr></tbody></table></div>
      </section>
    </main>
  `,
  computed: {
    clientServices() {
      return api.client.services().size;
    },
  },
}).use(api).mount("#app");

function localDateTime() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function formatFieldError(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") return value.message || JSON.stringify(value);
  return value || "";
}

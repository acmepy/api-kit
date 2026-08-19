import { ref, readonly, provide, inject, onScopeDispose, computed } from 'vue';

/** Injection key used by the ApiKit Vue plugin. */
const ApiVueKey = Symbol("ApiKitVue");

/**
 * Creates the Vue-facing state for an ApiKit client.
 *
 * The client remains the single source of truth: services keep their local
 * cache and this layer refreshes refs whenever the client reports a change.
 */
function createApiVue(client) {
  if (!client || typeof client.onChange !== "function") {
    throw new TypeError("createApiVue requiere un ApiKitClient");
  }

  const connected = ref(Boolean(client.connected?.()));
  const lastReceivedAt = ref(client.lastReceivedAt?.() || null);
  const session = ref(null);
  const event = ref(null);
  const error = ref(null);
  const ready = ref(false);

  const refreshSession = async () => {
    try {
      session.value = await client.session();
    } catch (cause) {
      error.value = cause;
    }
  };

  const unsubscribe = client.onChange((nextEvent) => {
    event.value = nextEvent;
    connected.value = Boolean(client.connected?.());
    lastReceivedAt.value = nextEvent?.lastReceivedAt || client.lastReceivedAt?.() || null;
    if (["login", "logout", "auth-expired"].includes(nextEvent?.source)) refreshSession();
  });

  const initialized = refreshSession().finally(() => {
    ready.value = true;
  });

  const api = {
    client,
    connected: readonly(connected),
    lastReceivedAt: readonly(lastReceivedAt),
    session: readonly(session),
    event: readonly(event),
    error: readonly(error),
    ready: readonly(ready),
    initialized,
    async login(credentials) {
      error.value = null;
      try {
        return await client.login(credentials);
      } catch (cause) {
        error.value = cause;
        throw cause;
      } finally {
        await refreshSession();
      }
    },
    async logout() {
      error.value = null;
      try {
        return await client.logout();
      } catch (cause) {
        error.value = cause;
        throw cause;
      } finally {
        await refreshSession();
      }
    },
    async sync(force = false) {
      error.value = null;
      try {
        return await client.syncServices(force);
      } catch (cause) {
        error.value = cause;
        throw cause;
      }
    },
    install(app) {
      app.provide(ApiVueKey, api);
    },
    dispose() {
      unsubscribe();
    },
  };

  return api;
}

/** Alias kept for projects that prefer the Vue-first name. */
const createVueApi = createApiVue;

/** Makes an ApiKit Vue instance available to descendant components. */
function provideApi(api) {
  provide(ApiVueKey, api);
  return api;
}

/** Returns the Vue state registered with app.use(api). */
function useApi() {
  const api = inject(ApiVueKey, null);
  if (!api) throw new Error("ApiKit Vue no fue instalado. Usa app.use(createApiVue(client)).");
  return api;
}

/**
 * Reactive facade for a discovered client service.
 * `records` is always a view of the local client cache. Call `pull()` when a
 * manual remote refresh is wanted; SSE and `changes` refresh it automatically.
 */
function useApiService(name) {
  const api = useApi();
  const records = ref([]);
  const loading = ref(false);
  const error = ref(null);
  let active = true;

  const service = () => api.client.service(name);
  const refresh = async () => {
    if (typeof api.client.services === "function" && !api.client.services().has(name)) {
      return { ok: true, data: records.value };
    }
    loading.value = true;
    error.value = null;
    try {
      const response = await service().list();
      if (active) records.value = response.data || [];
      return response;
    } catch (cause) {
      if (active) error.value = cause;
      throw cause;
    } finally {
      if (active) loading.value = false;
    }
  };

  const run = (operation) => async (...args) => {
    error.value = null;
    try {
      const response = await service()[operation](...args);
      await refresh();
      return response;
    } catch (cause) {
      error.value = cause;
      throw cause;
    }
  };

  const unsubscribe = api.client.onChange(() => {
    refresh().catch(() => {});
  });
  refresh().catch(() => {});

  onScopeDispose(() => {
    active = false;
    unsubscribe();
  });

  return {
    name,
    records: readonly(records),
    data: readonly(records),
    loading: readonly(loading),
    error: readonly(error),
    empty: computed(() => records.value.length === 0),
    refresh,
    list: refresh,
    get: (...args) => service().get(...args),
    pull: run("pull"),
    pullOne: run("pullOne"),
    create: run("create"),
    update: run("update"),
    remove: run("remove"),
    push: run("push"),
  };
}

export { ApiVueKey, createApiVue, createVueApi, provideApi, useApi, useApiService };
//# sourceMappingURL=api-vue.js.map

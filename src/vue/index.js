import { computed, inject, onScopeDispose, provide, reactive, readonly, ref, watch } from "vue";

/** Injection key used by the ApiKit Vue plugin. */
export const ApiVueKey = Symbol("ApiKitVue");

/**
 * Creates the Vue-facing state for an ApiKit client.
 *
 * The client remains the single source of truth: services keep their local
 * cache and this layer refreshes refs whenever the client reports a change.
 */
export function createApiVue(client) {
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
export const createVueApi = createApiVue;

/** Makes an ApiKit Vue instance available to descendant components. */
export function provideApi(api) {
  provide(ApiVueKey, api);
  return api;
}

/** Returns the Vue state registered with app.use(api). */
export function useApi() {
  const api = inject(ApiVueKey, null);
  if (!api) throw new Error("ApiKit Vue no fue instalado. Usa app.use(createApiVue(client)).");
  return api;
}

/**
 * Reactive facade for a discovered client service.
 * `records` is always a view of the local client cache. Call `pull()` when a
 * manual remote refresh is wanted; SSE and `changes` refresh it automatically.
 */
export function useApiService(name) {
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

/**
 * Reactive form state backed by a discovered client service.
 * Unique rules are evaluated against the service's local cache as fields
 * change, while submit still lets the server remain the final authority.
 */
export function useApiForm(name, options = {}) {
  const api = useApi();
  const data = reactive({ ...(options.initial || {}) });
  const errors = reactive({});
  const validating = ref(false);
  const submitting = ref(false);
  const debounce = Number(options.debounce ?? 250);
  const timers = new Map();

  const service = () => api.client.service(name);
  const operation = () => {
    const value = typeof options.operation === "function" ? options.operation() : options.operation?.value ?? options.operation;
    return value || "create";
  };
  const available = () => typeof api.client.services !== "function" || api.client.services().has(name);
  const setErrors = (nextErrors = {}) => {
    for (const key of Object.keys(errors)) delete errors[key];
    Object.assign(errors, nextErrors || {});
  };
  const setFieldError = (field, value) => {
    if (value) errors[field] = value;
    else delete errors[field];
  };

  const validateField = async (field) => {
    if (!available()) return true;
    validating.value = true;
    try {
      await service().validateAt(field, data, operation());
      setFieldError(field, null);
      return true;
    } catch (cause) {
      setFieldError(field, cause.errors?.[field] || cause.message);
      return false;
    } finally {
      validating.value = false;
    }
  };
  const scheduleFieldValidation = (field) => {
    clearTimeout(timers.get(field));
    timers.set(field, setTimeout(() => {
      validateField(field).catch(() => {});
    }, Math.max(0, debounce)));
  };
  const validate = async () => {
    if (!available()) return data;
    validating.value = true;
    try {
      const validated = await service().validate(data, operation());
      Object.assign(data, validated);
      setErrors();
      return validated;
    } catch (cause) {
      setErrors(cause.errors || { form: cause.message });
      throw cause;
    } finally {
      validating.value = false;
    }
  };
  const submit = async () => {
    submitting.value = true;
    try {
      const validated = await validate();
      const action = operation();
      if (action === "create") return await service().create(validated);
      if (action === "update") {
        const id = options.id?.value ?? options.id ?? data.id;
        if (id === undefined || id === null) throw new Error("useApiForm requiere id para update");
        return await service().update(id, validated);
      }
      throw new Error(`Operacion de formulario "${action}" no soportada`);
    } catch (cause) {
      if (cause.errors) setErrors(cause.errors);
      throw cause;
    } finally {
      submitting.value = false;
    }
  };
  const reset = (values = options.initial || {}) => {
    for (const key of Object.keys(data)) delete data[key];
    Object.assign(data, values);
    setErrors();
  };

  const stop = watch(() => ({ ...data }), (next, previous) => {
    for (const field of Object.keys(next)) {
      if (next[field] !== previous[field]) scheduleFieldValidation(field);
    }
  });
  onScopeDispose(() => {
    stop();
    for (const timer of timers.values()) clearTimeout(timer);
  });

  return {
    name,
    data,
    errors: readonly(errors),
    validating: readonly(validating),
    submitting: readonly(submitting),
    valid: computed(() => Object.keys(errors).length === 0),
    validateField,
    validate,
    submit,
    reset,
    clearErrors: () => setErrors(),
  };
}

import { BaseService } from "./services/base-service.js";
import { defaultAdapter } from "./adapters/index.js";
import { ApiClientError } from "./errors.js";
import { encodeBody } from "./http.js";
import { discoverServiceDescriptors } from "./schema-descriptors.js";
import { PendingService } from "./services/pending-service.js";
import { SchemaService } from "./services/schema-service.js";
import { SessionService } from "./services/session-service.js";
import { joinUrl, normalizeTimeout } from "./utils.js";

const DEFAULT_PREFIX = "api";
const DEFAULT_SESSION_KEY = `${DEFAULT_PREFIX}:session`;
const DEFAULT_PING_INTERVAL = 5000;
const DEFAULT_PING_TIMEOUT = 3000;
const DEFAULT_SSE_WATCHDOG_TIMEOUT = 25000;
const DEFAULT_SYNC_CACHE_TIMEOUT = 5 * 60 * 1000;

function normalizeCacheTimeout(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout >= 0 ? timeout : fallback;
}

export function createApiClient(options = {}) {
  return new ApiClient(options);
}

export class ApiClient {
  #host;
  #baseUrl;
  #fetch;
  #adapter;
  #createAdapter;
  #prefix;
  #sessionKey;
  #session = null;
  #services = new Map();
  #listeners = new Set();
  #online = false;
  #lastReceivedAt = null;
  #syncServicesPromise = null;
  #backgroundSyncPromise = null;
  #backgroundServiceSyncs = new Map();
  #cachedRequests = new Map();
  #changesPromise = null;
  #pingTimer = null;
  #pingAbort = null;
  #pingPromise = null;
  #sseAbort = null;
  #sseReader = null;
  #sseOpenPromise = null;
  #watchdogTimer = null;
  #pingInterval;
  #pingTimeout;
  #sseWatchdogTimeout;
  #syncCacheTimeout;
  #changesEnabled;
  #sseEnabled;
  #paths;

  constructor(options = {}) {
    const url = new URL(options.url || "http://localhost:3000/api");
    this.#host = url.origin;
    this.#baseUrl = url.pathname.replace(/\/+$/g, "");
    this.#fetch = options.fetch || globalThis.fetch?.bind(globalThis);
    this.#adapter = options.adapter || defaultAdapter(options);
    this.#createAdapter = options.createAdapter || ((adapterOptions = {}) => defaultAdapter({ ...options, ...adapterOptions }));
    this.#prefix = options.prefix || DEFAULT_PREFIX;
    this.#sessionKey = options.sessionKey || (this.#prefix === DEFAULT_PREFIX ? DEFAULT_SESSION_KEY : `${this.#prefix}:session`);
    this.#services.set("pending", new PendingService({ client: this, prefix: this.#prefix, createAdapter: this.#createAdapter }));
    this.#pingInterval = normalizeTimeout(options.pingInterval ?? options.pingIntervalMs, DEFAULT_PING_INTERVAL);
    this.#pingTimeout = normalizeTimeout(options.pingTimeout ?? options.pingTimeoutMs, DEFAULT_PING_TIMEOUT);
    this.#sseWatchdogTimeout = normalizeTimeout(options.sseWatchdogTimeout ?? options.sseWatchdogTimeoutMs, DEFAULT_SSE_WATCHDOG_TIMEOUT);
    this.#syncCacheTimeout = normalizeCacheTimeout(options.syncCacheTimeout, DEFAULT_SYNC_CACHE_TIMEOUT);
    this.#changesEnabled = options.changes !== false;
    this.#sseEnabled = options.sse !== false;
    this.#paths = {
      login: options.loginPath || "/login",
      logout: options.logoutPath || "/logout",
      session: options.sessionPath || "/session",
      ping: options.pingPath || "/ping",
      schema: options.schemaPath || "/schema.json",
      changes: options.changesPath || "/changes",
      sse: options.ssePath || "/sse",
    };

    if (!this.#fetch) throw new Error("ApiClient requiere fetch");
    queueMicrotask(() => this.#startPing());
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  get adapter() {
    return this.#adapter;
  }

  async login(credentials = {}) {
    const response = await this.request(this.#paths.login, { method: "POST", body: credentials, auth: false });
    await this.sessionService().create(response.data || null);
    this.#onLine("login", response.data);

    await this.syncServices();
    if (this.#changesEnabled) await this.changes();
    this.#stopPing();
    if (this.#sseEnabled) await this.#openSse();
    return response;
  }

  async logout() {
    const response = await this.request(this.#paths.logout, { method: "POST" });
    await this.#clearServices();
    this.#stopPing();
    this.#closeSse();
    this.#clearWatchdog();
    this.#offLine("logout", response.data);
    this.#startPing();
    return response;
  }

  sessionService(){
    if (!this.#services.has("session")) this.#services.set('session', new SessionService({ client: this, prefix: this.#prefix, createAdapter: this.#createAdapter, path: this.#paths.session }));    
    return this.service("session")
  }
  async session() {
    const session = (await this.sessionService().adapter.getAll())[0] || {};
    if (session?.token && !this.#syncServicesPromise) await this.syncServices();
    return session;
  }

  async #expireSession(error) {
    await this.#clearServices()
    this.#stopPing();
    this.#closeSse();
    this.#clearWatchdog();
    this.#offLine("auth-expired", error?.response || null);
    this.#startPing();
  }

  async token() {
    return (await this.session())?.token || null;
  }

  service(name) {
    const service = this.#services.get(name);
    if (!service) throw new Error(`Servicio "${name}" no descubierto`);
    return service;
  }

  services() {
    return new Map(this.#services);
  }

  async cachedRequest(key, path, { force = false, ...options } = {}) {
    const cacheKey = `cache:${key}`;
    const cached = await this.#adapter.get(cacheKey);
    if (!force && cached && Object.hasOwn(cached, "data")) {
      const response = { ok: true, data: cached.data, cached: true };
      if (!this.#isSyncCacheFresh(cached)) response.refresh = this.#refreshCachedRequest(cacheKey, path, options);
      return response;
    }
    return this.#refreshCachedRequest(cacheKey, path, options);
  }

  async markServiceCacheUpdated(name) {
    const id = this.#serviceCacheKey(name);
    await this.#adapter.put(id, { id, lastUpdateAt: new Date().toISOString() });
  }

  async syncServices(force = false) {
    if (this.#syncServicesPromise) return this.#syncServicesPromise;
    if (!force && this.#services.get("schema")) return;

    const sync = this.#synchronizeServices(force);
    this.#syncServicesPromise = sync;
    try {
      return await sync;
    } finally {
      if (this.#syncServicesPromise === sync) this.#syncServicesPromise = null;
    }
  }

  async #synchronizeServices(force) {
    const schemaService = new SchemaService({ client: this, prefix: this.#prefix, createAdapter: this.#createAdapter, path: this.#paths.schema });
    this.#services.set("schema", schemaService);
    const cachedSchema = await this.#cachedDocument(schemaService);
    const cacheMetadata = await schemaService.adapter.get("metadata");

    if (!force && cachedSchema && this.#isSyncCacheFresh(cacheMetadata)) {
      await this.#registerSchemaServices(cachedSchema, schemaService);
      return;
    }

    if (!force && cachedSchema && cacheMetadata) {
      await this.#registerSchemaServices(cachedSchema, schemaService);
      if (this.#online) this.#refreshSchemaDocumentInBackground(schemaService);
      return;
    }

    await this.#refreshSchemaDocument(schemaService, force, cachedSchema);
  }

  async #refreshSchemaDocument(schemaService, force, fallbackSchema = null) {
    let schema = fallbackSchema;
    try {
      if (!this.#online) throw Error("OffLine");
      const document = await schemaService.pull();
      if (!Array.isArray(document?.services)) throw new Error("Documento schema invalido");
      schema = document;
    } catch (error) {
      if (error.status === 401) {
        await this.#expireSession(error);
        throw error;
      }
      schema ||= await this.#cachedDocument(schemaService);
      if (!schema) {
        if (error.message === "OffLine") return;
        throw error;
      }
    }

    await this.#registerSchemaServices(schema, schemaService, { force });
    if (schema && schema !== fallbackSchema) {
      await schemaService.adapter.put("metadata", { id: "metadata", lastUpdateAt: new Date().toISOString() });
    }
  }

  #refreshSchemaDocumentInBackground(schemaService) {
    if (this.#backgroundSyncPromise) return;
    const refresh = this.#refreshSchemaDocument(schemaService, false)
      .catch((error) => {
        if (error?.status !== 401) console.error("api-client, syncServices", error);
      })
      .finally(() => {
        if (this.#backgroundSyncPromise === refresh) this.#backgroundSyncPromise = null;
      });
    this.#backgroundSyncPromise = refresh;
  }

  async #registerSchemaServices(schema, schemaService, { force = false } = {}) {
    for (const descriptor of discoverServiceDescriptors(schema, this.#baseUrl)) {
      if (!descriptor.operations.list) continue;
      const service = new BaseService({ client: this, prefix: this.#prefix, createAdapter: this.#createAdapter, ...descriptor });
      this.#services.set(descriptor.name, service);
      if (Object.keys(descriptor.schemas || {}).length > 0) await schemaService.update(descriptor.name, descriptor.schemas);
      try {
        const localRecords = (await service.list()).data;
        if (localRecords.length === 0 || force) await service.pull();
        else if (!(await this.#isServiceCacheFresh(descriptor.name))) this.#refreshServiceInBackground(service);
      } catch (error) {
        if (error?.status === 401) {
          await this.#expireSession(error);
          throw error;
        }
        console.error("api-client, syncServices", error);
      }
    }
  }

  #refreshServiceInBackground(service) {
    if (this.#backgroundServiceSyncs.has(service.name)) return;
    const refresh = service.pull()
      .catch((error) => {
        if (error?.status !== 401) console.error("api-client, service refresh", service.name, error);
      })
      .finally(() => this.#backgroundServiceSyncs.delete(service.name));
    this.#backgroundServiceSyncs.set(service.name, refresh);
  }

  #serviceCacheKey(name) {
    return `sync:${name}`;
  }

  async #isServiceCacheFresh(name) {
    return this.#isSyncCacheFresh(await this.#adapter.get(this.#serviceCacheKey(name)));
  }

  #refreshCachedRequest(cacheKey, path, options) {
    if (this.#cachedRequests.has(cacheKey)) return this.#cachedRequests.get(cacheKey);
    const refresh = this.request(path, options)
      .then(async (response) => {
        await this.#adapter.put(cacheKey, { id: cacheKey, data: response.data, lastUpdateAt: new Date().toISOString() });
        return response;
      })
      .finally(() => this.#cachedRequests.delete(cacheKey));
    this.#cachedRequests.set(cacheKey, refresh);
    return refresh;
  }

  async #cachedDocument(service) {
    const document = await service.adapter.get("document");
    if (document) return document;
    return (await service.adapter.getAll()).find((record) => record?.schema) || null;
  }

  #isSyncCacheFresh(metadata) {
    const updatedAt = Date.parse(metadata?.lastUpdateAt || "");
    return Number.isFinite(updatedAt) && Date.now() - updatedAt < this.#syncCacheTimeout;
  }

  connected() {
    return this.#online;
  }

  lastReceivedAt() {
    return this.#lastReceivedAt;
  }

  destroy() {
    this.#stopPing();
    this.#closeSse();
    this.#clearWatchdog();
    this.#listeners.clear();
  }

  disconnect() {
    this.destroy();
  }

  onChange(listener) {
    if (typeof listener !== "function") throw new TypeError("listener debe ser una funcion");
    this.#listeners.add(listener);
    return () => this.offChange(listener);
  }

  offChange(listener) {
    this.#listeners.delete(listener);
  }

  notifyChange(event = {}) {
    this.#emitChange({ type: "cache", ...event });
  }

  async changes(since) {
    if (this.#changesPromise) return this.#changesPromise;

    const changes = this.#requestChanges(since);
    this.#changesPromise = changes;
    try {
      return await changes;
    } finally {
      if (this.#changesPromise === changes) this.#changesPromise = null;
    }
  }

  async #requestChanges(since) {
    const requestedSince = since ? this.#normalizeDateTime(since) : this.#lastReceivedAt || this.#now();
    const query = { since: requestedSince };
    let response;
    try {
      response = await this.request(this.#paths.changes, { query });
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) await this.#expireSession(error);
      throw error;
    }
    const receivedAt = this.#touchLastReceivedAt();
    await this.#applyChangesData(response.data);
    this.#onLine("changes", response.data, { lastReceivedAt: receivedAt });
    this.#emitChange({ type: "changes", data: response.data, lastReceivedAt: receivedAt });
    return response;
  }

  async request(path, options = {}) {
    const url = this.url(path, options.query);
    const headers = { Accept: "application/json", ...(options.headers || {}) };
    const body = encodeBody(options.body, headers);
    const token = options.token || await this.token() || null;
    if (options.requireToken && !token) throw new ApiClientError("Sesion local requerida", { status: 401 });
    if (options.auth !== false && token) headers.Authorization = `Bearer ${token}`;

    let response;
    try {
      response = await this.#fetch(url, { method: options.method || "GET", headers, body, signal: options.signal, cache: options.cache });
    } catch (error) {
      const payload = { ok: false, message: error.message || "Error de red", error };
      throw new ApiClientError(payload.message, { response: payload });
    }
    const contentType = response.headers?.get?.("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok || payload?.ok === false){
      throw new ApiClientError(payload?.message || response.statusText, { status: response.status, response: payload });
    }

    return payload;
  }

  url(path, query = {}) {
    const url = new URL(joinUrl(joinUrl(this.#host, this.#baseUrl), path));
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async #ping() {
    if (this.#pingPromise) return this.#pingPromise;

    const ping = this.#runPing();
    this.#pingPromise = ping;
    try {
      return await ping;
    } finally {
      if (this.#pingPromise === ping) this.#pingPromise = null;
    }
  }

  async #runPing() {
    const controller = new AbortController();
    this.#pingAbort = controller;
    const timeout = setTimeout(() => controller.abort(), this.#pingTimeout);
    timeout.unref?.();
    try {
      await this.#pingRequest(controller.signal);
    } catch {
      this.#offLine("ping");
      if (this.#pingAbort === controller) this.#pingAbort = null;
      clearTimeout(timeout);
      return;
    }

    try {
      const localSession = await this.session() || null;
      if (!localSession?.token) throw new ApiClientError("Sesion local requerida", { status: 401 });
      await this.syncServices();
      if (this.#changesEnabled) await this.changes();
      this.#stopPing();
      if (this.#sseEnabled) await this.#openSse();
    } catch {
      this.#closeSse();
    } finally {
      if (this.#pingAbort === controller) this.#pingAbort = null;
      clearTimeout(timeout);
    }
  }

  async #pingRequest(signal) {
    const response = await this.request(this.#paths.ping, { method: "GET", auth: false, signal });
    this.#onLine("ping", response.data);
    return response;
  }

  #startPing() {
    if (this.#pingTimer) return;
    this.#pingTimer = setInterval(() => {this.#ping()}, this.#pingInterval);
    this.#pingTimer.unref?.();
    this.#ping();
  }

  #stopPing() {
    const abort = this.#pingAbort;
    this.#pingAbort = null;
    abort?.abort();
    if (!this.#pingTimer) return;
    clearInterval(this.#pingTimer);
    this.#pingTimer = null;
  }

  async #openSse() {
    if (!this.#sseEnabled) return;
    if (this.#sseAbort) return;

    if (this.#sseOpenPromise) return this.#sseOpenPromise;

    const opening = this.#startSse();
    this.#sseOpenPromise = opening;
    try {
      return await opening;
    } finally {
      if (this.#sseOpenPromise === opening) this.#sseOpenPromise = null;
    }
  }

  async #startSse() {
    if (!(await this.token())) return;
    if (this.#sseAbort) return;
    const controller = new AbortController();
    this.#sseAbort = controller;
    const headers = { Accept: "text/event-stream" };
    const token = await this.token();
    if (token) headers.Authorization = `Bearer ${token}`;

    this.#fetch(this.url(this.#paths.sse), { headers, signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(response.statusText);
        this.#resetWatchdog();
        return this.#readSse(response);
      })
      .catch(() => {
        if (this.#sseAbort === controller) {
          this.#closeSse();
          this.#offLine("sse");
          this.#startPing();
        }
      });
  }

  async #readSse(response) {
    if (!response.body?.getReader) return;
    const reader = response.body.getReader();
    this.#sseReader = reader;
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (this.#sseAbort) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || "";
        for (const part of parts) await this.#handleSseMessage(part);
      }
    } finally {
      if (this.#sseReader === reader) this.#sseReader = null;
      reader.releaseLock?.();
    }
  }

  async #handleSseMessage(raw) {
    if (!raw.trim()) return;
    const receivedAt = this.#touchLastReceivedAt();
    this.#onLine("sse", undefined, { lastReceivedAt: receivedAt });
    this.#resetWatchdog();
    const lines = raw.split(/\r?\n/);
    const dataLines = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) return;

    let data = dataLines.join("\n");
    try {
      data = JSON.parse(data);
    } catch (error) {
      console.error("[api] [sse]", error);
    }
    await this.#applyServiceData(data);
    this.#emitChange({ type: "sse", data, lastReceivedAt: receivedAt });
  }

  async #applyServiceData(data) {
    if (!data || typeof data !== "object") return;
    const serviceName = data.service || data.serviceName || data.tableName;
    if (!serviceName || serviceName === "audit") return;
    const service = this.#services.get(serviceName);
    if (!service) return;
    await service.applyData(data);
  }

  async #applyChangesData(data) {
    if (!Array.isArray(data)) return;
    for (const change of data) await this.#applyServiceData(change);
  }

  #resetWatchdog() {
    this.#clearWatchdog();
    this.#watchdogTimer = setTimeout(() => {
      this.#closeSse();
      this.#offLine("watchdog");
      this.#startPing();
    }, this.#sseWatchdogTimeout);
    this.#watchdogTimer.unref?.();
  }

  #clearWatchdog() {
    if (!this.#watchdogTimer) return;
    clearTimeout(this.#watchdogTimer);
    this.#watchdogTimer = null;
  }

  #closeSse() {
    const abort = this.#sseAbort;
    const reader = this.#sseReader;
    this.#sseAbort = null;
    this.#sseReader = null;
    abort?.abort();
    reader?.cancel?.().catch?.(() => {});
  }

  async #clearServices() {
    for (const [serviceName, service] of this.#services.entries()) {
      if (serviceName === "audit") continue;
      await service.clear();
      await this.#adapter.delete(this.#serviceCacheKey(serviceName));
    }
  }

  #onLine(source, data, extra = {}) {
    const changed = !this.#online;
    this.#online = true;
    this.#emitChange({ type: "online", source, data, changed, ...extra });
  }

  #offLine(source, data) {
    const changed = this.#online;
    this.#online = false;
    this.#emitChange({ type: "offline", source, data, changed });
  }

  #emitChange(event) {
    for (const listener of this.#listeners) listener(event);
  }

  #touchLastReceivedAt() {
    this.#lastReceivedAt = this.#now();
    return this.#lastReceivedAt;
  }

  #now() {
    return new Date().toISOString();
  }

  #normalizeDateTime(value) {
    return value instanceof Date ? value.toISOString() : value;
  }
}


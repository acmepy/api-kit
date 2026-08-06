import { BaseService } from "./services/base-service.js";
import { defaultAdapter } from "./adapters/index.js";
import { ApiKitClientError } from "./errors.js";
import { encodeBody } from "./http.js";
import { discoverServiceDescriptors } from "./openapi.js";
import { PendingService } from "./services/pending-service.js";
import { fallbackOrigin, joinUrl, normalizeBaseUrl, normalizeTimeout } from "./utils.js";

const DEFAULT_SERVICE_PREFIX = "api-kit";
const DEFAULT_SESSION_KEY = `${DEFAULT_SERVICE_PREFIX}:session`;
const DEFAULT_PING_INTERVAL = 5000;
const DEFAULT_PING_TIMEOUT = 3000;
const DEFAULT_SSE_WATCHDOG_TIMEOUT = 25000;

export function createApiKitClient(options = {}) {
  return new ApiKitClient(options);
}

export class ApiKitClient {
  #baseUrl;
  #fetch;
  #adapter;
  #servicePrefix;
  #sessionKey;
  #session = null;
  #services = new Map();
  #openapi = null;
  #listeners = new Set();
  #online = false;
  #lastReceivedAt = null;
  #syncServicesPromise = null;
  #pingTimer = null;
  #pingAbort = null;
  #sseAbort = null;
  #sseReader = null;
  #watchdogTimer = null;
  #pingInterval;
  #pingTimeout;
  #sseWatchdogTimeout;
  #paths;

  constructor(options = {}) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl || options.url || "");
    this.#fetch = options.fetch || globalThis.fetch?.bind(globalThis);
    this.#adapter = options.adapter || defaultAdapter(options);
    this.#servicePrefix = options.servicePrefix || DEFAULT_SERVICE_PREFIX;
    this.#sessionKey = options.sessionKey || (this.#servicePrefix === DEFAULT_SERVICE_PREFIX ? DEFAULT_SESSION_KEY : `${this.#servicePrefix}:session`);
    this.#services.set("pending", new PendingService({ client: this, servicePrefix: this.#servicePrefix }));
    this.#pingInterval = normalizeTimeout(options.pingInterval ?? options.pingIntervalMs, DEFAULT_PING_INTERVAL);
    this.#pingTimeout = normalizeTimeout(options.pingTimeout ?? options.pingTimeoutMs, DEFAULT_PING_TIMEOUT);
    this.#sseWatchdogTimeout = normalizeTimeout(options.sseWatchdogTimeout ?? options.sseWatchdogTimeoutMs, DEFAULT_SSE_WATCHDOG_TIMEOUT);
    this.#paths = {
      login: options.loginPath || "/login",
      logout: options.logoutPath || "/logout",
      session: options.sessionPath || "/session",
      ping: options.pingPath || "/ping",
      openapi: options.openapiPath || "/openapi.json",
      changes: options.changesPath || "/changes",
      sse: options.ssePath || "/sse",
    };

    if (!this.#fetch) throw new Error("ApiKitClient requiere fetch");
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
    this.#session = response.data || null;
    await this.#persistSession();
    this.#markOnline("login", response.data);
    await this.syncServices();
    await this.changes();
    this.#stopPing();
    await this.#openSse();
    return response;
  }

  async logout() {
    const response = await this.request(this.#paths.logout, { method: "POST" });
    await this.#clearLocalSession();
    await this.#clearServiceCaches();
    await this.#clearCachedOpenapi();
    this.#stopPing();
    this.#closeSse();
    this.#clearWatchdog();
    this.#markOffline("logout", response.data);
    this.#startPing();
    return response;
  }

  async session() {
    return this.#loadSession();
  }

  async clearSession() {
    await this.#clearSession();
    this.#markOffline("session");
    return null;
  }

  async discover(openapi) {
    let source = openapi ? "provided" : "openapi";
    if (openapi) {
      this.#openapi = openapi;
      await this.#persistOpenapi();
    } else {
      try {
        this.#openapi = await this.request(this.#paths.openapi, { method: "GET" });
        await this.#persistOpenapi();
        this.#markOnline("openapi", this.#openapi);
      } catch (error) {
        if (this.#isAuthExpiredError(error)) throw error;
        const cached = await this.#loadCachedOpenapi();
        if (!cached) throw error;
        this.#openapi = cached;
        source = "openapi-cache";
        this.#markOffline(source, { message: error.message });
      }
    }

    const pendingService = this.#pendingService();
    this.#services.clear();
    this.#services.set("pending", pendingService);

    for (const descriptor of discoverServiceDescriptors(this.#openapi, this.#baseUrl)) {
      if (descriptor.name === "pending") continue;
      this.#services.set(descriptor.name, new BaseService({ client: this, servicePrefix: this.#servicePrefix, ...descriptor }));
    }

    await this.#preloadServiceSchemas();

    if (source === "openapi-cache") this.#emitChange({ type: "discover", source, data: this.#openapi });
    return this;
  }


  async #preloadServiceSchemas() {
    for (const service of this.#services.values()) {
      if (service.name === "pending" || typeof service.loadSchema !== "function") continue;
      await service.loadSchema();
    }
  }
  service(name) {
    const service = this.#services.get(name);
    if (!service) throw new Error(`Servicio "${name}" no descubierto`);
    return service;
  }

  services() {
    return new Map(this.#services);
  }

  async syncServices(force = false) {
    if (this.#syncServicesPromise) return this.#syncServicesPromise;
    const promise = this.#runSyncServices(force);
    this.#syncServicesPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.#syncServicesPromise === promise) this.#syncServicesPromise = null;
    }
  }

  connected() {
    return this.#online;
  }

  isConnected() {
    return this.connected();
  }

  getSession() {
    return this.#session;
  }

  token() {
    return this.#session?.token || null;
  }

  lastReceivedAt() {
    return this.#lastReceivedAt;
  }

  onChange(listener) {
    if (typeof listener !== "function") throw new TypeError("listener debe ser una funcion");
    this.#listeners.add(listener);
    return () => this.offChange(listener);
  }

  offChange(listener) {
    this.#listeners.delete(listener);
  }

  async changes(since) {
    const requestedSince = since ? this.#normalizeDateTime(since) : this.#lastReceivedAt || this.#now();
    const query = { since: requestedSince };
    let response;
    try {
      response = await this.request(this.#paths.changes, { query });
    } catch (error) {
      if (this.#isAuthExpiredError(error)) await this.#expireSession(error);
      throw error;
    }
    const receivedAt = this.#touchLastReceivedAt();
    await this.#applyChangesData(response.data);
    this.#markOnline("changes", response.data, { lastReceivedAt: receivedAt });
    this.#emitChange({ type: "changes", data: response.data, lastReceivedAt: receivedAt });
    return response;
  }

  async stopConnection() {
    return this.logout();
  }

  async request(path, options = {}) {
    await this.#loadSession();
    const url = this.url(path, options.query);
    const headers = { Accept: "application/json", ...(options.headers || {}) };
    const body = encodeBody(options.body, headers);
    const token = options.token || this.#session?.token || null;
    if (options.requireToken && !token) throw new ApiKitClientError("Sesion local requerida", { status: 401 });
    if (options.auth !== false && token) headers.Authorization = `Bearer ${token}`;

    const response = await this.#fetch(url, { method: options.method || "GET", headers, body, signal: options.signal });
    const contentType = response.headers?.get?.("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok || payload?.ok === false) throw new ApiKitClientError(payload?.message || response.statusText, { status: response.status, response: payload });

    return payload;
  }

  url(path, query = {}) {
    const url = new URL(joinUrl(this.#baseUrl, path), fallbackOrigin());
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async #runSyncServices(force = false) {
    try {
      await this.discover();
    } catch (error) {
      if (this.#isAuthExpiredError(error)) {
        await this.#expireSession(error);
        throw error;
      }
      const result = { ok: false, results: {}, errors: { discover: error.message } };
      this.#emitChange({ type: "sync", source: "services", ...result });
      return result;
    }

    const results = {};
    for (const service of this.#services.values()) {
      if (service.name === "audit") continue;
      if (!service.operations.list) continue;
      const cacheKey = this.#serviceCacheKey(service.name);
      const cached = await this.#adapter.get(cacheKey);
      if (!force && this.#hasCachedServiceData(cached)) {
        results[service.name] = { ok: true, data: cached || [], local: true, skipped: true };
        continue;
      }
      try {
        const response = await service.pull();
        results[service.name] = { ok: true, data: response.data || [] };
      } catch (error) {
        if (this.#isAuthExpiredError(error)) {
          await this.#expireSession(error);
          throw error;
        }
        results[service.name] = { ok: false, error: error.message };
      }
    }

    let pending = { ok: true, results: [], errors: [] };
    try {
      pending = await this.#pendingService().push(null, { discover: false, throwAuthErrors: true });
    } catch (error) {
      if (this.#isAuthExpiredError(error)) {
        await this.#expireSession(error);
        throw error;
      }
      pending = { ok: false, results: [], errors: [{ ok: false, error: error.message }] };
    }

    const errors = Object.fromEntries(Object.entries(results).filter(([, result]) => !result.ok));
    const ok = Object.keys(errors).length === 0 && pending.ok;
    this.#emitChange({ type: "sync", source: "services", ok, results, errors, pending });
    return { ok, results, errors, pending };
  }

  async #ping() {
    const controller = new AbortController();
    this.#pingAbort = controller;
    const timeout = setTimeout(() => controller.abort(), this.#pingTimeout);
    timeout.unref?.();
    try {
      await this.#pingRequest(controller.signal);
    } catch {
      this.#markOffline("ping");
      if (this.#pingAbort === controller) this.#pingAbort = null;
      clearTimeout(timeout);
      return;
    }

    try {
      const localSession = await this.#loadSession();
      if (!localSession?.token) throw new ApiKitClientError("Sesion local requerida", { status: 401 });
      await this.syncServices();
      await this.changes();
      this.#stopPing();
      await this.#openSse();
    } catch {
      this.#closeSse();
    } finally {
      if (this.#pingAbort === controller) this.#pingAbort = null;
      clearTimeout(timeout);
    }
  }

  async #pingRequest(signal) {
    const response = await this.request(this.#paths.ping, { method: "GET", auth: false, signal });
    this.#markOnline("ping", response.data);
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
    if (this.#sseAbort) return;
    await this.#loadSession();
    if (!this.token()) return;
    const controller = new AbortController();
    this.#sseAbort = controller;
    const headers = { Accept: "text/event-stream" };
    if (this.#session?.token) headers.Authorization = `Bearer ${this.#session.token}`;

    this.#fetch(this.url(this.#paths.sse), { headers, signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(response.statusText);
        this.#resetWatchdog();
        return this.#readSse(response);
      })
      .catch(() => {
        if (this.#sseAbort === controller) {
          this.#closeSse();
          this.#markOffline("sse");
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
    this.#markOnline("sse", undefined, { lastReceivedAt: receivedAt });
    this.#resetWatchdog();
    const lines = raw.split(/\r?\n/);
    const dataLines = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) return;

    let data = dataLines.join("\n");
    try {
      data = JSON.parse(data);
    } catch (error) {
      console.error("[api-kit] [sse]", error);
    }
    await this.#applySseData(data);
    this.#emitChange({ type: "sse", data, lastReceivedAt: receivedAt });
  }

  async #applySseData(data) {
    if (!data || typeof data !== "object") return;
    const serviceName = data.service || data.serviceName || data.tableName;
    if (!serviceName || serviceName === "audit") return;
    const service = this.#services.get(serviceName);
    if (!service) return;

    const action = data.action || data.type;
    if (action === "create" || action === "update") {
      const record = data.new && typeof data.new === "object" ? { ...data.new } : null;
      if (!record) return;
      if (record.id === undefined && data.rowId !== undefined && data.rowId !== null) record.id = data.rowId;
      if (record.id === undefined || record.id === null) return;
      await service.create(record, { isPending: true });
      return;
    }

    if (action === "delete" || action === "remove") {
      const id = data.old?.id ?? data.rowId ?? data.id;
      if (id === undefined || id === null) return;
      await service.remove(id, { isPending: true });
    }
  }

  async #applyChangesData(data) {
    if (!Array.isArray(data)) return;
    for (const change of data) await this.#applySseData(change);
  }

  #resetWatchdog() {
    this.#clearWatchdog();
    this.#watchdogTimer = setTimeout(() => {
      this.#closeSse();
      this.#markOffline("watchdog");
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

  async #clearSession() {
    await this.#clearLocalSession();
    await this.#clearServiceCaches();
    await this.#clearCachedOpenapi();
    this.#stopPing();
    this.#closeSse();
    this.#clearWatchdog();
  }

  async #expireSession(error) {
    await this.#clearSession()
    this.#markOffline("auth-expired", error?.response || null);
    this.#startPing();
  }

  #isAuthExpiredError(error) {
    return error instanceof ApiKitClientError && error.status === 401;
  }

  async #clearLocalSession() {
    this.#session = null;
    await this.#adapter.remove(this.#sessionKey);
  }

  async #clearServiceCaches() {
    for (const [serviceName, service] of this.#services.entries()) {
      if (serviceName === "audit") continue;
      await service.clear();
    }
  }

  #markOnline(source, data, extra = {}) {
    const changed = !this.#online;
    this.#online = true;
    this.#emitChange({ type: "online", source, data, changed, ...extra });
  }

  #markOffline(source, data) {
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

  async #loadSession() {
    if (this.#session) return this.#session;
    this.#session = (await this.#adapter.get(this.#sessionKey)) || null;
    return this.#session;
  }

  async #persistSession() {
    if (this.#session) await this.#adapter.set(this.#sessionKey, this.#session);
  }


  async #loadCachedOpenapi() {
    return (await this.#adapter.get(this.#openapiCacheKey())) || null;
  }

  async #persistOpenapi() {
    if (this.#openapi) await this.#adapter.set(this.#openapiCacheKey(), this.#openapi);
  }

  async #clearCachedOpenapi() {
    await this.#adapter.remove(this.#openapiCacheKey());
  }
  #serviceCacheKey(serviceName) {
    return `${this.#servicePrefix}:${serviceName}`;
  }

  #openapiCacheKey() {
    return `${this.#servicePrefix}:openapi`;
  }

  #pendingService() {
    return this.#services.get("pending");
  }

  #hasCachedServiceData(value) {
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== null;
  }

}


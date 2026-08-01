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
const DEFAULT_SSE_WATCHDOG_TIMEOUT = 20000;

export function createApiKitClient(options = {}) {
  return new ApiKitClient(options);
}

export class ApiKitClient {
  #baseUrl;
  #fetch;
  #adapter;
  #servicePrefix;
  #sessionKey;
  #pendingService;
  #session = null;
  #services = new Map();
  #openapi = null;
  #listeners = new Set();
  #online = false;
  #lastReceivedAt = null;
  #syncServicesPromise = null;
  #pingTimer = null;
  #sseAbort = null;
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
    this.#pendingService = new PendingService({ client: this, adapter: this.#adapter, servicePrefix: this.#servicePrefix });
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
    await this.#pendingService.clear();
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
    this.#openapi = openapi || (await this.request(this.#paths.openapi, { method: "GET" }));
    if (!openapi) this.#markOnline("openapi", this.#openapi);
    this.#services.clear();

    for (const descriptor of discoverServiceDescriptors(this.#openapi, this.#baseUrl)) {
      this.#services.set(descriptor.name, new BaseService({ client: this, ...descriptor }));
    }

    return this;
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

  async serviceData(serviceName) {
    return (await this.#adapter.get(this.#serviceCacheKey(serviceName))) || [];
  }

  async setServiceData(serviceName, data = []) {
    await this.#adapter.set(this.#serviceCacheKey(serviceName), data);
    return data;
  }

  async addServiceRecord(serviceName, record = {}) {
    const records = await this.serviceData(serviceName);
    const nextRecords = [...records.filter((item) => String(item?.id) !== String(record.id)), record];
    await this.setServiceData(serviceName, nextRecords);
    return record;
  }

  async removeServiceRecord(serviceName, id) {
    const records = await this.serviceData(serviceName);
    const nextRecords = records.filter((item) => String(item?.id) !== String(id));
    await this.setServiceData(serviceName, nextRecords);
    return nextRecords;
  }

  async nextTemporaryId() {
    return this.#pendingService.nextTemporaryId();
  }

  async pending() {
    return this.#pendingService.list();
  }

  async addPending(operation = {}) {
    return this.#pendingService.create(operation);
  }

  async removePending(id) {
    return this.#pendingService.remove(id);
  }

  async updatePending(id, patch = {}) {
    return this.#pendingService.update(id, patch);
  }

  async resendPending(id = null) {
    return this.#pendingService.resend(id);
  }

  async resendAllPending() {
    return this.#pendingService.resendAll();
  }

  pendingService() {
    return this.#pendingService;
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
    const response = await this.request(this.#paths.changes, { query });
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
    if (options.requireToken && !token) {
      throw new ApiKitClientError("Sesion local requerida", { status: 401 });
    }
    if (options.auth !== false && token) headers.Authorization = `Bearer ${token}`;

    const response = await this.#fetch(url, { method: options.method || "GET", headers, body, signal: options.signal });
    const contentType = response.headers?.get?.("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();

    if (!response.ok || payload?.ok === false) {
      throw new ApiKitClientError(payload?.message || response.statusText, { status: response.status, response: payload });
    }

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
        const response = await service.list();
        await this.#adapter.set(cacheKey, response.data || []);
        results[service.name] = { ok: true, data: response.data || [] };
      } catch (error) {
        results[service.name] = { ok: false, error: error.message };
      }
    }

    let pending = { ok: true, results: [], errors: [] };
    try {
      pending = await this.#pendingService.resend(null, { discover: false });
    } catch (error) {
      pending = { ok: false, results: [], errors: [{ ok: false, error: error.message }] };
    }

    const errors = Object.fromEntries(Object.entries(results).filter(([, result]) => !result.ok));
    const ok = Object.keys(errors).length === 0 && pending.ok;
    this.#emitChange({ type: "sync", source: "services", ok, results, errors, pending });
    return { ok, results, errors, pending };
  }

  async #ping() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#pingTimeout);
    try {
      await this.#pingRequest(controller.signal);
    } catch {
      this.#markOffline("ping");
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
    this.#pingTimer = setInterval(() => {
      this.#ping();
    }, this.#pingInterval);
    this.#pingTimer.unref?.();
    this.#ping();
  }

  #stopPing() {
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
    const decoder = new TextDecoder();
    let buffer = "";

    while (this.#sseAbort) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || "";
      for (const part of parts) await this.#handleSseMessage(part);
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
    } catch {}
    await this.#applySseData(data);
    this.#emitChange({ type: "sse", data, lastReceivedAt: receivedAt });
  }

  async #applySseData(data) {
    if (!data || typeof data !== "object") return;
    const serviceName = data.service || data.serviceName || data.tableName;
    if (!serviceName || serviceName === "audit") return;

    const action = data.action || data.type;
    if (action === "create" || action === "update") {
      const record = data.new && typeof data.new === "object" ? { ...data.new } : null;
      if (!record) return;
      if (record.id === undefined && data.rowId !== undefined && data.rowId !== null) record.id = data.rowId;
      if (record.id === undefined || record.id === null) return;
      await this.addServiceRecord(serviceName, record);
      return;
    }

    if (action === "delete" || action === "remove") {
      const id = data.old?.id ?? data.rowId ?? data.id;
      if (id === undefined || id === null) return;
      await this.removeServiceRecord(serviceName, id);
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
    this.#sseAbort = null;
    abort?.abort();
  }

  async #clearSession() {
    await this.#clearLocalSession();
    this.#stopPing();
    this.#closeSse();
    this.#clearWatchdog();
  }

  async #clearLocalSession() {
    this.#session = null;
    await this.#adapter.remove(this.#sessionKey);
  }

  async #clearServiceCaches() {
    for (const serviceName of this.#services.keys()) {
      if (serviceName === "audit") continue;
      await this.#adapter.remove(this.#serviceCacheKey(serviceName));
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

  #serviceCacheKey(serviceName) {
    return `${this.#servicePrefix}:${serviceName}`;
  }

  #hasCachedServiceData(value) {
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== null;
  }

}

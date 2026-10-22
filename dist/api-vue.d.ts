import type { App, InjectionKey, Ref } from "vue";
import type { ApiClient, BaseService, LoginOptions, ServiceRecord, ServiceId, ApiResponse } from "./api-client";
export interface ApiVue {
  client: ApiClient;
  connected: Readonly<Ref<boolean>>;
  session: Readonly<Ref<unknown>>;
  event: Readonly<Ref<unknown>>;
  lastReceivedAt: Readonly<Ref<unknown>>;
  error: Readonly<Ref<unknown>>;
  ready: Readonly<Ref<boolean>>;
  initialized: Promise<void>;
  login(credentials?: Record<string, unknown>, options?: LoginOptions): Promise<unknown>;
  logout(): Promise<unknown>;
  sync(force?: boolean): Promise<void>;
  install(app: App): void;
  dispose(): void;
}
export const ApiVueKey: InjectionKey<ApiVue>;
export interface ApiVueOptions { client?: ApiClient; [key: string]: unknown; }
export function createApiVue(client: ApiClient): ApiVue;
export const createVueApi: typeof createApiVue;
export function provideApi(api: ApiVue): ApiVue;
export function useApi(): ApiVue;
export interface ApiVueService<T extends ServiceRecord = ServiceRecord> {
  name: string;
  records: Readonly<Ref<readonly T[]>>;
  data: Readonly<Ref<readonly T[]>>;
  loading: Readonly<Ref<boolean>>;
  error: Readonly<Ref<unknown>>;
  empty: Readonly<Ref<boolean>>;
  refresh(): Promise<ApiResponse<T[]>>;
  list(): Promise<ApiResponse<T[]>>;
  get: BaseService<T>["get"];
  pull: BaseService<T>["pull"];
  pullOne: BaseService<T>["pullOne"];
  create: BaseService<T>["create"];
  save: BaseService<T>["save"];
  update: BaseService<T>["update"];
  remove: BaseService<T>["remove"];
  push: BaseService<T>["push"];
  createDetail: BaseService<T>["createDetail"];
  updateDetail: BaseService<T>["updateDetail"];
  removeDetail: BaseService<T>["removeDetail"];
}
export function useApiService<T extends ServiceRecord = ServiceRecord>(name: string): ApiVueService<T>;
export interface ApiFormOptions<T> {
  initial?: Partial<T>;
  operation?: "create" | "update" | Ref<"create" | "update"> | (() => "create" | "update");
  id?: ServiceId | Ref<ServiceId>;
  debounce?: number;
}
export interface ApiForm<T> {
  name: string;
  data: Partial<T>;
  errors: Readonly<Record<string, string>>;
  validating: Readonly<Ref<boolean>>;
  submitting: Readonly<Ref<boolean>>;
  valid: Readonly<Ref<boolean>>;
  validateField(field: string): Promise<boolean>;
  validate(): Promise<Partial<T>>;
  submit(): Promise<ApiResponse<T>>;
  reset(data?: Partial<T>): void;
  clearErrors(): void;
}
export function useApiForm<T extends ServiceRecord = ServiceRecord>(name: string, options?: ApiFormOptions<T>): ApiForm<T>;

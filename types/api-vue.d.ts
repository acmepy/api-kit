import type { App, InjectionKey, Ref } from "vue";
import type { ApiClient, BaseService, LoginOptions, ServiceRecord } from "./api-client";
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
export function useApiService<T extends ServiceRecord = ServiceRecord>(name: string): BaseService<T>;
export interface ApiForm<T> { data: Ref<Partial<T>>; errors: Ref<Record<string, string>>; loading: Ref<boolean>; submit(): Promise<T>; reset(data?: Partial<T>): void; }
export function useApiForm<T extends ServiceRecord = ServiceRecord>(service: BaseService<T>, initialData?: Partial<T>): ApiForm<T>;

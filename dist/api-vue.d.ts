import type { App, InjectionKey, Ref } from "vue";
import type { ApiClient, BaseService, ServiceRecord } from "./api-client";
export interface ApiVue { client: ApiClient; }
export const ApiVueKey: InjectionKey<ApiVue>;
export interface ApiVueOptions { client?: ApiClient; [key: string]: unknown; }
export function createApiVue(options?: ApiVueOptions): { install(app: App): void };
export const createVueApi: typeof createApiVue;
export function provideApi(client: ApiClient): void;
export function useApi(): ApiClient;
export function useApiService<T extends ServiceRecord = ServiceRecord>(name: string): BaseService<T>;
export interface ApiForm<T> { data: Ref<Partial<T>>; errors: Ref<Record<string, string>>; loading: Ref<boolean>; submit(): Promise<T>; reset(data?: Partial<T>): void; }
export function useApiForm<T extends ServiceRecord = ServiceRecord>(service: BaseService<T>, initialData?: Partial<T>): ApiForm<T>;

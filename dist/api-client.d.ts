export interface StorageAdapter<T = unknown> {
  getAll(): Promise<T[]>;
  get(key: string | number): Promise<T | null>;
  add(value: T | T[]): Promise<T | T[]>;
  put(key: string | number, value: T): Promise<T>;
  delete(key: string | number): Promise<void>;
  clear(): Promise<void>;
}

export class BaseAdapter<T = unknown> implements StorageAdapter<T> {
  getAll(): Promise<T[]>;
  get(key: string | number): Promise<T | null>;
  add(value: T | T[]): Promise<T | T[]>;
  put(key: string | number, value: T): Promise<T>;
  delete(key: string | number): Promise<void>;
  clear(): Promise<void>;
}

export class MapAdapter<T = unknown> extends BaseAdapter<T> {
  constructor(map?: Map<string | number, T>, keyOf?: (record: T) => string | number);
}

export interface LocalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class LocalStorageAdapter<T = unknown> extends BaseAdapter<T> {
  constructor(options?: { storage?: LocalStorageLike; prefix?: string; service?: string; keyOf?: (record: T) => string | number });
}

export interface IndexedDbKeyval {
  createStore(dbName: string, storeName: string): unknown;
  values(store: unknown): Promise<unknown[]>;
  get(key: string | number, store: unknown): Promise<unknown>;
  set(key: string | number, value: unknown, store: unknown): Promise<void>;
  setMany(entries: Array<[string | number, unknown]>, store: unknown): Promise<void>;
  del(key: string | number, store: unknown): Promise<void>;
  clear(store: unknown): Promise<void>;
}

export interface IndexedDbAdapterOptions {
  indexedDB?: IDBFactory;
  dbName?: string;
  storeName?: string;
  idbKeyval?: IndexedDbKeyval;
  keyOf?: (record: any) => string | number;
}

export class IndexedDbAdapter<T = unknown> extends BaseAdapter<T> {
  constructor(options?: IndexedDbAdapterOptions);
}

export interface CreateAdapterOptions extends IndexedDbAdapterOptions {
  type?: "memory" | "map" | "localStorage" | "indexedDB";
  storage?: LocalStorageLike;
  prefix?: string;
  service?: string;
}
export function createAdapter<T = unknown>(options?: CreateAdapterOptions): StorageAdapter<T>;

export interface ApiResponse<T = unknown> {
  data?: T;
  error?: string;
  message?: string;
  [key: string]: unknown;
}
export class ApiClientError extends Error {
  status?: number;
  response?: ApiResponse;
  constructor(message: string, options?: { status?: number; response?: ApiResponse; cause?: unknown });
}

export interface ApiClientOptions {
  url?: string;
  baseUrl?: string;
  token?: string;
  headers?: Record<string, string>;
  adapter?: StorageAdapter;
  storage?: CreateAdapterOptions["type"];
  prefix?: string;
  changes?: boolean;
  sse?: boolean;
  schema?: boolean;
  schemaTimeout?: number;
  [key: string]: unknown;
}
export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface ChangeEvent {
  service?: string;
  action?: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface LoginOptions { sync?: boolean; }

export class ApiClient {
  constructor(options?: ApiClientOptions);
  readonly baseUrl: string;
  readonly adapter: StorageAdapter;
  login(credentials?: Record<string, unknown>, options?: LoginOptions): Promise<unknown>;
  logout(): Promise<void>;
  sessionService(): SessionService;
  session(): Promise<unknown>;
  token(): string | null;
  service(name: string): BaseService | undefined;
  services(): Map<string, BaseService>;
  cachedRequest<T = unknown>(key: string, path: string, options?: RequestOptions & { force?: boolean }): Promise<T>;
  markServiceCacheUpdated(name: string): void;
  syncServices(force?: boolean): Promise<void>;
  connected(): boolean;
  lastReceivedAt(): number | null;
  destroy(): void;
  disconnect(): void;
  onChange(listener: (event: ChangeEvent) => void): () => void;
  offChange(listener: (event: ChangeEvent) => void): void;
  notifyChange(event?: ChangeEvent): void;
  changes(since?: string | number): Promise<ChangeEvent[]>;
  request<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
  url(path: string, query?: Record<string, unknown>): string;
}
export function createApiClient(options?: ApiClientOptions): ApiClient;

export interface ServiceOptions {
  client: ApiClient;
  name: string;
  path?: string;
  operations?: Record<string, unknown>;
  schemas?: Record<string, unknown>;
  primaryKeyAttributes?: string[];
  details?: Record<string, { foreignKey: string; primaryKeyAttributes: string[] }>;
  prefix?: string;
  createAdapter?: (options?: CreateAdapterOptions) => StorageAdapter;
}
export interface PushResult {
  ok: boolean;
  id?: string | number;
  operation?: string;
  service?: string;
  response?: ApiResponse;
  error?: string;
  errors?: Record<string, string> | null;
}
export interface PushResponse extends ApiResponse {
  ok: boolean;
  results: PushResult[];
  errors: PushResult[];
}
export type ServiceId = string | number | Record<string, string | number>;
export interface ServiceRecord { id?: string | number; [key: string]: unknown; }
export class BaseService<T extends ServiceRecord = ServiceRecord> {
  constructor(options: ServiceOptions);
  readonly client: ApiClient;
  readonly name: string;
  readonly path: string;
  readonly operations: Record<string, unknown>;
  readonly schemas: Record<string, unknown> | null;
  readonly primaryKeyAttributes: string[];
  readonly details: NonNullable<ServiceOptions["details"]>;
  readonly prefix: string;
  readonly adapter: StorageAdapter<T>;
  keyOf(record?: Partial<T>): string | number | undefined;
  list(): Promise<ApiResponse<T[]>>;
  pending(): Promise<ApiResponse<T[]>>;
  get(id: ServiceId): Promise<ApiResponse<T | null>>;
  create(data: Partial<T>, options?: { pending?: boolean }): Promise<ApiResponse<T>>;
  update(id: ServiceId, data: Partial<T>, options?: { pending?: boolean }): Promise<ApiResponse<T>>;
  remove(id: ServiceId, options?: { pending?: boolean }): Promise<ApiResponse<T>>;
  createDetail(id: ServiceId, detail: string, data?: Record<string, unknown>): Promise<ApiResponse>;
  updateDetail(id: ServiceId, detail: string, detailId: string | number, data?: Record<string, unknown>): Promise<ApiResponse>;
  removeDetail(id: ServiceId, detail: string, detailId: string | number): Promise<ApiResponse>;
  pull(query?: Record<string, unknown>): Promise<ApiResponse<T[]>>;
  pullOne(id: ServiceId, query?: Record<string, unknown>): Promise<ApiResponse<T>>;
  applyData(data: ChangeEvent): Promise<void>;
  nextTemporaryId(): Promise<number>;
  push(id?: ServiceId | null): Promise<PushResponse>;
  pushOne(record: T): Promise<PushResult>;
  validate(data: Partial<T>, operation?: string): Promise<Partial<T>>;
  validateAt(field: string, data?: Partial<T>, operation?: string): Promise<unknown>;
  unique(field: string, value: unknown, data?: Partial<T>): Promise<Error | null>;
  permissions(operation: string): string[];
  request<R = unknown>(operation: string, options?: { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown }): Promise<ApiResponse<R>>;
  clear(): Promise<void>;
}
export class PendingService<T extends ServiceRecord = ServiceRecord> extends BaseService<T> {
  push(): Promise<PushResponse>;
}
export class SchemaService<T extends ServiceRecord = ServiceRecord> extends BaseService<T> {}
export class SessionService<T extends ServiceRecord = ServiceRecord> extends BaseService<T> {}

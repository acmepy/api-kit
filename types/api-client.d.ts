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
  constructor(map?: Map<string | number, T>);
}

export interface LocalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class LocalStorageAdapter<T = unknown> extends BaseAdapter<T> {
  constructor(storage?: LocalStorageLike, prefix?: string);
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
  dbName?: string;
  storeName?: string;
  idbKeyval?: IndexedDbKeyval;
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

export class ApiClient {
  constructor(options?: ApiClientOptions);
  readonly baseUrl: string;
  readonly adapter: StorageAdapter;
  login(credentials?: Record<string, unknown>): Promise<unknown>;
  logout(): Promise<void>;
  sessionService(): SessionService;
  session(): Promise<unknown>;
  token(): string | null;
  service(name: string): BaseService | undefined;
  services(): Record<string, BaseService>;
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
  prefix?: string;
  createAdapter?: (options?: CreateAdapterOptions) => StorageAdapter;
}
export interface ServiceRecord { id?: string | number; [key: string]: unknown; }
export class BaseService<T extends ServiceRecord = ServiceRecord> {
  constructor(options: ServiceOptions);
  readonly client: ApiClient;
  readonly name: string;
  readonly path: string;
  readonly operations: Record<string, unknown>;
  readonly schemas: Record<string, unknown>;
  readonly prefix: string;
  readonly adapter: StorageAdapter<T>;
  list(params?: Record<string, unknown>): Promise<T[]>;
  pending(params?: Record<string, unknown>): Promise<T[]>;
  get(id: string | number, options?: RequestOptions): Promise<T | null>;
  create(data: Partial<T>, options?: RequestOptions): Promise<T>;
  update(id: string | number, data: Partial<T>, options?: RequestOptions): Promise<T>;
  remove(id: string | number, options?: RequestOptions): Promise<void>;
  pull(options?: { force?: boolean }): Promise<T[]>;
  pullOne(id: string | number, options?: RequestOptions): Promise<T | null>;
  applyData(data: T | T[]): Promise<T | T[]>;
  nextTemporaryId(): string;
  push(options?: RequestOptions): Promise<void>;
  pushOne(id: string | number, options?: RequestOptions): Promise<T>;
  validate(data: Partial<T>, operation?: string): Promise<Record<string, string>>;
  validateAt(field: string, value: unknown, data?: Partial<T>, operation?: string): Promise<string | undefined>;
  unique(field: string, value: unknown, id?: string | number): Promise<boolean>;
  permissions(): Record<string, boolean>;
  request<R = unknown>(path: string, options?: RequestOptions): Promise<R>;
  clear(): Promise<void>;
}
export class PendingService<T extends ServiceRecord = ServiceRecord> extends BaseService<T> {}
export class SchemaService<T extends ServiceRecord = ServiceRecord> extends BaseService<T> {}
export class SessionService<T extends ServiceRecord = ServiceRecord> extends BaseService<T> {}

export interface RequestContext { requestId?: string; user?: unknown; [key: string]: unknown; }
export interface ApiResponse<T = unknown> { ok: true; data: T; [key: string]: unknown; }
export interface ListResponse<T = unknown> extends ApiResponse<T[]> { total?: number; page?: number; pageSize?: number; }
export class AppError extends Error { status: number; code?: string; details?: unknown; constructor(message?: string, options?: Record<string, unknown>); }
export class ConfigError extends AppError {}
export class ValidationError extends AppError {}
export class NotFoundError extends AppError {}
export class ConflictError extends AppError {}
export class AuthRequiredError extends AppError {}
export class ForbiddenError extends AppError {}
export class InternalError extends AppError {}
export class BaseModel { static init(...args: unknown[]): unknown; }
export class BaseService<T = Record<string, unknown>> { constructor(options?: Record<string, unknown>); list(options?: Record<string, unknown>): Promise<T[]>; get(id: string | number, options?: Record<string, unknown>): Promise<T>; create(data: Partial<T>, options?: Record<string, unknown>): Promise<T>; update(id: string | number, data: Partial<T>, options?: Record<string, unknown>): Promise<T>; remove(id: string | number, options?: Record<string, unknown>): Promise<void>; }
export class BaseRouter { constructor(options?: Record<string, unknown>); }
export class BaseModule { constructor(options?: Record<string, unknown>); }
export interface ResourceDefinition { name: string; [key: string]: unknown; }
export function defineResource(definition: ResourceDefinition): ResourceDefinition;
export interface RouteDefinition { method: string; path: string; permission?: string; handler?: (...args: unknown[]) => unknown; [key: string]: unknown; }
export class RouteRegistry { add(route: RouteDefinition): RouteDefinition; all(): RouteDefinition[]; find(method: string, path: string): RouteDefinition | undefined; }
export interface CreateApiOptions { modules?: unknown[]; models?: unknown[]; services?: unknown[]; routes?: RouteDefinition[]; [key: string]: unknown; }
export interface ApiInstance { app: unknown; router: unknown; errorHandler: (...args: unknown[]) => unknown; modules: unknown; models: unknown; services: unknown; routes: RouteRegistry; schemas: unknown; events: unknown; audit: { sseClients(): unknown[] }; auth: unknown; close(): Promise<void>; }
export function createApi(options?: CreateApiOptions): Promise<ApiInstance>;
export function getContext(): RequestContext | undefined;
export function runWithContext<T>(context: RequestContext, callback: () => T): T;
export function log(...args: unknown[]): void;
export function requestLogger(...args: unknown[]): unknown;
export function setLogging(options?: Record<string, unknown>): void;
export function ok<T>(data: T, options?: Record<string, unknown>): ApiResponse<T>;
export function list<T>(data: T[], options?: Record<string, unknown>): ListResponse<T>;

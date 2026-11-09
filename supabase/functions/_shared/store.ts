/**
 * Persistence seam.
 *
 * `createStore` depends on the narrow `DatabaseClient` interface below, so the
 * delivery pipeline can be reasoned about (and stubbed) without a live database.
 * `createServiceClient` is the only place the service-role credential is used.
 *
 * The whole feature lives in the `bark` schema. That schema is listed in
 * `supabase/config.toml`'s `[api] schemas` because PostgREST — the transport
 * supabase-js speaks — can only address exposed schemas. The security boundary is
 * privilege-based, not visibility-based: RLS is enabled with no policies and all
 * privileges are revoked from `anon`/`authenticated`, so a publishable key grants
 * nothing (see 20260101000000_bark_schema.sql).
 *
 * All multi-statement logic lives in `security definer` RPCs
 * (supabase/migrations/20260101000100_bark_rpc.sql); the store only shapes calls.
 */

import type { RateLimitResult } from "./ratelimit.ts";
import type {
  DeliveryOrigin,
  DeliveryRecord,
  DeliveryStatus,
  DeviceKind,
  DeviceRecord,
  PendingDelivery,
} from "./types.ts";

export interface QueryResult<T> {
  data: T | null;
  error: { message: string } | null;
}

/** The subset of database behaviour the server needs. Table names are schema-relative. */
export interface DatabaseClient {
  rpc<T>(name: string, args: Record<string, unknown>): Promise<QueryResult<T>>;
  insert<T>(table: string, row: Record<string, unknown>): Promise<QueryResult<T>>;
  update<T>(
    table: string,
    match: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<QueryResult<T>>;
  count(table: string, match?: Record<string, unknown>): Promise<number>;
}

export interface RegisterDeviceInput {
  deviceKey?: string | null;
  deviceToken: string;
  deviceKind: DeviceKind;
}

export interface NewDeliveryInput {
  requestId: string;
  deviceKey: string;
  origin: DeliveryOrigin;
  status: DeliveryStatus;
  attemptCount: number;
  apnsStatus?: number | null;
  apnsReason?: string | null;
  apnsId?: string | null;
  archived?: boolean;
  nextAttemptAt?: string | null;
  /** Retained only while the row is retryable; cleared on a terminal state. */
  payload?: Record<string, unknown> | null;
}

export interface DeliveryPatch {
  status?: DeliveryStatus;
  attemptCount?: number;
  apnsStatus?: number | null;
  apnsReason?: string | null;
  apnsId?: string | null;
  archived?: boolean;
  nextAttemptAt?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface ArchiveInput {
  deliveryId: string;
  deviceKey: string;
  payload: Record<string, unknown>;
  /** ISO timestamp; omitted means the table default (one day out). */
  expiresAt?: string;
}

export interface Store {
  registerDevice(input: RegisterDeviceInput): Promise<DeviceRecord>;
  lookupDevice(deviceKey: string): Promise<DeviceRecord | null>;
  insertDelivery(input: NewDeliveryInput): Promise<DeliveryRecord>;
  updateDelivery(id: string, patch: DeliveryPatch): Promise<void>;
  insertArchive(input: ArchiveInput): Promise<void>;
  claimRetries(batch: number): Promise<PendingDelivery[]>;
  disableDevice(deviceKey: string): Promise<void>;
  /** Marks a token permanently invalid without deleting the registration (FR-013, FR-021). */
  invalidateDevice(deviceKey: string, reason: string): Promise<void>;
  countDevices(): Promise<number>;
  /** Atomic fixed-window counter (bark_hit_rate_limit). */
  hitRateLimit(
    bucketKey: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult>;
}

function unwrap<T>(result: QueryResult<T>, what: string): T | null {
  if (result.error) throw new Error(`${what} failed: ${result.error.message}`);
  return result.data;
}

function defined<T extends Record<string, unknown>>(patch: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

export function createStore(client: DatabaseClient): Store {
  return {
    async registerDevice(input) {
      const row = unwrap(
        await client.rpc<DeviceRecord>("bark_register_device", {
          p_device_key: input.deviceKey ?? null,
          p_device_token: input.deviceToken,
          p_device_kind: input.deviceKind,
        }),
        "registerDevice",
      );
      if (!row) throw new Error("registerDevice returned no row");
      return row;
    },

    async lookupDevice(deviceKey) {
      const row = unwrap(
        await client.rpc<DeviceRecord | DeviceRecord[]>("bark_lookup_device", {
          p_device_key: deviceKey,
        }),
        "lookupDevice",
      );
      if (!row) return null;
      return Array.isArray(row) ? (row[0] ?? null) : row;
    },

    async insertDelivery(input) {
      const row = unwrap(
        await client.insert<DeliveryRecord>("delivery", {
          request_id: input.requestId,
          device_key: input.deviceKey,
          origin: input.origin,
          status: input.status,
          attempt_count: input.attemptCount,
          apns_status: input.apnsStatus ?? null,
          apns_reason: input.apnsReason ?? null,
          apns_id: input.apnsId ?? null,
          archived: input.archived ?? false,
          next_attempt_at: input.nextAttemptAt ?? null,
          payload: input.payload ?? null,
        }),
        "insertDelivery",
      );
      if (!row) throw new Error("insertDelivery returned no row");
      return row;
    },

    async updateDelivery(id, patch) {
      unwrap(
        await client.update<DeliveryRecord>(
          "delivery",
          { id },
          defined({
            status: patch.status,
            attempt_count: patch.attemptCount,
            apns_status: patch.apnsStatus,
            apns_reason: patch.apnsReason,
            apns_id: patch.apnsId,
            archived: patch.archived,
            next_attempt_at: patch.nextAttemptAt,
            payload: patch.payload,
            updated_at: new Date().toISOString(),
          }),
        ),
        "updateDelivery",
      );
    },

    async insertArchive(input) {
      const row: Record<string, unknown> = {
        delivery_id: input.deliveryId,
        device_key: input.deviceKey,
        payload: input.payload,
      };
      if (input.expiresAt) row.expires_at = input.expiresAt;
      unwrap(await client.insert("archive", row), "insertArchive");
    },

    async claimRetries(batch) {
      const rows = unwrap(
        await client.rpc<PendingDelivery[]>("bark_claim_retries", { p_batch: batch }),
        "claimRetries",
      );
      return rows ?? [];
    },

    async disableDevice(deviceKey) {
      unwrap(
        await client.rpc("bark_disable_device", { p_device_key: deviceKey }),
        "disableDevice",
      );
    },

    async invalidateDevice(deviceKey, reason) {
      const now = new Date().toISOString();
      unwrap(
        await client.update<DeviceRecord>("device", { device_key: deviceKey }, {
          invalidated_at: now,
          last_error: reason,
          updated_at: now,
        }),
        "invalidateDevice",
      );
    },

    async countDevices() {
      return await client.count("device", { disabled_at: null });
    },

    async hitRateLimit(bucketKey, limit, windowSeconds) {
      const rows = unwrap(
        await client.rpc<RateLimitResult | RateLimitResult[]>("bark_hit_rate_limit", {
          p_bucket_key: bucketKey,
          p_limit: limit,
          p_window_seconds: windowSeconds,
        }),
        "hitRateLimit",
      );
      const row = Array.isArray(rows) ? rows[0] : rows;
      return row ?? { allowed: true, remaining: 0, retryAfter: 0 };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* supabase-js adapter                                                         */
/* -------------------------------------------------------------------------- */

interface PostgrestResult {
  data: unknown;
  error: { message: string } | null;
}

interface FilterBuilder extends PromiseLike<PostgrestResult> {
  eq(column: string, value: unknown): FilterBuilder;
  match(match: Record<string, unknown>): FilterBuilder;
  limit(count: number): FilterBuilder;
  maybeSingle(): Promise<PostgrestResult>;
  select(
    columns?: string,
    options?: Record<string, unknown>,
  ): FilterBuilder & { count?: number | null };
}

interface SupabaseLike {
  rpc(name: string, args?: Record<string, unknown>): Promise<PostgrestResult>;
  from(table: string): {
    insert(row: Record<string, unknown>): FilterBuilder;
    update(patch: Record<string, unknown>): FilterBuilder;
    select(columns?: string, options?: Record<string, unknown>): FilterBuilder;
  };
}

function applyMatch(builder: FilterBuilder, match: Record<string, unknown>): FilterBuilder {
  let scoped = builder;
  for (const [column, value] of Object.entries(match)) scoped = scoped.eq(column, value);
  return scoped;
}

/** Builds the service-role client, scoped to the `bark` schema. */
export async function createServiceClient(config: {
  supabaseUrl: string;
  serviceRoleKey: string;
}): Promise<DatabaseClient> {
  // Import the npm specifier directly rather than the bare `@supabase/supabase-js`
  // alias. The alias only resolves through an import map/deno.json next to the
  // entrypoint. That works locally, but a deployed function does not reliably
  // carry the global `supabase/functions/deno.json`, so the dynamic import threw
  // at request time and every DB-backed route returned a generic 500.
  const { createClient } = await import("npm:@supabase/supabase-js@2");
  const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "bark" },
  }) as unknown as SupabaseLike;

  return {
    async rpc<T>(name: string, args: Record<string, unknown>): Promise<QueryResult<T>> {
      const { data, error } = await supabase.rpc(name, args);
      return { data: (data as T) ?? null, error };
    },

    async insert<T>(
      table: string,
      row: Record<string, unknown>,
    ): Promise<QueryResult<T>> {
      const { data, error } = await supabase
        .from(table)
        .insert(row)
        .select()
        .maybeSingle();
      return { data: (data as T) ?? null, error };
    },

    async update<T>(
      table: string,
      match: Record<string, unknown>,
      patch: Record<string, unknown>,
    ): Promise<QueryResult<T>> {
      if (Object.keys(match).length === 0) {
        return { data: null, error: { message: "empty match" } };
      }
      const scoped = applyMatch(supabase.from(table).update(patch), match);
      const { data, error } = await scoped.select().maybeSingle();
      return { data: (data as T) ?? null, error };
    },

    async count(table: string, match: Record<string, unknown> = {}): Promise<number> {
      const scoped = applyMatch(
        supabase.from(table).select("*", { count: "exact", head: true }),
        match,
      );
      const result = await scoped as PostgrestResult & { count?: number | null };
      if (result.error) throw new Error(`count failed: ${result.error.message}`);
      return result.count ?? 0;
    },
  };
}

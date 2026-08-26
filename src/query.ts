/**
 * A scalar a filter can compare against. `null` is deliberately absent: core has no
 * "is null" operator, and sending one would be a filter that silently matches nothing.
 */
export type Scalar = string | number | boolean;

/** Negation: `{"not": scalar | array}`. Build it with {@link not}. */
export interface NotCondition {
  not: Scalar | Scalar[];
}

/** A bounded condition. Build it with {@link gt}, {@link gte}, {@link lt}, {@link lte} or {@link between}. */
export interface RangeCondition {
  gt?: Scalar;
  gte?: Scalar;
  lt?: Scalar;
  lte?: Scalar;
}

/**
 * Containment: `{"key": k, "value": v}`, valid only where the resource sheet declares the
 * filterable as `contains`. Build it with {@link contains}.
 */
export interface ContainsCondition {
  key: Scalar;
  value: Scalar;
}

/** Everything a single filter entry may be. */
export type FilterValue = Scalar | Scalar[] | NotCondition | RangeCondition | ContainsCondition;

/**
 * A filter map. Conditions are ANDed together, and THE OPERATOR IS DECIDED BY THE SHAPE OF THE
 * VALUE — that shape grammar is the contract:
 *
 * ```text
 * scalar                          equality
 * array                           IN
 * {"not": scalar|array}           negation
 * {"gte": x, "lte": y}            range (gt, gte, lt, lte)
 * {"key": k, "value": v}          containment, where the sheet declares `contains`
 * ```
 *
 * Use the builders rather than writing the objects by hand:
 *
 * ```ts
 * const filter: Filter = {
 *   projectId: 15,                          // equality
 *   state: anyOf('analisis', 'planificacion'), // IN
 *   createdAt: gte('2026-01-01'),           // range
 *   type: not('otro'),                      // negation
 * };
 * ```
 */
export type Filter = Record<string, FilterValue>;

/**
 * Builds an IN condition.
 *
 * A single value is still sent as an array, which core reads as a one-element IN — identical
 * in meaning to equality.
 *
 * The name is `anyOf` rather than `in` because `in` is a reserved word in JavaScript and
 * cannot be an import binding.
 */
export function anyOf(...values: Scalar[]): Scalar[] {
  return values;
}

/** Negates a scalar or a set. */
export function not(value: Scalar | Scalar[]): NotCondition {
  return { not: value };
}

/**
 * Builds a bounded condition from any of `gt`, `gte`, `lt`, `lte`. Bounds left `undefined` are
 * omitted, so `range({ gte: x })` is an open-ended lower bound.
 */
export function range(bounds: RangeCondition): RangeCondition {
  const out: RangeCondition = {};
  if (bounds.gt !== undefined) out.gt = bounds.gt;
  if (bounds.gte !== undefined) out.gte = bounds.gte;
  if (bounds.lt !== undefined) out.lt = bounds.lt;
  if (bounds.lte !== undefined) out.lte = bounds.lte;
  return out;
}

/** The one-sided ranges, which is what most calls need. */
export function gt(value: Scalar): RangeCondition {
  return { gt: value };
}

export function gte(value: Scalar): RangeCondition {
  return { gte: value };
}

export function lt(value: Scalar): RangeCondition {
  return { lt: value };
}

export function lte(value: Scalar): RangeCondition {
  return { lte: value };
}

/** The closed range, inclusive on both ends. */
export function between(from: Scalar, to: Scalar): RangeCondition {
  return { gte: from, lte: to };
}

/**
 * Builds a containment condition, valid only where the resource sheet declares the filterable
 * as `contains` — `requirements.tags` is the case that exists today.
 */
export function contains(key: Scalar, value: Scalar): ContainsCondition {
  return { key, value };
}

/**
 * Whether a list also returns the total.
 *
 * The shape mirrors the wire exactly — `true`, `"only"`, or the key absent — because a
 * three-state enum of our own would be one more thing to keep in step with core.
 *
 *   - omitted: no total, one query. The default.
 *   - `true`: the collection AND the total. Opt-in because it costs a second query over the
 *     whole universe of the filter.
 *   - `"only"`: the total, and the rows query is NOT executed.
 */
export type CountOption = true | 'only';

/**
 * The payload of a `{resource}.list`. Six levers and no more: any other top-level key is
 * `invalid_fields`, and so is any of the eleven forbidden identity names.
 *
 * The NAMES inside `filter`, `sort`, `fields` and `include` are decided by the resource sheet.
 * Fetch it with {@link Client.contract}.
 */
export interface ListQuery {
  /** Filter conditions, ANDed. See {@link Filter} for the shape grammar. */
  filter?: Filter | undefined;
  /**
   * Sort criteria in order; a leading `-` is descending. The engine always appends `id` as the
   * final tie-breaker, because the keyset cursor needs a total order.
   */
  sort?: string[] | undefined;
  /**
   * Restricts the returned set to names from base ∪ includable. `id` is always returned
   * whether asked for or not.
   */
  fields?: string[] | undefined;
  /**
   * Adds includables. A collection includable with a cap returns at most `cap` items per row
   * and marks the row with its truncated flag.
   */
  include?: string[] | undefined;
  /**
   * The page size. A limit above the resource's `maxLimit` is CLAMPED SILENTLY — success, not
   * failure. Read the effective value back from {@link Page.limit}.
   */
  limit?: number | undefined;
  /**
   * Continues a previous page. Valid only for the exact filter and sort it was minted for.
   */
  cursor?: string | undefined;
  /** Opts into the total. */
  count?: CountOption | undefined;
}

/**
 * The payload of a `{resource}.get`.
 *
 * `filter`, `sort`, `page` and `count` are an ERROR here, not an ignorable extra: a get asks
 * about one identified resource, and accepting a filter in silence would let the caller believe
 * something had been trimmed. This interface simply has nowhere to put them.
 */
export interface GetQuery {
  /** Required. */
  id: number;
  /** Restricts the returned set. */
  fields?: string[] | undefined;
  /** Adds includables. */
  include?: string[] | undefined;
  /**
   * The discriminator, accepted as a fourth key only where a resource declares one. On
   * `comments` it is MANDATORY.
   */
  entityType?: string | undefined;
}

/**
 * The pagination block of a list reply.
 *
 * THE ABSENCE OF A CURSOR IS THE ONLY END-OF-COLLECTION SIGNAL. There is no `hasMore` boolean,
 * because two ways of saying the same thing eventually disagree.
 */
export interface Page {
  /** The EFFECTIVE limit, with the default and the silent cap applied. */
  limit: number;
  /**
   * How many items this page carries. It can be fewer than `limit` because of the byte budget:
   * the engine cuts the page before the reply exceeds what NATS accepts and emits the cursor at
   * the cut. So a short page does NOT mean the end.
   */
  returned: number;
  /** Absent on the last page. */
  cursor?: string;
  /** Present only when `count` was requested. */
  total?: number;
}

/** Reports whether another page exists, which is exactly "a cursor came back". */
export function hasMore(page: Page): boolean {
  return typeof page.cursor === 'string' && page.cursor.length > 0;
}

/**
 * The reply of a list.
 *
 * There is no decode step: JSON.parse is eager, so the items are already decoded by the time
 * this object exists. `T` is yours to assert — the returned field set changes with `fields` and
 * `include`, so no single shape fits every call.
 */
export interface Collection<T> {
  items: T[];
  page: Page;
}

/** Renders a {@link ListQuery} into the wire shape, folding limit/cursor into `page`. */
export function listPayload(query: ListQuery): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (query.filter && Object.keys(query.filter).length > 0) {
    out['filter'] = query.filter;
  }
  if (query.sort && query.sort.length > 0) {
    out['sort'] = query.sort;
  }
  if (query.fields && query.fields.length > 0) {
    out['fields'] = query.fields;
  }
  if (query.include && query.include.length > 0) {
    out['include'] = query.include;
  }
  const page: Record<string, unknown> = {};
  if (typeof query.limit === 'number' && query.limit > 0) {
    page['limit'] = query.limit;
  }
  if (query.cursor) {
    page['cursor'] = query.cursor;
  }
  if (Object.keys(page).length > 0) {
    out['page'] = page;
  }
  if (query.count !== undefined) {
    out['count'] = query.count;
  }
  return out;
}

/** Renders a {@link GetQuery} into the wire shape. */
export function getPayload(query: GetQuery): Record<string, unknown> {
  const out: Record<string, unknown> = { id: query.id };
  if (query.fields && query.fields.length > 0) {
    out['fields'] = query.fields;
  }
  if (query.include && query.include.length > 0) {
    out['include'] = query.include;
  }
  if (query.entityType) {
    out['entityType'] = query.entityType;
  }
  return out;
}

/** One entry of the `requirements.tags` reply: a key and the values in use for it. */
export interface TagGroup {
  key: string;
  values: string[];
}

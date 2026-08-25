import { JikuInvalidRequest } from './errors.ts';
import type { ListQuery, Scalar } from './query.ts';

/**
 * Describes one name in a whitelist.
 */
export interface Field {
  /**
   * What the name IS: `field`, `computed`, `relation`, or a scalar type (`integer`, `string`,
   * `date`, `boolean`, `enum`).
   *
   * It is what makes local type coercion possible: a filter on an integer must send `15`, not
   * `"15"`, because the comparison is decided by the JSON type.
   */
  kind: string;
  /** Names the entry in {@link Resource.enums} that lists the allowed values. */
  enum?: string;
  /** Marks a full-text filterable, conventionally `q`. */
  search?: boolean;
  /** Marks a search filterable that also matches numbers. */
  searchNumeric?: boolean;
  /**
   * Marks a filterable that takes a `{key, value}` containment shape instead of a scalar. It
   * is present only where the resource sheet allows it; build the value with `contains()`.
   */
  contains?: { shape: string[] };
  /** `one` or `many` on a relation. */
  cardinality?: 'one' | 'many';
  /** The columns a relation includable brings back. */
  fields?: string[];
  /**
   * Set where a relation collapses to a single scalar column rather than an object —
   * `subscriptors` comes back as a list of `userId`, for instance.
   */
  scalar?: string;
  /** Marks a relation that may be null. */
  optional?: boolean;
  /** The per-row limit of a collection includable. */
  cap?: number;
  /**
   * The SIBLING key that marks a row whose collection hit the cap. It is a sibling of the
   * collection (`commentsTruncated`), never a nested field.
   */
  truncatedFlag?: string;
}

/** One allowed value of an enum, with the label the UI shows. */
export interface EnumValue {
  value: string;
  label?: string;
}

/** A resource's default sort and page sizes. */
export interface Defaults {
  sort: string[];
  /** The page size applied when none is given. */
  limit: number;
  /**
   * The cap. A limit above it is CLAMPED SILENTLY — success, not failure — so this is the only
   * place a caller can learn the real ceiling.
   */
  maxLimit: number;
}

/**
 * Names the field that selects a variant.
 *
 * On `comments.get` it is MANDATORY: the same id means different records under different entity
 * types, so there is nothing sensible to default to.
 */
export interface Discriminator {
  field: string;
  values: string[];
}

/**
 * One variant's whitelists. It has no `sortable` or `defaults` of its own — those are shared by
 * the resource.
 */
export interface Variant {
  base?: Record<string, Field> | null;
  includable?: Record<string, Field> | null;
  filterable?: Record<string, Field> | null;
  enums?: Record<string, EnumValue[]> | null;
}

/**
 * One resource's five whitelists.
 *
 * DENY BY DEFAULT: a name that is not in one of these lists DOES NOT EXIST. It comes back as
 * `invalid_fields` with `errorDetails`, never as a silently ignored lever — an ignored filter
 * would return MORE data than asked for, which is the worst failure mode a read contract has.
 *
 * # THREE RESOURCES KEEP THEIR FIELDS SOMEWHERE ELSE
 *
 * `comments`, `activity` and `subscriptions` are DISCRIMINATED: their `base`, `includable` and
 * `filterable` are EMPTY (they arrive as `null`), and the real whitelists live per variant under
 * `variants`, selected by the discriminator field (`entityType`). Only `sortable` and `defaults`
 * stay at this level.
 *
 * Read them through {@link forVariant} rather than reaching into the maps, or those three
 * resources will look like they have no fields at all.
 */
export interface Resource {
  /** What a list or a get returns without asking for anything. */
  base?: Record<string, Field> | null;
  /** What `include` may add. */
  includable?: Record<string, Field> | null;
  /** What `filter` may name. */
  filterable?: Record<string, Field> | null;
  /** What `sort` may name. */
  sortable?: string[] | null;
  /** The sort, limit and maxLimit applied when the caller asks for none. */
  defaults: Defaults;
  /** The allowed values of the enum filterables, keyed by enum name. */
  enums?: Record<string, EnumValue[]> | null;
  /**
   * Present on the three resources that have variants. It names the field that selects one and
   * lists the accepted values.
   */
  discriminator?: Discriminator | null;
  /** The per-variant whitelists, keyed by discriminator value. */
  variants?: Record<string, Variant> | null;
}

/**
 * What `meta.describe` returns: the five whitelists of every resource, as data.
 *
 * # WHY THIS IS WORTH FETCHING RATHER THAN HARDCODING
 *
 * `meta.describe` projects THE SAME STRUCTURES the validator reads to reject names. So every
 * name it declares works and one it does not declare answers `invalid_fields` — there is no
 * second copy to drift. A table compiled into this library would be exactly that second copy.
 *
 * It describes the CONTRACT, not the data, so it is identical for every caller. Knowing that an
 * includable `email` exists grants access to no email: row trimming and the field whitelist
 * still apply to every query.
 */
export interface Contract {
  resources: Record<string, Resource>;
}

/** `null` and `undefined` both mean "no names here". */
function entries<T>(map: Record<string, T> | null | undefined): Record<string, T> {
  return map ?? {};
}

function list(values: string[] | null | undefined): string[] {
  return values ?? [];
}

/** The resource names in a contract, sorted. */
export function resourceNames(contract: Contract): string[] {
  return Object.keys(contract.resources).sort();
}

/**
 * Looks a resource up, suggesting a near match when there is none.
 *
 * @throws {JikuInvalidRequest} when the name is not in the contract.
 */
export function resourceOf(contract: Contract, name: string): Resource {
  const found = contract.resources[name];
  if (found) {
    return found;
  }
  const known = resourceNames(contract);
  let message = `jiku: unknown resource ${JSON.stringify(name)}`;
  const near = suggest(name, known);
  if (near) {
    message += `; did you mean ${JSON.stringify(near)}?`;
  }
  throw new JikuInvalidRequest(`${message}\n  known: ${known.join(', ')}`);
}

/**
 * Returns the resource as it applies to one variant.
 *
 * For an undiscriminated resource it returns the resource unchanged, so callers need no special
 * case. For a discriminated one:
 *
 *   - a known variant name yields that variant's whitelists;
 *   - an OMITTED name yields the UNION of every variant.
 *
 * The union is deliberate. Validation must never reject what the server would accept, and
 * without a variant chosen there is no way to know which one applies — so the permissive answer
 * is the only correct one. An unknown name is left to the server, which owns that rule.
 */
export function forVariant(resource: Resource, name?: string): Resource {
  const variants = entries(resource.variants);
  if (Object.keys(variants).length === 0) {
    return resource;
  }

  const out: Resource = {
    sortable: list(resource.sortable),
    defaults: resource.defaults,
    ...(resource.discriminator ? { discriminator: resource.discriminator } : {}),
    variants,
    base: {},
    includable: {},
    filterable: {},
    enums: {},
  };

  const merge = (variant: Variant): void => {
    Object.assign(out.base as Record<string, Field>, entries(variant.base));
    Object.assign(out.includable as Record<string, Field>, entries(variant.includable));
    Object.assign(out.filterable as Record<string, Field>, entries(variant.filterable));
    Object.assign(out.enums as Record<string, EnumValue[]>, entries(variant.enums));
  };

  if (name !== undefined && name !== '') {
    const variant = variants[name];
    if (variant) {
      merge(variant);
    }
    // An unknown variant name yields empty whitelists rather than the union: the server owns
    // that rule, and inventing one here could reject a query it would have accepted.
    return out;
  }
  for (const variant of Object.values(variants)) {
    merge(variant);
  }
  return out;
}

/** The discriminator values that have a variant, sorted. */
export function variantNames(resource: Resource): string[] {
  return Object.keys(entries(resource.variants)).sort();
}

/** Lists base ∪ includable, which is exactly what `fields` may name. */
export function fieldNames(resource: Resource): string[] {
  return [
    ...new Set([
      ...Object.keys(entries(resource.base)),
      ...Object.keys(entries(resource.includable)),
    ]),
  ].sort();
}

/** Lists what `include` may name. */
export function includableNames(resource: Resource): string[] {
  return Object.keys(entries(resource.includable)).sort();
}

/** Lists what `filter` may name. */
export function filterableNames(resource: Resource): string[] {
  return Object.keys(entries(resource.filterable)).sort();
}

/** Lists what `sort` may name. */
export function sortableNames(resource: Resource): string[] {
  return [...list(resource.sortable)].sort();
}

/**
 * Checks a list query against a resource's whitelists BEFORE it is published, returning one
 * message per problem.
 *
 * Every rejection here is one core would also make, with the same meaning — the point is only
 * that it arrives without a round trip and can name the alternatives. It is deliberately
 * conservative: it flags names that are certainly wrong and never invents a rule of its own, so
 * it cannot refuse a query the server would have accepted.
 *
 * Returns an empty array when the query is fine. {@link assertValidQuery} is the throwing
 * version.
 */
export function validateQuery(resource: Resource, query: ListQuery): string[] {
  const problems: string[] = [];
  const filterable = entries(resource.filterable);
  const sortable = list(resource.sortable);
  const includable = entries(resource.includable);
  const fields = fieldNames(resource);

  for (const name of Object.keys(query.filter ?? {})) {
    if (!(name in filterable)) {
      problems.push(unknownName('filter', name, filterableNames(resource)));
    }
  }
  for (const name of query.sort ?? []) {
    const bare = name.startsWith('-') ? name.slice(1) : name;
    if (!sortable.includes(bare)) {
      problems.push(unknownName('sort', bare, sortableNames(resource)));
    }
  }
  for (const name of query.fields ?? []) {
    if (!fields.includes(name)) {
      problems.push(unknownName('fields', name, fields));
    }
  }
  for (const name of query.include ?? []) {
    if (!(name in includable)) {
      problems.push(unknownName('include', name, includableNames(resource)));
    }
  }

  // Enum values are checked too, because the allowed list is right here and a typo in a state
  // is at least as common as a typo in a field name.
  const enums = entries(resource.enums);
  for (const [name, value] of Object.entries(query.filter ?? {})) {
    const field = filterable[name];
    if (!field?.enum) {
      continue;
    }
    const allowed = enums[field.enum];
    if (!allowed || allowed.length === 0) {
      continue;
    }
    const values = allowed.map((entry) => entry.value);
    for (const candidate of enumCandidates(value)) {
      if (!values.includes(candidate)) {
        problems.push(
          `filter ${JSON.stringify(name)} does not accept ${JSON.stringify(candidate)}; ` +
            `allowed: ${values.join(', ')}`,
        );
      }
    }
  }

  return problems;
}

/**
 * Throws a {@link JikuInvalidRequest} listing everything {@link validateQuery} found, or
 * returns silently.
 */
export function assertValidQuery(resource: Resource, query: ListQuery): void {
  const problems = validateQuery(resource, query);
  if (problems.length > 0) {
    throw new JikuInvalidRequest(`jiku: invalid request:\n  - ${problems.join('\n  - ')}`);
  }
}

/**
 * Pulls the scalar strings out of a filter value of any shape, so an enum check works on
 * equality, IN and negation alike.
 *
 * Range and containment shapes yield nothing, which is correct: an enum is not ordered and does
 * not contain.
 */
function enumCandidates(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'object' && value !== null && 'not' in value) {
    return enumCandidates(value.not);
  }
  return [];
}

function unknownName(lever: string, name: string, allowed: string[]): string {
  let message = `unknown ${lever} ${JSON.stringify(name)}`;
  const near = suggest(name, allowed);
  if (near) {
    message += `; did you mean ${JSON.stringify(near)}?`;
  }
  return `${message}\n    allowed: ${[...allowed].sort().join(', ')}`;
}

/**
 * Turns a filter value parsed from a string into the JSON type the contract declares.
 *
 * It matters because the operator is decided by the SHAPE of the value and the comparison by its
 * TYPE: `{"projectId": "15"}` is not the same request as `{"projectId": 15}`. Anything that only
 * ever has strings — a CLI, a query string, an HTML form — would otherwise have to guess, and
 * guessing "looks like a number, send a number" breaks any string field whose values happen to
 * be digits, like a project code.
 *
 * An unknown name is returned unchanged rather than rejected: naming is
 * {@link validateQuery}'s job, and doing it in two places means two error messages for one
 * mistake.
 */
export function coerce(resource: Resource, name: string, raw: string): Scalar {
  const field = entries(resource.filterable)[name];
  if (!field) {
    return raw;
  }
  return coerceKind(field.kind, raw);
}

/** Coerces a raw string to the JSON type of a declared field kind. */
export function coerceKind(kind: string, raw: string): Scalar {
  switch (kind) {
    case 'integer': {
      // Number() rather than parseInt(): parseInt("15abc") is 15, which would send a filter
      // the caller never wrote. Number("15abc") is NaN, which is the honest answer.
      const value = Number(raw);
      if (!Number.isInteger(value) || raw.trim() === '') {
        throw new JikuInvalidRequest(
          `jiku: invalid request: ${JSON.stringify(raw)} is not an integer`,
        );
      }
      return value;
    }
    case 'number':
    case 'float':
    case 'decimal': {
      const value = Number(raw);
      if (!Number.isFinite(value) || raw.trim() === '') {
        throw new JikuInvalidRequest(
          `jiku: invalid request: ${JSON.stringify(raw)} is not a number`,
        );
      }
      return value;
    }
    case 'boolean':
    case 'bool':
      switch (raw.toLowerCase()) {
        case 'true':
        case '1':
        case 'yes':
          return true;
        case 'false':
        case '0':
        case 'no':
          return false;
        default:
          throw new JikuInvalidRequest(
            `jiku: invalid request: ${JSON.stringify(raw)} is not a boolean`,
          );
      }
    default:
      // Strings, dates and enums all travel as strings. A date is deliberately NOT parsed and
      // re-formatted here: core accepts what its schema accepts, and reformatting would risk
      // changing the meaning of a value the caller wrote deliberately.
      return raw;
  }
}

/**
 * Returns the closest candidate within a small edit distance, so a typo gets named instead of
 * the caller re-reading a list of forty names.
 */
export function suggest(input: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  const limit = Math.floor(input.length / 3) + 1;
  for (const candidate of candidates) {
    const distance = editDistance(input.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= limit ? best : undefined;
}

/** Levenshtein with a single rolling row. */
function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  // Code points, not UTF-16 units. Field names are ASCII, so the emoji-decomposition caveat the
  // rule warns about cannot arise here.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  const source = [...a];
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  const target = [...b];
  let previous = Array.from({ length: target.length + 1 }, (_, index) => index);
  let current = new Array<number>(target.length + 1).fill(0);

  for (let i = 1; i <= source.length; i++) {
    current[0] = i;
    for (let j = 1; j <= target.length; j++) {
      const cost = source[i - 1] === target[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[target.length] as number;
}

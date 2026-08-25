import { coerce, type Resource } from './describe.ts';
import { JikuInvalidRequest } from './errors.ts';
import { contains, not, type Filter, type Scalar } from './query.ts';

/**
 * The filter operators, longest first so a two-character one is never read as its one-character
 * prefix.
 */
const OPERATORS = ['>=', '<=', '!=', '=', '>', '<'] as const;

type Operator = (typeof OPERATORS)[number];

const RANGE_KEYS: Record<string, 'gt' | 'gte' | 'lt' | 'lte'> = {
  '>=': 'gte',
  '<=': 'lte',
  '>': 'gt',
  '<': 'lt',
};

/**
 * Turns human-written filter expressions into a wire {@link Filter}.
 *
 * The bus decides the operator by the SHAPE of the value, so this syntax is a surface over those
 * shapes rather than an invention of its own:
 *
 * ```text
 * projectId=15                 {"projectId": 15}                          equality
 * state=analisis,activo        {"state": ["analisis","activo"]}           IN
 * state!=cancelado             {"state": {"not": "cancelado"}}            negation
 * createdAt>=2026-01-01        {"createdAt": {"gte": "2026-01-01"}}       range
 * createdAt<2026-07-01         {"createdAt": {"lt": "2026-07-01"}}        range
 * tag:modulo=facturacion       {"tag": {"key":"modulo","value":"..."}}    containment
 * ```
 *
 * Repeating a name MERGES range bounds, so the two halves of a window can be written separately,
 * which is how anyone would type it:
 *
 * ```ts
 * parseFilter(['createdAt>=2026-01-01', 'createdAt<2026-07-01'])
 * // -> { createdAt: { gte: '2026-01-01', lt: '2026-07-01' } }
 * ```
 *
 * A repeat that is NOT a range is an error rather than a silent overwrite: two conditions on one
 * name would otherwise leave the caller believing both applied.
 *
 * Values are typed by the resource contract when one is given: a filter on an integer sends
 * `15`, not `"15"`. Omit the resource to skip coercion and send everything as a string.
 *
 * This exists for anything whose input is text — a CLI flag, a query string, a form field. Code
 * that already has typed values should build a {@link Filter} directly with the builders.
 */
export function parseFilter(expressions: string[], resource?: Resource): Filter {
  const out: Filter = {};
  const ranges = new Map<string, Record<string, Scalar>>();

  for (const expression of expressions) {
    const { name, operator, value } = splitExpression(expression);

    // Containment: `tag:modulo=facturacion`. Both halves stay strings — a containment key is a
    // name, not a typed column.
    const colon = name.indexOf(':');
    if (colon > 0) {
      const key = name.slice(0, colon);
      const inner = name.slice(colon + 1);
      if (operator !== '=') {
        throw new JikuInvalidRequest(
          `jiku: invalid request: containment (${key}:${inner}) only supports \`=\`, not ` +
            JSON.stringify(operator),
        );
      }
      if (key in out) {
        throw new JikuInvalidRequest(
          `jiku: invalid request: ${JSON.stringify(key)} is filtered twice`,
        );
      }
      out[key] = contains(inner, value);
      continue;
    }

    switch (operator) {
      case '=':
      case '!=': {
        if (name in out) {
          throw new JikuInvalidRequest(
            `jiku: invalid request: ${JSON.stringify(name)} is filtered twice. Only range ` +
              `bounds (>=, <=, >, <) merge; for a set of values use one expression with ` +
              `commas: '${name}=a,b'`,
          );
        }
        const coerced = coerceList(resource, name, value);
        out[name] = operator === '!=' ? not(coerced) : coerced;
        break;
      }
      case '>=':
      case '<=':
      case '>':
      case '<': {
        const coerced = resource ? coerce(resource, name, value) : value;
        let bounds = ranges.get(name);
        if (!bounds) {
          bounds = {};
          ranges.set(name, bounds);
        }
        const key = RANGE_KEYS[operator] as string;
        if (key in bounds) {
          throw new JikuInvalidRequest(
            `jiku: invalid request: ${JSON.stringify(name)} has two ${key} bounds`,
          );
        }
        bounds[key] = coerced;
        break;
      }
    }
  }

  for (const [name, bounds] of ranges) {
    if (name in out) {
      throw new JikuInvalidRequest(
        `jiku: invalid request: ${JSON.stringify(name)} has both an equality and a range ` +
          `condition`,
      );
    }
    out[name] = bounds;
  }
  return out;
}

/**
 * Turns a possibly comma-separated value into a scalar or an array, which is what picks equality
 * versus IN.
 *
 * A trailing comma is how you force a one-element array; it is otherwise indistinguishable from
 * a scalar, and the two mean the same thing to core anyway.
 */
function coerceList(
  resource: Resource | undefined,
  name: string,
  value: string,
): Scalar | Scalar[] {
  const one = (raw: string): Scalar => (resource ? coerce(resource, name, raw) : raw);
  if (!value.includes(',')) {
    return one(value);
  }
  const out = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map(one);
  if (out.length === 0) {
    throw new JikuInvalidRequest(`jiku: invalid request: ${JSON.stringify(name)} has no values`);
  }
  return out;
}

/**
 * Finds the operator in an expression.
 *
 * It scans LEFT TO RIGHT and takes the longest operator at the earliest position — not the first
 * operator in the list that appears anywhere. The difference matters: `title=a>=b` splits on the
 * `=` at index 5, giving the value `a>=b`. Searching by operator instead would find the `>=` and
 * split there, producing the field name `title=a`.
 *
 * So the rule is: the FIRST operator ends the field name, and everything after it is the value,
 * operators included. A field name cannot contain one of these characters anyway.
 */
function splitExpression(expression: string): {
  name: string;
  operator: Operator;
  value: string;
} {
  for (let i = 0; i < expression.length; i++) {
    for (const candidate of OPERATORS) {
      if (!expression.startsWith(candidate, i)) {
        continue;
      }
      const name = expression.slice(0, i).trim();
      const value = expression.slice(i + candidate.length).trim();
      if (name === '') {
        throw new JikuInvalidRequest(
          `jiku: invalid request: ${JSON.stringify(expression)} has no field name on the ` +
            `left of ${candidate}`,
        );
      }
      if (value === '') {
        throw new JikuInvalidRequest(
          `jiku: invalid request: ${JSON.stringify(expression)} has no value on the right ` +
            `of ${candidate}`,
        );
      }
      return { name, operator: candidate, value };
    }
  }
  throw new JikuInvalidRequest(
    `jiku: invalid request: ${JSON.stringify(expression)} is not a filter expression. Use ` +
      `name=value, name!=value, or name>=value (also <=, >, <)`,
  );
}

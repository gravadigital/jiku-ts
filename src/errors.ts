/**
 * The brand every error this library throws carries.
 *
 * `instanceof` is the natural test in JavaScript and it is the one documented here, but it
 * compares constructor identity, and two copies of this package in one dependency tree have
 * two different constructors. A `Symbol.for` brand is registry-global, so {@link isJikuError}
 * keeps working across copies where `instanceof` quietly stops.
 */
const BRAND: unique symbol = Symbol.for('gravadigital.jiku.error') as never;

/**
 * The base class of everything this library throws.
 *
 * Every subclass carries the same brand, so a caller who only wants to know "did this come
 * from jiku?" can ask {@link isJikuError} without enumerating the subclasses.
 */
export class JikuError extends Error {
  /** @internal */
  readonly [BRAND] = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Reports whether a value is an error thrown by this library, across duplicate copies of the
 * package.
 */
export function isJikuError(value: unknown): value is JikuError {
  return typeof value === 'object' && value !== null && BRAND in value;
}

/**
 * A request this library rejected LOCALLY, before publishing, because core would answer
 * `invalid_fields`. Fix the call — nothing reached the network.
 */
export class JikuInvalidRequest extends JikuError {}

/** Use of a {@link Client} that was closed or never connected. */
export class JikuNotConnected extends JikuError {
  constructor(message = 'jiku: not connected') {
    super(message);
  }
}

/**
 * A bus timeout: no reply arrived.
 *
 * On this bus the first suspect is a wrong instance or a wrong method, not a slow core. The
 * classic third cause — a wrong inbox prefix — is not possible through this client, which is
 * why the message says so.
 */
export class JikuTimeout extends JikuError {}

/**
 * Nothing is subscribed to the subject: the bus said so IMMEDIATELY rather than the request
 * timing out.
 *
 * It is a firmer signal than a timeout — the method almost certainly does not exist, or it
 * was asked on the wrong plane or instance.
 */
export class JikuNoEndpoint extends JikuError {}

/**
 * The BUS refused to publish, which is a different thing from core refusing and has a
 * different fix.
 *
 * The distinction is worth spelling out every time: the bus refuses by subject, before core
 * sees anything; core refuses by role and by its own `users` table, after. A caller who
 * confuses the two goes looking in the wrong service.
 */
export class JikuPermissionDenied extends JikuError {
  /** The subject the bus refused. */
  readonly subject: string;
  /** The method that was being published. */
  readonly method: string;

  constructor(message: string, subject: string, method: string, options?: ErrorOptions) {
    super(message, options);
    this.subject = subject;
    this.method = method;
  }
}

/**
 * The shared error catalog. One catalog for both planes, not one per plane.
 *
 * The HTTP column of the spec is documentation for a future consumer, not behaviour, so it is
 * deliberately not mapped here.
 *
 * # THIS CATALOG IS NOT CLOSED, AND A CLIENT MUST NOT TREAT IT AS SUCH
 *
 * It is the deployment's, not this library's — core owns it and grows it. As write rules move
 * from the api into core, new business-rule codes appear that this list will not have. That is
 * why nothing here switches exhaustively on a code: an unrecognised one still arrives as a
 * {@link JikuFailure} with its `code` and `details` intact, `hint()` just returns `undefined`,
 * and a caller comparing against the constant it cares about keeps working.
 *
 * Use {@link isCode}, never a `switch` with a `default` that assumes it has seen everything.
 * `ErrorCodeValue` is `string`-widened for exactly this reason: an unknown code must remain
 * representable.
 */
export const ErrorCode = {
  /**
   * A name or value the resource sheet does not declare. Deny by default: a name that is not
   * whitelisted does not exist.
   */
  InvalidFields: 'invalid_fields',
  /**
   * A cursor that does not decode, or whose scope no longer matches the filter and sort it
   * was minted for.
   */
  InvalidCursor: 'invalid_cursor',
  /**
   * Gate 1: this caller may not run this method. Usually the wrong role for the plane — a
   * person publishing a command, for instance.
   */
  CallerNotAuthorized: 'caller_not_authorized',
  /**
   * Gate 2: the caller has no row in `users`. A different question from authorisation, and
   * merging the two would erase the rule that an unknown caller gets an error rather than an
   * empty list.
   */
  UnknownCaller: 'unknown_caller',
  /** A method that is not in the registry. Check the spelling against `meta.describe`. */
  UnknownCommand: 'unknown_command',
  /**
   * PostgreSQL's `statement_timeout` (8s) firing before the bus timeout (10s) — by design, so
   * the caller gets an explanation instead of silence.
   */
  QueryTimeout: 'query_timeout',
  /**
   * The dispatcher's catch. The dispatcher never throws, because a thrown exception would
   * become a mute bus timeout on the caller's side.
   */
  InternalError: 'internal_error',

  // The *_not_found codes. On a `get` they do NOT distinguish "does not exist" from "you may
  // not see it": answering a permission error would confirm to an external caller that the
  // resource exists.
  ClientNotFound: 'client_not_found',
  ProjectNotFound: 'project_not_found',
  RequirementNotFound: 'requirement_not_found',
  TaskNotFound: 'task_not_found',
  CommentNotFound: 'comment_not_found',
  FileNotFound: 'file_not_found',
  PersonNotFound: 'person_not_found',
  ObjectiveNotFound: 'objective_not_found',
  UserNotFound: 'user_not_found',
  WorkedTimeNotFound: 'worked_time_not_found',
  UnworkedTimeNotFound: 'unworked_time_not_found',
  SubscriptionNotFound: 'subscription_not_found',

  // Emitted by commands only. These are business-rule refusals rather than shape errors, so a
  // caller that retries the same request gets the same answer.
  FileNotOwned: 'file_not_owned',
  AlreadySubscribed: 'already_subscribed',
  DailyLimitExceeded: 'daily_limit_exceeded',
  FileTooLarge: 'file_too_large',
  FileTypeNotAllowed: 'file_type_not_allowed',
  InvalidResponsiblePerson: 'invalid_responsible_person',
  RequirementProjectMismatch: 'requirement_project_mismatch',
  /**
   * The mandatory conclusion on resolve. REQ-012 narrowed it back to requirements of type
   * `incidencia`: resolving any other type no longer needs a resolution type or a conclusion.
   */
  ResolutionRequired: 'resolution_required',
  /** The hours window and the week validation. Arrived with REQ-007. */
  InvalidDateRange: 'invalid_date_range',
  /**
   * Only the comment's author or an admin may edit one. Added by REQ-011 with the
   * comment-editing commands.
   */
  CommentNotOwned: 'comment_not_owned',
  /**
   * The entry must actually be a comment — an activity row of any other kind is not editable
   * even for its own author. Added by REQ-011.
   */
  ActivityNotEditable: 'activity_not_editable',
  /** A stage the project does not have. Arrived with REQ-007. */
  StageNotFound: 'stage_not_found',
  /**
   * The project-permission refusal: the caller may run the method, but not against this
   * project. Distinct from {@link ErrorCode.CallerNotAuthorized}, which is about the method
   * itself.
   */
  AccessDenied: 'access_denied',

  // Declared with NO CURRENT EMITTER, and kept deliberately — core keeps them in its own
  // catalog, so this library does too. A code that loses its emitter keeps its constant: the
  // catalog is not closed, and nothing here may assume these are unreachable.
  /**
   * The requirement state workflow refusing a transition, until REQ-012 made transitions free
   * by product decision. `requirements.{id}.edit` and `.resolve` stopped emitting it.
   */
  InvalidStateTransition: 'invalid_state_transition',
  /** Declared for completeness; core's catalog keeps it. No current emitter. */
  FileNotAvailable: 'file_not_available',
  /** Declared for completeness; core's catalog keeps it. No current emitter. */
  InvalidAttachmentId: 'invalid_attachment_id',
} as const;

/**
 * A failure code.
 *
 * Deliberately `string`-widened rather than a closed union of {@link ErrorCode}: core owns the
 * catalog and grows it, so a code this library has never heard of must still typecheck. The
 * `(string & {})` keeps editor completion for the known codes.
 */
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode] | (string & {});

/**
 * The structured half of a failure, so a caller never parses the message with a regex.
 *
 * The query plane populates it from day one: a rejected name comes back as
 * `{field, value, allowed}`, where `allowed` is the resource sheet's list by reference — which
 * is exactly what makes `meta.describe` verifiable against the validator.
 *
 * Unknown keys are preserved, so a field core starts sending tomorrow is not lost.
 */
export interface ErrorDetails {
  field?: string;
  value?: unknown;
  allowed?: string[];
  [key: string]: unknown;
}

/** Options accepted by the {@link JikuFailure} constructor. */
export interface JikuFailureInit {
  code: ErrorCodeValue;
  /** The message core sent. It is in the deployment's language, which is Spanish today. */
  errorMessage?: string;
  details?: ErrorDetails;
  /** The method that failed, added by this library for context. */
  method?: string;
}

/** A `status: failure` reply, with everything core said about it. */
export class JikuFailure extends JikuError {
  /** The failure code. Compare it with {@link isCode} or against {@link ErrorCode}. */
  readonly code: ErrorCodeValue;
  /** The message core sent, verbatim and unparsed. */
  readonly errorMessage: string | undefined;
  /** The structured half of the failure, when core sent one. */
  readonly details: ErrorDetails | undefined;
  /** The method that failed. */
  readonly method: string | undefined;

  constructor(init: JikuFailureInit) {
    super(formatFailure(init));
    this.code = init.code;
    this.errorMessage = init.errorMessage;
    this.details = init.details;
    this.method = init.method;
  }

  /**
   * Advice for the failure codes whose cause is not obvious from the code alone, or
   * `undefined` when the code explains itself.
   */
  hint(): string | undefined {
    return hintFor(this.code);
  }
}

/**
 * Renders the rejected value for a message.
 *
 * NOT `String()`: core types `value` as whatever the rejected input was, and an object
 * stringifies to "[object Object]" — which turns the most useful half of the message into noise
 * exactly when the value is interesting.
 */
function renderValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object') {
    try {
      // Always a string here: `value` is an object or null, and JSON.stringify only returns
      // undefined for a function, a symbol or undefined itself.
      return JSON.stringify(value);
    } catch {
      // A circular structure, or a toJSON that threw. The message is worth more than the value.
      return '[unserialisable]';
    }
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  // A function, a symbol, or undefined. None of these can come off the wire, but `value` is
  // typed unknown and a caller can construct a JikuFailure by hand.
  return `[${typeof value}]`;
}

function formatFailure(init: JikuFailureInit): string {
  let out = 'jiku: ';
  if (init.method) {
    out += `${init.method}: `;
  }
  out += init.code || 'failure';
  if (init.errorMessage) {
    out += `: ${init.errorMessage}`;
  }
  const details = init.details;
  if (details) {
    if (details.field) {
      out += ` (field ${JSON.stringify(details.field)}`;
      if (details.value !== undefined && details.value !== null) {
        // NOT String(): core types `value` as whatever the rejected input was, and an object
        // stringifies to "[object Object]" — which turns the most useful half of the message
        // into noise exactly when the value is interesting.
        out += ` = ${renderValue(details.value)}`;
      }
      out += ')';
    }
    if (details.allowed && details.allowed.length > 0) {
      out += `; allowed: ${[...details.allowed].sort().join(', ')}`;
    }
  }
  return out;
}

/**
 * Reports whether an error is a core failure carrying the given code.
 *
 * ```ts
 * if (isCode(err, ErrorCode.TaskNotFound)) {
 *   // ...
 * }
 * ```
 */
export function isCode(error: unknown, code: ErrorCodeValue): boolean {
  return error instanceof JikuFailure
    ? error.code === code
    : isJikuError(error) && (error as { code?: unknown }).code === code;
}

function hintFor(code: ErrorCodeValue): string | undefined {
  switch (code) {
    case ErrorCode.CallerNotAuthorized:
      // Three causes, and the code cannot tell them apart — so all three are named, in the
      // order they are worth checking. The bus already accepted the publish at this point,
      // which is what makes this confusing: the refusal is core's, not the bus's.
      return (
        'the BUS accepted this and CORE refused it. Two different systems, two questions. ' +
        'Three things produce this code:\n' +
        "  1. The caller's role authorises no such method in CORE's role -> method map, which " +
        'is separate from the bus permission template and deny-by-default. Beware the roles ' +
        'that grant bus access and authorise NOTHING in core: `internal-app`, `core` and ' +
        '`bus-observer`. The api works while holding `internal-app` because it is exempt by ' +
        "its `sub` (core's CORE_TRUSTED_PUBLISHER_ID), NOT because of the role — so a second " +
        'identity given that same role can do nothing at all. For queries you want a product ' +
        "role (admin, user, external-user); for writes, a role core's map grants commands to.\n" +
        '  2. Core has no row for this caller in its `users` table. That row is created from ' +
        'the authentication event the auth-callout publishes on connect; if core never ' +
        "received it or discarded it, no row exists and EVERY method is refused. Core's log " +
        'names a discarded event (`[events] descartado`) and the field that was missing.\n' +
        '  3. The very first request of a brand-new identity can lose a race with its own ' +
        'authentication event, which is fire-and-forget and unacknowledged. Retrying once ' +
        'distinguishes this from the other two.'
      );
    case ErrorCode.UnknownCaller:
      return (
        "core authorised the method but could not resolve the caller's CLASS, which means it " +
        'has no row for this caller in `users`. The identity is synchronised from the ' +
        'authentication event the auth-callout publishes on connect, so either that event ' +
        "never arrived or core discarded it — core's log says which (`[events] descartado`)."
      );
    case ErrorCode.UnknownCommand:
      return (
        'no endpoint is registered for that method. Fetch the contract with ' +
        '`client.describe()` for the list core actually serves.'
      );
    case ErrorCode.InvalidCursor:
      return (
        'a cursor is only valid for the exact filter and sort it was minted for. Re-run the ' +
        'query from the first page.'
      );
    case ErrorCode.QueryTimeout:
      return (
        "the query exceeded PostgreSQL's statement_timeout (8s). Narrow the filter, or ask " +
        'for fewer includables.'
      );
    case ErrorCode.InvalidFields:
      return (
        'deny by default: a name the resource sheet does not declare does not exist. ' +
        '`client.contract()` lists every name that does, and `validateQuery()` checks a query ' +
        'against them before it is sent.'
      );
    default:
      return undefined;
  }
}

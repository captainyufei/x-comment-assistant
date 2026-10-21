/** Pure recognition of the narrow retry-progress events emitted by Codex CLI 0.147.0.
 * Official producers: core/src/responses_retry.rs and
 * exec/src/event_processor_with_jsonl_output.rs at rust-v0.147.0.
 * Unknown diagnostics remain terminal in the bridge; this helper never retries.
 */
const MAX_NOTICE_CHARS = 1500;
const MAX_RETRIES = 100; // model-provider-info/src/lib.rs hard cap, not a new retry budget.

const HARD_FAILURE = /auth|login|logged[ _-]?(?:in|out)|sign[ _-]?(?:in|out)|\b(?:401|403|429)\b|quota|usage[ _-]?limit|rate[ _-]?limit|credits?|config|unsupported|not supported|api[ _-]?key|token|\b(?:tools?|mcp|commands?|shell|exec|execution|browser|sandbox|approval|permissions?|denied|blocked)\b|(?:tool|mcp|command|shell|exec)[_-]|web[ _-]?search|file[ _-]?change/iu;

// Full short diagnostic strings only, rather than "stream disconnected" plus
// arbitrary text. Additional instructions or novel error types must fail closed.
const STREAM_REASON = /^(?:websocket closed(?: by server)? before response\.completed|connection closed before response\.completed|stream ended before response\.completed|unexpected (?:EOF|end of stream)|connection reset(?: by peer)?(?: \(os error (?:54|104)\))?|broken pipe(?: \(os error 32\))?|(?:operation|request|connection) timed out|stream idle timeout|timed out waiting for response\.completed|error decoding response body|error reading a body from connection)$/iu;
const STATUS_NAMES = new Map([
  ['500', 'Internal Server Error'],
  ['502', 'Bad Gateway'],
  ['503', 'Service Unavailable'],
  ['504', 'Gateway Timeout'],
]);
const STATUS_BODIES = new Set([
  '', 'Internal Server Error', 'Bad Gateway', 'Service Unavailable', 'Gateway Timeout',
  'upstream connect error or disconnect/reset before headers. reset reason: connection failure',
  'upstream connect error or disconnect/reset before headers. reset reason: connection termination',
]);

function safeDiagnosticUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 1200 || /[\s()<>"'\\]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && Boolean(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function isSendingRequest(detail) {
  const match = /^(?:Connection failed: )?error sending request for url \(([^()]+)\)$/u.exec(detail);
  return Boolean(match && safeDiagnosticUrl(match[1]));
}

function isUnexpectedStatus(detail) {
  const [base, ...metadata] = detail.split(', ');
  const match = /^unexpected status (5\d\d)(?: ([A-Za-z ]+))?(?:: ?(.*))?$/u.exec(base);
  if (!match || !STATUS_NAMES.has(match[1])) return false;
  if (match[2] !== undefined && match[2] !== STATUS_NAMES.get(match[1])) return false;
  if (!STATUS_BODIES.has(match[3] ?? '')) return false;
  // These metadata labels and their order match UnexpectedResponseError::fmt.
  let lastIndex = -1;
  for (const field of metadata) {
    let index;
    if (field.startsWith('url: ') && safeDiagnosticUrl(field.slice(5))) index = 0;
    else if (/^cf-ray: [A-Za-z0-9-]{1,80}$/u.test(field)) index = 1;
    else if (/^request id: [A-Za-z0-9_-]{1,100}$/u.test(field)) index = 2;
    else return false;
    if (index <= lastIndex) return false;
    lastIndex = index;
  }
  return true;
}

function isKnownTransportDiagnostic(detail) {
  const streamPrefix = 'stream disconnected before completion: ';
  if (detail.startsWith(streamPrefix)) {
    const reason = detail.slice(streamPrefix.length);
    return STREAM_REASON.test(reason) || isSendingRequest(reason) || isUnexpectedStatus(reason);
  }
  return isSendingRequest(detail) || isUnexpectedStatus(detail);
}

/** Returns sanitized progress counts, never the raw error/URL/body or a retry instruction. */
export function parseReconnectNotice(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)
    || !Object.hasOwn(event, 'type') || !Object.hasOwn(event, 'message')
    || Reflect.ownKeys(event).length !== 2 || event.type !== 'error'
    || typeof event.message !== 'string') return null;
  const message = event.message;
  if (!message || message.length > MAX_NOTICE_CHARS || /[\r\n\u2028\u2029]/u.test(message) || HARD_FAILURE.test(message)) return null;
  const match = /^Reconnecting\.\.\. ([1-9]\d{0,2})\/([1-9]\d{0,2})(?: \((.+)\))?$/u.exec(message);
  if (!match) return null;
  const attempt = Number(match[1]), maxAttempts = Number(match[2]);
  if (attempt > maxAttempts || maxAttempts > MAX_RETRIES) return null;
  if (match[3] !== undefined && !isKnownTransportDiagnostic(match[3])) return null;
  return {attempt, maxAttempts};
}

/**
 * Backoff for the steps that fail without meaning anything.
 *
 * The asset layer's slow steps all cross a network this app does not own —
 * R2 from the browser, R2 from the Worker, a model vendor — and a single lost
 * connection there is not a verdict about the work, it is weather. Without a
 * retry the whole node is marked failed and the person has to start over,
 * which is a heavy answer to a light problem.
 *
 * What must never be retried is anything that could happen *twice*: a step is
 * a candidate only if running it again is indistinguishable from running it
 * once. Each caller decides that for itself — see `retriableFetchFailure` for
 * the rule that covers the HTTP steps.
 */

/** Delays in ms, one per retry after the first attempt. */
const BACKOFF_MS = [400, 1_200, 3_000];

export interface RetryOptions {
  /** Total tries, including the first. Capped by the backoff table. */
  attempts?: number;
  /** Cancels both the waiting and any further attempt. */
  signal?: AbortSignal;
  /** Called before each wait, for callers that want to say what is happening. */
  onRetry?: (attempt: number, error: unknown) => void;
}

/**
 * Sleep that gives up when the signal does. A plain `setTimeout` would hold a
 * cancelled upload for the whole backoff before noticing nobody wants it — and
 * on a deleted node that is a patch written after the node is gone.
 */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);

      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs `attempt` until it succeeds, `retriable` says to stop, or the tries run
 * out — then throws the last error, which is the one worth showing: it is what
 * the step was still failing with after being given every chance.
 */
export async function withRetry<T>(
  attempt: () => Promise<T>,
  retriable: (error: unknown) => boolean,
  options: RetryOptions = {}
): Promise<T> {
  const attempts = Math.min(options.attempts ?? BACKOFF_MS.length + 1, BACKOFF_MS.length + 1);

  let last: unknown;

  for (let index = 0; index < attempts; index++) {
    try {
      return await attempt();
    } catch (error) {
      last = error;

      // An abort is the caller changing its mind, not a failure to retry
      // through — and the signal check below would catch it a beat later
      // anyway, after a pointless verdict from `retriable`.
      if (options.signal?.aborted) throw error;
      if (index === attempts - 1 || !retriable(error)) throw error;

      options.onRetry?.(index + 1, error);

      await wait(BACKOFF_MS[index], options.signal);
    }
  }

  throw last;
}

/**
 * Thrown for an HTTP step that answered, so the status survives to the retry
 * decision — `fetch` only rejects when nothing came back at all.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Whether an HTTP step is worth trying again.
 *
 * A `fetch` that rejects never reached a server, or the answer never made it
 * back — either way nothing decided anything, so it is safe to ask again.
 * A server that answered decided something: 5xx is the server saying it could
 * not do its job right now, and 4xx is it saying the request itself is wrong,
 * which repeating cannot fix. 408 and 429 are the two 4xx that describe timing
 * rather than the request.
 */
export function retriableFetchFailure(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status >= 500 || error.status === 408 || error.status === 429;
  }

  // A DOMException here is the abort, which `withRetry` has already refused
  // to retry; anything else is the network.
  return !(error instanceof DOMException);
}

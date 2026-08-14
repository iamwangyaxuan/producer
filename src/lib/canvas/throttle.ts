/**
 * A trailing-edge throttle: calls go through at most once per `ms`, and the
 * last one to arrive during a quiet period is delivered when it ends rather
 * than dropped. That trailing delivery is the point — a cursor stream that
 * simply skipped its final event would leave every cursor resting a few pixels
 * from where its person actually stopped.
 */
export function throttled<T extends unknown[]>(ms: number, run: (...args: T) => void) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: T | null = null;

  function flush() {
    timer = null;

    if (pending) {
      const args = pending;

      pending = null;
      last = Date.now();
      run(...args);
    }
  }

  function call(...args: T) {
    const now = Date.now();

    if (!timer && now - last >= ms) {
      last = now;
      run(...args);

      return;
    }

    pending = args;
    timer ??= setTimeout(flush, ms - (now - last));
  }

  call.cancel = () => {
    if (timer) clearTimeout(timer);

    timer = null;
    pending = null;
  };

  return call;
}

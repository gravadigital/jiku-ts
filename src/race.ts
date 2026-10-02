/**
 * Races a promise against one or two abort signals.
 *
 * The NATS request API takes a timeout but no signal, so cancellation is implemented here. It
 * stops the WAIT, not the request: the message is already published and core, or JetStream, may
 * still act on it.
 */
export function race<T>(promise: Promise<T>, ...signals: (AbortSignal | undefined)[]): Promise<T> {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const cleanups: (() => void)[] = [];
    const settle = (fn: () => void): void => {
      for (const cleanup of cleanups) {
        cleanup();
      }
      fn();
    };
    for (const signal of present) {
      if (signal.aborted) {
        settle(() => {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(signal.reason);
        });
        return;
      }
      const onAbort = (): void => {
        settle(() => {
          // Whatever the caller passed to abort() is what they get back, Error or not. Wrapping
          // it would hide the reason they chose.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(signal.reason);
        });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      cleanups.push(() => {
        signal.removeEventListener('abort', onAbort);
      });
    }
    promise.then(
      (value) => {
        settle(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        settle(() => {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(error);
        });
      },
    );
  });
}

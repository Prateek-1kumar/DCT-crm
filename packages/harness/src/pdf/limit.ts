/**
 * Runs at most `max` jobs at once; the rest wait their turn, in order. A finished job hands its place straight to the
 * next waiting one, so the count never passes `max` even for a moment.
 */
export function limit(max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(job: () => Promise<T>): Promise<T> {
    if (running >= max) await new Promise<void>((go) => waiting.push(go));
    else running++;
    try {
      return await job();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

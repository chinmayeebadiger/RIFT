export interface BoundedRequestMetrics<T> {
  readonly requestCount: number;
  readonly completedCount: number;
  readonly errorCount: number;
  readonly maxInFlight: number;
  readonly latenciesMs: readonly number[];
  readonly results: readonly (T | undefined)[];
  readonly errors: readonly { readonly index: number; readonly error: unknown }[];
}

export interface BoundedRequestOptions<T> {
  readonly count: number;
  readonly concurrency: number;
  readonly request: (index: number) => Promise<T>;
}

/**
 * Run a deterministic, bounded request workload and retain enough data for a
 * test or local smoke check to report request counts, errors, and latency.
 * Latencies are observations only; callers should avoid wall-clock thresholds.
 */
export async function runBoundedRequests<T>(options: BoundedRequestOptions<T>): Promise<BoundedRequestMetrics<T>> {
  if (!Number.isSafeInteger(options.count) || options.count < 0) {
    throw new Error("count must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency <= 0) {
    throw new Error("concurrency must be a positive safe integer");
  }

  const results: (T | undefined)[] = Array.from({ length: options.count });
  const latenciesMs: number[] = Array.from({ length: options.count });
  const errors: { index: number; error: unknown }[] = [];
  let nextIndex = 0;
  let inFlight = 0;
  let maxInFlight = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < options.count) {
      const index = nextIndex;
      nextIndex += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const startedAt = performance.now();
      try {
        results[index] = await options.request(index);
      } catch (error: unknown) {
        errors.push({ index, error });
      } finally {
        latenciesMs[index] = performance.now() - startedAt;
        inFlight -= 1;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(options.count, options.concurrency) }, () => worker()));

  return {
    requestCount: options.count,
    completedCount: results.filter((result) => result !== undefined).length,
    errorCount: errors.length,
    maxInFlight,
    latenciesMs,
    results,
    errors,
  };
}

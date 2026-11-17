/**
 * Map items through an async function with at most `limit` calls in flight.
 * Results keep the input order.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = [];
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next;
			next += 1;
			results[index] = await fn(items[index] as T, index);
		}
	};
	const workers = Math.max(1, Math.min(limit, items.length));
	await Promise.all(Array.from({ length: workers }, worker));
	return results;
}

export function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const buckets = new Map();

  function prune(key, at) {
    const hits = buckets.get(key);
    if (!hits) return [];
    const cutoff = at - windowMs;
    while (hits.length > 0 && hits[0] <= cutoff) hits.shift();
    if (hits.length === 0) buckets.delete(key);
    return hits;
  }

  return {
    check(key) {
      const at = now();
      const hits = prune(key, at);
      if (hits.length >= limit) return false;
      hits.push(at);
      buckets.set(key, hits);
      return true;
    },
    remaining(key) {
      return Math.max(0, limit - prune(key, now()).length);
    },
    reset(key) {
      buckets.delete(key);
    },
    get size() {
      return buckets.size;
    },
  };
}

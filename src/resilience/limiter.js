/**
 * Creates a concurrency limiter: at most `concurrency` calls run at once,
 * the rest wait in a FIFO queue. Handy for "download these 200 files, 4 at a
 * time" without pulling in a queue library. (Same idea as p-limit.)
 *
 * ```js
 * const limit = createLimiter(4);
 * const bytes = await Promise.all(urls.map((u) => limit(() => download(u))));
 * // or: await limit.map(urls, (u) => download(u));
 * ```
 *
 * @param {number} [concurrency=Infinity] - integer >= 1, or Infinity
 */
function createLimiter(concurrency = Infinity) {
  if (concurrency !== Infinity && !(Number.isInteger(concurrency) && concurrency >= 1)) {
    throw new TypeError("createLimiter: `concurrency` must be an integer >= 1 (or Infinity)");
  }

  const queue = [];
  let active = 0;

  function next() {
    while (active < concurrency && queue.length > 0) {
      active++;
      queue.shift()();
    }
  }

  function limit(fn, ...args) {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(() => fn(...args))
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  }

  Object.defineProperties(limit, {
    activeCount: { get: () => active },
    pendingCount: { get: () => queue.length },
  });

  /** Runs `fn(item, index)` for every item through the limiter. Results keep input order. */
  limit.map = (items, fn) => Promise.all(Array.from(items, (item, i) => limit(fn, item, i)));

  return limit;
}

module.exports = { createLimiter };

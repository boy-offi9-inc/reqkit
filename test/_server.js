const http = require("node:http");

// Tiny local server for integration tests. `handler(req, res, hits)` where
// hits is the 1-based request counter for that server.
async function startServer(handler) {
  let hits = 0;
  const server = http.createServer((req, res) => handler(req, res, ++hits));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))),
  };
}

module.exports = { startServer };

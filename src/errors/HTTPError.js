class HTTPError extends Error {
  constructor(response, request) {
    const statusText = response.statusText ? ` ${response.statusText}` : "";
    super(`Request failed with status ${response.status}${statusText}: ${request.method} ${request.url}`);
    this.name = "HTTPError";
    this.status = response.status;
    this.statusText = response.statusText || "";
    this.response = response;
    this.url = request.url;
    this.method = request.method;
  }
}

module.exports = { HTTPError };

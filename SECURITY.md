# Security policy

## Supported versions

Security fixes are released against the latest version. reqkit is pre-1.0, so please reproduce on the newest release before reporting.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub:
<https://github.com/boy-offi9-inc/reqkit/security/advisories/new>

Include the affected version, what you found, and a minimal reproduction if you can. Fixes ship as a patch release, with credit if you'd like it.

## Scope

reqkit processes data a server controls and carries credentials, so these are in scope:

- credentials (`auth` tokens, default `Authorization` / `Cookie` / API-key headers) reaching an origin they shouldn't
- a server-controlled URL (`Link` headers, redirects) steering requests somewhere unintended
- denial of service from hostile input: unbounded memory or super-linear parsing in header, SSE, NDJSON or line readers
- a retry repeating a non-idempotent request unexpectedly

Out of scope: SSRF protection for server-side use (reqkit does not resolve DNS or block private addresses, so validate user-supplied URLs yourself) and bugs in third-party HTTP clients used alongside reqkit.

The protections already in place are described in the [Security section of the README](./README.md#security).

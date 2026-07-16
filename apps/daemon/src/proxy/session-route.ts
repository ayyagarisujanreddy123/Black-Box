import { IdentifierSchema } from "@blackbox/protocol";

const SESSION_ROUTE_PREFIX = "/.blackbox/session/";

export interface SessionScopedPath {
  readonly sessionId: string;
  readonly path: string;
}

export function sessionScopedProxyBaseUrl(
  proxyOrigin: string,
  sessionId: string,
): string {
  const origin = new URL(proxyOrigin);
  if (
    origin.pathname !== "/" ||
    origin.search.length > 0 ||
    origin.hash.length > 0
  ) {
    throw new TypeError(
      "The proxy origin must not contain a path, query, or fragment.",
    );
  }
  const validated = IdentifierSchema.parse(sessionId);
  const encoded = Buffer.from(validated, "utf8").toString("base64url");
  return new URL(`${SESSION_ROUTE_PREFIX}${encoded}/v1`, origin)
    .toString()
    .replace(/\/$/u, "");
}

export function parseSessionScopedPath(
  path: string,
): SessionScopedPath | undefined {
  if (!path.startsWith(SESSION_ROUTE_PREFIX)) {
    return undefined;
  }
  const remainder = path.slice(SESSION_ROUTE_PREFIX.length);
  const separator = remainder.indexOf("/");
  if (separator <= 0) {
    return undefined;
  }
  const encoded = remainder.slice(0, separator);
  if (!/^[A-Za-z\d_-]+$/u.test(encoded)) {
    return undefined;
  }
  let sessionId: string;
  try {
    sessionId = IdentifierSchema.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(encoded, "base64url"),
      ),
    );
  } catch {
    return undefined;
  }
  const providerPath = remainder.slice(separator);
  if (providerPath !== "/v1" && !providerPath.startsWith("/v1/")) {
    return undefined;
  }
  return { sessionId, path: providerPath };
}

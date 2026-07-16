import { isIP } from "node:net";

import { z } from "zod";

import {
  ProxyConfigurationError,
  ProxyLoopError,
  UnsafeBindError,
} from "./errors.js";

export const DEFAULT_PROXY_HOST = "127.0.0.1";
export const DEFAULT_PROXY_PORT = 4141;
export const DEFAULT_UPSTREAM_ORIGIN = "https://api.openai.com";

export interface ProxyConfigurationInput {
  readonly listenHost?: string;
  readonly listenPort?: number;
  readonly upstream?: string | URL;
  readonly allowNonLoopback?: boolean;
  readonly captureQueueMaxBytes?: number;
  readonly maxRequestBodyBytes?: number;
  readonly maxResponseBodyBytes?: number;
}

export interface ProxyConfiguration {
  readonly listenHost: string;
  readonly listenPort: number;
  readonly upstream: URL;
  readonly allowNonLoopback: boolean;
  readonly captureQueueMaxBytes: number;
  readonly maxRequestBodyBytes: number;
  readonly maxResponseBodyBytes: number;
}

const HostSchema = z.string().trim().min(1).max(253);
const PortSchema = z.number().int().min(1).max(65_535);
const ByteLimitSchema = z
  .number()
  .int()
  .positive()
  .max(1024 * 1024 * 1024);

function normalizedHost(host: string): string {
  const withoutBrackets =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return withoutBrackets.toLowerCase().replace(/\.$/u, "");
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizedHost(host);
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  if (isIP(normalized) === 4) {
    const firstOctet = Number(normalized.split(".")[0]);
    return firstOctet === 127;
  }
  return false;
}

function effectivePort(url: URL): number {
  if (url.port !== "") {
    return Number(url.port);
  }
  return url.protocol === "https:" ? 443 : 80;
}

function validateUpstream(input: string | URL): URL {
  let upstream: URL;
  try {
    upstream = input instanceof URL ? new URL(input) : new URL(input);
  } catch (error: unknown) {
    throw new ProxyConfigurationError(
      "INVALID_UPSTREAM",
      `Upstream must be an absolute HTTP(S) origin: ${String(error)}`,
    );
  }

  if (!new Set(["http:", "https:"]).has(upstream.protocol)) {
    throw new ProxyConfigurationError(
      "INVALID_UPSTREAM",
      "Upstream protocol must be HTTP or HTTPS.",
    );
  }
  if (
    upstream.username !== "" ||
    upstream.password !== "" ||
    upstream.pathname !== "/" ||
    upstream.search !== "" ||
    upstream.hash !== ""
  ) {
    throw new ProxyConfigurationError(
      "INVALID_UPSTREAM",
      "Upstream must be a credential-free origin without a path, query, or fragment.",
    );
  }
  return upstream;
}

export function assertNoProxyLoop(
  listenHost: string,
  listenPort: number,
  upstream: URL,
): void {
  if (effectivePort(upstream) !== listenPort) {
    return;
  }

  const upstreamHost = normalizedHost(upstream.hostname);
  const listenerHost = normalizedHost(listenHost);
  if (
    upstreamHost === listenerHost ||
    (isLoopbackHost(upstreamHost) && isLoopbackHost(listenerHost))
  ) {
    throw new ProxyLoopError(upstream.origin);
  }
}

export function resolveProxyConfiguration(
  input: ProxyConfigurationInput = {},
): ProxyConfiguration {
  const listenHost = HostSchema.parse(input.listenHost ?? DEFAULT_PROXY_HOST);
  const listenPort = PortSchema.parse(input.listenPort ?? DEFAULT_PROXY_PORT);
  const allowNonLoopback = input.allowNonLoopback === true;
  const upstream = validateUpstream(input.upstream ?? DEFAULT_UPSTREAM_ORIGIN);

  if (!isLoopbackHost(listenHost) && !allowNonLoopback) {
    throw new UnsafeBindError(listenHost);
  }
  assertNoProxyLoop(listenHost, listenPort, upstream);

  return {
    listenHost,
    listenPort,
    upstream,
    allowNonLoopback,
    captureQueueMaxBytes: ByteLimitSchema.parse(
      input.captureQueueMaxBytes ?? 4 * 1024 * 1024,
    ),
    maxRequestBodyBytes: ByteLimitSchema.parse(
      input.maxRequestBodyBytes ?? 16 * 1024 * 1024,
    ),
    maxResponseBodyBytes: ByteLimitSchema.parse(
      input.maxResponseBodyBytes ?? 64 * 1024 * 1024,
    ),
  };
}

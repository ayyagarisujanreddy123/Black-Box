import { readdir, readFile, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

const MAXIMUM_INDEX_BYTES = 1024 * 1024;
const MAXIMUM_ASSET_BYTES = 5 * 1024 * 1024;
const MAXIMUM_TOTAL_ASSET_BYTES = 20 * 1024 * 1024;
const ASSET_NAME = /^[A-Za-z\d][A-Za-z\d._-]{0,199}\.(?:css|js)$/u;

const VIEWER_SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "object-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy":
    "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

interface ViewerAsset {
  readonly bytes: Buffer;
  readonly mediaType: string;
}

function send(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  asset: ViewerAsset,
  cacheControl: string,
): void {
  response.writeHead(status, {
    ...VIEWER_SECURITY_HEADERS,
    "cache-control": cacheControl,
    "content-type": asset.mediaType,
    "content-length": asset.bytes.byteLength,
  });
  response.end(request.method === "HEAD" ? undefined : asset.bytes);
}

function sendStaticError(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  message: string,
  allow?: string,
): void {
  const bytes = Buffer.from(`${message}\n`, "utf8");
  response.writeHead(status, {
    ...VIEWER_SECURITY_HEADERS,
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "content-length": bytes.byteLength,
    ...(allow === undefined ? {} : { allow }),
  });
  response.end(request.method === "HEAD" ? undefined : bytes);
}

export class ViewerAssets {
  private constructor(
    readonly directory: string,
    private readonly index: ViewerAsset,
    private readonly assets: ReadonlyMap<string, ViewerAsset>,
  ) {}

  static async load(directory: string): Promise<ViewerAssets> {
    const root = await realpath(directory);
    const indexBytes = await readFile(join(root, "index.html"));
    if (indexBytes.byteLength > MAXIMUM_INDEX_BYTES) {
      throw new RangeError("Viewer index exceeds the 1 MiB packaging limit.");
    }
    const assetDirectory = join(root, "assets");
    const entries = await readdir(assetDirectory, { withFileTypes: true });
    const assets = new Map<string, ViewerAsset>();
    let totalBytes = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !ASSET_NAME.test(entry.name)) {
        continue;
      }
      const bytes = await readFile(join(assetDirectory, entry.name));
      if (bytes.byteLength > MAXIMUM_ASSET_BYTES) {
        throw new RangeError(`Viewer asset ${entry.name} exceeds 5 MiB.`);
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAXIMUM_TOTAL_ASSET_BYTES) {
        throw new RangeError("Packaged viewer assets exceed 20 MiB.");
      }
      assets.set(`/assets/${entry.name}`, {
        bytes,
        mediaType: entry.name.endsWith(".css")
          ? "text/css; charset=utf-8"
          : "text/javascript; charset=utf-8",
      });
    }
    if (assets.size === 0) {
      throw new Error(`Viewer asset directory ${assetDirectory} is empty.`);
    }
    return new ViewerAssets(
      root,
      { bytes: indexBytes, mediaType: "text/html; charset=utf-8" },
      assets,
    );
  }

  handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): boolean {
    const isIndex = url.pathname === "/" || url.pathname === "/index.html";
    const isAsset = url.pathname.startsWith("/assets/");
    if (!isIndex && !isAsset) {
      return false;
    }
    request.resume();
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendStaticError(
        request,
        response,
        405,
        "Method not allowed.",
        "GET, HEAD",
      );
      return true;
    }
    if (isIndex) {
      send(request, response, 200, this.index, "no-store");
      return true;
    }
    const asset = this.assets.get(url.pathname);
    if (asset === undefined) {
      sendStaticError(request, response, 404, "Viewer asset not found.");
      return true;
    }
    send(request, response, 200, asset, "public, max-age=31536000, immutable");
    return true;
  }
}

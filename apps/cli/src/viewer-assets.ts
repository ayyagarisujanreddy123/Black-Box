import { fileURLToPath } from "node:url";

export function packagedViewerDirectory(): string {
  return fileURLToPath(new URL("./viewer/", import.meta.url));
}

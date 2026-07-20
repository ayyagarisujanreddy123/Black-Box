import { cp, rm } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

const source = fileURLToPath(new URL("../dist/public/", import.meta.url));
const target = fileURLToPath(
  new URL("../../cli/dist/viewer/", import.meta.url),
);

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true, force: true });

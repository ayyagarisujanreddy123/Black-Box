import { buildTarget } from "../src/config.js";

if (buildTarget !== "demo") {
  process.stderr.write(
    `Build target mismatch: expected 'demo', received '${buildTarget}'.\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Build target is valid.\n");
}

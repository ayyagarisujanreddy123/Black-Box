#!/usr/bin/env node

import { runCli } from "./index.js";

process.exitCode = runCli(process.argv.slice(2));

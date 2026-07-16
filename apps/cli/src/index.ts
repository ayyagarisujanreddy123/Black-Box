const HELP = `Black Box — the flight recorder for AI coding agents

Usage:
  blackbox --help

The repository foundation is installed. Recorder commands arrive in the next
milestones; no capture daemon is started by this skeleton.`;

export function runCli(arguments_: readonly string[]): number {
  const command = arguments_[0];

  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  process.stderr.write(
    `blackbox: command '${command}' is not implemented in milestone M0\n`,
  );
  return 1;
}

#!/usr/bin/env bun
import { parseArgs } from "./cli.js";
import { cmdDoctor } from "./commands/doctor.js";
import { cmdInit } from "./commands/init.js";
import { cmdSkills } from "./commands/skills.js";
import { cmdDown, cmdStatus, cmdUp } from "./commands/stack.js";
import { type CmdHandler, printHelp } from "./ui.js";

const handlers: Record<string, CmdHandler> = {
  up: cmdUp,
  down: cmdDown,
  status: cmdStatus,
  init: cmdInit,
  doctor: cmdDoctor,
  skills: cmdSkills,
};

const args = parseArgs(process.argv.slice(2));

if (!args.command || args.command === "help" || args.flags.help === true) {
  printHelp();
  process.exit(args.command && args.command !== "help" ? 1 : 0);
}

const handler = handlers[args.command];
if (!handler) {
  console.error(`comando desconhecido: ${args.command}\n`);
  printHelp();
  process.exit(1);
}

handler(args)
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });

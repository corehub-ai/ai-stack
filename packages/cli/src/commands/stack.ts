import type { ParsedArgs } from "../cli.js";
import {
  composeDownArgs,
  composePsArgs,
  composeUpArgs,
  runCompose,
  splitProfiles,
} from "../compose.js";
import { resolvePaths } from "../paths.js";

export async function cmdUp(args: ParsedArgs): Promise<number> {
  const paths = resolvePaths();
  const composeArgs = composeUpArgs(paths, {
    profiles: splitProfiles(args.flags.profile),
    build: args.flags["no-build"] !== true,
    detach: true,
  });
  return await runCompose(composeArgs);
}

export async function cmdDown(args: ParsedArgs): Promise<number> {
  const paths = resolvePaths();
  return await runCompose(composeDownArgs(paths, { volumes: args.flags.volumes === true }));
}

export async function cmdStatus(_args: ParsedArgs): Promise<number> {
  const paths = resolvePaths();
  return await runCompose(composePsArgs(paths));
}

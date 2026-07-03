import type { ParsedArgs } from "../cli.js";
import { notImplemented } from "../ui.js";

export async function cmdDoctor(_args: ParsedArgs): Promise<number> {
  return notImplemented("doctor");
}

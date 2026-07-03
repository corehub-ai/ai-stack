import type { ParsedArgs } from "../cli.js";
import { notImplemented } from "../ui.js";

export async function cmdUp(_args: ParsedArgs): Promise<number> {
  return notImplemented("up");
}

export async function cmdDown(_args: ParsedArgs): Promise<number> {
  return notImplemented("down");
}

export async function cmdStatus(_args: ParsedArgs): Promise<number> {
  return notImplemented("status");
}

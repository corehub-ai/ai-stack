import type { ParsedArgs } from "./cli.js";

export type CmdHandler = (args: ParsedArgs) => Promise<number>;

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export function say(label: string, status: "PASS" | "FAIL", detail = ""): void {
  const color = status === "PASS" ? GREEN : RED;
  const tail = detail ? ` ${DIM}${detail}${RESET}` : "";
  console.log(`${label.padEnd(48)} ${color}${status}${RESET}${tail}`);
}

export function notImplemented(name: string): number {
  console.error(`'${name}' ainda não implementado`);
  return 1;
}

export function printHelp(): void {
  console.log(`corehub — orquestra o ia-stack

uso: corehub <comando> [opções]

comandos:
  init                 gera deploy/compose/.env com segredos novos (não sobrescreve; use --force)
  up [--profile ui]    sobe o stack (docker compose up -d --build); use --no-build p/ pular o build
  down [--volumes]     derruba o stack (--volumes remove os volumes nomeados)
  status               docker compose ps dos serviços
  doctor               smoke-test da cadeia (health dos 3 hops + request ponta-a-ponta)
  skills sync          symlink das skills do repo em ~/.claude/skills e ~/.agents/skills

globais:
  --help               esta ajuda
  COREHUB_ROOT=<dir>   força a raiz do repositório (se não rodar de dentro dele)`);
}

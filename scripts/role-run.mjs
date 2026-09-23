#!/usr/bin/env node

import process from "node:process";
import { createCodexRoleRunCli } from "../adapters/codex/role-run.mjs";

const cli = createCodexRoleRunCli();
const [command, ...args] = process.argv.slice(2);

try {
  if (command === "start") console.log(cli.start(args));
  else if (command === "record") cli.record(args);
  else if (command === "recommend") console.log(JSON.stringify(cli.recommend(args), null, 2));
  else throw new Error("usage: role-run.mjs <start|record|recommend> [options]");
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}

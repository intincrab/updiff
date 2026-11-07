#!/usr/bin/env node
import { main } from './commands.ts';

const code = await main(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  color: process.stdout.isTTY === true && !process.env.NO_COLOR,
});
process.exitCode = code;

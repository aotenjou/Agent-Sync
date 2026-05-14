#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv).catch((error) => {
  console.error(`agent-sync: ${error.message}`);
  if (process.env.AGENT_SYNC_DEBUG) {
    console.error(error.stack);
  }
  process.exit(1);
});

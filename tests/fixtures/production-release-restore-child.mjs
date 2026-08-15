import { writeSync } from "node:fs";

import {
  parseReleaseConfig,
  restoreBackup,
} from "../../scripts/production-release/lib.mjs";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

const request = JSON.parse(input);
const config = parseReleaseConfig(request.config, {
  repositoryRoot: request.repositoryRoot,
  homeRoot: request.homeRoot,
});

function pause(marker) {
  writeSync(1, `${marker}\n`);
  const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(gate, 0, 0);
}

restoreBackup(request.repositoryRoot, config, request.backupRoot, {
  confirmReplace: request.confirmReplace,
  fromSha: request.fromSha,
  operationId: request.operationId,
  onInitialPreparation: request.pauseAt === "preparation"
    ? () => pause("PREPARATION_DURABLE")
    : null,
  onInitialTransaction: request.pauseAt === "preparation"
    ? null
    : () => pause("TRANSACTION_DURABLE"),
});

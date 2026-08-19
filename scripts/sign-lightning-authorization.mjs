#!/usr/bin/env node

import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { signLightningAuthorizationEnvelope } from "../lib/lightning-authorization-envelope.mjs";

const keyPath = process.env.COORDINATOR_PRIVATE_KEY_PATH;
if (!keyPath) throw new Error("COORDINATOR_PRIVATE_KEY_PATH is required");
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 262_144) throw new Error("authorization payload exceeds signer limit");
}
const payload = JSON.parse(input);
const privateKey = createPrivateKey(await readFile(keyPath));
process.stdout.write(`${JSON.stringify(signLightningAuthorizationEnvelope(payload, privateKey))}\n`);

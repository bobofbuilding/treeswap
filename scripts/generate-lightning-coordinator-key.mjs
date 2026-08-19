#!/usr/bin/env node

import { generateKeyPairSync } from "node:crypto";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [privateArgument, publicArgument] = process.argv.slice(2);
if (!privateArgument || !publicArgument) {
  throw new Error("private and public key paths are required");
}
const privatePath = resolve(privateArgument);
const publicPath = resolve(publicArgument);
const exists = async (path) => access(path).then(() => true, () => false);
const [privateExists, publicExists] = await Promise.all([exists(privatePath), exists(publicPath)]);
if (privateExists !== publicExists) throw new Error("coordinator keypair is incomplete; inspect it before recovery");
if (!privateExists) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await Promise.all([mkdir(dirname(privatePath), { recursive: true }), mkdir(dirname(publicPath), { recursive: true })]);
  await writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
  await writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }), { flag: "wx", mode: 0o644 });
}
await Promise.all([chmod(privatePath, 0o600), chmod(publicPath, 0o644)]);

import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request } from "node:https";
import { checkServerIdentity } from "node:tls";

const certificate = await readFile(process.env.TLS_CERTIFICATE_PATH, "utf8");
const expectedFingerprint = new X509Certificate(certificate).fingerprint256;

await new Promise((resolve, reject) => {
  const probe = request({
    hostname: "127.0.0.1",
    port: Number(process.env.PORT),
    servername: new URL(process.env.PROVIDER_ORIGIN).hostname,
    path: "/healthz",
    method: "GET",
    agent: false,
    rejectUnauthorized: true,
    ca: certificate,
    checkServerIdentity: (servername, peer) => {
      const hostnameError = checkServerIdentity(servername, peer);
      if (hostnameError) return hostnameError;
      return new X509Certificate(peer.raw).fingerprint256 === expectedFingerprint
        ? undefined : new Error("invoice-material health peer changed");
    },
  }, (response) => {
    let received = 0;
    response.on("data", (chunk) => {
      received += chunk.length;
      if (received > 1_024) probe.destroy(new Error("invoice-material health body is too large"));
    });
    response.on("end", () => {
      if (response.statusCode === 200) resolve();
      else reject(new Error("invoice-material health status is not ready"));
    });
  });
  probe.setTimeout(1_500, () => probe.destroy(new Error("invoice-material health timed out")));
  probe.on("error", reject);
  probe.end();
});

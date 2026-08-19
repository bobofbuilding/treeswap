let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 262_144) throw new Error("adapter request exceeds client limit");
}
const response = await fetch("http://127.0.0.1:3000/v1/action", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: input,
});
const body = await response.text();
process.stdout.write(body);
if (!response.ok) process.exitCode = 1;

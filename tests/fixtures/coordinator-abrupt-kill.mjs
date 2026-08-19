import { DatabaseSync } from "node:sqlite";

const path = process.argv[2];
if (!path) throw new Error("coordinator database path is required");

const database = new DatabaseSync(path, {
  enableForeignKeyConstraints: true,
  timeout: 5_000,
});
database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
database.exec("BEGIN IMMEDIATE");
database.prepare("INSERT INTO coordinator_meta(key, value) VALUES ('crash_committed_probe', 'committed')").run();
database.exec("COMMIT");
database.exec("BEGIN IMMEDIATE");
database.prepare("INSERT INTO coordinator_meta(key, value) VALUES ('crash_uncommitted_probe', 'uncommitted')").run();
process.stdout.write("READY\n");
setInterval(() => {}, 60_000);

import { copyFileSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const own = fileURLToPath(new URL(".", import.meta.url)),
  density = fileURLToPath(new URL("../density/", import.meta.url)),
  out = process.env.DENSITY_OUTPUT;
if (!out) throw Error("Explicit profile output required");
mkdirSync(out, { recursive: true });
for (const name of readdirSync(density)) copyFileSync(join(density, name), join(out, name));
for (const name of ["profile-requests.mjs", "db-telemetry.mjs", "pool-config.py"])
  copyFileSync(join(own, name), join(out, name));
const replace = (text, before, after) => {
  if (text.split(before).length !== 2) throw Error("Frozen diagnostic fixture anchor changed");
  return text.replace(before, after);
};
let driver = readFileSync(join(out, "run-density.mjs"), "utf8");
driver = replace(
  driver,
  'import { measurePhase } from "./phase.mjs";',
  'import { measurePhase } from "./phase.mjs";\nimport { runSingleRequests } from "./profile-requests.mjs";',
);
driver = replace(
  driver,
  '    dependencyImages["postgres:17.7-alpine"].imageId,\n  ]);',
  '    dependencyImages["postgres:17.7-alpine"].imageId,\n    "postgres","-c","shared_preload_libraries=pg_stat_statements","-c","track_io_timing=on","-c","log_statement=all","-c","log_min_duration_statement=0","-c","log_parameter_max_length=0","-c","log_parameter_max_length_on_error=0","-c","logging_collector=on","-c","log_destination=csvlog","-c","log_directory=/tmp/profile-logs","-c","log_filename=profile.csv","-c","log_rotation_age=0","-c","log_rotation_size=0",\n  ]);',
);
driver = replace(
  driver,
  "  const mock = container([",
  '  run(["exec",db,"psql","-X","-U","fixture_admin","-d","basalt_pool","-v","ON_ERROR_STOP=1","-c","CREATE EXTENSION pg_stat_statements"]);\n  const mock = container([',
);
const begin = driver.indexOf("    if (functional) {");
const end = driver.indexOf('  save("complete.json",', begin);
if (begin < 0 || end < 0) throw Error("Diagnostic operation block missing");
driver =
  driver.slice(0, begin) +
  `    await runSingleRequests({out,ports,json,attempt,databaseContainer:db});
    run(["cp",pool+":/tmp/sql-profile.ndjson",join(out,"home-sql.ndjson")]);
    run(["cp",pool+":/fixture/sql-instrumentation.json",join(out,"sql-instrumentation.json")]);
    run(["cp",pool+":/fixture/home-source",join(out,"home-source")]);
    run(["cp",db+":/tmp/profile-logs",join(out,"postgres-logs")]);
  }
` +
  driver.slice(end);
// Preserve first failure traces before teardown, including failures before profile completion.
driver = replace(
  driver,
  '  for (const observer of observers) observer.kill("SIGTERM");',
  '  if(pool)try{run(["cp",pool+":/tmp/sql-profile.ndjson",join(out,"home-sql.ndjson")]);}catch{}\n  for (const observer of observers) observer.kill("SIGTERM");',
);
writeFileSync(join(out, "run-density.mjs"), driver);
let setup = readFileSync(join(out, "profile.mjs"), "utf8");
setup = replace(
  setup,
  "    image,\n  ]);",
  '    "--mount",`type=bind,source=${root}/pool-config.py,target=/fixture-pool-config.py,readonly`,\n    "--env","DENSITY_DB_POOL_SIZE=6","--env","DENSITY_SQL_TRACE=1",\n    "--entrypoint","python3",image,"/fixture-pool-config.py",\n  ]);',
);
writeFileSync(join(out, "profile.mjs"), setup);
const profiles = JSON.parse(readFileSync(join(out, "profiles.json"), "utf8"));
profiles.profiles = profiles.profiles.filter((row) => row.name === "standard-2");
profiles.scope =
  "Single-request diagnostic SQL profile. Instrumented database/sql binary and idle controls; no capacity inference.";
writeFileSync(join(out, "profiles.json"), JSON.stringify(profiles, null, 2) + "\n");
const sha = (data) => createHash("sha256").update(data).digest("hex");
const files = Object.fromEntries(
  readdirSync(out)
    .filter((name) => /\.(mjs|py|json)$/.test(name))
    .map((name) => [name, sha(readFileSync(join(out, name)))]),
);
writeFileSync(
  join(out, "study-fingerprints.json"),
  JSON.stringify(
    {
      frozenAtUtc: new Date().toISOString(),
      head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      runtimeSource: "53d3a3730859fd2b46f435cdaaa6ffedaf73400b",
      image: readFileSync(join(out, "image.id"), "utf8").trim(),
      diagnosticOnly: true,
      files,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({ frozen: true, mode: "diagnostic-profile", files: Object.keys(files).length }),
);

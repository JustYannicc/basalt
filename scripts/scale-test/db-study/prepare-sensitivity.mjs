import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const own = fileURLToPath(new URL(".", import.meta.url)),
  density = fileURLToPath(new URL("../density/", import.meta.url));
const out = process.env.DENSITY_OUTPUT,
  size = Number(process.env.DENSITY_DB_POOL_SIZE),
  profile = process.env.DENSITY_PROFILE;
if (!out || ![6, 12, 24].includes(size) || !["standard-1", "standard-2"].includes(profile))
  throw Error("Unrecognized database sensitivity inputs");
mkdirSync(out, { recursive: true });
for (const name of readdirSync(density)) copyFileSync(join(density, name), join(out, name));
for (const name of ["pool-config.py", "db-observe.mjs", "db-telemetry.mjs"])
  copyFileSync(join(own, name), join(out, name));
const replace = (text, before, after) => {
  if (text.split(before).length !== 2)
    throw Error("Frozen fixture anchor changed: " + before.slice(0, 80));
  return text.replace(before, after);
};
let driver = readFileSync(join(out, "run-density.mjs"), "utf8");
driver = replace(
  driver,
  'import { measurePhase } from "./phase.mjs";',
  'import { measurePhase } from "./phase.mjs";\nimport { databaseSnapshot,startDatabaseObserver,statementDeltas } from "./db-telemetry.mjs";',
);
driver = replace(driver, "let pool,", "let databaseContainer;\nlet pool,");
driver = replace(
  driver,
  "  const result = await measurePhase(",
  "  const dbBefore=databaseSnapshot(databaseContainer);\n  const result = await measurePhase(",
);
driver = replace(
  driver,
  "  results.push(result);",
  '  const dbAfter=databaseSnapshot(databaseContainer);\n  save(result.name+"-postgres.json",{before:dbBefore,after:dbAfter,statements:statementDeltas(dbBefore,dbAfter)});\n  results.push(result);',
);
driver = replace(driver, "  const db = container([", "  const db = container([");
// Configure monitoring before Home starts; every sensitivity arm uses the same PostgreSQL inputs.
driver = replace(
  driver,
  '    dependencyImages["postgres:17.7-alpine"].imageId,\n  ]);',
  '    dependencyImages["postgres:17.7-alpine"].imageId,\n    "postgres","-c","shared_preload_libraries=pg_stat_statements","-c","track_io_timing=on","-c","max_connections=100",\n  ]);\n  databaseContainer=db;',
);
driver = replace(
  driver,
  "  const mock = container([",
  '  run(["exec",db,"psql","-X","-U","fixture_admin","-d","basalt_pool","-v","ON_ERROR_STOP=1","-c","CREATE EXTENSION pg_stat_statements"]);\n  startDatabaseObserver(root,out,db,observers);\n  const mock = container([',
);
writeFileSync(join(out, "run-density.mjs"), driver);
let setup = readFileSync(join(out, "profile.mjs"), "utf8");
setup = replace(
  setup,
  "    image,\n  ]);",
  '    "--mount",`type=bind,source=${root}/pool-config.py,target=/fixture-pool-config.py,readonly`,\n    "--env","DENSITY_DB_POOL_SIZE=' +
    size +
    '",\n    "--entrypoint","python3",\n    image,"/fixture-pool-config.py",\n  ]);',
);
setup = replace(
  setup,
  '  save(profile.name + "-capabilities.json", caps);',
  "  if(caps.server_info.database_pool.max_open_connections!==" +
    size +
    ')throw Error("Actual Home DB pool cap differs from sensitivity arm");\n  save(profile.name + "-capabilities.json", caps);',
);
writeFileSync(join(out, "profile.mjs"), setup);
const profiles = JSON.parse(readFileSync(join(out, "profiles.json"), "utf8"));
profiles.profiles = profiles.profiles.filter((row) => row.name === profile);
profiles.scope +=
  " Database sensitivity only: configured max-open/max-idle " +
  size +
  "; private PG17.7 with pg_stat_statements; no production database.";
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
      size,
      profile,
      image: readFileSync(join(out, "image.id"), "utf8").trim(),
      files,
      parameters: {
        levels: profiles.levels,
        workloads: profiles.workloads,
        profiles: profiles.profiles,
      },
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({ frozen: true, poolSize: size, profile, files: Object.keys(files).length }),
);

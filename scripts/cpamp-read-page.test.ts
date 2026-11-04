import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("source reader freezes keyset ranges, hashes private refs and detects changes on a second pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "basalt-cpamp-source-"));
  const database = join(dir, "source.sqlite");
  const python = (script: string) => {
    const result = spawnSync("python3", ["-", database], { input: script, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    python(`import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE usage_events(id INTEGER PRIMARY KEY,event_hash TEXT,timestamp TEXT,provider TEXT,model TEXT,endpoint TEXT,service_tier TEXT,request_id TEXT,auth_index TEXT,api_key_hash TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_creation_tokens INTEGER,reasoning_tokens INTEGER,total_tokens INTEGER,latency_ms INTEGER,failed INTEGER,fail_status_code INTEGER,generate INTEGER,raw_json TEXT)')
for n in range(1,202):
 c.execute('INSERT INTO usage_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(n,format(n,'064x'),'2026-05-05T11:32:18.619000001Z','fixture','fixture','/v1/responses',None,'private-request','private-account','private-key',100,10,None,0,3,110,200,0,0,1,'private-payload'))
c.commit()
c.close()
`);
    const read = (extra: string[] = []) => {
      const result = spawnSync(
        "python3",
        [
          "scripts/cpamp-read-page.py",
          "--database",
          database,
          "--source",
          "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          "--upper",
          "201",
          "--after",
          "0",
          ...extra,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /private-/);
      return JSON.parse(result.stdout);
    };
    const first = read();
    assert.equal(first.rows.length, 200);
    assert.equal(first.end, "200");
    assert.equal(first.more, true);
    assert.equal(first.rows[0].status_code, null);
    assert.equal(first.rows[0].cache_read_tokens, null);
    assert.equal(read(["--end", "200"]).checksum, first.checksum);
    python(
      "import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.execute('INSERT INTO usage_events(id) VALUES(202)')\nc.commit()\nc.close()\n",
    );
    assert.equal(read(["--end", "200"]).checksum, first.checksum);
    python(
      "import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.execute('UPDATE usage_events SET input_tokens=101 WHERE id=1')\nc.commit()\nc.close()\n",
    );
    assert.notEqual(read(["--end", "200"]).checksum, first.checksum);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

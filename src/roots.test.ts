import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertAllowedPath, expandHomePath, resolveAllowedPath } from "./roots.js";

const home = homedir();

assert.equal(expandHomePath("~"), home);
assert.equal(expandHomePath("~/personal/mcpishcode"), resolve(home, "personal", "mcpishcode"));
assert.equal(expandHomePath("~user/project"), "~user/project");
assert.equal(expandHomePath("$HOME/project"), "$HOME/project");

assert.equal(
  assertAllowedPath("~/personal/mcpishcode", [join(home, "personal")]),
  resolve(home, "personal", "mcpishcode"),
);

assert.equal(
  assertAllowedPath("~/personal/mcpishcode", ["~/personal"]),
  resolve(home, "personal", "mcpishcode"),
);

assert.equal(
  resolveAllowedPath("~/file.txt", "/workspace", ["/workspace"]),
  resolve("/workspace", "~/file.txt"),
);

if (process.platform === "win32") {
  assert.throws(
    () => assertAllowedPath("C:\\Users\\Administrator", ["G:\\Projects\\Dev\\Github\\mcpishcode"]),
    /Path is outside allowed roots/,
  );
}

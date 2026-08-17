// node test.mjs — asserts the pure logic in public/lib.js. No framework.
import assert from "node:assert/strict";
import {
  authHash, parseRepo, bucketPr, median, repoStats, prSearchQuery, relTime,
} from "./public/lib.js";

// Must match what locator_spy/speed100 send, or logins won't be portable.
assert.equal(
  await authHash("Foo@Bar.com", "pw"),
  await authHash("foo@bar.com", "pw"),
  "email must be lowercased before hashing",
);
assert.match(await authHash("a@b.c", "pw"), /^[0-9a-f]{64}$/);

assert.deepEqual(parseRepo(" browserstack/accessibility "), {
  owner: "browserstack", name: "accessibility", full: "browserstack/accessibility",
});
assert.equal(parseRepo("https://github.com/foo/bar.git").full, "foo/bar");
assert.equal(parseRepo("not-a-repo"), null);
assert.equal(parseRepo("a/b/c"), null);
assert.equal(parseRepo('<img src=x onerror=alert(1)>/x'), null, "must reject injection");

// search/issues collapses merged and closed-unmerged into state:"closed".
assert.equal(bucketPr({ state: "open", pull_request: {} }), "open");
assert.equal(bucketPr({ state: "closed", pull_request: { merged_at: "2026-01-01T00:00:00Z" } }), "merged");
assert.equal(bucketPr({ state: "closed", pull_request: { merged_at: null } }), "closed");

assert.equal(median([]), null);
assert.equal(median([3, 1, 2]), 2);
assert.equal(median([4, 1, 3, 2]), 2.5, "even count averages the middle pair");
assert.equal(median([10, 2, 1]), 2, "must sort numerically, not lexically");

const now = Date.parse("2026-01-11T00:00:00Z");
const s = repoStats([
  { state: "open", created_at: "2026-01-01T00:00:00Z", draft: true, pull_request: {} },
  { state: "open", created_at: "2026-01-09T00:00:00Z", pull_request: {} },
  { state: "closed", created_at: "2026-01-01T00:00:00Z", pull_request: { merged_at: "2026-01-01T02:00:00Z" } },
  { state: "closed", created_at: "2026-01-01T00:00:00Z", pull_request: { merged_at: "2026-01-01T06:00:00Z" } },
  { state: "closed", created_at: "2026-01-01T00:00:00Z", pull_request: { merged_at: null } },
], now);
assert.deepEqual(s, {
  total: 5, open: 2, merged: 2, closed: 1, draft: 1,
  medianMergeHours: 4, oldestOpenDays: 10,
});
assert.equal(repoStats([], now).medianMergeHours, null, "no merges => no median, not 0");

assert.equal(prSearchQuery("me", "o/r"), "is:pr author:me repo:o/r");
assert.equal(prSearchQuery("me", "o/r", "closed"), "is:pr author:me repo:o/r is:closed is:unmerged",
  "closed filter must exclude merged, else it double-counts");

assert.equal(relTime("2026-01-10T22:00:00Z", now), "2h ago");
assert.equal(relTime("2026-01-01T00:00:00Z", now), "10d ago");

console.log("ok");

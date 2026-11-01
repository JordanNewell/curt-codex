/**
 * Regenerate demos/synthetic-rollout from the synthetic fixtures, then run:
 *
 *   node dist/cli.js demos/synthetic-rollout -o demos/synthetic-flow
 *   node dist/cli.js --emit-rollout demos/synthetic-flow -o demos/synthetic-rollout-emit
 *
 * and delete demos/synthetic-rollout-emit (round-trip output; regenerable).
 * All content is synthetic — see test/fixtures.ts.
 */

import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildFixtureTree } from "./fixtures.ts";

const target = join(import.meta.dirname, "..", "demos", "synthetic-rollout");
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
buildFixtureTree(target);
console.log(`wrote ${target}`);

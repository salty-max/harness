// What the tests share (never vendored): a project root shaped like the
// WoW family's, so the assertions the family's tools always had keep holding
// under a harness.toml.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FAMILY_TOML = `[project]
name = "family"
term = "family"

[state]
board = "board"
cache = ".cache/harness"

[tools]
dir = "addon-kit"

[extensions]
packet = "addon-kit/packet-extras.ts"

[review]
waive = ['(^|/)(README|CLAUDE|CURSEFORGE)\\.md$', '^docs/', '\\.toc$']

[review.copies]
patterns = ['^addon/[^/]+/(Kit\\.lua|Media/)|(^|/)wowmock\\.lua$|^scripts/(root\\.(ts|py)|locales-lib\\.ts|package-lib\\.ts)$|^i18n/kit/|^(wow\\.yml|stylua\\.toml)$']
except = ["addon-kit"]
`;

export const DUMMY_PACKET_EXTENSION = `export function extras(c) {
  return { lines: ["", "## Extra", "files: " + c.files.join(",")], count: c.files.length };
}
`;

/** harness.toml of a family-shaped root, and addon-kit/ beside where its extension lives. */
export function writeFamilyConfig(root: string) {
  mkdirSync(join(root, "addon-kit"), { recursive: true });
  writeFileSync(join(root, "harness.toml"), FAMILY_TOML);
  writeFileSync(join(root, "addon-kit", "packet-extras.ts"), DUMMY_PACKET_EXTENSION);
}

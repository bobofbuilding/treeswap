const COMMIT = /^[0-9a-f]{40}$/;
const MAIN_REFERENCE = /^([0-9a-f]{40})[\t ]+refs\/heads\/main$/;
const CANONICAL_ORIGIN = /^https:\/\/github\.com\/bobofbuilding\/treeswap(?:\.git)?$/;

export const TREESWAP_CANONICAL_ORIGIN = "https://github.com/bobofbuilding/treeswap.git";

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

export function assertTreeSwapCanonicalOrigin(value) {
  if (!CANONICAL_ORIGIN.test(String(value ?? ""))) {
    throw new Error("source provenance requires the canonical TreeSwap HTTPS origin");
  }
  return TREESWAP_CANONICAL_ORIGIN;
}

export function parsePublishedMainReference(value) {
  const match = MAIN_REFERENCE.exec(String(value ?? ""));
  if (!match) throw new Error("source provenance requires one exact remote main reference");
  return match[1];
}

export function validatePublishedMainSource(input) {
  exactKeys(input, ["branch", "head", "originUrl", "published", "status"], "published source provenance");
  const head = String(input.head ?? "");
  const published = String(input.published ?? "");
  assertTreeSwapCanonicalOrigin(input.originUrl);
  if (String(input.status ?? "") !== "" || input.branch !== "main"
      || !COMMIT.test(head) || !COMMIT.test(published) || head !== published) {
    throw new Error("source provenance requires the exact clean commit currently published on remote main");
  }
  return head;
}

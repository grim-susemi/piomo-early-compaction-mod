import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import {
  anchorMatches,
  createWarmAnchorSnapshot,
  fingerprint,
  type AnchorEntry,
  type WarmAnchorSnapshot,
} from "../src/anchor";

// Tests may import the internal reference implementation; src/ must not.
const REFERENCE_PATH =
  "C:/Users/USER/.bun/install/global/node_modules/@code-yeongyu/senpi/dist/core/compaction/warm-anchor.js";

interface ReferenceModule {
  createWarmAnchorSnapshot(
    firstKeptEntryId: string,
    branchEntries: readonly AnchorEntry[],
  ): WarmAnchorSnapshot | undefined;
  isWarmSummaryAnchorValid(
    snapshot: WarmAnchorSnapshot,
    currentBranchEntries: readonly AnchorEntry[],
  ): boolean;
}

const reference = (await import(pathToFileURL(REFERENCE_PATH).href)) as ReferenceModule;

type FixtureEntry = AnchorEntry & Record<string, unknown>;

function entry(id: string, type: string, content: Record<string, unknown> = {}): FixtureEntry {
  return { id, type, ...content };
}

interface Fixture {
  name: string;
  branch: FixtureEntry[];
  firstKeptEntryId: string;
}

const FIXTURES: Fixture[] = [
  {
    name: "linear branch, cut in the middle",
    firstKeptEntryId: "e3",
    branch: [
      entry("e0", "message", { role: "user", text: "a" }),
      entry("e1", "message", { role: "assistant", text: "b" }),
      entry("e2", "message", { role: "user", text: "c" }),
      entry("e3", "message", { role: "assistant", text: "d" }),
      entry("e4", "message", { role: "user", text: "e" }),
    ],
  },
  {
    name: "empty prefix, cut is the first entry",
    firstKeptEntryId: "m0",
    branch: [
      entry("m0", "message", { role: "user", text: "first" }),
      entry("m1", "message", { role: "assistant", text: "second" }),
    ],
  },
  {
    name: "cut is the last entry",
    firstKeptEntryId: "m2",
    branch: [
      entry("m0", "message", { role: "user", text: "one" }),
      entry("m1", "message", { role: "assistant", text: "two" }),
      entry("m2", "message", { role: "user", text: "three" }),
    ],
  },
  {
    name: "compaction entry before the cut",
    firstKeptEntryId: "keep",
    branch: [
      entry("c0", "compaction", { summary: "earlier summary" }),
      entry("m0", "message", { role: "user", text: "one" }),
      entry("m1", "message", { role: "assistant", text: "two" }),
      entry("keep", "message", { role: "user", text: "kept" }),
      entry("tail", "message", { role: "assistant", text: "tail" }),
    ],
  },
  {
    name: "compaction entry after the cut",
    firstKeptEntryId: "keep",
    branch: [
      entry("m0", "message", { role: "user", text: "one" }),
      entry("m1", "message", { role: "assistant", text: "two" }),
      entry("keep", "message", { role: "user", text: "kept" }),
      entry("tail", "custom", { customType: "idle-wait" }),
      entry("c1", "compaction", { summary: "later summary" }),
    ],
  },
];

function prefixOf(branch: readonly FixtureEntry[], firstKeptEntryId: string): FixtureEntry[] {
  const index = branch.findIndex((item) => item.id === firstKeptEntryId);
  if (index < 0) throw new Error(`fixture is missing ${firstKeptEntryId}`);
  return branch.slice(0, index);
}

describe("createWarmAnchorSnapshot port", () => {
  for (const fixture of FIXTURES) {
    test(`deep-equals the reference: ${fixture.name}`, () => {
      const ported = createWarmAnchorSnapshot(fixture.firstKeptEntryId, fixture.branch);
      const expected = reference.createWarmAnchorSnapshot(fixture.firstKeptEntryId, fixture.branch);
      expect(ported).toEqual(expected);
      expect(ported).toBeDefined();
      expect(reference.isWarmSummaryAnchorValid(ported!, fixture.branch)).toBe(true);
      expect(anchorMatches(ported, fixture.branch)).toBe(true);
    });
  }

  test("missing firstKeptEntryId returns undefined and never matches", () => {
    const branch = FIXTURES[0]!.branch;
    expect(createWarmAnchorSnapshot("does-not-exist", branch)).toBeUndefined();
    expect(reference.createWarmAnchorSnapshot("does-not-exist", branch)).toBeUndefined();
    expect(anchorMatches(undefined, branch)).toBe(false);
  });

  test("empty prefix is a valid anchor", () => {
    const branch = FIXTURES[1]!.branch;
    const snapshot = createWarmAnchorSnapshot(branch[0]!.id, branch);
    expect(snapshot).toEqual({
      firstKeptEntryId: "m0",
      prefixEntryIds: [],
      latestCompactionEntryId: null,
    });
    expect(reference.isWarmSummaryAnchorValid(snapshot!, branch)).toBe(true);
    expect(anchorMatches(snapshot, branch)).toBe(true);
    expect(fingerprint(undefined, snapshot!.prefixEntryIds)).toBe(fingerprint(undefined, []));
  });
});

describe("warm anchor validity under growth", () => {
  test("appends after the cut keep the ported anchor valid", () => {
    const fixture = FIXTURES[0]!;
    const snapshot = createWarmAnchorSnapshot(fixture.firstKeptEntryId, fixture.branch);
    const grown = [
      ...fixture.branch,
      entry("z1", "message", { role: "user", text: "next prompt" }),
      entry("z2", "custom", { customType: "monitor-state" }),
    ];

    expect(reference.isWarmSummaryAnchorValid(snapshot!, grown)).toBe(true);
    expect(anchorMatches(snapshot, grown)).toBe(true);
    expect(createWarmAnchorSnapshot(fixture.firstKeptEntryId, grown)).toEqual(snapshot);

    // Appends are outside the summarized prefix, so the fingerprint is unchanged.
    expect(fingerprint(undefined, prefixOf(grown, fixture.firstKeptEntryId))).toBe(
      fingerprint(undefined, prefixOf(fixture.branch, fixture.firstKeptEntryId)),
    );
  });

  test("an id edit before the cut invalidates the anchor and changes the fingerprint", () => {
    const fixture = FIXTURES[0]!;
    const snapshot = createWarmAnchorSnapshot(fixture.firstKeptEntryId, fixture.branch);
    const edited = fixture.branch.map((item) =>
      item.id === "e1" ? { ...item, id: "e1-renamed" } : item,
    );

    expect(reference.isWarmSummaryAnchorValid(snapshot!, edited)).toBe(false);
    expect(anchorMatches(snapshot, edited)).toBe(false);
    expect(fingerprint(undefined, prefixOf(edited, fixture.firstKeptEntryId))).not.toBe(
      fingerprint(undefined, prefixOf(fixture.branch, fixture.firstKeptEntryId)),
    );
  });

  test("a content edit before the cut keeps ids valid but changes the fingerprint", () => {
    const fixture = FIXTURES[0]!;
    const snapshot = createWarmAnchorSnapshot(fixture.firstKeptEntryId, fixture.branch);
    const edited = fixture.branch.map((item) =>
      item.id === "e1" ? { ...item, text: "rewritten by context_edit" } : item,
    );

    // ID-based validity cannot see a content rewrite, which is why the
    // fingerprint exists: the apply path discards on a mismatch.
    expect(reference.isWarmSummaryAnchorValid(snapshot!, edited)).toBe(true);
    expect(anchorMatches(snapshot, edited)).toBe(true);
    expect(fingerprint(undefined, prefixOf(edited, fixture.firstKeptEntryId))).not.toBe(
      fingerprint(undefined, prefixOf(fixture.branch, fixture.firstKeptEntryId)),
    );
  });
});

describe("compaction boundaries", () => {
  const base = [
    entry("m0", "message", { role: "user", text: "one" }),
    entry("m1", "message", { role: "assistant", text: "two" }),
    entry("keep", "message", { role: "user", text: "kept" }),
    entry("tail", "message", { role: "assistant", text: "tail" }),
  ];

  test("a compaction after the cut changes latestCompactionEntryId and invalidates", () => {
    const snapshot = createWarmAnchorSnapshot("keep", base)!;
    const appended = [...base, entry("c-after", "compaction", { summary: "later" })];
    const next = createWarmAnchorSnapshot("keep", appended)!;

    expect(snapshot.latestCompactionEntryId).toBeNull();
    expect(next.latestCompactionEntryId).toBe("c-after");
    expect(reference.isWarmSummaryAnchorValid(snapshot, appended)).toBe(false);
    expect(anchorMatches(snapshot, appended)).toBe(false);
    // The boundary is after the cut, so the summarized prefix is unchanged.
    expect(fingerprint("previous", prefixOf(appended, "keep"))).toBe(
      fingerprint("previous", prefixOf(base, "keep")),
    );
  });

  test("a compaction inside the summarized prefix changes the fingerprint", () => {
    const withCompaction = [entry("c-prefix", "compaction", { summary: "inline" }), ...base];
    const snapshot = createWarmAnchorSnapshot("keep", withCompaction)!;

    expect(snapshot.latestCompactionEntryId).toBe("c-prefix");
    expect(fingerprint("previous", prefixOf(withCompaction, "keep"))).not.toBe(
      fingerprint("previous", prefixOf(base, "keep")),
    );
  });
});

describe("fingerprint", () => {
  test("is a stable sha256 hex over the previous summary and canonical prefix", () => {
    const left = [
      entry("e1", "message", { role: "user", text: "x", meta: { b: 2, a: 1 } }),
      entry("e2", "message", { role: "assistant", text: "y" }),
    ];
    const sameDifferentKeyOrder = [
      { meta: { a: 1, b: 2 }, text: "x", role: "user", type: "message", id: "e1" },
      { type: "message", id: "e2", text: "y", role: "assistant" },
    ];

    expect(fingerprint("previous summary", left)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint("previous summary", left)).toBe(
      fingerprint("previous summary", sameDifferentKeyOrder),
    );
    expect(fingerprint("previous summary", left)).toBe(fingerprint("previous summary", left));
  });

  test("distinguishes summary text, absent summary, and array order", () => {
    const left = [
      entry("e1", "message", { text: "x" }),
      entry("e2", "message", { text: "y" }),
    ];
    const reversed = [...left].reverse();

    expect(fingerprint(undefined, left)).not.toBe(fingerprint("", left));
    expect(fingerprint("one", left)).not.toBe(fingerprint("two", left));
    expect(fingerprint("previous", left)).not.toBe(fingerprint("previous", reversed));
  });

  test("hashes a UTF-8 length-prefixed summary including non-ASCII text", () => {
    const prefix = [entry("e1", "message", { text: "summary covered this" })];
    const plain = fingerprint("hello", prefix);
    const unicode = fingerprint("안녕하세요", prefix);

    expect(plain).toMatch(/^[0-9a-f]{64}$/);
    expect(unicode).toMatch(/^[0-9a-f]{64}$/);
    expect(unicode).not.toBe(plain);
  });
});

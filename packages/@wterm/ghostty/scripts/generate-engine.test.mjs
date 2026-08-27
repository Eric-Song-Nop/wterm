import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseGhosttyDependency } from "./generate-engine.mjs";

const COMMIT = "fe317f850c3ab212f6638122c459b9b48b99a016";
const PACKAGE_HASH =
  "ghostty-1.3.2-dev-5UdBCxyDUwWzvNOIPY-t4kzXgd0NAKxYPkpDkW_d0pwd";
const FORK_URL = `https://github.com/Eric-Song-Nop/ghostty/archive/${COMMIT}.tar.gz`;

function ghosttyDependency(url = FORK_URL, extra = "") {
  return `.ghostty = .{
    .url = ${JSON.stringify(url)},
    .hash = ${JSON.stringify(PACKAGE_HASH)},
    ${extra}
  },`;
}

function zon(dependencies) {
  return `.{
    .minimum_zig_version = "0.16.0",
    .dependencies = .{
      ${dependencies}
    },
  }`;
}

describe("parseGhosttyDependency", () => {
  it("parses the current dependency declaration", async () => {
    const source = await readFile(
      new URL("../zig/build.zig.zon", import.meta.url),
      "utf8",
    );

    expect(parseGhosttyDependency(source)).toEqual({
      ghosttyCommit: COMMIT,
      ghosttyPackageHash: PACKAGE_HASH,
      ghosttyRepository: "Eric-Song-Nop/ghostty",
      zigVersion: "0.16.0",
    });
  });

  it("rejects the upstream repository", () => {
    const upstream = FORK_URL.replace("Eric-Song-Nop", "ghostty-org");
    expect(() =>
      parseGhosttyDependency(zon(ghosttyDependency(upstream))),
    ).toThrow(/Eric-Song-Nop\/ghostty/);
  });

  it.each([
    ["HTTP", FORK_URL.replace("https://", "http://")],
    ["credentials", FORK_URL.replace("github.com", "user@github.com")],
    ["port", FORK_URL.replace("github.com", "github.com:443")],
    [
      "lookalike host",
      FORK_URL.replace("github.com", "github.com.example.invalid"),
    ],
    [
      "GitHub-shaped path on a malicious host",
      FORK_URL.replace(
        "https://github.com",
        "https://example.invalid/github.com",
      ),
    ],
    ["query", `${FORK_URL}?download=1`],
    ["hash", `${FORK_URL}#archive`],
    ["extra path", `${FORK_URL}/example.invalid`],
  ])("rejects a non-canonical %s URL", (_label, url) => {
    expect(() => parseGhosttyDependency(zon(ghosttyDependency(url)))).toThrow(
      /Ghostty dependency URL/,
    );
  });

  it("ignores a valid URL hidden in a comment", () => {
    const lure = ghosttyDependency(FORK_URL)
      .split("\n")
      .map((line) => `// ${line}`)
      .join("\n");
    const upstream = FORK_URL.replace("Eric-Song-Nop", "ghostty-org");
    expect(() =>
      parseGhosttyDependency(zon(`${lure}\n${ghosttyDependency(upstream)}`)),
    ).toThrow(/Eric-Song-Nop\/ghostty/);
  });

  it("rejects duplicate .ghostty dependencies", () => {
    expect(() =>
      parseGhosttyDependency(
        zon(`${ghosttyDependency()}\n${ghosttyDependency()}`),
      ),
    ).toThrow(/exactly one \.ghostty/);
  });

  it("rejects duplicate .url fields", () => {
    expect(() =>
      parseGhosttyDependency(
        zon(ghosttyDependency(FORK_URL, `.url = ${JSON.stringify(FORK_URL)},`)),
      ),
    ).toThrow(/exactly one \.url/);
  });
});

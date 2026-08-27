import { describe, expect, it } from "vitest";
import { GHOSTTY_ENGINE_PROVENANCE } from "../engine.js";

const GHOSTTY_FORK_REPOSITORY = "Eric-Song-Nop/ghostty";

describe("generated engine provenance", () => {
  it("publishes only the reviewed fork patch identity", () => {
    expect(GHOSTTY_ENGINE_PROVENANCE.ghosttyRepository).toBe(
      GHOSTTY_FORK_REPOSITORY,
    );
    expect(GHOSTTY_ENGINE_PROVENANCE.patches).toEqual([
      {
        baseCommit: GHOSTTY_ENGINE_PROVENANCE.ghosttyUpstreamBaseCommit,
        commit: GHOSTTY_ENGINE_PROVENANCE.ghosttyCommit,
        id: "ansi-decrqm-dispatch",
        repository: GHOSTTY_FORK_REPOSITORY,
      },
    ]);
    expect(JSON.stringify(GHOSTTY_ENGINE_PROVENANCE)).not.toContain("https://");
  });
});

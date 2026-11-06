import { describe, expect, it } from "vitest";
import { makeTeam } from "./helpers/fakeTeam";

/** Every limit is optional and off by default: 0 means no limit. */
describe("limits set to 0 are unlimited", () => {
  const unlimited = { maxTeammates: 0, maxAutoTurns: 0, maxTeamOutputTokens: 0 };
  const usage = { input: 0, output: 1_000_000, uncachedInput: 0, cacheRead: 0, cacheWrite: 0 };

  it("auto-turns never run out", () => {
    const { team } = makeTeam(unlimited);
    for (let i = 0; i < 1000; i++) expect(team.takeAutoTurn("main")).toBe(true);
  });

  it("the team token budget never pauses agents", () => {
    const { team, lead } = makeTeam(unlimited);
    for (let i = 0; i < 20; i++) expect(team.recordUsage("main", usage)).toBe(true);
    expect(team.allowModelCall("main")).toBe(true);
    expect(lead.info().status).not.toBe("paused");
  });

  it("any number of teammates can be spawned", () => {
    const { team } = makeTeam(unlimited);
    for (let i = 0; i < 25; i++) team.spawnTeammate({ name: `t${i}`, role: "helper", prompt: "" }, "main");
    expect(team.roster().filter((a) => !a.isLead)).toHaveLength(25);
  });

  it("a limit that is set still applies", () => {
    const { team } = makeTeam({ ...unlimited, maxAutoTurns: 2 });
    expect(team.takeAutoTurn("main")).toBe(true);
    expect(team.takeAutoTurn("main")).toBe(true);
    expect(team.takeAutoTurn("main")).toBe(false);
  });
});

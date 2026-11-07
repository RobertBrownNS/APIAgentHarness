import { describe, expect, it } from "vitest";
import { runTeamTool } from "../src/team/teamTools";
import { makeTeam } from "./helpers/fakeTeam";

describe("teams with local (Unsloth) models", () => {
  const local = { localModels: ["local:qwen-local", "local:gemma-local"] };

  it("main can spawn a teammate on a local model", () => {
    const { team } = makeTeam(local);
    const info = team.spawnTeammate({ name: "helper", role: "reads docs", prompt: "", model: "local:qwen-local" }, "main");
    expect(info.model).toBe("local:qwen-local");
  });

  it("an agent can be switched between Claude and a local model", () => {
    const { team } = makeTeam(local);
    team.spawnTeammate({ name: "helper", role: "x", prompt: "" }, "main");
    team.setAgentModel("helper", "local:gemma-local");
    expect(team.roster().find((a) => a.name === "helper")?.model).toBe("local:gemma-local");
    team.setAgentModel("helper", "claude-sonnet-5-5");
    expect(team.roster().find((a) => a.name === "helper")?.model).toBe("claude-sonnet-5-5");
  });

  it("unknown non-local models are still refused", () => {
    const { team } = makeTeam(local);
    expect(() => team.spawnTeammate({ name: "helper", role: "x", prompt: "", model: "gpt-x" }, "main")).toThrow(/Unknown model/);
  });

  it("team_roster tells main which models it can use, local ones included", async () => {
    const { team } = makeTeam(local);
    const out = await runTeamTool("team_roster", {}, { self: "main", isLead: true, team });
    expect(out).toContain("Models for spawn_teammate:");
    expect(out).toContain("claude-opus-5-5");
    expect(out).toContain("local:qwen-local");
  });

  it("the config carries the local model list for the model picker", () => {
    const { team } = makeTeam({ ...local, localServer: "http://localhost:8888", hasLocalKey: true });
    const c = team.config();
    expect(c.localModels).toEqual(local.localModels);
    expect(c.hasLocalKey).toBe(true);
  });
});

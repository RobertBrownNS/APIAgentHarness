import { describe, expect, it } from "vitest";
import { isCredentialEnvVar, scrubEnv } from "../src/agent/envFilter";

describe("isCredentialEnvVar", () => {
  it.each([
    "ANTHROPIC_API_KEY", "anthropic_auth_token", "AWS_ACCESS_KEY_ID", "AWS_REGION", "AZURE_CLIENT_SECRET",
    "AZURE_STORAGE_KEY", "GITHUB_TOKEN", "gh_token", "NPM_TOKEN", "NODE_AUTH_TOKEN", "CI_JOB_TOKEN",
    "MY_SERVICE_TOKEN", "DB_PASSWORD", "DB_PASSWD", "DEPLOY_PAT", "STRIPE_SECRET", "OPENAI_API_KEY", "TOKEN", "KEY",
  ])("strips %s", (n) => expect(isCredentialEnvVar(n)).toBe(true));

  it.each(["PATH", "Path", "HOME", "USERPROFILE", "TEMP", "NODE_ENV", "SystemRoot", "PYTHONPATH", "KEYBOARD", "LANG", "AZURE_REGION", "GITHUB_WORKSPACE", "GITHUB_ACTIONS", "GITHUB_REF"])(
    "keeps %s",
    (n) => expect(isCredentialEnvVar(n)).toBe(false),
  );
});

describe("scrubEnv", () => {
  it("removes credentials and undefined values, keeps the rest", () => {
    const out = scrubEnv({ PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "x", AWS_PROFILE: "p", FOO_KEY: "k", EMPTY: undefined });
    expect(out).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

// Pure (no vscode): which environment variables a spawned agent command may inherit.

const CREDENTIAL_SUFFIX = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PAT|KEY)$/;
const CREDENTIAL_PREFIX = /^(ANTHROPIC_|AWS_|AZURE_.*(SECRET|KEY|PASSWORD|TOKEN))/;
const CREDENTIAL_NAMES = new Set(["GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN", "CI_JOB_TOKEN"]);

/** True for variables that look like credentials (case-insensitive). */
export function isCredentialEnvVar(name: string): boolean {
  const n = name.toUpperCase();
  return CREDENTIAL_PREFIX.test(n) || CREDENTIAL_NAMES.has(n) || CREDENTIAL_SUFFIX.test(n);
}

/** Copy of env without credential-looking variables or undefined values. PATH, HOME etc. are kept. */
export function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !isCredentialEnvVar(k)) out[k] = v;
  }
  return out;
}

import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { checkCommand, ultraBackstop, type PolicyContext } from "../src/team/autoPolicy";

/** #54: ANSI-C quoting, posix backslash escapes, wrappers, %ProgramFiles(x86)%, ComSpec fallback, Remove-Item abbreviations. */
const ROOT = path.resolve("/ws/proj");
const base: PolicyContext = { written: new Set() };
const posix = (c: string) => checkCommand(c, ROOT, { ...base, shell: "posix" });
const cmd = (c: string) => checkCommand(c, ROOT, { ...base, shell: "cmd" });
const both = (c: string) => checkCommand(c, ROOT, { ...base, shell: "both" });
const BS = String.fromCharCode(92);

describe("posix: ANSI-C and locale quoting ask", () => {
  it.each(["echo $'a'", "git $'push'", "rm $'-rf' build", "cat $'.env'", 'echo $"hello"', 'git $"push"', "echo ok; echo $'x'"])("asks: %s", (c) => expect(posix(c).verdict, c).toBe("ask"));
  it.each(["echo '$'", "echo 'a$b'", 'echo "cost $5"', "git commit -m 'costs $5'", "echo $1"])("not ANSI-C: %s", (c) => expect(posix(c).verdict, c).not.toBe("ask"));
  it("is not special under cmd", () => {
    expect(cmd("echo $'a'").verdict).not.toBe("ask");
  });
});

describe("posix: a backslash before a name character spells the name", () => {
  it.each([
    `cat ${BS}.env`,
    `cat .${BS}env`,
    `cat .${BS}ssh/config`,
    `cat ${BS}.ssh/config`,
    `rm -${BS}rf build`,
    `g${BS}it push`,
    `r${BS}m -rf build`,
    `cat id${BS}_rsa`,
    `cat ${BS}~/.ssh/id_rsa`,
  ])("asks: %s", (c) => expect(posix(c).verdict, c).toBe("ask"));
  it.each([`echo ${BS}$HOME`, `echo "${BS}$HOME"`, `echo a${BS} b`, `git commit -m "a${BS}${BS}b"`])("literal escapes are fine: %s", (c) => {
    expect(posix(c).verdict, c).not.toBe("ask");
  });
  it("the same backslash text is a Windows path under cmd and is fine", () => {
    expect(cmd(`type src${BS}agent${BS}tools.ts`).verdict).toBe("allow");
    expect(cmd(`dir src${BS}agent`).verdict).toBe("allow");
    expect(cmd(`mkdir src${BS}utils`).verdict).not.toBe("ask");
  });
  it("and a secret spelled with a backslash still asks under cmd", () => {
    expect(cmd(`type .ssh${BS}config`).verdict).toBe("ask");
    expect(cmd(`type .${BS}.env`).verdict).toBe("ask");
  });
});

describe("wrappers are unwrapped and the rest is judged", () => {
  const WRAPPED_DANGERS = ["git push", "rm -rf build", "sudo ls", "npm publish", "cat ~/.ssh/id_rsa", "git reset --hard", "echo x > .env"];
  const WRAPPERS = ["env", "env FOO=1", "env -i", "env -u X", "command", "nohup", "time", "timeout 5", "timeout 5s", "nice", "nice -n 10", "stdbuf -o0", "setsid", "exec", "xargs", "xargs -n 1", "env FOO=1 BAR=2", "nohup env FOO=1", "time timeout 5"];
  for (const w of WRAPPERS) {
    it.each(WRAPPED_DANGERS)(`${w} %s asks`, (d) => {
      expect(posix(`${w} ${d}`).verdict, `${w} ${d}`).toBe("ask");
    });
  }
  it("wrappers with a harmless command are allowed", () => {
    for (const c of ["env FOO=1 git status", "nohup git status", "time git diff", "timeout 5 git status", "nice -n 5 git log", "command git status", "stdbuf -o0 git status", "env -i git status"]) {
      expect(posix(c).verdict, c).not.toBe("ask");
    }
    expect(posix("env FOO=1 git status").verdict).toBe("allow");
    expect(posix("timeout 5 git status").verdict).toBe("allow");
  });
  it("a wrapper whose remainder is a shell or interpreter asks", () => {
    for (const c of ["xargs sh", "env bash", "env sh -c ls", "nohup bash", "timeout 5 sh", "xargs -n 1 bash -c x"]) expect(posix(c).verdict, c).toBe("ask");
  });
  it("eval always asks in Auto", () => {
    for (const c of ["eval ls", "eval 'echo hi'", 'eval "git status"', "EVAL ls", "echo hi; eval ls"]) expect(posix(c).verdict, c).toBe("ask");
  });
  it("a wrapper with nothing after it does not crash", () => {
    for (const c of ["env", "nohup", "time", "timeout", "timeout 5", "nice", "nice -n", "xargs", "stdbuf", "setsid", "exec", "command"]) {
      expect(() => posix(c), c).not.toThrow();
    }
  });
  it("wrappers stack and still reach the hard rule", () => {
    expect(posix("env FOO=1 nohup timeout 5 nice -n 3 git push").verdict).toBe("ask");
    expect(posix("nohup env timeout 5 xargs git push").verdict).toBe("ask");
  });
  it("the same wrappers are unwrapped by the Ultra backstop", () => {
    const u = (c: string) => ultraBackstop(c, ROOT, { written: new Set(), shell: "posix" }).verdict;
    for (const c of ["env git push --force", "nohup git push -f", "timeout 5 rm -rf /", "nice -n 5 rm -rf ~", "xargs rm -rf /", "time sudo ls", "env FOO=1 rm -rf ..", "stdbuf -o0 git push --force"]) expect(u(c), c).toBe("ask");
    for (const c of ["env FOO=1 rm -rf build", "nohup git push", "timeout 5 npm test"]) expect(u(c), c).toBe("allow");
  });
});

describe("cmd: %ProgramFiles(x86)% is a variable", () => {
  it.each(["echo %ProgramFiles(x86)%", "dir %ProgramFiles(x86)%", "cd %ProgramFiles(x86)% && dir", 'echo "%ProgramFiles(x86)%"', "echo %CommonProgramFiles(x86)%"])("asks: %s", (c) => {
    expect(cmd(c).verdict, c).toBe("ask");
  });
  it("literal in sh", () => {
    expect(posix("echo %ProgramFiles(x86)%").verdict).not.toBe("ask");
  });
});

describe('shell "both" (a Windows machine whose %ComSpec% is not cmd.exe) applies both rule sets', () => {
  it("anything either shell would expand asks", () => {
    for (const c of ["echo $HOME", "echo %USERPROFILE%", "echo a^b", "echo $(id)", "echo `id`", "git $'push'", `cat .${BS}env`]) expect(both(c).verdict, c).toBe("ask");
  });
  it("things neither shell expands are as before", () => {
    for (const c of ["git status", "npm test", "git diff", "echo hello"]) expect(both(c).verdict, c).not.toBe("ask");
    expect(both("git status").verdict).toBe("allow");
  });
  it("Windows backslash paths ask under both (sh would treat them as escapes)", () => {
    expect(both(`type src${BS}agent${BS}tools.ts`).verdict).toBe("ask");
  });
  it("never less strict than either shell alone", () => {
    for (const c of ["echo $HOME", "echo %USERPROFILE%", 'git commit -m "costs $5"', "echo a^b", `dir src${BS}x`, "git p''ush", "echo $'x'"]) {
      const b = both(c).verdict;
      for (const single of [posix(c).verdict, cmd(c).verdict]) {
        if (single === "ask") expect(b, c).toBe("ask");
      }
    }
  });
  it("the Ultra backstop accepts shell both too", () => {
    expect(ultraBackstop("rm -rf /", ROOT, { written: new Set(), shell: "both" }).verdict).toBe("ask");
    expect(ultraBackstop("npm test", ROOT, { written: new Set(), shell: "both" }).verdict).toBe("allow");
  });
});

describe("Remove-Item / ri / rm / del / rd abbreviations of -Recurse are recursive deletes", () => {
  const CMDLETS = ["Remove-Item", "ri", "rm", "del", "erase", "rd", "rmdir"];
  const FLAGS = ["-r", "-re", "-rec", "-recu", "-recur", "-recurs", "-recurse", "-Recurse", "-RECURSE", "-Recurse:1", "-r:1", "-rec:1"];
  for (const c of CMDLETS) {
    it.each(FLAGS)(`${c} build %s asks`, (f) => {
      expect(cmd(`${c} build ${f}`).verdict, `${c} build ${f}`).toBe("ask");
    });
  }
  it("flags that are not abbreviations of -Recurse do not trigger", () => {
    for (const c of ["Remove-Item a.txt", "Remove-Item a.txt -Force", "Remove-Item a.txt -Confirm", "ri a.txt -Force", "Remove-Item -Path a.txt"]) expect(cmd(c).verdict, c).not.toBe("ask");
  });
  it("-Recurse combined with other flags and positions", () => {
    expect(cmd("Remove-Item -Force -r build").verdict).toBe("ask");
    expect(cmd("Remove-Item -Path build -rec -Force").verdict).toBe("ask");
    expect(cmd("ls; Remove-Item build -re").verdict).toBe("ask");
  });
});

describe("small known over-asks", () => {
  it.fails("an escaped backslash (two backslashes) is literal in sh (GAP, very low)", () => {
    expect(posix("echo " + BS + BS).verdict).not.toBe("ask");
  });
  it("xargs with a delete asks even inside the workspace (its targets come from stdin)", () => {
    expect(ultraBackstop("xargs rm -rf build", ROOT, { written: new Set(), shell: "posix" }).verdict).toBe("ask");
  });
});

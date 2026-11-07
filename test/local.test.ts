import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A fake Unsloth Desktop: records requests, serves /v1/models and a non-streaming /v1/messages reply.
const seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let baseUrl = "";
const config: Record<string, unknown> = {};
vi.mock("vscode", () => ({
  workspace: { getConfiguration: () => ({ get: (k: string, d: unknown) => (k in config ? config[k] : d) }) },
}));

import { createLocalClient, listLocalModels, localServerUrl } from "../src/agent/local";
import { isKnownModel, isLocalModel, localModelId } from "../src/shared/protocol";

const secretsWith = (key?: string) => ({ get: async () => key }) as never;
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.headers.authorization !== "Bearer sk-unsloth-test") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } }));
        return;
      }
      if (req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "idle-model", loaded: false }, { id: "qwen-local", loaded: true }] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "qwen-local",
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config["local.baseUrl"] = `${baseUrl}/v1/`; // trailing /v1 and slash must be tolerated
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("local model names", () => {
  it("recognises local: models and keeps Claude ids known", () => {
    expect(isLocalModel("local:qwen")).toBe(true);
    expect(localModelId("local:qwen")).toBe("qwen");
    expect(isKnownModel("local:qwen")).toBe(true);
    expect(isKnownModel("claude-opus-5-5")).toBe(true);
    expect(isKnownModel("local:")).toBe(false);
    expect(isKnownModel("gpt-x")).toBe(false);
  });
});

describe("Unsloth Desktop connection", () => {
  it("strips a trailing /v1 from the base URL (the SDK adds it)", () => {
    expect(localServerUrl()).toBe(baseUrl);
  });

  it("lists models as local:<id>, loaded ones first", async () => {
    expect(await listLocalModels(secretsWith("sk-unsloth-test"))).toEqual(["local:qwen-local", "local:idle-model"]);
  });

  it("returns no models without a key or with a wrong key", async () => {
    expect(await listLocalModels(secretsWith(undefined))).toEqual([]);
    expect(await listLocalModels(secretsWith("sk-unsloth-wrong"))).toEqual([]);
  });

  it("sends Messages requests to /v1/messages with a Bearer key and no x-api-key", async () => {
    const client = await createLocalClient(secretsWith("sk-unsloth-test"));
    expect(client).toBeDefined();
    const before = seen.length;
    const msg = await client!.messages.create({ model: "qwen-local", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
    expect(msg.content[0]).toMatchObject({ type: "text", text: "hi" });
    const req = seen[before];
    expect(req.method).toBe("POST");
    expect(req.url?.split("?")[0]).toBe("/v1/messages");
    expect(req.headers.authorization).toBe("Bearer sk-unsloth-test");
    expect(req.headers["x-api-key"]).toBeUndefined();
  });

  it("has no client without a key", async () => {
    expect(await createLocalClient(secretsWith(undefined))).toBeUndefined();
  });
});

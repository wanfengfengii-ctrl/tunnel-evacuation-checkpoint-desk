import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../../src/api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api client", () => {
  it("getDrill maps a 404 to null (no drill yet)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getDrill()).resolves.toBeNull();
  });

  it("startDrill posts to the start endpoint and parses state", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(201, {
          status: "in_progress",
          node: "cross_passage_open",
          version: 1,
          steps: ["cross_passage_open", "upstream_seal", "headcount"],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const drill = await api.startDrill();
    expect(drill.version).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/drills/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
  });

  it("confirm submits exactly the seen node and version", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, {
          status: "in_progress",
          node: "headcount",
          version: 3,
          steps: ["cross_passage_open", "upstream_seal", "headcount"],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await api.confirm({ node: "upstream_seal", version: 2 });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      node: "upstream_seal",
      version: 2,
    });
  });

  it("surfaces 409 bodies (actual node/version) via ApiError", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(409, {
        error: "old_version",
        detail: "提交的是旧版本 1，服务器当前版本为 2。",
        node: "upstream_seal",
        version: 2,
        drill_status: "in_progress",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.confirm({ node: "upstream_seal", version: 1 }),
    ).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ node: "upstream_seal", version: 2 }),
    });
  });

  it("wraps network failures as a visible ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("boom")));
    await expect(api.getDrill()).rejects.toBeInstanceOf(ApiError);
  });
});

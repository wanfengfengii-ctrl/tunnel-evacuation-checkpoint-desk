import { expect, test, type Page } from "@playwright/test";
import { resetApi, startApi, stopApi } from "./server-ctl";

const LABELS = {
  cross_passage_open: "横通道开启",
  upstream_seal: "上游封闭",
  headcount: "人员清点",
} as const;

async function postJson(page: Page, path: string, body: unknown) {
  return page.evaluate(
    async ({ path, body }) => {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let parsed: Record<string, unknown> | null = null;
      const text = await res.text();
      if (text) parsed = JSON.parse(text) as Record<string, unknown>;
      return { status: res.status, body: parsed };
    },
    { path, body },
  );
}

test.beforeEach(async () => {
  // Fresh database (and API process) per test. Within a test, stopApi/startApi
  // deliberately keeps the file to prove durability.
  await resetApi();
});

test("固定顺序：启动后首节点为横通道开启、版本 1，只能依次推进", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("start-button").click();

  await expect(page.getByTestId("current-node")).toHaveText(LABELS.cross_passage_open);
  await expect(page.getByTestId("current-version")).toHaveText("1");
  await expect(page.getByTestId("step-cross_passage_open")).toHaveClass(/step-current/);

  await page.getByTestId("confirm-button").click();
  await expect(page.getByTestId("current-node")).toHaveText(LABELS.upstream_seal);
  await expect(page.getByTestId("current-version")).toHaveText("2");

  await page.getByTestId("confirm-button").click();
  await expect(page.getByTestId("current-node")).toHaveText(LABELS.headcount);
  await expect(page.getByTestId("current-version")).toHaveText("3");
});

test("旧按钮请求晚到：真实 409 后页面展示服务器实际节点/版本且状态不变", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("start-button").click();

  // The page has seen cross_passage_open@1. Meanwhile the server moves on
  // (the earlier click actually went through and a retry is now in flight):
  // advance out-of-band so the page's held (node, version) is stale.
  const raced = await postJson(page, "/api/drills/confirm", {
    node: "cross_passage_open",
    version: 1,
  });
  expect(raced.status).toBe(200);

  // The page still believes it is on v1; clicking its button now is the late,
  // duplicated request. The real API must reject it with HTTP 409.
  await page.getByTestId("confirm-button").click();

  const banner = page.getByTestId("error-banner");
  await expect(banner).toBeVisible();
  await expect(page.getByTestId("error-text")).toContainText("服务器实际");
  await expect(page.getByTestId("error-text")).toContainText(LABELS.upstream_seal);
  await expect(page.getByTestId("error-text")).toContainText("版本 2");

  // Conflict must not mutate state: after automatic refresh the page shows
  // the server's actual next node.
  await expect(page.getByTestId("current-node")).toHaveText(LABELS.upstream_seal);
  await expect(page.getByTestId("current-version")).toHaveText("2");

  // The commander simply continues from the correct node.
  await page.getByTestId("confirm-button").click();
  await expect(page.getByTestId("current-node")).toHaveText(LABELS.headcount);
  await expect(page.getByTestId("current-version")).toHaveText("3");
});

test("API 成功确认后重启：刷新后仍在唯一正确的下一节点继续", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("start-button").click();

  // Restart after the start (drill row exists at v1).
  await stopApi();
  await startApi();
  await page.reload();
  await expect(page.getByTestId("current-node")).toHaveText(LABELS.cross_passage_open);
  await expect(page.getByTestId("current-version")).toHaveText("1");

  await page.getByTestId("confirm-button").click();
  await expect(page.getByTestId("current-node")).toHaveText(LABELS.upstream_seal);
  await page.getByTestId("confirm-button").click();
  await expect(page.getByTestId("current-node")).toHaveText(LABELS.headcount);
  await expect(page.getByTestId("current-version")).toHaveText("3");

  // Hard restart after a successful confirmation, then the commander resumes.
  await stopApi();
  await startApi();
  await page.reload();
  await expect(page.getByTestId("current-node")).toHaveText(LABELS.headcount);
  await expect(page.getByTestId("current-version")).toHaveText("3");
  await expect(page.getByTestId("confirm-button")).toBeVisible();
});

test("最后一步双发重试竞态：只完成一次，迟到的请求 409，重启后仍只显示一次完成", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("start-button").click();
  await page.getByTestId("confirm-button").click();
  await page.getByTestId("confirm-button").click();
  await expect(page.getByTestId("current-version")).toHaveText("3");

  // Network retry: two identical final confirmations hit the real API at once
  // through the same-origin /api proxy. Exactly one may complete.
  const outcomes = await page.evaluate(async () => {
    const payload = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node: "headcount", version: 3 }),
    };
    const [a, b] = await Promise.all([
      fetch("/api/drills/confirm", payload),
      fetch("/api/drills/confirm", { ...payload }),
    ]);
    return Promise.all(
      [a, b].map(async (res) => ({
        status: res.status,
        body: await res.json(),
      })),
    );
  });

  const statuses = outcomes.map((o) => o.status).sort();
  expect(statuses).toEqual([200, 409]);
  const conflict = outcomes.find((o) => o.status === 409)!;
  expect(conflict.body.error).toBe("drill_completed");
  expect(conflict.body.version).toBe(4);

  // Restart after completion; the browser shows exactly one completion.
  await stopApi();
  await startApi();
  await page.reload();

  await expect(page.getByTestId("completed-banner")).toBeVisible();
  await expect(page.getByTestId("completed-banner")).toHaveCount(1);
  await expect(page.getByTestId("confirm-button")).toHaveCount(0);
  await expect(page.getByTestId("start-button")).toHaveCount(0);
  await expect(page.getByTestId("drill-status")).toHaveText("已完成");

  // Any later stale click is still 409 with the actual state and no change.
  const stale = await postJson(page, "/api/drills/confirm", {
    node: "headcount",
    version: 3,
  });
  expect(stale.status).toBe(409);
  expect(stale.body).not.toBeNull();
  const staleBody = stale.body as Record<string, unknown>;
  expect(staleBody.error).toBe("drill_completed");
  expect(staleBody.version).toBe(4);
});

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

// ---------------------------------------------------------------------------
// Planned duration
// ---------------------------------------------------------------------------

test("不填预计用时：默认 30 分钟，服务端返回启动与结束时刻", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("start-button").click();
  await expect(page.getByTestId("timer")).toBeVisible();

  const plan = await page.evaluate(async () => {
    const res = await fetch("/api/drills");
    return (await res.json()) as {
      planned_minutes: number;
      started_at: string;
      planned_end_at: string;
    };
  });
  expect(plan.planned_minutes).toBe(30);

  // The end instant shown equals started_at + 30 minutes, rendered locally.
  const expectedEndLocal = await page.evaluate((endAt) => {
    return new Date(endAt).toLocaleString("zh-CN", { hour12: false });
  }, plan.planned_end_at);
  await expect(page.getByTestId("timer-end-at")).toHaveText(expectedEndLocal);
  const diffMs = new Date(plan.planned_end_at).getTime()
    - new Date(plan.started_at).getTime();
  expect(diffMs).toBe(30 * 60_000);

  // Immediately after start the remaining time is close to 30 minutes.
  await expect(page.getByTestId("timer-remaining")).toContainText("29:");
});

test("指定预计用时贯穿写入与查询：45 分钟后刷新页面仍按同一时刻计时", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("planned-minutes").fill("45");
  await page.getByTestId("start-button").click();
  await expect(page.getByTestId("timer")).toBeVisible();

  const plan = await page.evaluate(async () => {
    const res = await fetch("/api/drills");
    return (await res.json()) as {
      planned_minutes: number;
      started_at: string;
      planned_end_at: string;
    };
  });
  expect(plan.planned_minutes).toBe(45);
  expect(
    new Date(plan.planned_end_at).getTime()
      - new Date(plan.started_at).getTime(),
  ).toBe(45 * 60_000);

  const endTextBefore = (await page.getByTestId("timer-end-at").textContent()) ?? "";

  // Reload (as a field commander would): the same server end instant drives
  // the countdown, and remaining time keeps counting down from ~44 minutes.
  await page.reload();
  await expect(page.getByTestId("timer-end-at")).toHaveText(endTextBefore.trim());
  await expect(page.getByTestId("timer-remaining")).toContainText("44:");

  // The persisted plan is what the API still reports after the reload.
  const planAfterReload = await page.evaluate(async () => {
    const res = await fetch("/api/drills");
    return (await res.json()) as { planned_minutes: number };
  });
  expect(planAfterReload.planned_minutes).toBe(45);
});

test("启动前超出范围的预计用时给出提示且不发起启动请求", async ({ page }) => {
  await page.goto("/");
  const input = page.getByTestId("planned-minutes");
  const startButton = page.getByTestId("start-button");

  for (const value of ["4", "181", "0", "7.5"]) {
    await input.fill(value);
    await expect(page.getByTestId("duration-hint")).toBeVisible();
    await expect(startButton).toBeDisabled();
  }

  await input.fill("180");
  await expect(page.getByTestId("duration-hint")).toHaveCount(0);
  await expect(startButton).toBeEnabled();

  // None of the invalid attempts created a drill on the real server.
  const probe = await page.evaluate(async () => {
    const res = await fetch("/api/drills");
    return res.status;
  });
  expect(probe).toBe(404);
});

/** Install a controllable clock before any page script runs: ``Date`` (and
 * Date.now) is shifted by a mutable offset, while real setInterval keeps
 * firing so the page's per-second tick re-renders with the faked time. */
async function installControllableClock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const RealDate = Date;
    let offsetMs = 0;
    (window as unknown as { __advanceClock: (ms: number) => void }).__advanceClock = (
      ms,
    ) => {
      offsetMs += ms;
    };
    const FakeDate = class extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) {
          super(RealDate.now() + offsetMs);
        } else {
          // Forward native constructor arguments (e.g. an ISO string) untouched.
          super(...(args as ConstructorParameters<typeof Date>));
        }
      }
      static now(): number {
        return RealDate.now() + offsetMs;
      }
    } as unknown as DateConstructor;
    globalThis.Date = FakeDate;
  });
}

test("可控时钟：剩余时间切换为已超出预计，且三步确认仍可依次完成", async ({
  page,
}) => {
  await installControllableClock(page);

  await page.goto("/");
  await page.getByTestId("planned-minutes").fill("5");
  await page.getByTestId("start-button").click();

  await expect(page.getByTestId("timer-remaining")).toContainText("04:");
  await expect(page.getByTestId("timer-overtime")).toHaveCount(0);

  // Shift the browser clock 6 minutes beyond the real start instant. The
  // server-provided planned end instant is unchanged; within one real second
  // the page's own interval must flip to the overtime display.
  await page.evaluate(() => {
    (window as unknown as { __advanceClock: (ms: number) => void }).__advanceClock(
      6 * 60_000,
    );
  });
  await expect(page.getByTestId("timer-overtime")).toBeVisible();
  await expect(page.getByTestId("timer-overtime")).toContainText("已超出预计");
  await expect(page.getByTestId("timer-overtime")).toContainText("01:");
  await expect(page.getByTestId("timer-remaining")).toHaveCount(0);

  // Overtime changes nothing about the confirmation order: the field commander
  // still completes all three steps in sequence.
  await page.getByTestId("confirm-button").click();
  await expect(page.getByTestId("current-node")).toHaveText(LABELS.upstream_seal);
  await page.getByTestId("confirm-button").click();
  await expect(page.getByTestId("current-node")).toHaveText(LABELS.headcount);
  await page.getByTestId("confirm-button").click();

  await expect(page.getByTestId("completed-banner")).toBeVisible();
  await expect(page.getByTestId("confirm-button")).toHaveCount(0);
  // Timer remains mounted and still reports the overtime state.
  await expect(page.getByTestId("timer-overtime")).toContainText("已超出预计");
});

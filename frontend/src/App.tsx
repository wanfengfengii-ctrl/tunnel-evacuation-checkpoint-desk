import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type { DrillState } from "./types";
import { nodeLabel } from "./types";

export default function App() {
  // undefined = initial load in flight, null = no drill exists.
  const [drill, setDrill] = useState<DrillState | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const state = await api.getDrill();
    setDrill(state);
  }, []);

  useEffect(() => {
    refresh().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [refresh]);

  /** After a conflict: surface the server message, then re-render server
   * state so a late/stale request can never leave the page ahead of truth. */
  const handleConflict = useCallback(
    async (err: ApiError) => {
      const body = err.body as { detail?: string; node?: string; version?: number };
      const actual =
        body.node !== undefined && body.version !== undefined
          ? `（服务器实际：${nodeLabel(body.node)} / 版本 ${body.version}）`
          : "";
      setError(`${body.detail ?? err.message}${actual}`);
      await refresh();
    },
    [refresh],
  );

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setDrill(await api.startDrill());
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await handleConflict(err);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }, [handleConflict]);

  const confirm = useCallback(async () => {
    if (!drill) return;
    setBusy(true);
    setError(null);
    // Submit exactly the node and the version the page has seen.
    const seenNode = drill.node;
    const seenVersion = drill.version;
    try {
      setDrill(await api.confirm({ node: seenNode, version: seenVersion }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await handleConflict(err);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }, [drill, handleConflict]);

  if (drill === undefined) {
    return (
      <main className="panel">
        <h1>隧道疏散演练指挥席</h1>
        {error !== null ? (
          <div className="banner banner-error" role="alert">
            <strong>连接失败：</strong>
            {error}
            <div className="actions" style={{ marginTop: 12 }}>
              <button
                type="button"
                onClick={() =>
                  refresh().catch((err: unknown) =>
                    setError(err instanceof Error ? err.message : String(err)),
                  )
                }
              >
                重试连接
              </button>
            </div>
          </div>
        ) : (
          <p>正在连接指挥 API…</p>
        )}
      </main>
    );
  }

  const inProgress = drill !== null && drill.status === "in_progress";
  const completed = drill !== null && drill.status === "completed";
  const currentIndex = drill
    ? drill.status === "completed"
      ? drill.steps.length
      : Math.max(0, drill.steps.indexOf(drill.node))
    : -1;

  return (
    <main className="panel">
      <h1>隧道疏散演练指挥席</h1>

      {error !== null && (
        <div className="banner banner-error" role="alert" data-testid="error-banner">
          <strong>操作被拒绝：</strong>
          <span data-testid="error-text">{error}</span>
        </div>
      )}

      {completed && (
        <div className="banner banner-done" role="status" data-testid="completed-banner">
          演练已全部完成（横通道开启 → 上游封闭 → 人员清点）。
        </div>
      )}

      <section className="state" aria-live="polite">
        {drill === null ? (
          <p data-testid="no-drill">当前没有进行中的演练。</p>
        ) : (
          <>
            <p>
              状态：
              <strong data-testid="drill-status">
                {completed ? "已完成" : "进行中"}
              </strong>
            </p>
            {!completed && (
              <p>
                当前节点：
                <strong data-testid="current-node">{nodeLabel(drill.node)}</strong>
                {"　"}节点版本：
                <strong data-testid="current-version">{drill.version}</strong>
              </p>
            )}
          </>
        )}
      </section>

      <ol className="steps">
        {(drill?.steps ?? ["cross_passage_open", "upstream_seal", "headcount"]).map(
          (step, index) => {
            const stateClass =
              drill === null
                ? "pending"
                : index < currentIndex
                  ? "done"
                  : index === currentIndex
                    ? "current"
                    : "pending";
            return (
              <li key={step} className={`step step-${stateClass}`} data-testid={`step-${step}`}>
                <span className="step-index">{index + 1}</span>
                <span className="step-label">{nodeLabel(step)}</span>
                <span className="step-state">
                  {stateClass === "done"
                    ? "已确认"
                    : stateClass === "current"
                      ? `待确认（版本 ${drill?.version ?? ""}）`
                      : "未到达"}
                </span>
              </li>
            );
          },
        )}
      </ol>

      <div className="actions">
        {drill === null && (
          <button
            type="button"
            onClick={start}
            disabled={busy}
            data-testid="start-button"
          >
            启动演练
          </button>
        )}
        {inProgress && (
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            data-testid="confirm-button"
          >
            确认：{nodeLabel(drill.node)}（版本 {drill.version}）
          </button>
        )}
        <button type="button" onClick={() => refresh().catch(() => undefined)} data-testid="refresh-button">
          刷新服务器状态
        </button>
      </div>
    </main>
  );
}

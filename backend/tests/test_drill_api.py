import threading


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_no_drill_initially_returns_404(client):
    response = client.get("/api/drills")
    assert response.status_code == 404
    assert response.json()["detail"] == "drill_not_found"


def test_start_creates_fixed_order_with_version_1(client):
    response = client.post("/api/drills/start")
    assert response.status_code == 201
    state = response.json()
    assert state == {
        "status": "in_progress",
        "node": "cross_passage_open",
        "version": 1,
        "steps": ["cross_passage_open", "upstream_seal", "headcount"],
    }


def test_second_start_is_409_and_changes_nothing(started):
    response = started.post("/api/drills/start")
    assert response.status_code == 409
    body = response.json()
    assert body["error"] == "drill_already_exists"
    assert body["node"] == "cross_passage_open"
    assert body["version"] == 1

    state = started.get("/api/drills").json()
    assert state["node"] == "cross_passage_open"
    assert state["version"] == 1
    assert state["status"] == "in_progress"


def _confirm(client, node, version, expected_status=200):
    response = client.post(
        "/api/drills/confirm", json={"node": node, "version": version}
    )
    assert response.status_code == expected_status, response.text
    return response.json()


def test_happy_path_advances_each_step_and_completes_once(started):
    state = _confirm(started, "cross_passage_open", 1)
    assert state["node"] == "upstream_seal" and state["version"] == 2
    state = _confirm(started, "upstream_seal", 2)
    assert state["node"] == "headcount" and state["version"] == 3
    state = _confirm(started, "headcount", 3)
    assert state["status"] == "completed" and state["version"] == 4
    assert state["node"] == "headcount"


def test_duplicate_confirmation_is_409_with_actual_state(started):
    # First confirmation succeeds, advancing to upstream_seal@2.
    _confirm(started, "cross_passage_open", 1)

    # A late retry of the already-applied button click arrives afterwards.
    response = started.post(
        "/api/drills/confirm",
        json={"node": "cross_passage_open", "version": 1},
    )
    assert response.status_code == 409
    body = response.json()
    assert body["error"] == "duplicate_confirmation"
    assert body["node"] == "upstream_seal"
    assert body["version"] == 2
    assert body["drill_status"] == "in_progress"

    # No state change: still upstream_seal@2.
    state = started.get("/api/drills").json()
    assert state["node"] == "upstream_seal" and state["version"] == 2


def test_old_version_same_node_is_409_and_does_not_advance(started):
    _confirm(started, "cross_passage_open", 1)
    _confirm(started, "upstream_seal", 2)
    # Now at headcount@3. A delayed request carrying upstream_seal@1
    # (node mismatch lands first) -- here specifically test node-correct but
    # stale version by rewinding the page's seen version.
    response = started.post(
        "/api/drills/confirm", json={"node": "headcount", "version": 2}
    )
    assert response.status_code == 409
    body = response.json()
    assert body["error"] == "old_version"
    assert body["node"] == "headcount" and body["version"] == 3

    state = started.get("/api/drills").json()
    assert state["node"] == "headcount" and state["version"] == 3


def test_future_version_is_409(started):
    response = started.post(
        "/api/drills/confirm", json={"node": "cross_passage_open", "version": 99}
    )
    assert response.status_code == 409
    assert response.json()["error"] == "version_mismatch"
    assert started.get("/api/drills").json()["version"] == 1


def test_skipping_a_node_is_409(started):
    response = started.post(
        "/api/drills/confirm", json={"node": "headcount", "version": 1}
    )
    assert response.status_code == 409
    body = response.json()
    assert body["error"] == "skipped_node"
    assert body["node"] == "cross_passage_open" and body["version"] == 1
    assert started.get("/api/drills").json()["node"] == "cross_passage_open"


def test_unknown_node_is_409(started):
    response = started.post(
        "/api/drills/confirm", json={"node": "detonate_bridge", "version": 1}
    )
    assert response.status_code == 409
    assert response.json()["error"] == "unknown_node"
    assert started.get("/api/drills").json()["version"] == 1


def test_confirming_before_start_is_404(client):
    response = client.post(
        "/api/drills/confirm", json={"node": "cross_passage_open", "version": 1}
    )
    assert response.status_code == 404


def test_confirmation_after_completion_is_409_and_completion_is_singular(started):
    _confirm(started, "cross_passage_open", 1)
    _confirm(started, "upstream_seal", 2)
    completed = _confirm(started, "headcount", 3)
    assert completed["status"] == "completed" and completed["version"] == 4

    # Retry of the final click must not produce a second completion.
    response = started.post(
        "/api/drills/confirm", json={"node": "headcount", "version": 3}
    )
    assert response.status_code == 409
    body = response.json()
    assert body["error"] == "drill_completed"
    assert body["version"] == 4

    state = started.get("/api/drills").json()
    assert state["status"] == "completed" and state["version"] == 4


def test_malformed_body_is_rejected_not_faked(client):
    response = client.post("/api/drills/confirm", json={"node": 123})
    assert response.status_code == 422
    assert "detail" in response.json()


def test_concurrent_identical_confirmations_advance_exactly_once(started):
    """Simulate a network retry: two in-flight requests for the same
    (node, version). BEGIN IMMEDIATE serialises them; exactly one wins."""
    results: list[int] = []
    barrier = threading.Barrier(2)

    def fire():
        barrier.wait()
        response = started.post(
            "/api/drills/confirm",
            json={"node": "cross_passage_open", "version": 1},
        )
        results.append(response.status_code)

    threads = [threading.Thread(target=fire) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert sorted(results) == [200, 409]
    state = started.get("/api/drills").json()
    assert state["node"] == "upstream_seal" and state["version"] == 2

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.ratelimit import RateLimit


def make_client(per_minute: int) -> TestClient:
    app = FastAPI()
    app.add_middleware(RateLimit, per_minute=per_minute)

    @app.get("/api/places")
    def places():
        return []

    @app.get("/api/series")
    def series():
        return {}

    @app.get("/api/health")
    def health():
        return {"ok": True}

    return TestClient(app)


def test_blocks_after_budget_and_reports_retry():
    c = make_client(per_minute=5)
    codes = [c.get("/api/places").status_code for _ in range(7)]
    assert codes[:5] == [200] * 5 and codes[5] == 429
    assert int(c.get("/api/places").headers["Retry-After"]) >= 1


def test_expensive_endpoints_cost_more():
    c = make_client(per_minute=12)
    assert [c.get("/api/series").status_code for _ in range(3)] == [200, 200, 429]  # cost 6 each


def test_health_and_clients_are_separate():
    c = make_client(per_minute=1)
    assert all(c.get("/api/health").status_code == 200 for _ in range(5))
    assert c.get("/api/places", headers={"x-forwarded-for": "1.1.1.1"}).status_code == 200
    assert c.get("/api/places", headers={"x-forwarded-for": "2.2.2.2"}).status_code == 200
    assert c.get("/api/places", headers={"x-forwarded-for": "1.1.1.1"}).status_code == 429

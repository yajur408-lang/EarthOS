from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.ratelimit import RateLimit
from app.ratelimit import client_ip


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


def _req(xff: str | None, peer: str = "10.0.0.9") -> Request:
    headers = [(b"x-forwarded-for", xff.encode())] if xff is not None else []
    return Request({"type": "http", "headers": headers, "client": (peer, 1234)})


def test_forged_leftmost_entry_is_ignored():
    # The client sent "1.2.3.4"; the one trusted proxy appended the real address.
    assert client_ip(_req("1.2.3.4, 203.0.113.7"), proxy_hops=1) == "203.0.113.7"


def test_two_proxies_take_second_from_right():
    assert client_ip(_req("1.2.3.4, 203.0.113.7, 172.16.0.2"), proxy_hops=2) == "203.0.113.7"


def test_no_proxy_uses_socket_address():
    assert client_ip(_req("1.2.3.4"), proxy_hops=0) == "10.0.0.9"
    assert client_ip(_req(None), proxy_hops=1) == "10.0.0.9"


def test_rotating_forged_headers_share_one_bucket():
    ips = {client_ip(_req(f"9.9.9.{i}, 198.51.100.1"), proxy_hops=1) for i in range(50)}
    assert ips == {"198.51.100.1"}


def test_forged_header_cannot_dodge_the_limit():
    c = make_client(per_minute=1)
    # Behind one proxy the real address is the last entry; rotating the forged first entry doesn't buy a new bucket.
    assert c.get("/api/places", headers={"x-forwarded-for": "6.6.6.1, 198.51.100.1"}).status_code == 200
    assert c.get("/api/places", headers={"x-forwarded-for": "6.6.6.2, 198.51.100.1"}).status_code == 429

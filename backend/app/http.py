"""One shared TLS context: building one loads the CA bundle (~0.2 s, much more on a small host),
and every request creates a client, even when all its data is already cached."""

import ssl

import certifi
import httpx

_SSL = ssl.create_default_context(cafile=certifi.where())


def client(**kw) -> httpx.AsyncClient:
    return httpx.AsyncClient(verify=_SSL, **kw)

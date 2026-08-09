from __future__ import annotations

import secrets

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import Settings

_scheme = HTTPBearer(auto_error=False, description="Bearer <ADMIN_TOKEN>")


class MisconfiguredAuth(RuntimeError):
    pass


def verify_configuration(settings: Settings) -> None:
    """Refuse to start unauthenticated unless someone said so out loud.

    Defaulting to open is how a service ends up on the public internet with an
    endpoint that spends money on LLM calls and creates markets people bet on.
    Running without a token stays possible — for local dev and tests — but it has
    to be a deliberate choice, not the path of least resistance.
    """
    if not settings.admin_token and not settings.allow_unauthenticated:
        raise MisconfiguredAuth(
            "ADMIN_TOKEN is not set. Generate one with "
            "`python -c \"import secrets; print(secrets.token_urlsafe(32))\"` and put it "
            "in .env, or set ALLOW_UNAUTHENTICATED=1 to run without auth (local only)."
        )


async def require_token(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_scheme),
) -> None:
    """Bearer-token gate, matching the xpred Worker's convention.

    Same header shape (`Authorization: Bearer <token>`) so both services can share
    one credential.
    """
    settings: Settings = request.app.state.services.settings

    if not settings.admin_token:
        return  # verify_configuration already established this was deliberate

    if credentials is None or not credentials.credentials:
        raise HTTPException(
            status_code=401,
            detail="Missing bearer token. Send 'Authorization: Bearer <ADMIN_TOKEN>'.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Constant-time: a plain == leaks the token's prefix through response timing.
    if not secrets.compare_digest(credentials.credentials, settings.admin_token):
        raise HTTPException(
            status_code=401,
            detail="Invalid bearer token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

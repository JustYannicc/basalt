"""A retained fleet ordinal names Home without changing the legacy address."""

from __future__ import annotations

from dataclasses import dataclass

from .home_peer import MAX_ORDINAL, peer_port


@dataclass(frozen=True)
class HomeIdentity:
    ordinal: int | None = None

    @classmethod
    def parse(cls, value: str | None) -> "HomeIdentity":
        if value is None:
            return cls()
        if not value.isascii() or not value.isdecimal() or str(int(value)) != value:
            raise ValueError("invalid Home identity")
        ordinal = int(value)
        if not 1 <= ordinal <= MAX_ORDINAL:
            raise ValueError("invalid Home identity")
        return cls(ordinal)

    @property
    def port(self) -> int:
        return 8327 if self.ordinal is None else 8329

    @property
    def advertised_port(self) -> int:
        return 8327 if self.ordinal is None else peer_port(self.ordinal)

    @property
    def name(self) -> str:
        return "basalt-pool" if self.ordinal is None else f"basalt-pool-{self.ordinal}"

    @property
    def database_name(self) -> str:
        return "basalt-home" if self.ordinal is None else f"basalt-home-{self.ordinal}"

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class MethodParamsPayload(BaseModel):
    max_iter: int = 100
    k_max: int = 5
    max_no_improv: int = 50
    time_limit: float = 60.0
    strategy: str = "best"
    population_size: int = 50
    generations: int = 100
    crossover_rate: float = 0.8
    mutation_rate: float = 0.1
    elitism: int = 2
    seed: int | None = None


class RunCreatePayload(BaseModel):
    p: int = Field(default=5, ge=1)
    metric: Literal["distance", "time"] = "distance"
    radius_km: float = Field(default=100.0, ge=0)
    max_time_h: float = Field(default=1.0, ge=0)
    target_uf: str | None = "MG"
    greenfield: bool = False
    demand_col: str = "Total"
    methods: list[str] = Field(default_factory=lambda: ["greedy", "local_search", "vns", "genetic", "exact"])
    method_params: dict[str, MethodParamsPayload] = Field(default_factory=dict)
    execution_mode: Literal["sequential", "independent"] = "sequential"


class RunCreateResponse(BaseModel):
    run_id: str
    status: str

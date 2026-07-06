from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Callable, Literal


Metric = Literal["distance", "time"]
ExecutionMode = Literal["sequential", "independent"]
RunStatus = Literal["queued", "running", "completed", "failed"]
MethodStatus = Literal["completed", "optimal", "feasible", "time_limit", "infeasible", "error"]


ProgressCallback = Callable[[str, int, int, dict[str, Any]], None]


@dataclass
class MethodParams:
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


@dataclass
class ScenarioConfig:
    p: int = 5
    metric: Metric = "distance"
    radius_km: float = 100.0
    max_time_h: float = 1.0
    target_uf: str | None = "MG"
    greenfield: bool = False
    demand_file: str | None = None
    demand_col: str = "Total"
    existing_sites_file: str | None = None
    methods: list[str] = field(default_factory=lambda: ["greedy", "local_search", "vns", "genetic", "exact"])
    method_params: dict[str, MethodParams] = field(default_factory=dict)
    execution_mode: ExecutionMode = "sequential"


@dataclass
class ProgressPoint:
    step: int
    z: float
    method: str
    elapsed_seconds: float = 0.0
    label: str = ""


@dataclass
class SiteResult:
    municipio_id: int
    municipio_nome: str
    municipio_uf: str
    populacao_local: float
    populacao_nova_coberta: float
    latitude: float | None = None
    longitude: float | None = None


@dataclass
class MapPoint:
    municipio_id: int
    municipio_nome: str
    municipio_uf: str
    latitude: float
    longitude: float
    demanda: float
    status: str
    covering_campuses: str = ""
    is_selected_site: bool = False
    is_existing_site: bool = False


@dataclass
class MapArea:
    municipio_id: int
    municipio_nome: str
    municipio_uf: str
    demanda: float
    status: str
    polygons: list[list[list[list[float]]]] = field(default_factory=list)
    covering_campuses: str = ""
    is_selected_site: bool = False
    is_existing_site: bool = False


@dataclass
class MapPayload:
    points: list[MapPoint] = field(default_factory=list)
    areas: list[MapArea] = field(default_factory=list)
    selected_site_ids: list[int] = field(default_factory=list)
    existing_site_ids: list[int] = field(default_factory=list)


@dataclass
class OptimizationResult:
    method: str
    status: MethodStatus
    z: float
    selected_sites: list[int]
    runtime_seconds: float
    coverage_percent: float
    new_covered_demand: float
    progress_trace: list[ProgressPoint] = field(default_factory=list)
    message: str = ""
    sites: list[SiteResult] = field(default_factory=list)
    map_payload: MapPayload = field(default_factory=MapPayload)

    # Complementary info when an exact "optimal" result is also present in the run
    gap_to_optimal: float | None = None   # e.g. 0.0 = matched proven optimal, 1.23 = 1.23% worse
    reference_z: float | None = None      # the Z of the proven optimal (if available)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class RunResult:
    run_id: str
    status: RunStatus
    config: ScenarioConfig
    results: list[OptimizationResult] = field(default_factory=list)
    logs: list[str] = field(default_factory=list)
    progress: dict[str, dict[str, Any]] = field(default_factory=dict)
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

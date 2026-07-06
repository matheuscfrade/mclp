from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.sparse import csr_matrix
from shapely.geometry import MultiPolygon, Polygon

import config as local_config
import data_loader
import heuristics as local_heuristics

from .models import MapArea, MapPayload, MapPoint, ScenarioConfig, SiteResult


@dataclass
class MCLPInstance:
    config: ScenarioConfig
    candidates: list[int]
    demand_nodes: list[int]
    demand_dict: dict[int, float]
    names_dict: dict[int, str]
    uf_dict: dict[int, str]
    coords_dict: dict[int, tuple[float, float]]
    existing_site_ids: set[int]
    pre_covered: set[int]
    coverage_map: dict[int, set[int]]
    cov_matrix: csr_matrix
    demand_vector: np.ndarray
    cand_to_idx: dict[int, int]
    node_to_idx: dict[int, int]
    initial_coverage: np.ndarray

    @property
    def total_demand(self) -> float:
        return float(sum(self.demand_dict.values()))

    @property
    def initial_z(self) -> float:
        return float(sum(self.demand_dict.get(i, 0) for i in self.pre_covered))


def _normalize_uf(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip().upper()
    return value or None


def _geometry_to_polygons(geometry: Polygon | MultiPolygon | None) -> list[list[list[list[float]]]]:
    if geometry is None or geometry.is_empty:
        return []

    if isinstance(geometry, Polygon):
        geometries = [geometry]
    elif isinstance(geometry, MultiPolygon):
        geometries = list(geometry.geoms)
    else:
        return []

    polygons: list[list[list[list[float]]]] = []
    for polygon in geometries:
        rings: list[list[list[float]]] = []
        exterior = [[float(x), float(y)] for x, y in polygon.exterior.coords]
        if len(exterior) >= 4:
            rings.append(exterior)
        for interior in polygon.interiors:
            hole = [[float(x), float(y)] for x, y in interior.coords]
            if len(hole) >= 4:
                rings.append(hole)
        if rings:
            polygons.append(rings)
    return polygons


def build_instance(run_config: ScenarioConfig) -> MCLPInstance:
    target_uf = _normalize_uf(run_config.target_uf)
    use_km = run_config.metric == "distance"
    demand_file = run_config.demand_file or local_config.DEMAND_FILE
    existing_sites_file = run_config.existing_sites_file or local_config.EXISTING_SITES_FILE

    dist_df = data_loader.load_distances(local_config.DISTANCES_FILE, uf_filter=target_uf)
    demand_dict, names_dict, uf_dict = data_loader.load_demand(
        demand_file,
        "Cód.",
        [run_config.demand_col],
        uf_filter=target_uf,
    )
    coords_dict = data_loader.load_coordinates(local_config.COORDS_FILE, uf_filter=target_uf)

    existing_site_ids: set[int] = set()
    if not run_config.greenfield:
        sites_df = data_loader.load_existing_sites(existing_sites_file, uf_filter=target_uf)
        existing_site_ids = set(int(value) for value in sites_df["id"].unique())

    demand_nodes = list(demand_dict.keys())
    candidates = [municipio_id for municipio_id in demand_nodes if municipio_id not in existing_site_ids]
    relevant_origins = set(candidates) | existing_site_ids
    dist_filtered = dist_df[
        dist_df["origem"].isin(relevant_origins) & dist_df["destino"].isin(demand_nodes)
    ].copy()

    if use_km:
        dist_covered = dist_filtered[dist_filtered["distancia"] <= run_config.radius_km].copy()
    else:
        dist_covered = dist_filtered[dist_filtered["tempo"] <= run_config.max_time_h].copy()

    pre_covered: set[int] = set()
    if existing_site_ids:
        pre_covered.update(
            int(value)
            for value in dist_covered[dist_covered["origem"].isin(existing_site_ids)]["destino"].unique()
        )
        pre_covered.update(municipio_id for municipio_id in existing_site_ids if municipio_id in demand_dict)

    coverage_map = dist_covered.groupby("origem")["destino"].apply(lambda series: set(int(value) for value in series)).to_dict()
    for site_id in set(candidates) | existing_site_ids:
        coverage_map.setdefault(site_id, set())
        if site_id in demand_dict:
            coverage_map[site_id].add(site_id)

    cov_matrix, demand_vector, cand_to_idx, node_to_idx, initial_coverage = (
        local_heuristics.build_sparse_matrix_from_df(
            dist_filtered,
            demand_dict,
            candidates,
            demand_nodes,
            run_config.radius_km,
            run_config.max_time_h,
            use_km,
            pre_covered,
        )
    )

    return MCLPInstance(
        config=run_config,
        candidates=candidates,
        demand_nodes=demand_nodes,
        demand_dict=demand_dict,
        names_dict=names_dict,
        uf_dict=uf_dict,
        coords_dict=coords_dict,
        existing_site_ids=existing_site_ids,
        pre_covered=pre_covered,
        coverage_map=coverage_map,
        cov_matrix=cov_matrix,
        demand_vector=demand_vector,
        cand_to_idx=cand_to_idx,
        node_to_idx=node_to_idx,
        initial_coverage=initial_coverage,
    )


def evaluate_solution(instance: MCLPInstance, selected_sites: list[int]) -> float:
    return float(
        local_heuristics.calculate_z(
            selected_sites,
            instance.cov_matrix,
            instance.demand_vector,
            instance.cand_to_idx,
            instance.initial_coverage,
        )
    )


def solution_sites(instance: MCLPInstance, selected_sites: list[int]) -> list[SiteResult]:
    covered_so_far = set(instance.pre_covered)
    rows: list[SiteResult] = []

    for site_id in selected_sites:
        covered = instance.coverage_map.get(site_id, set())
        newly_covered = covered - covered_so_far
        covered_so_far.update(newly_covered)
        lat, lon = instance.coords_dict.get(site_id, (None, None))
        rows.append(
            SiteResult(
                municipio_id=site_id,
                municipio_nome=instance.names_dict.get(site_id, str(site_id)),
                municipio_uf=instance.uf_dict.get(site_id, ""),
                populacao_local=float(instance.demand_dict.get(site_id, 0)),
                populacao_nova_coberta=float(sum(instance.demand_dict.get(value, 0) for value in newly_covered)),
                latitude=lat,
                longitude=lon,
            )
        )

    return rows


def solution_map_payload(instance: MCLPInstance, selected_sites: list[int]) -> MapPayload:
    selected_set = set(selected_sites)
    status_dict = {municipio_id: "Uncovered" for municipio_id in instance.demand_nodes}
    city_covering_campuses: dict[int, list[str]] = {}
    shapefile = data_loader.load_shapefile(
        local_config.SHAPEFILE_FILE,
        uf_filter=_normalize_uf(instance.config.target_uf),
        tolerance=0.005,
    )

    def register_coverage(site_id: int, suffix: str) -> None:
        site_name = instance.names_dict.get(site_id, str(site_id))
        for city_id in instance.coverage_map.get(site_id, set()):
            city_covering_campuses.setdefault(city_id, []).append(f"{site_name}{suffix}")

    for site_id in instance.existing_site_ids:
        if site_id in status_dict:
            status_dict[site_id] = "Existing_Site"
        for covered in instance.coverage_map.get(site_id, set()):
            if covered in status_dict and status_dict[covered] != "Existing_Site":
                status_dict[covered] = "Existing_Covered"
        register_coverage(site_id, " (Existente)")

    for site_id in selected_sites:
        was_covered = status_dict.get(site_id) == "Existing_Covered"
        if status_dict.get(site_id) != "Existing_Site":
            status_dict[site_id] = "New_Site_Overlapping" if was_covered else "New_Site"
        for covered in instance.coverage_map.get(site_id, set()):
            current_status = status_dict.get(covered)
            if current_status not in {"Existing_Site", "Existing_Covered", "New_Site", "New_Site_Overlapping"}:
                status_dict[covered] = "New_Covered"
        register_coverage(site_id, " (Novo)")

    points: list[MapPoint] = []
    areas: list[MapArea] = []
    for municipio_id in instance.demand_nodes:
        coords = instance.coords_dict.get(municipio_id)
        if not coords:
            continue
        lat, lon = coords
        points.append(
            MapPoint(
                municipio_id=municipio_id,
                municipio_nome=instance.names_dict.get(municipio_id, str(municipio_id)),
                municipio_uf=instance.uf_dict.get(municipio_id, ""),
                latitude=float(lat),
                longitude=float(lon),
                demanda=float(instance.demand_dict.get(municipio_id, 0)),
                status=status_dict.get(municipio_id, "Uncovered"),
                covering_campuses=", ".join(sorted(city_covering_campuses.get(municipio_id, []))) or "Nenhum",
                is_selected_site=municipio_id in selected_set,
                is_existing_site=municipio_id in instance.existing_site_ids,
            )
        )

    if shapefile is not None and not shapefile.empty:
        if shapefile.crs and shapefile.crs != "EPSG:4326":
            shapefile = shapefile.to_crs("EPSG:4326")
        for row in shapefile.itertuples(index=False):
            municipio_id = int(getattr(row, "id"))
            if municipio_id not in status_dict:
                continue
            areas.append(
                MapArea(
                    municipio_id=municipio_id,
                    municipio_nome=instance.names_dict.get(municipio_id, str(municipio_id)),
                    municipio_uf=instance.uf_dict.get(municipio_id, getattr(row, "SIGLA_UF", "")),
                    demanda=float(instance.demand_dict.get(municipio_id, 0)),
                    status=status_dict.get(municipio_id, "Uncovered"),
                    polygons=_geometry_to_polygons(getattr(row, "geometry", None)),
                    covering_campuses=", ".join(sorted(city_covering_campuses.get(municipio_id, []))) or "Nenhum",
                    is_selected_site=municipio_id in selected_set,
                    is_existing_site=municipio_id in instance.existing_site_ids,
                )
            )

    return MapPayload(
        points=points,
        areas=areas,
        selected_site_ids=sorted(int(value) for value in selected_set),
        existing_site_ids=sorted(int(value) for value in instance.existing_site_ids),
    )

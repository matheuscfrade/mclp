from __future__ import annotations

import random
import time
from collections.abc import Callable

import numpy as np

import heuristics as local_heuristics

from .instance import MCLPInstance, evaluate_solution, solution_map_payload, solution_sites
from .models import MethodParams, OptimizationResult, ProgressCallback, ProgressPoint


def _result(
    instance: MCLPInstance,
    method: str,
    status: str,
    selected: list[int],
    started_at: float,
    trace: list[ProgressPoint],
    message: str = "",
) -> OptimizationResult:
    z = evaluate_solution(instance, selected)
    coverage_percent = (z / instance.total_demand * 100) if instance.total_demand else 0.0
    return OptimizationResult(
        method=method,
        status=status,  # type: ignore[arg-type]
        z=z,
        selected_sites=[int(value) for value in selected],
        runtime_seconds=time.time() - started_at,
        coverage_percent=coverage_percent,
        new_covered_demand=max(0.0, z - instance.initial_z),
        progress_trace=trace,
        message=message,
        sites=solution_sites(instance, selected),
        map_payload=solution_map_payload(instance, selected),
    )


def run_greedy(instance: MCLPInstance, params: MethodParams, progress: ProgressCallback | None = None) -> OptimizationResult:
    started = time.time()
    trace: list[ProgressPoint] = []

    def callback(step: int, total: int, metrics: dict) -> None:
        z = float(metrics.get("z", 0))
        trace.append(ProgressPoint(step=step, z=z, method="greedy", elapsed_seconds=time.time() - started))
        if progress:
            progress("greedy", step, total, metrics)

    selected = local_heuristics.greedy_heuristic(
        instance.candidates,
        instance.config.p,
        instance.cov_matrix,
        instance.demand_vector,
        instance.cand_to_idx,
        instance.initial_coverage,
        progress_callback=callback,
    )
    return _result(instance, "greedy", "completed", selected, started, trace, "Solução inicial gulosa (greedy)")


def run_local_search(
    instance: MCLPInstance,
    params: MethodParams,
    progress: ProgressCallback | None = None,
    initial_solution: list[int] | None = None,
) -> OptimizationResult:
    started = time.time()
    trace: list[ProgressPoint] = []
    if initial_solution is None:
        initial_solution = run_greedy(instance, params).selected_sites
    if params.seed is not None:
        random.seed(params.seed)
        np.random.seed(params.seed)
    trace.append(
        ProgressPoint(
            step=0,
            z=evaluate_solution(instance, initial_solution),
            method="local_search",
            elapsed_seconds=0.0,
        )
    )

    def callback(step: int, total: int, metrics: dict) -> None:
        z = float(metrics.get("z", 0))
        trace.append(ProgressPoint(step=step, z=z, method="local_search", elapsed_seconds=time.time() - started))
        if progress:
            progress("local_search", step, total, metrics)

    selected, _ = local_heuristics.local_search(
        initial_solution,
        instance.candidates,
        instance.cov_matrix,
        instance.demand_vector,
        instance.cand_to_idx,
        instance.initial_coverage,
        max_iter=params.max_iter,
        strategy=params.strategy,
        progress_callback=callback,
    )
    initial_z = trace[0].z if trace else 0
    final_z = evaluate_solution(instance, selected)
    msg = "Nenhuma melhoria encontrada na busca local" if final_z <= initial_z else "Busca local aplicada (melhoria incremental)"
    return _result(instance, "local_search", "completed", selected, started, trace, msg)


def run_vns(
    instance: MCLPInstance,
    params: MethodParams,
    progress: ProgressCallback | None = None,
    initial_solution: list[int] | None = None,
) -> OptimizationResult:
    started = time.time()
    trace: list[ProgressPoint] = []
    if initial_solution is None:
        initial_solution = run_local_search(instance, params).selected_sites
    if params.seed is not None:
        random.seed(params.seed)
        np.random.seed(params.seed)
    trace.append(
        ProgressPoint(
            step=0,
            z=evaluate_solution(instance, initial_solution),
            method="vns",
            elapsed_seconds=0.0,
        )
    )

    def callback(step: int, total: int, metrics: dict) -> None:
        z = float(metrics.get("z", 0))
        trace.append(ProgressPoint(step=step, z=z, method="vns", elapsed_seconds=time.time() - started))
        if progress:
            progress("vns", step, total, metrics)

    selected, _ = local_heuristics.vns(
        initial_solution,
        instance.candidates,
        instance.coverage_map,
        instance.demand_dict,
        instance.pre_covered,
        k_max=min(params.k_max, instance.config.p),
        max_iter=params.max_iter,
        max_no_improv=params.max_no_improv,
        max_time_seconds=params.time_limit,
        ls_strategy=params.strategy,
        progress_callback=callback,
        sparse_structures=(
            instance.cov_matrix,
            instance.demand_vector,
            instance.cand_to_idx,
            instance.node_to_idx,
            instance.initial_coverage,
        ),
    )
    initial_z = trace[0].z if trace else 0
    final_z = evaluate_solution(instance, selected)
    msg = "Nenhuma melhoria adicional encontrada no VNS" if final_z <= initial_z else "VNS aplicado (busca em vizinhanças)"
    return _result(instance, "vns", "completed", selected, started, trace, msg)


def run_genetic(
    instance: MCLPInstance,
    params: MethodParams,
    progress: ProgressCallback | None = None,
    initial_solution: list[int] | None = None,
) -> OptimizationResult:
    started = time.time()
    rng = random.Random(params.seed)
    trace: list[ProgressPoint] = []
    p = min(instance.config.p, len(instance.candidates))
    if p <= 0:
        return _result(instance, "genetic", "error", [], started, trace, "Sem candidatos disponiveis.")

    candidates = list(instance.candidates)
    population_size = max(4, params.population_size)
    elitism = max(1, min(params.elitism, population_size - 1))
    if initial_solution:
        trace.append(
            ProgressPoint(
                step=0,
                z=evaluate_solution(instance, initial_solution),
                method="genetic",
                elapsed_seconds=0.0,
            )
        )

    def normalize(individual: list[int]) -> list[int]:
        unique = list(dict.fromkeys(individual))
        missing = [candidate for candidate in candidates if candidate not in unique]
        while len(unique) < p and missing:
            choice = rng.choice(missing)
            missing.remove(choice)
            unique.append(choice)
        return unique[:p]

    def fitness(individual: list[int]) -> float:
        return evaluate_solution(instance, individual)

    def tournament(scored: list[tuple[float, list[int]]], size: int = 3) -> list[int]:
        contenders = rng.sample(scored, k=min(size, len(scored)))
        return max(contenders, key=lambda item: item[0])[1][:]

    def crossover(parent_a: list[int], parent_b: list[int]) -> list[int]:
        if rng.random() > params.crossover_rate:
            return parent_a[:]
        pool = list(dict.fromkeys(parent_a + parent_b))
        rng.shuffle(pool)
        return normalize(pool)

    def mutate(individual: list[int]) -> list[int]:
        mutated = individual[:]
        if rng.random() <= params.mutation_rate:
            pos = rng.randrange(len(mutated))
            available = [candidate for candidate in candidates if candidate not in mutated]
            if available:
                mutated[pos] = rng.choice(available)
        return normalize(mutated)

    population: list[list[int]] = []
    if initial_solution:
        # No fluxo sequencial, a melhor solução anterior entra como indivíduo elite.
        # O restante da população continua aleatório para preservar diversidade.
        population.append(normalize(initial_solution))
    while len(population) < population_size:
        population.append(rng.sample(candidates, k=p))
    best_solution = population[0]
    best_z = fitness(best_solution)

    for generation in range(params.generations):
        if params.time_limit and time.time() - started >= params.time_limit:
            break

        scored = sorted(((fitness(individual), individual) for individual in population), key=lambda item: item[0], reverse=True)
        if scored[0][0] > best_z:
            best_z, best_solution = scored[0][0], scored[0][1][:]

        trace.append(
            ProgressPoint(
                step=generation + 1,
                z=best_z,
                method="genetic",
                elapsed_seconds=time.time() - started,
            )
        )
        if progress:
            progress("genetic", generation + 1, params.generations, {"z": best_z})

        next_population = [individual[:] for _, individual in scored[:elitism]]
        while len(next_population) < population_size:
            child = crossover(tournament(scored), tournament(scored))
            next_population.append(mutate(child))
        population = next_population

    initial_z = trace[0].z if trace else 0
    msg = "Algoritmo genético convergiu" if best_z > initial_z else "Algoritmo genético (sem melhoria sobre inicial)"
    return _result(instance, "genetic", "completed", best_solution, started, trace, msg)


def run_exact(instance: MCLPInstance, params: MethodParams, progress: ProgressCallback | None = None, initial_solution: list[int] | None = None) -> OptimizationResult:
    started = time.time()
    trace: list[ProgressPoint] = []
    try:
        import pulp
    except ImportError:
        return _result(instance, "exact", "error", [], started, trace, "Dependencia 'pulp' nao instalada.")

    p = min(instance.config.p, len(instance.candidates))
    candidates = instance.candidates
    nodes = [node for node in instance.demand_nodes if instance.demand_dict.get(node, 0) > 0]
    idx_to_cand = {idx: cand for cand, idx in instance.cand_to_idx.items()}

    csc = instance.cov_matrix.tocsc()
    coverers: dict[int, list[int]] = {}
    for node in nodes:
        node_idx = instance.node_to_idx[node]
        candidate_indices = csc[:, node_idx].indices
        coverers[node] = [idx_to_cand[int(index)] for index in candidate_indices if int(index) in idx_to_cand]

    problem = pulp.LpProblem("MCLP", pulp.LpMaximize)
    x = pulp.LpVariable.dicts("x", candidates, cat="Binary")
    y = pulp.LpVariable.dicts("y", nodes, cat="Binary")

    problem += pulp.lpSum(instance.demand_dict[node] * y[node] for node in nodes)
    problem += pulp.lpSum(x[candidate] for candidate in candidates) == p

    # Warm-start from best heuristic (if provided) - helps CBC find good solutions faster
    if initial_solution:
        initial_set = set(initial_solution)
        for candidate in candidates:
            x[candidate].setInitialValue(1 if candidate in initial_set else 0)

    for node in nodes:
        if node in instance.pre_covered:
            problem += y[node] == 1
        elif coverers[node]:
            problem += y[node] <= pulp.lpSum(x[candidate] for candidate in coverers[node])
        else:
            problem += y[node] == 0

    solver = pulp.PULP_CBC_CMD(msg=False, timeLimit=max(1, int(params.time_limit)))
    problem.solve(solver)
    elapsed = time.time() - started
    pulp_status = pulp.LpStatus.get(problem.status, "Unknown")

    selected = [int(candidate) for candidate in candidates if pulp.value(x[candidate]) and pulp.value(x[candidate]) > 0.5]
    status = "optimal" if pulp_status == "Optimal" else "feasible"
    if pulp_status == "Infeasible":
        status = "infeasible"
    elif pulp_status in {"Not Solved", "Undefined"} and elapsed >= params.time_limit:
        status = "time_limit"
    elif pulp_status not in {"Optimal", "Not Solved"} and not selected:
        status = "error"

    trace.append(ProgressPoint(step=1, z=evaluate_solution(instance, selected), method="exact", elapsed_seconds=elapsed))
    if progress:
        progress("exact", 1, 1, {"z": trace[-1].z, "status": pulp_status})
    return _result(instance, "exact", status, selected, started, trace, f"PuLP/CBC: {pulp_status}")


METHOD_RUNNERS: dict[str, Callable[[MCLPInstance, MethodParams, ProgressCallback | None], OptimizationResult]] = {
    "greedy": run_greedy,
    "exact": run_exact,
}


def run_methods(instance: MCLPInstance, progress: ProgressCallback | None = None) -> list[OptimizationResult]:
    results: list[OptimizationResult] = []
    greedy_solution: list[int] | None = None
    local_solution: list[int] | None = None
    best_heuristic_solution: list[int] | None = None
    best_heuristic_z = float("-inf")

    requested_methods = set(instance.config.methods)
    heuristic_order = ["greedy", "local_search", "vns", "genetic"]
    ordered_methods = [method for method in heuristic_order if method in requested_methods]
    if any(method in requested_methods for method in heuristic_order[1:]) and "greedy" not in ordered_methods:
        # Toda heurística posterior depende do Greedy como ponto de partida explícito.
        ordered_methods.insert(0, "greedy")
    if "exact" in requested_methods:
        # O modelo matemático é independente e pode rodar sozinho ou após as heurísticas.
        ordered_methods.append("exact")

    for method in ordered_methods:
        params = instance.config.method_params.get(method, MethodParams())
        if method == "greedy":
            result = run_greedy(instance, params, progress)
            greedy_solution = result.selected_sites
        elif method == "local_search":
            result = run_local_search(instance, params, progress, greedy_solution)
            local_solution = result.selected_sites
        elif method == "vns":
            initial = (local_solution or greedy_solution) if instance.config.execution_mode == "sequential" else greedy_solution
            result = run_vns(instance, params, progress, initial)
        elif method == "genetic":
            initial = best_heuristic_solution if instance.config.execution_mode == "sequential" else greedy_solution
            result = run_genetic(instance, params, progress, initial)
        elif method in METHOD_RUNNERS:
            # Métodos registrados aqui rodam sem receber solução anterior por padrão.
            # Para o exato, passamos a melhor heurística como warm-start quando em modo sequencial.
            initial_for_exact = best_heuristic_solution if (method == "exact" and instance.config.execution_mode == "sequential") else None
            result = METHOD_RUNNERS[method](instance, params, progress, initial_for_exact)
        else:
            result = OptimizationResult(
                method=method,
                status="error",
                z=0,
                selected_sites=[],
                runtime_seconds=0,
                coverage_percent=0,
                new_covered_demand=0,
                message=f"Metodo desconhecido: {method}",
            )
        results.append(result)
        if method != "exact" and result.status != "error" and result.z >= best_heuristic_z:
            best_heuristic_z = result.z
            best_heuristic_solution = result.selected_sites

    _attach_optimality_gaps(results)
    return results


def _attach_optimality_gaps(results: list[OptimizationResult]) -> None:
    """
    Post-process results to make heuristics and exact complementary.

    If an exact result is present (either "optimal" or "feasible"), attach:
      - gap_to_optimal (percentage worse than the reference Z from exact)
      - reference_z (the best Z reported by the exact model)

    When the exact is "feasible" (not proven), the gap is relative to the
    best *known* solution from the MIP. The UI can label it accordingly
    (e.g. "melhor Z conhecido pelo exato").
    """
    if not results:
        return

    exact_ref = next(
        (r for r in results if r.method == "exact" and r.z > 0 and r.status in ("optimal", "feasible")),
        None,
    )
    if exact_ref is None:
        return

    ref_z = exact_ref.z

    for r in results:
        if r.status == "error" or r.z < 0:
            continue

        if r.method == "exact":
            r.gap_to_optimal = 0.0
            r.reference_z = ref_z
        else:
            gap = (ref_z - r.z) / ref_z * 100.0
            r.gap_to_optimal = round(max(0.0, gap), 4)
            r.reference_z = ref_z

from __future__ import annotations

import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict

from core.algorithms import run_methods
from core.instance import build_instance
from core.models import MethodParams, RunResult, ScenarioConfig

from .schemas import RunCreatePayload


class JobStore:
    def __init__(self) -> None:
        self._runs: dict[str, RunResult] = {}
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=2)

    def create(
        self,
        payload: RunCreatePayload,
        demand_file: str | None = None,
        existing_sites_file: str | None = None,
        run_id: str | None = None,
    ) -> RunResult:
        run_id = run_id or str(uuid.uuid4())
        config = ScenarioConfig(
            p=payload.p,
            metric=payload.metric,
            radius_km=payload.radius_km,
            max_time_h=payload.max_time_h,
            target_uf=payload.target_uf,
            greenfield=payload.greenfield,
            demand_file=demand_file,
            demand_col=payload.demand_col,
            existing_sites_file=existing_sites_file,
            methods=payload.methods,
            method_params={
                name: MethodParams(**params.model_dump())
                for name, params in payload.method_params.items()
            },
            execution_mode=payload.execution_mode,
        )
        run = RunResult(run_id=run_id, status="queued", config=config)
        with self._lock:
            self._runs[run_id] = run
        self._executor.submit(self._execute, run_id)
        return run

    def get(self, run_id: str) -> RunResult | None:
        with self._lock:
            return self._runs.get(run_id)

    def _append_log(self, run_id: str, message: str) -> None:
        with self._lock:
            run = self._runs[run_id]
            run.logs.append(message)

    def _update_progress(self, run_id: str, method: str, step: int, total: int, z: float, status: str = "running") -> None:
        total = max(1, int(total or 1))
        step = max(0, min(int(step or 0), total))
        with self._lock:
            run = self._runs[run_id]
            last_logged = run.progress.get(method, {}).get("last_logged_step", -1)
            run.progress[method] = {
                "method": method,
                "step": step,
                "total": total,
                "z": float(z or 0),
                "percent": round((step / total) * 100, 1),
                "status": status,
                "last_logged_step": last_logged,
            }

    def _should_log_progress(self, run_id: str, method: str, step: int, total: int) -> bool:
        total = max(1, int(total or 1))
        if step <= 0 or step >= total:
            return True
        interval = max(1, total // 10)
        with self._lock:
            current = self._runs[run_id].progress.get(method, {})
            last_logged = int(current.get("last_logged_step", -1))
            should_log = step - last_logged >= interval
            if should_log:
                current["last_logged_step"] = step
                self._runs[run_id].progress[method] = current
            return should_log

    def _execute(self, run_id: str) -> None:
        with self._lock:
            run = self._runs[run_id]
            run.status = "running"

        try:
            self._append_log(run_id, "Carregando dados e construindo instancia MCLP.")
            instance = build_instance(run.config)

            def progress(method: str, step: int, total: int, metrics: dict) -> None:
                z = metrics.get("z", 0)
                self._update_progress(run_id, method, step, total, z)
                if self._should_log_progress(run_id, method, step, total):
                    self._append_log(run_id, f"{method}: passo {step}/{total}, Z={z:,.0f}")

            results = run_methods(instance, progress=progress)
            with self._lock:
                run = self._runs[run_id]
                run.results = results
                run.status = "completed"
                for result in results:
                    previous_progress = run.progress.get(result.method, {})
                    total = int(previous_progress.get("total") or len(result.progress_trace) or 1)
                    run.progress[result.method] = {
                        "method": result.method,
                        "step": total,
                        "total": total,
                        "z": result.z,
                        "percent": 100,
                        "status": result.status,
                    }
                run.logs.append("Execucao concluida.")
        except Exception as exc:
            details = traceback.format_exc()
            with self._lock:
                run = self._runs[run_id]
                run.status = "failed"
                run.error = str(exc)
                run.logs.append(f"Erro: {exc}")
                run.logs.extend(details.rstrip().splitlines()[-8:])

    def snapshot(self, run_id: str) -> dict | None:
        run = self.get(run_id)
        if not run:
            return None
        return asdict(run)


store = JobStore()

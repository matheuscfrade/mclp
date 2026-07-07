from __future__ import annotations

import io
import json
import sys
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Any

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(errors="replace")

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

import config as local_config
from core.exports import to_map_html_bytes, to_pdf_bytes, to_xlsx_bytes
from core.files import demand_template_bytes, existing_sites_template_bytes, preview_tabular

from .jobs import store
from .schemas import RunCreatePayload, RunCreateResponse

app = FastAPI(title="MCLP API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/runs", response_model=RunCreateResponse)
def create_run(payload: RunCreatePayload) -> RunCreateResponse:
    run = store.create(payload)
    return RunCreateResponse(run_id=run.run_id, status=run.status)


async def _save_upload(run_id: str, upload: UploadFile | None, prefix: str) -> str | None:
    if upload is None or not upload.filename:
        return None
    suffix = Path(upload.filename).suffix.lower()
    if suffix not in {".csv", ".parquet"}:
        raise HTTPException(status_code=400, detail=f"Formato invalido para {upload.filename}")
    target_dir = local_config.BASE_DIR / "runtime_uploads" / run_id
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{prefix}{suffix}"
    target.write_bytes(await upload.read())
    return str(target)


@app.post("/api/runs/upload", response_model=RunCreateResponse)
async def create_run_upload(
    payload: str = Form(...),
    demand_file: UploadFile | None = File(default=None),
    existing_sites_file: UploadFile | None = File(default=None),
) -> RunCreateResponse:
    try:
        parsed_payload = RunCreatePayload(**json.loads(payload))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Payload invalido: {exc}") from exc
    run_id = str(uuid.uuid4())
    demand_path = await _save_upload(run_id, demand_file, "demand")
    existing_path = await _save_upload(run_id, existing_sites_file, "existing_sites")
    run = store.create(parsed_payload, demand_file=demand_path, existing_sites_file=existing_path, run_id=run_id)
    return RunCreateResponse(run_id=run.run_id, status=run.status)


@app.get("/api/templates/demand.csv")
def demand_template() -> StreamingResponse:
    return StreamingResponse(
        io.BytesIO(demand_template_bytes()),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="template_demanda.csv"'},
    )


@app.get("/api/templates/existing-sites.csv")
def existing_sites_template() -> StreamingResponse:
    return StreamingResponse(
        io.BytesIO(existing_sites_template_bytes()),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="template_cobertura_inicial.csv"'},
    )


@app.post("/api/files/preview")
async def preview_file(file: UploadFile = File(...)) -> dict:
    run_id = f"preview-{uuid.uuid4()}"
    path = await _save_upload(run_id, file, "preview")
    if path is None:
        raise HTTPException(status_code=400, detail="Arquivo ausente")
    return preview_tabular(path)


@app.get("/api/runs/{run_id}")
def get_run(run_id: str) -> dict:
    snapshot = store.snapshot(run_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Run not found")
    snapshot["results"] = [
        {
            "method": result["method"],
            "status": result["status"],
            "z": result["z"],
            "runtime_seconds": result["runtime_seconds"],
            "coverage_percent": result["coverage_percent"],
            "new_covered_demand": result["new_covered_demand"],
            "message": result["message"],
            "gap_to_optimal": result.get("gap_to_optimal"),
            "reference_z": result.get("reference_z"),
        }
        for result in snapshot["results"]
    ]
    return snapshot


@app.get("/api/runs/{run_id}/results")
def get_results(
    run_id: str,
    include_maps: bool = Query(default=False),
    max_trace_points: int = Query(default=800, ge=50, le=5000),
) -> dict:
    snapshot = store.snapshot(run_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Run not found")
    for result in snapshot["results"]:
        result["progress_trace"] = _thin_trace(result.get("progress_trace", []), max_trace_points)
        if not include_maps:
            result["map_payload"] = _empty_map_payload(result.get("map_payload", {}))
    return snapshot


@app.get("/api/runs/{run_id}/results/{method}/map")
def get_result_map(run_id: str, method: str) -> dict:
    run = store.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    result = next((item for item in run.results if item.method == method), None)
    if result is None:
        raise HTTPException(status_code=404, detail="Method result not found")
    return asdict(result.map_payload)


def _thin_trace(trace: list[dict[str, Any]], max_points: int) -> list[dict[str, Any]]:
    if len(trace) <= max_points:
        return trace
    if max_points <= 2:
        return [trace[0], trace[-1]]
    step = (len(trace) - 1) / (max_points - 1)
    indexes = {round(i * step) for i in range(max_points)}
    indexes.add(0)
    indexes.add(len(trace) - 1)
    return [trace[index] for index in sorted(indexes)]


def _empty_map_payload(map_payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "points": [],
        "areas": [],
        "selected_site_ids": map_payload.get("selected_site_ids", []),
        "existing_site_ids": map_payload.get("existing_site_ids", []),
    }


def _completed_run(run_id: str):
    run = store.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.status != "completed":
        raise HTTPException(status_code=409, detail="Run is not completed")
    return run


@app.get("/api/runs/{run_id}/exports/xlsx")
def export_xlsx(run_id: str) -> StreamingResponse:
    run = _completed_run(run_id)
    return StreamingResponse(
        io.BytesIO(to_xlsx_bytes(run)),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="mclp_{run_id}.xlsx"'},
    )


@app.get("/api/runs/{run_id}/exports/report")
def export_report(run_id: str) -> StreamingResponse:
    run = _completed_run(run_id)
    pdf_bytes = to_pdf_bytes(run)

    # Defensive check: if we somehow got non-PDF content (should not happen after the
    # fixes in core/exports.py), return a clear error instead of a corrupt .pdf file.
    if not pdf_bytes.startswith(b"%PDF"):
        raise HTTPException(
            status_code=500,
            detail="Falha ao gerar PDF. Instale 'fpdf2' (pip install fpdf2) e reinicie o servidor.",
        )

    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="mclp_{run_id}.pdf"'},
    )


@app.get("/api/runs/{run_id}/exports/map-coverage")
def export_coverage_map(run_id: str, method: str | None = Query(default=None)) -> StreamingResponse:
    run = _completed_run(run_id)
    return StreamingResponse(
        io.BytesIO(to_map_html_bytes(run, method, "coverage")),
        media_type="text/html",
        headers={"Content-Disposition": f'attachment; filename="mclp_{run_id}_mapa_cobertura.html"'},
    )


@app.get("/api/runs/{run_id}/exports/map-demand")
def export_demand_map(run_id: str, method: str | None = Query(default=None)) -> StreamingResponse:
    run = _completed_run(run_id)
    return StreamingResponse(
        io.BytesIO(to_map_html_bytes(run, method, "demand")),
        media_type="text/html",
        headers={"Content-Disposition": f'attachment; filename="mclp_{run_id}_mapa_demanda.html"'},
    )

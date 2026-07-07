from __future__ import annotations

import io
import json
from dataclasses import asdict
from html import escape

import pandas as pd

from .models import RunResult

# fpdf2 is published on PyPI as 'fpdf2' but imports as 'fpdf'.
# The legacy 'fpdf' package (<2.x) can produce broken PDFs with accented text.
try:
    import fpdf as _fpdf_pkg
    from fpdf import FPDF as _FPDF
except ImportError:
    _FPDF = None
    _fpdf_pkg = None

FPDF = _FPDF

if FPDF is not None and _fpdf_pkg is not None:
    version = str(getattr(_fpdf_pkg, "__version__", "0"))
    try:
        major = int(version.split(".")[0])
    except (ValueError, IndexError):
        major = 0
    if major < 2:
        FPDF = None


def results_dataframe(run: RunResult) -> pd.DataFrame:
    rows = []
    for result in run.results:
        rows.append(
            {
                "Metodo": result.method,
                "Status": result.status,
                "Z": result.z,
                "Cobertura_%": result.coverage_percent,
                "Demanda_Nova_Coberta": result.new_covered_demand,
                "Tempo_s": result.runtime_seconds,
                "Mensagem": result.message,
            }
        )
    return pd.DataFrame(rows)


def solution_dataframe(run: RunResult) -> pd.DataFrame:
    rows = []
    for result in run.results:
        for site in result.sites:
            row = asdict(site)
            row["metodo"] = result.method
            row["z_metodo"] = result.z
            rows.append(row)
    return pd.DataFrame(rows)


def to_xlsx_bytes(run: RunResult) -> bytes:
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        results_dataframe(run).to_excel(writer, index=False, sheet_name="Comparacao")
        solution_dataframe(run).to_excel(writer, index=False, sheet_name="Solucoes")
    return output.getvalue()


def _safe_pdf_text(text: str | None) -> str:
    """Sanitize text for PDF output to avoid UnicodeEncodeError with core fonts like Helvetica.
    Accented Brazilian municipality names (São, Paraná, etc.) are common in the data.
    """
    if not text:
        return ""
    # Replace chars not representable in latin-1 with '?'
    return str(text).encode("latin-1", errors="replace").decode("latin-1")


def _pdf_multicell(pdf: FPDF, h: float, text: str) -> None:
    """Render wrapped text using the full printable width.

    fpdf2 treats w=0 as the remaining space from the current x position to the
    right margin. After table rows that can leave too little room for long lines
    and trigger: "Not enough horizontal space to render a single character".
    """
    pdf.set_x(pdf.l_margin)
    pdf.multi_cell(
        pdf.epw,
        h,
        text,
        new_x="LMARGIN",
        new_y="NEXT",
        wrapmode="CHAR",
    )


def _pdf_table_widths(pdf: FPDF, widths: list[float]) -> list[float]:
    total = sum(widths)
    if total <= pdf.epw:
        return widths
    scale = pdf.epw / total
    return [width * scale for width in widths]


def to_pdf_bytes(run: RunResult) -> bytes:
    """Generate a simple PDF report.

    Always returns valid PDF bytes (never plain text).
    Strongly prefers fpdf2 (see pyproject.toml). The legacy 'fpdf' package
    is only used as a last resort and can produce unopenable PDFs with
    accented Brazilian place names.
    """
    if FPDF is None:
        # No PDF library at all — return a minimal valid PDF containing the error.
        # This way the user still gets a downloadable .pdf that opens and explains the problem.
        minimal_pdf = (
            b"%PDF-1.4\n"
            b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
            b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
            b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n"
            b"4 0 obj<</Length 180>>stream\n"
            b"BT /F1 14 Tf 50 750 Td (PDF export temporariamente indisponivel.) Tj ET\n"
            b"BT /F1 11 Tf 50 720 Td (Instale: pip install fpdf2) Tj ET\n"
            b"BT /F1 11 Tf 50 700 Td (Depois reinicie o servidor.) Tj ET\n"
            b"endstream\nendobj\n"
            b"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n"
            b"xref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000266 00000 n \n0000000430 00000 n \n"
            b"trailer<</Size 6/Root 1 0 R>>\n"
            b"startxref\n550\n"
            b"%%EOF\n"
        )
        return minimal_pdf

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()

    # Use Helvetica (built-in, reliable). "Arial" is not guaranteed in fpdf2 without add_font.
    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(0, 10, _safe_pdf_text("Relatorio MCLP"), new_x="LMARGIN", new_y="NEXT")

    pdf.set_font("Helvetica", "", 10)
    _pdf_multicell(
        pdf,
        6,
        _safe_pdf_text(
            "Execucao: {}\nStatus: {}\nP: {} | Metrica: {} | UF: {}".format(
                run.run_id,
                run.status,
                run.config.p,
                run.config.metric,
                run.config.target_uf or "Brasil",
            )
        ),
    )
    pdf.ln(4)

    pdf.set_font("Helvetica", "B", 12)
    pdf.set_x(pdf.l_margin)
    pdf.cell(pdf.epw, 8, _safe_pdf_text("Comparacao dos metodos"), new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "B", 9)

    widths = _pdf_table_widths(pdf, [32, 28, 32, 30, 30, 30])
    headers = ["Metodo", "Status", "Z", "Cob. %", "Nova Dem.", "Tempo"]
    pdf.set_x(pdf.l_margin)
    for header, width in zip(headers, widths, strict=False):
        pdf.cell(width, 7, _safe_pdf_text(header), border=1)
    pdf.ln()

    pdf.set_font("Helvetica", "", 9)
    for result in run.results:
        values = [
            _safe_pdf_text(result.method),
            _safe_pdf_text(result.status),
            f"{result.z:,.0f}".replace(",", "."),
            f"{result.coverage_percent:.2f}".replace(".", ","),
            f"{result.new_covered_demand:,.0f}".replace(",", "."),
            f"{result.runtime_seconds:.2f}".replace(".", ","),
        ]
        pdf.set_x(pdf.l_margin)
        for value, width in zip(values, widths, strict=False):
            pdf.cell(width, 7, str(value)[:24], border=1)
        pdf.ln()

    pdf.ln(5)
    pdf.set_font("Helvetica", "B", 12)
    pdf.set_x(pdf.l_margin)
    pdf.cell(pdf.epw, 8, _safe_pdf_text("Locais selecionados"), new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 9)
    for result in run.results:
        pdf.set_font("Helvetica", "B", 10)
        pdf.set_x(pdf.l_margin)
        pdf.cell(pdf.epw, 7, _safe_pdf_text(result.method), new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 9)
        for site in result.sites[:30]:
            safe_nome = _safe_pdf_text(site.municipio_nome)
            safe_uf = _safe_pdf_text(site.municipio_uf)
            _pdf_multicell(
                pdf,
                5,
                "- {} ({}) | ID {} | nova demanda: {}".format(
                    safe_nome,
                    safe_uf,
                    site.municipio_id,
                    f"{site.populacao_nova_coberta:,.0f}".replace(",", "."),
                ),
            )
        if len(result.sites) > 30:
            pdf.set_x(pdf.l_margin)
            pdf.cell(
                pdf.epw,
                5,
                f"... {len(result.sites) - 30} locais adicionais omitidos.",
                new_x="LMARGIN",
                new_y="NEXT",
            )

    # fpdf2 returns bytes for dest="S". Legacy fpdf may return str.
    pdf_bytes = pdf.output(dest="S")
    if isinstance(pdf_bytes, str):
        pdf_bytes = pdf_bytes.encode("latin-1", errors="replace")
    return pdf_bytes


def _status_color(status: str) -> str:
    return {
        "Existing_Site": "#0b3c6f",
        "Existing_Covered": "#4d8fcb",
        "New_Site": "#0f7b4d",
        "New_Site_Overlapping": "#db9f16",
        "New_Covered": "#7cc27e",
        "Uncovered": "#c0c8cd",
    }.get(status, "#c0c8cd")


def _demand_color(demand: float, max_demand: float) -> str:
    if max_demand <= 0:
        return "#d9dee2"
    ratio = max(0.0, min(1.0, demand / max_demand))
    green = round(220 - 180 * ratio)
    blue = round(180 - 180 * ratio)
    return f"rgb(235,{green},{blue})"


def _project(lon: float, lat: float, bounds: dict[str, float]) -> tuple[float, float]:
    width = 1000
    height = 620
    x = ((lon - bounds["min_lon"]) / max(0.0001, bounds["max_lon"] - bounds["min_lon"])) * width
    y = height - ((lat - bounds["min_lat"]) / max(0.0001, bounds["max_lat"] - bounds["min_lat"])) * height
    return x, y


def _map_bounds(areas) -> dict[str, float]:
    coords = []
    for area in areas:
        for polygon in area.polygons:
            for ring in polygon:
                coords.extend(ring)
    if not coords:
        return {"min_lon": -74, "max_lon": -34, "min_lat": -34, "max_lat": 6}
    return {
        "min_lon": min(point[0] for point in coords),
        "max_lon": max(point[0] for point in coords),
        "min_lat": min(point[1] for point in coords),
        "max_lat": max(point[1] for point in coords),
    }


def _ring_path(ring: list[list[float]], bounds: dict[str, float]) -> str:
    projected = [_project(lon, lat, bounds) for lon, lat in ring]
    if not projected:
        return ""
    first_x, first_y = projected[0]
    rest = " ".join(f"L {x:.3f} {y:.3f}" for x, y in projected[1:])
    return f"M {first_x:.3f} {first_y:.3f} {rest} Z"


def to_map_html_bytes(run: RunResult, method: str | None, mode: str) -> bytes:
    result = next((item for item in run.results if item.method == method), None) if method else None
    if result is None and run.results:
        result = max(run.results, key=lambda item: item.z)
    if result is None:
        return b""

    areas = result.map_payload.areas
    max_demand = max((area.demanda for area in areas), default=0)
    title = "Mapa de Cobertura" if mode == "coverage" else "Mapa de Calor da Demanda"

    features = []
    for area in areas:
        fill = _status_color(area.status) if mode == "coverage" else _demand_color(area.demanda, max_demand)
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "nome": area.municipio_nome,
                    "uf": area.municipio_uf,
                    "demanda": area.demanda,
                    "status": area.status,
                    "covering_campuses": area.covering_campuses,
                    "fill": fill,
                },
                "geometry": {"type": "MultiPolygon", "coordinates": area.polygons},
            }
        )

    geojson = json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False)

    html = f"""<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <title>{escape(title)} - MCLP</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    body {{ margin: 0; font-family: Arial, sans-serif; background: #eef2f4; color: #172026; }}
    main {{ padding: 24px; }}
    h1 {{ font-size: 22px; margin: 0 0 4px; }}
    p {{ margin: 0 0 16px; color: #52636d; }}
    #map {{ height: 78vh; min-height: 520px; border: 1px solid #d6dee3; }}
  </style>
</head>
<body>
  <main>
    <h1>{escape(title)}</h1>
    <p>Método: {escape(result.method)} | Z: {result.z:,.0f} | Cobertura: {result.coverage_percent:.2f}%</p>
    <div id="map"></div>
  </main>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const data = {geojson};
    const map = L.map("map");
    L.tileLayer("https://{{s}}.basemaps.cartocdn.com/light_all/{{z}}/{{x}}/{{y}}{{r}}.png", {{
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }}).addTo(map);
    const layer = L.geoJSON(data, {{
      style: (feature) => ({{
        fillColor: feature.properties.fill,
        fillOpacity: 0.78,
        color: "#ffffff",
        weight: 0.7
      }}),
      onEachFeature: (feature, layer) => {{
        const p = feature.properties;
        layer.bindTooltip(`<strong>${{p.nome}} - ${{p.uf}}</strong><br/>Demanda: ${{Number(p.demanda).toLocaleString("pt-BR")}}<br/>Status: ${{p.status}}<br/>Coberto por: ${{p.covering_campuses}}`, {{ sticky: true }});
      }}
    }}).addTo(map);
    map.fitBounds(layer.getBounds(), {{ padding: [20, 20] }});
  </script>
</body>
</html>"""
    return html.encode("utf-8")

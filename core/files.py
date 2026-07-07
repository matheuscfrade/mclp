from __future__ import annotations

import unicodedata
from pathlib import Path
from typing import Any

import pandas as pd

import config as local_config

ID_CANDIDATES = ["id", "ID", "Id", "Cód.", "Cod.", "Código", "Codigo", "Code"]


def _normalize(value: str) -> str:
    return "".join(
        char for char in unicodedata.normalize("NFD", value) if unicodedata.category(char) != "Mn"
    ).lower()


def read_tabular(path: str | Path) -> pd.DataFrame:
    path = Path(path)
    if path.suffix.lower() == ".parquet":
        return pd.read_parquet(path)
    try:
        return pd.read_csv(path, sep=None, engine="python", encoding="utf-8", dtype=str)
    except UnicodeDecodeError:
        return pd.read_csv(path, sep=None, engine="python", encoding="latin1", dtype=str)


def preview_tabular(path: str | Path, rows: int = 8) -> dict[str, Any]:
    df = read_tabular(path)
    return {
        "columns": [str(column) for column in df.columns],
        "rows": df.head(rows).fillna("").astype(str).to_dict(orient="records"),
        "row_count": int(len(df)),
    }


def _base_municipality_frame() -> pd.DataFrame:
    df = read_tabular(local_config.DEMAND_FILE)
    id_col = next((column for column in df.columns if column in ID_CANDIDATES), None)
    cols_map = {_normalize(str(column)): column for column in df.columns}
    name_col = cols_map.get("municipio") or cols_map.get("nome")
    uf_col = cols_map.get("uf")
    if not id_col or not name_col:
        return pd.DataFrame({"id": [], "Municipio": [], "UF": []})
    columns = [id_col, name_col] + ([uf_col] if uf_col else [])
    out = df[columns].copy()
    rename_map = {id_col: "id", name_col: "Municipio"}
    if uf_col:
        rename_map[uf_col] = "UF"
    return out.rename(columns=rename_map)


def demand_template_bytes() -> bytes:
    df = _base_municipality_frame()
    df["demanda"] = ""
    return df.to_csv(index=False, sep=";", encoding="utf-8-sig").encode("utf-8-sig")


def existing_sites_template_bytes() -> bytes:
    df = _base_municipality_frame()
    df["possui_campus"] = "N"
    return df.to_csv(index=False, sep=";", encoding="utf-8-sig").encode("utf-8-sig")

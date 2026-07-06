from pathlib import Path

BASE_DIR = Path(__file__).parent.resolve()
LOCAL_DATA_DIR = BASE_DIR / "clean_data"
ROOT_DATA_DIR = BASE_DIR.parent / "clean_data"


def _resolve_data_dir() -> Path:
    if LOCAL_DATA_DIR.exists() and any(LOCAL_DATA_DIR.iterdir()):
        return LOCAL_DATA_DIR
    return ROOT_DATA_DIR


DATA_DIR = _resolve_data_dir()

DISTANCES_FILE = str(DATA_DIR / 'df_ matriz_distancias.parquet')
EXISTING_SITES_FILE = str(DATA_DIR / 'df_campi_existentes.parquet')
DEMAND_FILE = str(DATA_DIR / 'df_populacao_idade_escolar.parquet')
COORDS_FILE = str(DATA_DIR / 'municipios.parquet')
SHAPEFILE_FILE = str(DATA_DIR / 'BR_Municipios_Simplified.shp')

# Default parameters
P = 5                   # Number of new sites
S_DISTANCE = 100.0          # Max coverage radius (km)
S_TIME = 1.0               # Max coverage time (hours)
USE_DISTANCE_KM = True     # True for km, False for time
TARGET_UF = 'MG'           # 'MG' (Minas Gerais) | None = Brazil

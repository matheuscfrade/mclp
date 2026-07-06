#!/usr/bin/env python3
"""
ensure_data.py

Garante que todos os arquivos necessários de dados estejam presentes em clean_data/.

Uso recomendado:
    python scripts/ensure_data.py
    python scripts/ensure_data.py --force          # força re-download
    python scripts/ensure_data.py --check-only     # só verifica, não baixa

Este script é o método oficial para preparar os dados após clonar o repositório.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Permite importar data_loader mesmo quando executado de dentro de scripts/
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    from data_loader import (
        GDRIVE_FILE_IDS,
        ensure_file_from_drive,
        is_lfs_pointer,
    )
except ImportError as e:
    print(f"[ERRO] Não foi possível importar data_loader: {e}")
    print("Execute este script a partir da raiz do projeto ou instale o pacote.")
    sys.exit(1)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Garante que os arquivos de dados do MCLP estejam presentes."
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Força o download novamente mesmo se o arquivo existir.",
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="Apenas verifica a existência dos arquivos (não baixa nada).",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Menos saída no console.",
    )
    args = parser.parse_args()

    data_dir = ROOT / "clean_data"
    data_dir.mkdir(parents=True, exist_ok=True)

    print(f"Diretório de dados: {data_dir}")
    print(f"Total de arquivos esperados: {len(GDRIVE_FILE_IDS)}")
    print("-" * 50)

    success_count = 0
    failed: list[str] = []

    for filename, file_id in GDRIVE_FILE_IDS.items():
        filepath = data_dir / filename

        if args.check_only:
            exists = filepath.exists() and not is_lfs_pointer(str(filepath))
            status = "OK" if exists else "FALTANDO"
            if not args.quiet:
                print(f"[{status}] {filename}")
            if exists:
                success_count += 1
            else:
                failed.append(filename)
            continue

        # Modo normal / force
        needs_download = args.force or not filepath.exists() or is_lfs_pointer(str(filepath))

        if not needs_download:
            if not args.quiet:
                print(f"[OK] {filename}")
            success_count += 1
            continue

        if not args.quiet:
            print(f"[BAIXANDO] {filename} ...")

        # Garante que o caminho seja string absoluta para a função existente
        ok = ensure_file_from_drive(str(filepath))

        if ok and filepath.exists() and filepath.stat().st_size > 1000:
            if not args.quiet:
                print(f"[SUCESSO] {filename}")
            success_count += 1
        else:
            print(f"[FALHA] Não foi possível obter {filename}")
            failed.append(filename)

    print("-" * 50)
    print(f"Arquivos prontos: {success_count}/{len(GDRIVE_FILE_IDS)}")

    if failed:
        print("Arquivos com problema:")
        for f in failed:
            print(f"  - {f}")
        print("\nDica: rode com --force ou baixe manualmente do Google Drive.")
        return 1

    if not args.quiet:
        print("\nTodos os arquivos de dados estão disponíveis!")
    return 0


if __name__ == "__main__":
    sys.exit(main())

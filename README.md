# MCLP

**Maximum Covering Location Problem** — ferramenta para resolver problemas de máxima cobertura (MCLP). Inclui suporte ao cenário da Rede Federal de Educação Profissional, Científica e Tecnológica (RFEPCT) como modelo de dados.

| Componente | Versão |
|------------|--------|
| Projeto Python (`pyproject.toml`) | **2.1.0** |
| Interface web (`web/package.json`) | **2.0.0** |

## Visão geral

- Backend **FastAPI** com fila de jobs em background
- Interface **React + Leaflet** em wizard de 4 abas: **Cenário**, **Métodos**, **Execução**, **Resultados**
- 5 métodos de otimização: `greedy`, `local_search`, `vns`, `genetic`, `exact`
- Exportações: **XLSX** (dados tabulares), **PDF** (relatório), mapas HTML interativos (cobertura e demanda)
- Dados base em `clean_data/` (obrigatório para o cenário RFEPCT e para métrica Distância)

## Endpoints da API

13 rotas documentadas:

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/health` | Status do serviço |
| POST | `/api/runs` | Criar execução (JSON, dados do cenário embutido) |
| POST | `/api/runs/upload` | Criar execução com upload de demanda e/ou locais existentes |
| GET | `/api/runs/{run_id}` | Status, logs e resumo dos resultados |
| GET | `/api/runs/{run_id}/results` | Resultados completos (mapas sob demanda) |
| GET | `/api/runs/{run_id}/results/{method}/map` | GeoJSON do mapa de um método |
| GET | `/api/templates/demand.csv` | Template CSV de demanda |
| GET | `/api/templates/existing-sites.csv` | Template CSV de locais existentes |
| POST | `/api/files/preview` | Pré-visualização de arquivo enviado |
| GET | `/api/runs/{run_id}/exports/xlsx` | Planilha (abas Comparação + Soluções) |
| GET | `/api/runs/{run_id}/exports/report` | Relatório PDF |
| GET | `/api/runs/{run_id}/exports/map-coverage?method=` | Mapa HTML de cobertura |
| GET | `/api/runs/{run_id}/exports/map-demand?method=` | Mapa HTML de demanda |

## Arquitetura

```
MCLP_app/
├── api/              # FastAPI: fila de jobs, rotas, exportações
├── core/             # Instância MCLP, 5 solvers, modelos, exports
├── web/              # React + Vite + Leaflet (wizard UI)
├── clean_data/       # Dados nacionais (demanda, distâncias, shapefile, campi)
├── config.py         # Caminhos dos arquivos de dados
├── data_loader.py    # Carregamento otimizado (matriz esparsa, parquets)
└── heuristics.py     # Implementação das heurísticas e modelo exato
```

Módulos na raiz (`config.py`, `data_loader.py`, `heuristics.py`) são importados diretamente pelo backend; não fazem parte do pacote `core/`, mas são essenciais ao funcionamento.

## Quick Start — Windows (PowerShell)

### 1. Clone e prepare os dados

```powershell
git clone https://github.com/matheuscfrade/mclp.git
cd MCLP_app

# Baixe os arquivos grandes gerenciados por Git LFS
git lfs pull

# (Opcional, mas recomendado) Verifique/baixe os dados usando o script auxiliar
python scripts/ensure_data.py
```

> O repositório usa **Git LFS** para os arquivos de `clean_data/`.  
> Tamanho aproximado após `git lfs pull`: ~530 MB.

### 2. Instalar dependências (backend)

```powershell
pip install -e ".[api,data]"   # inclui gdown para scripts/ensure_data.py
```

Alternativa mínima: `pip install -r requirements.txt`

### 3. Iniciar a API

```powershell
uvicorn api.main:app --reload --host 127.0.0.1 --port 8000
```

API: `http://127.0.0.1:8000`

Teste rápido:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
```

### 4. Iniciar o frontend

Abra um **segundo** terminal:

```powershell
cd web

# Recomendado: instalar node_modules fora da pasta do projeto
# (útil especialmente em pastas sincronizadas como OneDrive)
$installRoot = Join-Path $env:USERPROFILE ".mclp-web"
Copy-Item package.json $installRoot -Force
npm install --prefix $installRoot

.\dev.ps1
```

Interface: `http://127.0.0.1:5173`

> **Não abra `web/index.html` diretamente no navegador** (`file://`). O Vite precisa do servidor de desenvolvimento para carregar os módulos ES.

Para apontar a API manualmente:

```powershell
$env:VITE_API_BASE = "http://127.0.0.1:8000"
.\dev.ps1
```

---

## Manual de Uso do Sistema

### Visão geral do fluxo

A interface é um wizard de quatro abas (rótulos exatos na barra superior):

| Ordem | Aba na UI | Função |
|-------|-----------|--------|
| 1 | **Cenário** | Escolher preset, parâmetros e arquivos |
| 2 | **Métodos** | Selecionar algoritmos e ajustar parâmetros |
| 3 | **Execução** | Revisar resumo, iniciar e acompanhar progresso |
| 4 | **Resultados** | Comparar, visualizar mapas e exportar |

Cada aba só fica acessível quando os pré-requisitos anteriores estão preenchidos. Os botões de avanço entre abas são:

- **Cenário → Métodos:** `Continuar para os métodos de otimização →`
- **Métodos → Execução:** `OK, seguir para execução`
- **Execução:** `Executar otimização` (enquanto envia: `Enviando...`)

### Instalação e inicialização

Siga o [Quick Start](#quick-start--windows-powershell) acima. É necessário **dois terminais** abertos: um para a API (porta 8000) e outro para o frontend (porta 5173). Sem a API rodando, a interface exibirá erro ao tentar executar.

### Uso pela interface web

As quatro abas conduzem o fluxo completo. A configuração detalhada está nas seções seguintes; aqui, o caminho resumido:

1. **Cenário** — escolha RFEPCT ou Dados próprios, preencha parâmetros, clique em `Continuar para os métodos de otimização →`
2. **Métodos** — marque os algoritmos desejados, ajuste parâmetros, clique em `OK, seguir para execução`
3. **Execução** — revise o resumo e clique em `Executar otimização`
4. **Resultados** — abre automaticamente ao concluir; use as sub-abas Comparação, Mapas e locais, Exportações

### Configuração de Parâmetros

#### Cenário (aba Cenário)

**Escolha do cenário** (campo *Modelo de cenário*):

| Opção na UI | Valor interno | Uso |
|-------------|---------------|-----|
| Expansão da Rede Federal (RFEPCT) | `rfept` | Usa demanda IBGE (14–24 anos) e campi PNP/MEC de `clean_data/` |
| Dados próprios | `custom` | Exige upload de arquivo de demanda; locais existentes opcionais |
| Nenhum modelo selecionado | `none` | Estado inicial — escolha RFEPCT ou Dados próprios para continuar |

**Parâmetros principais:**

| Campo na UI | Campo API | Descrição |
|-------------|-----------|-----------|
| Novas unidades (p) | `p` | Quantidade de novos locais a abrir |
| Métrica | `metric` | `distance` (raio em km) ou `time` (tempo máximo em horas) |
| Raio máx. (km) | `radius_km` | Limite de distância quando métrica = Distância |
| Tempo máx. (h) | `max_time_h` | Limite de tempo quando métrica = Tempo |
| UF (opcional) | `target_uf` | Filtrar por estado; `Brasil (nacional)` envia `null` |
| Iniciar sem locais existentes | `greenfield` | Ignora cobertura inicial dos campi/locais do cenário |
| Coluna de demanda | `demand_col` | Coluna numérica do arquivo de demanda (padrão: `Total`) |

**Upload de arquivos** (opcional no RFEPCT, obrigatório em Dados próprios):

- **Demanda:** CSV ou Parquet — botões *Baixar template* apontam para `/api/templates/demand.csv`
- **Locais existentes:** CSV ou Parquet — template em `/api/templates/existing-sites.csv`
- Ao selecionar um arquivo, a interface chama `/api/files/preview` para mostrar colunas e primeiras linhas

#### Métodos (aba Métodos)

**Modo de comparação:**

| Botão na UI | Valor API | Comportamento |
|-------------|-----------|---------------|
| Sequencial / refinamento | `sequential` | Cada heurística parte da melhor solução anterior (Greedy → Busca Local → VNS → Genético) |
| Independente / comparação | `independent` | Cada método roda de forma isolada |

**Métodos disponíveis** (chaves exatas enviadas à API):

| Chave API | Nome na UI |
|-----------|------------|
| `greedy` | Greedy |
| `local_search` | Busca Local |
| `vns` | VNS |
| `genetic` | Algoritmo Genético |
| `exact` | Modelo Matemático |

> Busca Local, VNS e Algoritmo Genético **exigem Greedy** selecionado (a interface adiciona automaticamente).

Para cada método ativo, ajuste parâmetros na sub-aba correspondente (iterações, `k_max`, população, tempo limite CBC, etc.). Os valores são enviados em `method_params` no payload.

### Execução e Monitoramento

Na aba **Execução**, revise o resumo (cenário, métodos ativos, modo Sequencial/Independente) e clique em **Executar otimização**.

Durante a execução:

- A interface consulta `GET /api/runs/{run_id}` periodicamente
- O painel de progresso mostra passo atual e valor de Z por método
- Ao concluir (`status: completed`), os resultados completos são carregados via `GET /api/runs/{run_id}/results`
- A aba **Resultados** abre automaticamente

### Análise de Resultados e Exportações

Na aba **Resultados**, três sub-visões (botões no topo da seção):

| Sub-aba na UI | Conteúdo |
|---------------|----------|
| **Comparação** | Tabela com Z, cobertura %, demanda nova coberta, tempo e status; gráfico de convergência. Se o modelo exato terminar com `optimal`, mostra gap % das heurísticas |
| **Mapas e locais** | Mapa Leaflet por método (`/api/runs/{run_id}/results/{method}/map`), filtros de status, busca por município, lista de locais selecionados |
| **Exportações** | Links para XLSX, PDF e mapas HTML (habilitados somente com `status: completed`) |

| Botão na UI | URL | Arquivo gerado |
|-------------|-----|----------------|
| Dados tabulares / **XLSX** | `/api/runs/{run_id}/exports/xlsx` | `mclp_{run_id}.xlsx` |
| Relatório final / **PDF** | `/api/runs/{run_id}/exports/report` | `mclp_{run_id}.pdf` |
| Mapa interativo / **Cobertura** | `/api/runs/{run_id}/exports/map-coverage?method={method}` | `mclp_{run_id}_mapa_cobertura.html` |
| Mapa interativo / **Demanda** | `/api/runs/{run_id}/exports/map-demand?method={method}` | `mclp_{run_id}_mapa_demanda.html` |

O XLSX contém duas abas: **Comparacao** (resumo por método) e **Solucoes** (municípios selecionados com coordenadas).

### Exemplo rápido — cenário RFEPCT (interface)

1. Abra `http://127.0.0.1:5173`
2. **Cenário:** RFEPCT → p = 3 → Métrica Distância → Raio 100 km → UF = MG → `Continuar para os métodos de otimização →`
3. **Métodos:** Greedy + Busca Local + VNS (Sequencial / refinamento) → `OK, seguir para execução`
4. **Execução:** `Executar otimização`
5. **Resultados:** Comparação → Mapas e locais → Exportações (XLSX)

### Uso via API

#### Cenário RFEPCT (sem upload)

```powershell
$body = @{
  p = 3
  metric = "distance"
  radius_km = 100
  max_time_h = 1
  target_uf = "MG"
  greenfield = $false
  demand_col = "Total"
  methods = @("greedy", "local_search", "vns")
  execution_mode = "sequential"
  method_params = @{
    local_search = @{ max_iter = 100; strategy = "best" }
    vns = @{ max_iter = 100; k_max = 5; max_no_improv = 50; time_limit = 60; strategy = "best" }
  }
} | ConvertTo-Json -Depth 5

$run = Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/runs" -Method Post -Body $body -ContentType "application/json"
Write-Host "Run ID:" $run.run_id
```

#### Cenário com upload (Dados próprios)

```powershell
$payload = @{
  p = 5
  metric = "distance"
  radius_km = 100
  max_time_h = 1
  target_uf = "SP"
  greenfield = $true
  demand_col = "Total"
  methods = @("greedy", "exact")
  execution_mode = "independent"
  method_params = @{
    exact = @{ time_limit = 120 }
  }
} | ConvertTo-Json -Depth 5 -Compress

$form = @{
  payload = $payload
  demand_file = Get-Item "C:\caminho\demanda.csv"
}
# existing_sites_file é opcional

Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/runs/upload" -Method Post -Form $form
```

Equivalente com `curl`:

```bash
curl -X POST http://127.0.0.1:8000/api/runs/upload \
  -F "payload={\"p\":5,\"metric\":\"distance\",\"radius_km\":100,\"max_time_h\":1,\"target_uf\":\"SP\",\"greenfield\":true,\"demand_col\":\"Total\",\"methods\":[\"greedy\"],\"execution_mode\":\"independent\",\"method_params\":{}}" \
  -F "demand_file=@demanda.csv"
```

#### Acompanhar execução

```powershell
$runId = "SEU-RUN-ID"
do {
  Start-Sleep -Seconds 2
  $status = Invoke-RestMethod "http://127.0.0.1:8000/api/runs/$runId"
  Write-Host "status=$($status.status)"
} while ($status.status -in @("queued", "running"))

$results = Invoke-RestMethod "http://127.0.0.1:8000/api/runs/$runId/results"
```

#### Exportar resultados

```powershell
$runId = "SEU-RUN-ID"
Invoke-WebRequest "http://127.0.0.1:8000/api/runs/$runId/exports/xlsx" -OutFile "resultado.xlsx"
Invoke-WebRequest "http://127.0.0.1:8000/api/runs/$runId/exports/report" -OutFile "relatorio.pdf"
Invoke-WebRequest "http://127.0.0.1:8000/api/runs/$runId/exports/map-coverage?method=greedy" -OutFile "mapa_cobertura.html"
```

As rotas de exportação retornam HTTP 409 se a execução ainda não estiver `completed`.

## Fontes de dados e atribuição

- **Demanda (cenário RFEPCT):** População de 14 a 24 anos por município — Censo Demográfico 2022, IBGE.
- **Locais existentes (RFEPCT):** Campi da Rede Federal — Plataforma Nilo Peçanha (PNP/MEC), ano base 2024.
- **Matriz de distâncias rodoviárias e malha municipal:** Carvalho, Lucas Resende de; Amaral, Pedro Vasconcelos Maia do; Mendes, Philipe Scherrer. *Matrizes de distâncias e tempo de deslocamento rodoviário entre os municípios brasileiros: uma atualização metodológica para 2020*. Texto para Discussão n. 630, Cedeplar/UFMG, 2021. Malha Municipal Digital 2024, IBGE.

## Notas de desenvolvimento

- Instalação com ferramentas extras: `pip install -e ".[dev]"` (ruff)
- Build de produção do frontend: `cd web; .\build.ps1`
- Uploads temporários ficam em `runtime_uploads/` (gerado em tempo de execução)

---

**Seção legada / referência** — conteúdo preservado da documentação original.

## Métodos

- `greedy`: construção gulosa baseada em maior ganho marginal.
- `local_search`: refinamento por troca de candidatos.
- `vns`: busca em vizinhança variável usando a busca local como intensificação.
- `genetic`: população de soluções com seleção por torneio, crossover, mutação e elitismo.
- `exact`: modelo matemático MCLP com PuLP/CBC e limite de tempo.
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { GeoJSON, MapContainer, TileLayer, useMap } from "react-leaflet";

// Fix Leaflet default marker icons when using Vite / module bundlers (prevents broken marker squares).
// Safe even if the current UI primarily uses GeoJSON polygons.
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";

type MethodName = "greedy" | "local_search" | "vns" | "genetic" | "exact";
type TabName = "cenario" | "metodos" | "execucao" | "resultados";
type MapMode = "coverage" | "demand";
type ResultView = "comparacao" | "mapas" | "exportacoes";
type ScenarioPreset = "none" | "rfept" | "custom";
type ExecutionMode = "sequential" | "independent";

type MapPoint = {
  municipio_id: number;
  municipio_nome: string;
  municipio_uf: string;
  latitude: number;
  longitude: number;
  demanda: number;
  status: string;
  covering_campuses: string;
  is_selected_site: boolean;
  is_existing_site: boolean;
};

type MapArea = {
  municipio_id: number;
  municipio_nome: string;
  municipio_uf: string;
  demanda: number;
  status: string;
  polygons: number[][][][];
  covering_campuses: string;
  is_selected_site: boolean;
  is_existing_site: boolean;
};

type MethodResult = {
  method: string;
  status: string;
  z: number;
  runtime_seconds: number;
  coverage_percent: number;
  new_covered_demand: number;
  message: string;
  // Present when an exact "optimal" result was also computed in the same run
  gap_to_optimal?: number; // 0.0 means matched the proven optimum
  reference_z?: number;    // the Z of the proven optimal (if available)
};

type FullMethodResult = MethodResult & {
  selected_sites: number[];
  sites: Array<{
    municipio_id: number;
    municipio_nome: string;
    municipio_uf: string;
    populacao_local: number;
    populacao_nova_coberta: number;
    latitude?: number;
    longitude?: number;
  }>;
  progress_trace: Array<{ step: number; z: number; method: string; elapsed_seconds: number }>;
  map_payload: MapPayload;
};

type MapPayload = {
  points: MapPoint[];
  areas: MapArea[];
  selected_site_ids: number[];
  existing_site_ids: number[];
};

type RunSummary = {
  run_id: string;
  status: "queued" | "running" | "completed" | "failed";
  logs: string[];
  progress?: Record<string, MethodProgress>;
  error?: string;
  results: MethodResult[];
};

type MethodProgress = {
  method: string;
  step: number;
  total: number;
  z: number;
  percent: number;
  status: string;
};

type FullResult = RunSummary & {
  results: FullMethodResult[];
};

type HistoryItem = {
  run_id: string;
  label: string;
  form: RunForm;
  run: RunSummary;
  result: FullResult;
};

type PreviewData = {
  columns: string[];
  rows: Record<string, string>[];
  row_count: number;
};

type RunForm = {
  scenario_preset: ScenarioPreset;
  p: number;
  metric: "" | "distance" | "time";
  radius_km: number;
  max_time_h: number;
  target_uf: string;
  greenfield: boolean;
  demand_col: string;
  methods: MethodName[];
  execution_mode: ExecutionMode;
  local_search: { max_iter: number; strategy: string };
  vns: { max_iter: number; k_max: number; max_no_improv: number; time_limit: number; strategy: string };
  genetic: { population_size: number; generations: number; crossover_rate: number; mutation_rate: number; elitism: number; time_limit: number; seed: string };
  exact: { time_limit: number };
};

const methodLabels: Record<MethodName, string> = {
  greedy: "Greedy",
  local_search: "Busca Local",
  vns: "VNS",
  genetic: "Algoritmo Genético",
  exact: "Modelo Matemático",
};

const methodColors: Record<MethodName, string> = {
  greedy: "#176b52",
  local_search: "#2563a9",
  vns: "#8f5ab8",
  genetic: "#c98718",
  exact: "#b94a48",
};

const parameterHelp = {
  scenarioPreset: "Escolha o cenário de partida. Atualmente disponível: 'Expansão da Rede Federal (RFEPCT)'. Ou use 'Dados próprios' para carregar suas próprias bases de demanda e locais existentes. Outros cenários poderão ser adicionados no futuro.",
  newUnits: "Quantidade P de novas unidades a localizar. Aumentar P tende a ampliar a cobertura, mas também aumenta o espaço de busca e o tempo dos métodos.",
  targetUf: "Filtra a análise por estado (UF). Deixe em 'Brasil (nacional)' para considerar todo o país. Escolher um estado reduz significativamente o tamanho da instância e o tempo de processamento.",
  metric: "Define o critério de cobertura. Distância usa raio em km; Tempo usa limite em horas de deslocamento. A métrica escolhida muda quais municípios são considerados cobertos.",
  radiusKm: "Limite de distância para considerar um município coberto. Aumentar o raio amplia a cobertura potencial e pode reduzir diferenças entre métodos; reduzir torna o problema mais restritivo.",
  maxTimeH: "Limite de tempo de deslocamento, em horas. Exemplo: 1,5 significa uma hora e meia. Aumentar amplia a cobertura potencial; reduzir torna a seleção mais exigente.",
  greenfield: "Marque esta opção quando quiser ignorar completamente os locais já existentes do cenário escolhido. Deixe desmarcado para que o modelo considere a cobertura inicial gerada pelos locais já existentes naquele cenário.",
  demandUpload: "Arquivo CSV ou Parquet com a demanda por município. Em 'Dados próprios' este é o arquivo principal.",
  demandUploadReplace: "Substitui a demanda original do cenário por seus próprios dados.",
  demandColumn: "Coluna numérica usada como demanda a maximizar. Trocar a coluna muda o peso de cada município na função objetivo.",
  existingSitesUpload: "Arquivo com os locais já existentes que geram cobertura inicial. Em 'Dados próprios' é opcional (pode marcar 'Iniciar sem locais existentes').",
  existingSitesUploadReplace: "Substitui os locais existentes originais do cenário por seus próprios dados.",
  localMaxIter: "Padrão: 100. Faixa prática: 20 a 300. Aumentar permite testar mais trocas e pode melhorar a solução, mas aumenta o tempo. Reduzir acelera e pode parar antes de achar uma boa troca.",
  localStrategy: "Best improvement testa as trocas e usa a melhor melhoria encontrada, geralmente mais robusto e mais lento. First improvement aceita a primeira melhoria, geralmente mais rápido e menos exaustivo.",
  vnsMaxIter: "Padrão: 100. Faixa prática: 50 a 300. Aumentar dá mais ciclos de perturbação + busca local e pode melhorar o resultado. Reduzir prioriza velocidade.",
  vnsKMax: "Padrão: 5. Faixa: 1 até P, pois k representa quantos locais podem ser trocados na perturbação. k maior explora mudanças mais fortes, mas custa mais e pode desorganizar boas soluções.",
  vnsNoImprovement: "Padrão: 50. Número de ciclos consecutivos sem melhorar antes de parar. Valor maior insiste mais em procurar saída de ótimos locais; valor menor encerra mais cedo.",
  timeLimit: "Padrão: 60 segundos. Limite de tempo do método. Aumentar dá mais chance de melhoria em instâncias grandes; reduzir torna a execução mais previsível e rápida.",
  vnsStrategy: "Controla a Busca Local dentro do VNS. Best tende a refinar melhor cada perturbação, com mais custo. First tende a acelerar cada refinamento, com menor busca por troca ótima.",
  population: "Padrão: 50. Número de soluções por geração. População maior aumenta diversidade e chance de escapar de soluções ruins, mas cada geração fica mais cara. Mínimo: 4.",
  generations: "Padrão: 100. Número máximo de gerações. Aumentar prolonga a evolução e pode melhorar a solução; reduzir acelera, mas dá menos tempo para crossover e mutação atuarem.",
  crossover: "Padrão: 0,8, isto é, 80% de chance. Faixa: 0 a 1. Valor alto combina mais soluções boas; valor baixo preserva mais o primeiro pai e reduz mistura genética.",
  mutation: "Padrão: 0,1, isto é, 10% de chance. Faixa: 0 a 1, então 0,9 significa 90%, não 90. Aumentar explora mais locais novos; alto demais pode tornar a busca instável.",
  elitism: "Padrão: 2. Quantidade de melhores soluções copiadas sem alteração para a próxima geração. Aumentar protege bons resultados; alto demais reduz diversidade.",
  seed: "Opcional. Número inteiro usado para repetir a aleatoriedade. Mesma seed e mesmos parâmetros tendem a reproduzir o resultado; vazio deixa a execução variar.",
  exactTimeLimit: "Padrão: 60s. O modelo exato serve principalmente como 'verdade' para calcular o gap das heurísticas. Quando termina com 'optimal', a tabela de comparação mostra automaticamente o gap percentual de cada heurística em relação ao ótimo provado.",
};

const statusLabels: Record<string, string> = {
  all: "Todos",
  Existing_Site: "Local existente",
  Existing_Covered: "Cobertura existente",
  New_Site: "Novo local",
  New_Site_Overlapping: "Novo local sobreposto",
  New_Covered: "Nova cobertura",
  Uncovered: "Sem cobertura",
};

const tabs: Array<{ id: TabName; label: string }> = [
  { id: "cenario", label: "Cenário" },
  { id: "metodos", label: "Métodos" },
  { id: "execucao", label: "Execução" },
  { id: "resultados", label: "Resultados" },
];

const methodOrder: MethodName[] = ["greedy", "local_search", "vns", "genetic", "exact"];
const dependentHeuristics: MethodName[] = ["local_search", "vns", "genetic"];

const scenarioPresets: Record<ScenarioPreset, { title: string; text?: string; description?: string; demandDescription?: string; existingSitesDescription?: string; details?: string[] }> = {
  none: {
    title: "Nenhum modelo selecionado",
    text: "Escolha um modelo pré-programado ou use dados próprios para configurar a execução.",
  },
  rfept: {
    title: "Expansão da Rede Federal (RFEPCT)",
    description: "Este é um cenário realista baseado em dados públicos da Rede Federal de Educação Profissional, Científica e Tecnológica. Ele permite avaliar estratégias de expansão de unidades utilizando a população jovem como demanda e os campi já existentes como base de cobertura.",
    demandDescription: "População de 14 a 24 anos por município, segundo o Censo Demográfico 2022 do IBGE. Esta é a demanda que o modelo tenta maximizar a cobertura. As distâncias rodoviárias entre municípios provêm da matriz de Carvalho, Amaral e Mendes (\"Matrizes de distâncias e tempo de deslocamento rodoviário entre os municípios brasileiros: uma atualização metodológica para 2020\", TD 630/2021, Cedeplar/UFMG), baseada na malha municipal do IBGE.",
    existingSitesDescription: "Campi já implantados da Rede Federal (dados da Plataforma Nilo Peçanha - PNP/MEC, ano base 2024). Estes locais geram cobertura inicial automática no modelo.",
  },
  custom: {
    title: "Dados próprios",
    description: "Neste modo você tem total flexibilidade para analisar qualquer tipo de problema de cobertura. Basta fornecer seus próprios dados de demanda e, opcionalmente, a lista de locais já existentes.",
    demandDescription: "Você fornece o arquivo com a demanda que deseja maximizar (ex: população em idade escolar, número de empresas, etc.). Quando usar a métrica Distância, a cobertura é calculada com a matriz nacional de distâncias rodoviárias de Carvalho, Amaral e Mendes (\"Matrizes de distâncias e tempo de deslocamento rodoviário entre os municípios brasileiros: uma atualização metodológica para 2020\", TD 630/2021, Cedeplar/UFMG), baseada na malha municipal do IBGE.",
    existingSitesDescription: "Você fornece a lista de locais que já existem e devem ser considerados como cobertura inicial (opcional se marcar 'planejar do zero').",
  },
};

const methodSummaries: Record<MethodName, string> = {
  greedy: "Construção rápida por ganho marginal.",
  local_search: "Refina a solução por trocas locais.",
  vns: "Explora vizinhanças variáveis e intensifica.",
  genetic: "Busca populacional com mutação e elitismo.",
  exact: "Modelo exato (PuLP/CBC) — referência para validar qualidade das heurísticas e provar otimalidade.",
};

const ufOptions = [
  { value: "", label: "Selecione..." },
  { value: "BR", label: "Brasil (nacional)" },
  { value: "AC", label: "AC - Acre" },
  { value: "AL", label: "AL - Alagoas" },
  { value: "AP", label: "AP - Amapá" },
  { value: "AM", label: "AM - Amazonas" },
  { value: "BA", label: "BA - Bahia" },
  { value: "CE", label: "CE - Ceará" },
  { value: "DF", label: "DF - Distrito Federal" },
  { value: "ES", label: "ES - Espírito Santo" },
  { value: "GO", label: "GO - Goiás" },
  { value: "MA", label: "MA - Maranhão" },
  { value: "MT", label: "MT - Mato Grosso" },
  { value: "MS", label: "MS - Mato Grosso do Sul" },
  { value: "MG", label: "MG - Minas Gerais" },
  { value: "PA", label: "PA - Pará" },
  { value: "PB", label: "PB - Paraíba" },
  { value: "PR", label: "PR - Paraná" },
  { value: "PE", label: "PE - Pernambuco" },
  { value: "PI", label: "PI - Piauí" },
  { value: "RJ", label: "RJ - Rio de Janeiro" },
  { value: "RN", label: "RN - Rio Grande do Norte" },
  { value: "RS", label: "RS - Rio Grande do Sul" },
  { value: "RO", label: "RO - Rondônia" },
  { value: "RR", label: "RR - Roraima" },
  { value: "SC", label: "SC - Santa Catarina" },
  { value: "SP", label: "SP - São Paulo" },
  { value: "SE", label: "SE - Sergipe" },
  { value: "TO", label: "TO - Tocantins" },
];

const methodDetails: Record<MethodName, { theory: string; runs: string; code: string }> = {
  greedy: {
    theory: "A heurística gulosa constrói a solução passo a passo. Em cada iteração ela calcula, para todos os candidatos ainda disponíveis, qual local acrescentaria a maior demanda ainda não coberta. O candidato com maior ganho marginal entra na solução. É rápida e determinística, mas pode ficar presa em uma escolha localmente boa que impede uma combinação global melhor.",
    runs: "Nesta aplicação, o Greedy recebe a matriz esparsa de cobertura, o vetor de demanda e a cobertura inicial dos locais existentes. Ele gera a solução inicial obrigatória para as demais heurísticas. O usuário pode executar somente o Greedy, ou usar o Greedy como ponto de partida para Busca Local, VNS e Algoritmo Genético.",
    code: `Algoritmo: Greedy
ENTRADA: J, d, A, p, C0
SAÍDA: S

S ← ∅
C ← C0
ENQUANTO |S| < p FAÇA
    j* ← argmax ganho(j, C), para j ∈ J \\ S
    S ← S ∪ {j*}
    C ← C ∪ cobertos(j*)
FIM
RETORNE S`,
  },
  local_search: {
    theory: "A Busca Local parte de uma solução inicial e tenta melhorá-la por trocas: remove um local selecionado e testa inserir outro candidato. Se a troca aumenta a demanda coberta, a solução é atualizada. A estratégia best improvement avalia a melhor troca encontrada; first improvement aceita a primeira troca positiva.",
    runs: "No fluxo sequencial, ela sempre usa a solução do Greedy como entrada. Por isso, ao selecionar Busca Local, o Greedy também fica selecionado. A cada iteração a aplicação registra o valor de Z para alimentar o gráfico de convergência.",
    code: `Algoritmo: Busca Local
ENTRADA: S, J, max_iter
SAÍDA: S

REPITA
    (sai, entra) ← melhor_troca(S, J \\ S)
    SE ganho(sai, entra) > 0 ENTÃO
        S ← S - {sai} ∪ {entra}
    SENÃO
        PARE
    FIM
ATÉ max_iter
RETORNE S`,
  },
  vns: {
    theory: "VNS significa Variable Neighborhood Search. A ideia é alternar entre perturbação e intensificação: primeiro a solução é chacoalhada em uma vizinhança de tamanho k; depois uma Busca Local tenta melhorar a solução perturbada. Se melhora, o algoritmo volta para vizinhanças pequenas; se não melhora, aumenta k.",
    runs: "Nesta aplicação, o VNS usa a melhor solução sequencial disponível antes dele: normalmente a Busca Local, quando selecionada, ou o Greedy quando a Busca Local não foi selecionada. Ao selecionar VNS, o Greedy também fica selecionado. Ele respeita limite de iterações, k_max, limite sem melhoria e tempo máximo.",
    code: `Algoritmo: VNS
ENTRADA: S, k_max, limite
SAÍDA: S*

S* ← S
ENQUANTO limite não atingido FAÇA
    k ← 1
    ENQUANTO k ≤ k_max FAÇA
        S' ← perturbar(S*, k)
        S'' ← busca_local(S')
        SE Z(S'') > Z(S*) ENTÃO S* ← S''; k ← 1
        SENÃO k ← k + 1
    FIM
FIM
RETORNE S*`,
  },
  genetic: {
    theory: "O Algoritmo Genético trabalha com uma população de soluções. Cada indivíduo é um conjunto de p locais. A cada geração, as soluções são avaliadas pela demanda coberta; as melhores tendem a ser selecionadas, combinadas por crossover e alteradas por mutação. O elitismo preserva parte dos melhores indivíduos.",
    runs: "Nesta aplicação, o Algoritmo Genético roda em sequência com as demais heurísticas. Ele recebe a melhor solução heurística disponível até o momento como indivíduo elite inicial e completa a população com soluções aleatórias. Assim, tenta melhorar o resultado anterior sem perder diversidade. Ao selecionar o Algoritmo Genético, o Greedy também fica selecionado.",
    code: `Algoritmo: Algoritmo Genético
ENTRADA: S0, J, pop, g
SAÍDA: S*

P ← {S0} ∪ soluções_aleatórias(J, pop - 1)
PARA t ← 1 ATÉ g FAÇA
    avaliar(P)
    E ← elite(P)
    F ← crossover(selecionar(P))
    P ← E ∪ mutação(F)
FIM
RETORNE melhor(P)`,
  },
  exact: {
    theory: "O modelo matemático formula o MCLP como programação linear inteira binária. A variável x_j indica se o candidato j será aberto; y_i indica se a demanda i está coberta. A função objetivo maximiza a soma da demanda coberta, com restrição de selecionar exatamente p novos locais.",
    runs: "Nesta aplicação, o modelo é resolvido com PuLP/CBC. Ele é independente das heurísticas: pode rodar sozinho ou ao lado delas, mas não usa a solução do Greedy, da Busca Local, do VNS ou do Algoritmo Genético como entrada.",
    code: `Modelo matemático: MCLP
MAXIMIZE Σ d_i y_i

SUJEITO A:
    Σ x_j = p
    y_i ≤ Σ a_ij x_j, para todo i não coberto
    y_i = 1, para todo i já coberto
    x_j, y_i ∈ {0, 1}

RETORNE {j | x_j = 1}`,
  },
};

const defaultForm: RunForm = {
  scenario_preset: "none",
  p: 0,
  metric: "",
  radius_km: 0,
  max_time_h: 0,
  target_uf: "",
  greenfield: false,
  demand_col: "Total",
  methods: ["greedy", "local_search", "vns", "genetic", "exact"],
  execution_mode: "sequential",
  local_search: { max_iter: 100, strategy: "best" },
  vns: { max_iter: 100, k_max: 5, max_no_improv: 50, time_limit: 60, strategy: "best" },
  genetic: { population_size: 50, generations: 100, crossover_rate: 0.8, mutation_rate: 0.1, elitism: 2, time_limit: 60, seed: "" },
  exact: { time_limit: 60 },
};

function brNumber(value: number, decimals = 0) {
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function pickBestResult(results: Array<{ z: number; runtime_seconds: number; method: string }>) {
  if (!results.length) return null;
  // Highest Z (solution quality / covered demand) is primary.
  // When Z is equal (e.g. a heuristic matched the exact optimum), prefer the fastest runtime.
  // This makes "Melhor método" the best quality, with speed as tie-breaker.
  // Exact (Modelo Matemático) will naturally win when it has the proven best Z.
  return [...results].sort((a, b) => {
    if (b.z !== a.z) return b.z - a.z;
    return a.runtime_seconds - b.runtime_seconds;
  })[0];
}

function HelpTip({ text }: { text: string }) {
  const [hovering, setHovering] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const bubbleId = useId();
  const [bubbleStyle, setBubbleStyle] = useState<React.CSSProperties>({});

  // Bubble visible ONLY on direct mouse hover over the "i" button.
  // Pure hover (no click/pin) to simplify as requested. The target is precise to the button.
  const isVisible = hovering;

  // Portal + fixed positioning from the button rect makes every i pill (in main grid,
  // method tabs, checkboxes, uploads, etc.) behave identically with the same bubble position
  // and hover activation area.
  useEffect(() => {
    if (!isVisible || !buttonRef.current) {
      setBubbleStyle({});
      return;
    }
    const r = buttonRef.current.getBoundingClientRect();
    setBubbleStyle({
      position: "fixed",
      left: `${r.left + r.width / 2}px`,
      top: `${r.bottom + 8}px`,
      transform: "translateX(-50%)",
      opacity: 1,
      visibility: "visible",
      pointerEvents: "auto",
      zIndex: 9999,
    });
  }, [isVisible]);

  const show = () => setHovering(true);
  const hide = () => setHovering(false);

  return (
    <span className="help-tip" ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Mais informações: ${text}`}
        aria-describedby={isVisible ? bubbleId : undefined}
        title="Mais informações (passe o mouse para visualizar)"
        onMouseEnter={show}
        onMouseLeave={hide}
      >
        i
      </button>

      {isVisible &&
        createPortal(
          <span
            id={bubbleId}
            className="help-bubble"
            style={bubbleStyle}
            role="tooltip"
          >
            {text}
          </span>,
          document.body
        )}
    </span>
  );
}

function FieldTitle({ children, help, style }: { children: string; help: string; style?: React.CSSProperties }) {
  return (
    <span className="field-title" style={style}>
      <span>{children}</span>
      <HelpTip text={help} />
    </span>
  );
}

function normalizeSelectedMethods(methods: MethodName[]) {
  const selected = new Set(methods);
  if (dependentHeuristics.some((method) => selected.has(method))) {
    selected.add("greedy");
  }
  return methodOrder.filter((method) => selected.has(method));
}

function statusColor(status: string) {
  switch (status) {
    case "Existing_Site":
      return "#0b3c6f";
    case "Existing_Covered":
      return "#4d8fcb";
    case "New_Site":
      return "#0f7b4d";
    case "New_Site_Overlapping":
      return "#db9f16";
    case "New_Covered":
      return "#7cc27e";
    default:
      return "#c0c8cd";
  }
}

function demandColor(demand: number, maxDemand: number) {
  if (maxDemand <= 0) return "#d9dee2";
  const ratio = Math.max(0, Math.min(1, demand / maxDemand));
  const green = Math.round(220 - 180 * ratio);
  const blue = Math.round(180 - 180 * ratio);
  return `rgb(235, ${green}, ${blue})`;
}

function statusClass(status?: string) {
  switch (status) {
    case "running":
      return "is-running";
    case "completed":
      return "is-completed";
    case "failed":
      return "is-failed";
    case "queued":
      return "is-queued";
    default:
      return "is-ready";
  }
}

function mapFeatureCollection(areas: MapArea[], statusFilter: string) {
  const filtered = statusFilter === "all" ? areas : areas.filter((area) => area.status === statusFilter);
  return {
    type: "FeatureCollection",
    features: filtered.map((area) => ({
      type: "Feature",
      properties: area,
      geometry: {
        type: "MultiPolygon",
        coordinates: area.polygons,
      },
    })),
  } as any;
}

function boundsForAreas(areas: MapArea[]) {
  const bounds = L.latLngBounds([]);
  for (const area of areas) {
    for (const polygon of area.polygons) {
      for (const ring of polygon) {
        for (const [lng, lat] of ring) {
          bounds.extend([lat, lng]);
        }
      }
    }
  }
  return bounds.isValid() ? bounds : null;
}

function MapViewport({ areas, focusedArea, mapResetToken = 0 }: { areas: MapArea[]; focusedArea: MapArea | null; mapResetToken?: number }) {
  const map = useMap();
  useEffect(() => {
    const bounds = boundsForAreas(focusedArea ? [focusedArea] : areas);
    if (bounds) {
      map.fitBounds(bounds, { padding: [24, 24], maxZoom: focusedArea ? 10 : 7 });
    }
  }, [areas, focusedArea, map, mapResetToken]);
  return null;
}

// Clique fora de qualquer polígono → limpa a seleção (sem retângulo)
function MapClickDeselect({ onFeatureClick }: { onFeatureClick?: (id: number | null) => void }) {
  const map = useMap();
  useEffect(() => {
    const handler = () => {
      if (onFeatureClick) onFeatureClick(null);
    };
    map.on("click", handler);
    return () => {
      map.off("click", handler);
    };
  }, [map, onFeatureClick]);
  return null;
}

function MclpLeafletMap({
  method,
  areas,
  mode,
  statusFilter,
  focusedId,
  mapResetToken = 0,
  onFeatureClick,
}: {
  method: string;
  areas: MapArea[];
  mode: MapMode;
  statusFilter: string;
  focusedId: number | null;
  mapResetToken?: number;
  onFeatureClick?: (id: number | null) => void;
}) {
  const visibleAreas = statusFilter === "all" ? areas : areas.filter((area) => area.status === statusFilter);
  const focusedArea = areas.find((area) => area.municipio_id === focusedId) ?? null;
  const featureCollection = useMemo(() => mapFeatureCollection(areas, statusFilter), [areas, statusFilter]);
  const maxDemand = useMemo(() => Math.max(0, ...areas.map((area) => area.demanda)), [areas]);
  const bounds = boundsForAreas(areas);
  const center = bounds ? bounds.getCenter() : L.latLng(-18.5, -44);

  return (
    <div className="leaflet-shell">
      <MapContainer center={center} zoom={6} minZoom={4} scrollWheelZoom boxZoom={false} className="leaflet-map">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
        />
        <MapViewport areas={visibleAreas.length ? visibleAreas : areas} focusedArea={focusedArea} mapResetToken={mapResetToken} />
        <MapClickDeselect onFeatureClick={onFeatureClick} />
        <GeoJSON
          key={`${method}-${mode}-${statusFilter}-${focusedId ?? "none"}-${areas.length}`}
          data={featureCollection}
          style={(feature) => {
            const area = feature?.properties as MapArea;
            const focused = focusedId === area.municipio_id;
            return {
              fillColor: mode === "coverage" ? statusColor(area.status) : demandColor(area.demanda, maxDemand),
              fillOpacity: mode === "coverage" ? (focused ? 0.85 : 0.76) : (focused ? 0.9 : 0.82),
              color: focused ? "#00d5ff" : "#ffffff",
              weight: focused ? 4.5 : 0.7,
              // Leve brilho extra no selecionado
              ...(focused && { dashArray: undefined }),
            };
          }}
          onEachFeature={(feature, layer) => {
            const area = feature.properties as MapArea;

            layer.bindTooltip(
              `<strong>${area.municipio_nome} - ${area.municipio_uf}</strong><br/>` +
                `Demanda: ${brNumber(area.demanda)}<br/>` +
                `Status: ${area.status}<br/>` +
                `Coberto por: ${area.covering_campuses}`,
              { sticky: true },
            );

            // Clique no polígono → destaca a forma geográfica real da cidade (sem retângulo genérico)
            layer.on("click", (e) => {
              // Impede propagação que poderia gerar artefatos de seleção do browser
              if (e.originalEvent) {
                e.originalEvent.stopImmediatePropagation?.();
                e.originalEvent.preventDefault?.();
              }
              L.DomEvent?.stopPropagation?.(e);

              if (onFeatureClick) {
                onFeatureClick(area.municipio_id);
              }
            });

            // Cursor de mão para indicar que é clicável
            const el = (layer as any).getElement?.();
            if (el) {
              el.style.cursor = "pointer";
              el.style.outline = "none";
            }
          }}
        />
      </MapContainer>
    </div>
  );
}

function PreviewTable({ data }: { data: PreviewData | null }) {
  if (!data) return null;
  const columns = data.columns.slice(0, 8);
  return (
    <div className="preview-table">
      <div className="preview-meta">{brNumber(data.row_count)} linhas | {data.columns.length} colunas</div>
      <table>
        <thead>
          <tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr>
        </thead>
        <tbody>
          {data.rows.slice(0, 5).map((row, index) => (
            <tr key={index}>
              {columns.map((column) => <td key={column}>{row[column]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProgressChart({ result, executionMode }: { result: FullResult | null; executionMode: ExecutionMode }) {
  const [zoom, setZoom] = useState(1);
  const [windowStart, setWindowStart] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [hoveredIndependent, setHoveredIndependent] = useState<{ method: string; index: number } | null>(null);
  const series = (result?.results ?? []).flatMap((methodResult) => {
    const trace = methodResult.progress_trace.length
      ? methodResult.progress_trace
      : [{ step: 1, z: methodResult.z, method: methodResult.method, elapsed_seconds: methodResult.runtime_seconds }];
    return trace.map((point) => ({
      ...point,
      method: methodResult.method,
      label: methodLabels[methodResult.method as MethodName] ?? methodResult.method,
    }));
  });
  if (!series.length) return <div className="empty-state">Sem dados de convergência.</div>;
  const width = 720;
  const height = 180;
  const chartTitle = executionMode === "independent" ? "Comparação independente" : "Sequência completa";
  const chartLabel = executionMode === "independent" ? "Convergência independente por método" : "Convergência sequencial dos métodos";

  if (executionMode === "independent") {
    const groupedSeries = (result?.results ?? []).map((methodResult) => {
      const trace = methodResult.progress_trace.length
        ? methodResult.progress_trace
        : [{ step: 1, z: methodResult.z, method: methodResult.method, elapsed_seconds: methodResult.runtime_seconds }];
      const label = methodLabels[methodResult.method as MethodName] ?? methodResult.method;
      return {
        method: methodResult.method,
        label,
        color: methodColors[methodResult.method as MethodName] ?? "#176b52",
        points: trace.map((point) => ({ ...point, method: methodResult.method, label })),
      };
    }).filter((group) => group.points.length);
    const maxIndependentLength = Math.max(...groupedSeries.map((group) => group.points.length), 1);
    const visibleIndependentCount = Math.max(2, Math.ceil(maxIndependentLength / zoom));
    const maxIndependentStart = Math.max(0, maxIndependentLength - visibleIndependentCount);
    const safeIndependentStart = Math.min(windowStart, maxIndependentStart);

    return (
      <div className="progress-panel">
        <div className="progress-meta">
          <div>
            <span>{chartTitle}</span>
            <strong>cada método em seu próprio eixo de execução</strong>
          </div>
          <div className="zoom-controls">
            <button type="button" onClick={() => changeZoom(zoom - 1)} disabled={zoom <= 1}>-</button>
            <span>{zoom.toFixed(1)}x</span>
            <button type="button" onClick={() => changeZoom(zoom + 1)} disabled={zoom >= 8}>+</button>
            <button type="button" onClick={() => { setZoom(1); setWindowStart(0); }}>Reset</button>
          </div>
        </div>
        {zoom > 1 ? (
          <label className="zoom-window">
            Janela
            <input type="range" min={0} max={maxIndependentStart} value={safeIndependentStart} onChange={(event) => setWindowStart(Number(event.target.value))} />
          </label>
        ) : null}
        <div className="independent-progress-grid">
          {groupedSeries.map((group) => {
            const visibleMethodPoints = group.points.slice(safeIndependentStart, safeIndependentStart + visibleIndependentCount);
            const plotPoints = visibleMethodPoints.length ? visibleMethodPoints : group.points.slice(-1);
            const minMethodZ = Math.min(...plotPoints.map((point) => point.z));
            const maxMethodZ = Math.max(...plotPoints.map((point) => point.z));
            const methodRange = Math.max(maxMethodZ - minMethodZ, 1);
            const plottedMethodPoints = plotPoints.map((point, index) => {
              const x = plotPoints.length === 1 ? width / 2 : (index / (plotPoints.length - 1)) * width;
              const y = height - ((point.z - minMethodZ) / methodRange) * height;
              return { point, x, y };
            });
            const plottedMethod = plottedMethodPoints.map((point) => `${point.x},${point.y}`).join(" ");
            const firstPoint = group.points[0];
            const lastPoint = group.points[group.points.length - 1];
            const isSinglePoint = group.points.length === 1;
            const hoveredMethodIndex = hoveredIndependent?.method === group.method ? hoveredIndependent.index - safeIndependentStart : null;
            const hoveredMethodPoint = hoveredMethodIndex === null ? null : plottedMethodPoints[hoveredMethodIndex] ?? null;
            const methodTooltipWidth = 300;
            const methodTooltipHeight = 108;
            const methodTooltipX = hoveredMethodPoint ? Math.min(hoveredMethodPoint.x + 10, width - methodTooltipWidth - 6) : 0;
            const methodTooltipY = hoveredMethodPoint ? Math.min(Math.max(8, hoveredMethodPoint.y - 86), height - methodTooltipHeight - 6) : 0;

            function handleIndependentMove(event: MouseEvent<SVGSVGElement>) {
              const rect = event.currentTarget.getBoundingClientRect();
              const relativeX = ((event.clientX - rect.left) / rect.width) * width;
              const nearest = plottedMethodPoints.reduce((best, point, index) => {
                const distance = Math.abs(point.x - relativeX);
                return distance < best.distance ? { index, distance } : best;
              }, { index: 0, distance: Number.POSITIVE_INFINITY });
              setHoveredIndependent({ method: group.method, index: safeIndependentStart + nearest.index });
            }

            return (
              <div className="independent-progress-card" key={group.method}>
                <div className="independent-progress-head">
                  <strong><i style={{ background: group.color }} />{group.label}</strong>
                  <div className="independent-progress-stats">
                    <span>Z inicial={brNumber(firstPoint.z)}</span>
                    <span>Z final={brNumber(lastPoint.z)}</span>
                  </div>
                </div>
                <svg
                  className="progress-chart mini"
                  viewBox={`0 0 ${width} ${height}`}
                  role="img"
                  aria-label={`${chartLabel}: ${group.label}`}
                  onMouseMove={handleIndependentMove}
                  onMouseLeave={() => setHoveredIndependent(null)}
                >
                  {isSinglePoint ? null : <polyline points={plottedMethod} fill="none" stroke={group.color} strokeWidth="3" />}
                  {plottedMethodPoints.map(({ x, y }, index) => {
                    const absoluteIndex = safeIndependentStart + index;
                    return <circle key={`${group.method}-${absoluteIndex}`} cx={x} cy={y} r={hoveredIndependent?.method === group.method && hoveredIndependent.index === absoluteIndex ? 4.8 : isSinglePoint ? 5 : 2.2} fill={group.color} />;
                  })}
                  {hoveredMethodPoint ? (
                    <g className="chart-tooltip">
                      <line x1={hoveredMethodPoint.x} x2={hoveredMethodPoint.x} y1={0} y2={height} />
                      <rect x={methodTooltipX} y={methodTooltipY} width={methodTooltipWidth} height={methodTooltipHeight} rx="6" />
                      <text x={methodTooltipX + 14} y={methodTooltipY + 26}>{group.label}</text>
                      <text x={methodTooltipX + 14} y={methodTooltipY + 52}>
                        {hoveredMethodPoint.point.step === 0 ? "ponto inicial" : `passo ${hoveredMethodPoint.point.step}`}
                      </text>
                      <text x={methodTooltipX + 14} y={methodTooltipY + 77}>Z={brNumber(hoveredMethodPoint.point.z)}</text>
                      <text x={methodTooltipX + 14} y={methodTooltipY + 99}>t={brNumber(hoveredMethodPoint.point.elapsed_seconds, 2)}s</text>
                    </g>
                  ) : null}
                </svg>
                <div className="independent-progress-range">
                  <span>mín={brNumber(minMethodZ)}</span>
                  <span>{isSinglePoint ? "resultado único" : `${group.points.length} passos`}</span>
                  <span>máx={brNumber(maxMethodZ)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  const visibleCount = Math.max(2, Math.ceil(series.length / zoom));
  const maxStart = Math.max(0, series.length - visibleCount);
  const safeStart = Math.min(windowStart, maxStart);
  const visibleSeries = series.slice(safeStart, safeStart + visibleCount);
  const zValues = visibleSeries.map((point) => point.z).filter((z): z is number => typeof z === "number" && isFinite(z));
  const minZ = zValues.length ? Math.min(...zValues) : 0;
  const maxZ = zValues.length ? Math.max(...zValues) : 0;
  const range = Math.max(maxZ - minZ, 1);
  const plotted = visibleSeries.map((point, index) => {
    const x = visibleSeries.length === 1 ? 0 : (index / (visibleSeries.length - 1)) * width;
    const y = height - ((point.z - minZ) / range) * height;
    return { ...point, x, y, absoluteIndex: safeStart + index };
  });
  const methodSegments = plotted.reduce<Array<{ method: string; label: string; color: string; points: string }>>((segments, point, index) => {
    const color = methodColors[point.method as MethodName] ?? "#176b52";
    const previous = segments[segments.length - 1];
    if (!previous || previous.method !== point.method) {
      const carry = executionMode === "sequential" && index > 0 ? `${plotted[index - 1].x},${plotted[index - 1].y} ` : "";
      segments.push({ method: point.method, label: point.label, color, points: `${carry}${point.x},${point.y}` });
    } else {
      previous.points = `${previous.points} ${point.x},${point.y}`;
    }
    return segments;
  }, []);
  const methodMarkers = plotted.reduce<Array<{ method: string; label: string; index: number; x: number }>>((markers, point, index) => {
    if (index === 0 || plotted[index - 1].method !== point.method) {
      markers.push({ method: point.method, label: point.label, index, x: point.x });
    }
    return markers;
  }, []);
  const visibleMethods = methodMarkers.map((marker) => marker.method);
  const hovered = hoveredIndex === null ? null : plotted[hoveredIndex] ?? null;
  const tooltipX = hovered ? Math.min(hovered.x + 8, width - 168) : 0;
  const tooltipY = hovered ? Math.min(Math.max(8, hovered.y - 54), height - 70) : 0;

  function handleChartMove(event: MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const relativeX = ((event.clientX - rect.left) / rect.width) * width;
    const nearest = plotted.reduce((best, point, index) => {
      const distance = Math.abs(point.x - relativeX);
      return distance < best.distance ? { index, distance } : best;
    }, { index: 0, distance: Number.POSITIVE_INFINITY });
    setHoveredIndex(nearest.index);
  }

  function changeZoom(nextZoom: number) {
    const bounded = Math.max(1, Math.min(8, nextZoom));
    setZoom(bounded);
    setWindowStart((current) => Math.min(current, Math.max(0, series.length - Math.ceil(series.length / bounded))));
  }

  const overviewPoints = series
    .map((point, index) => {
      const x = series.length === 1 ? 0 : (index / (series.length - 1)) * width;
      const y = height - ((point.z - minZ) / range) * height;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <div className="progress-panel">
      <div className="progress-meta">
        <div>
          <span>{chartTitle}</span>
          <strong>{brNumber(minZ)} - {brNumber(maxZ)}</strong>
        </div>
        <div className="zoom-controls">
          <button type="button" onClick={() => changeZoom(zoom - 1)} disabled={zoom <= 1}>-</button>
          <span>{zoom.toFixed(1)}x</span>
          <button type="button" onClick={() => changeZoom(zoom + 1)} disabled={zoom >= 8}>+</button>
          <button type="button" onClick={() => { setZoom(1); setWindowStart(0); }}>Reset</button>
        </div>
      </div>
      {zoom > 1 ? (
        <label className="zoom-window">
          Janela
          <input type="range" min={0} max={maxStart} value={safeStart} onChange={(event) => setWindowStart(Number(event.target.value))} />
        </label>
      ) : null}
      <svg className="progress-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={chartLabel} onMouseMove={handleChartMove} onMouseLeave={() => setHoveredIndex(null)}>
        {methodMarkers.map((marker) => {
          return <line key={`${marker.method}-${marker.index}`} x1={marker.x} x2={marker.x} y1={0} y2={height} className="progress-marker" />;
        })}
        {executionMode === "sequential" ? <polyline points={overviewPoints} fill="none" className="progress-overview" /> : null}
        {methodSegments.map((segment, index) => <polyline key={`${segment.method}-${index}`} points={segment.points} fill="none" stroke={segment.color} strokeWidth="3" />)}
        {plotted.map((point, index) => {
          const color = methodColors[point.method as MethodName] ?? "#176b52";
          return <circle key={`${point.method}-${point.absoluteIndex}`} cx={point.x} cy={point.y} r={hoveredIndex === index ? 4.8 : 2.3} fill={color} />;
        })}
        {hovered ? (
          <g className="chart-tooltip">
            <line x1={hovered.x} x2={hovered.x} y1={0} y2={height} />
            <rect x={tooltipX} y={tooltipY} width="160" height="62" rx="6" />
            <text x={tooltipX + 10} y={tooltipY + 18}>{hovered.label}</text>
            <text x={tooltipX + 10} y={tooltipY + 37}>passo {hovered.step} | Z={brNumber(hovered.z)}</text>
            <text x={tooltipX + 10} y={tooltipY + 54}>t={brNumber(hovered.elapsed_seconds, 2)}s</text>
          </g>
        ) : null}
      </svg>
      <div className="progress-legend">
        {Object.entries(methodLabels).filter(([method]) => visibleMethods.includes(method)).map(([method, label]) => (
          <span key={method}><i style={{ background: methodColors[method as MethodName] }} />{label}</span>
        ))}
      </div>
    </div>
  );
}

function MethodProgressPanel({ run, methods, executionMode }: { run: RunSummary | null; methods: MethodName[]; executionMode: ExecutionMode }) {
  const resultsByMethod = new Map((run?.results ?? []).map((result) => [result.method, result]));
  const progressIndexes = methods
    .map((method, index) => (run?.progress?.[method] ? index : -1))
    .filter((index) => index >= 0);
  const latestProgressIndex = progressIndexes.length ? Math.max(...progressIndexes) : -1;
  return (
    <div className={`method-progress-grid ${executionMode}`} aria-live="polite">
      {methods.map((method, index) => {
        const progress = run?.progress?.[method];
        const result = resultsByMethod.get(method);
        const isCompletedSequential = executionMode === "sequential" && Boolean(progress) && index < latestProgressIndex;
        const isCurrentSequential = executionMode === "sequential" && Boolean(progress) && index === latestProgressIndex && run?.status === "running";
        const isDone = Boolean(result) || isCompletedSequential || progress?.status === "completed";
        const percent = isDone ? 100 : progress?.percent ?? 0;
        const total = result ? progress?.total ?? result.progress_trace?.length ?? 1 : progress?.total ?? 1;
        const step = isDone ? total : progress?.step ?? 0;
        const z = result?.z ?? progress?.z ?? 0;
        const isQueuedSequential = executionMode === "sequential" && run?.status === "running" && !progress && !result;
        const rawStatus = result ? result.status : progress?.status ?? (run?.status === "running" ? "aguardando" : "pendente");
        const status = isDone
          ? "concluído"
          : progress || isCurrentSequential
            ? "em execução"
            : isQueuedSequential
              ? latestProgressIndex >= 0
                ? "aguardando etapa anterior"
                : "aguardando"
              : rawStatus;
        return (
          <div className={`method-progress-card ${isDone ? "done" : progress ? "active" : ""} ${isQueuedSequential ? "queued" : ""}`} key={method}>
            <div className="method-progress-head">
              <strong>{methodLabels[method]}</strong>
              <span>{executionMode === "sequential" ? `etapa ${index + 1}/${methods.length} - ${status}` : status}</span>
            </div>
            <div className="method-progress-track">
              <i style={{ width: `${Math.max(0, Math.min(100, percent))}%`, background: methodColors[method] }} />
            </div>
            <div className="method-progress-meta">
              <span>{step}/{total}</span>
              <span>Z={brNumber(z)}</span>
              <span>{brNumber(percent, 1)}%</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function App() {
  const [form, setForm] = useState<RunForm>(defaultForm);
  const [tab, setTab] = useState<TabName>("cenario");
  const tabRef = useRef<TabName>("cenario");
  const [scenarioConfirmed, setScenarioConfirmed] = useState(false);
  const [methodsConfirmed, setMethodsConfirmed] = useState(false);
  const [methodConfigTab, setMethodConfigTab] = useState<MethodName>("local_search");
  const [resultView, setResultView] = useState<ResultView>("comparacao");
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunSummary | null>(null);
  const [fullResult, setFullResult] = useState<FullResult | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedMethod, setSelectedMethod] = useState<MethodName | null>(null);
  const [mapMode, setMapMode] = useState<MapMode>("coverage");
  const [mapStatusFilter, setMapStatusFilter] = useState("all");
  const [mapLoadingMethod, setMapLoadingMethod] = useState<string | null>(null);
  const [municipioSearch, setMunicipioSearch] = useState("");
  const [focusedMunicipioId, setFocusedMunicipioId] = useState<number | null>(null);
  const [mapViewResetToken, setMapViewResetToken] = useState(0);
  const [ufDropdownOpen, setUfDropdownOpen] = useState(false);
  const ufDropdownRef = useRef<HTMLDivElement>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // Fecha o dropdown de UF ao clicar fora
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (ufDropdownRef.current && !ufDropdownRef.current.contains(event.target as Node)) {
        setUfDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);
  const [demandFile, setDemandFile] = useState<File | null>(null);
  const [existingSitesFile, setExistingSitesFile] = useState<File | null>(null);
  const [demandPreview, setDemandPreview] = useState<PreviewData | null>(null);
  const [existingPreview, setExistingPreview] = useState<PreviewData | null>(null);

  // Refs for custom precise file choose buttons (hidden inputs triggered by dedicated buttons
  // so we control the exact clickable/hit area for "Escolher arquivo").
  const demandFileInputRef = useRef<HTMLInputElement>(null);
  const existingSitesFileInputRef = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const submittedFormRef = useRef<RunForm>(defaultForm);

  const best = useMemo(() => {
    if (!run?.results.length) return null;
    return pickBestResult(run.results);
  }, [run]);

  const activeResult = useMemo(() => {
    if (!fullResult?.results?.length) return null;
    if (selectedMethod) {
      return fullResult.results.find((result) => result.method === selectedMethod) ?? fullResult.results[0];
    }
    const bestMethod = best?.method;
    return fullResult.results.find((result) => result.method === bestMethod) ?? fullResult.results[0];
  }, [best?.method, fullResult, selectedMethod]);

  const municipioOptions = useMemo(() => {
    const areas = activeResult?.map_payload?.areas ?? [];
    return [...areas]
      .sort((a, b) => a.municipio_nome.localeCompare(b.municipio_nome))
      .map((area) => ({
        id: area.municipio_id,
        label: `${area.municipio_nome} - ${area.municipio_uf}`,
      }));
  }, [activeResult]);

  const selectedMethods = normalizeSelectedMethods(form.methods);
  const hasScenarioChoice = form.scenario_preset !== "none";
  const isCustomScenario = form.scenario_preset === "custom";

  // Validação de parâmetros obrigatórios
  const hasValidP = form.p > 0;
  const hasValidMetric = form.metric === "distance" || form.metric === "time";
  const hasValidCoverage = hasValidMetric && (form.metric === 'distance' ? form.radius_km > 0 : form.max_time_h > 0);

  // Para cenários pré-cadastrados, uploads são opcionais (servem como substituição).
  // Para "custom", uploads são obrigatórios.
  const customScenarioMissingDemand = isCustomScenario && !demandFile;
  const customScenarioMissingSites = isCustomScenario && !form.greenfield && !existingSitesFile;

  const canConfirmScenario = 
    hasScenarioChoice && 
    hasValidP && 
    hasValidMetric &&
    hasValidCoverage &&
    !customScenarioMissingDemand && 
    !customScenarioMissingSites;
  const canRun = scenarioConfirmed && methodsConfirmed && selectedMethods.length > 0;
  const hasCompletedResults = run?.status === "completed" && !!fullResult?.results.length;
  const currentStep = tab === "cenario" ? 1 : tab === "metodos" ? 2 : tab === "execucao" ? 3 : 4;

  function canAccessTab(tabName: TabName) {
    if (tabName === "cenario") return true;
    if (tabName === "metodos") return scenarioConfirmed;
    if (tabName === "execucao") return scenarioConfirmed && methodsConfirmed;
    return hasCompletedResults;
  }

  useEffect(() => {
    if (!runId || (run?.status !== "queued" && run?.status !== "running")) return;
    const timer = window.setInterval(async () => {
      const response = await fetch(`${API_BASE}/api/runs/${runId}`);
      const data = (await response.json()) as RunSummary;
      setRun(data);
      if (data.status === "completed") {
        const fullResponse = await fetch(`${API_BASE}/api/runs/${runId}/results`);
        const fullData = (await fullResponse.json()) as FullResult;
        setFullResult(fullData);
        setSelectedMethod((fullData.results[0]?.method as MethodName | undefined) ?? null);
        if (tabRef.current === "execucao") {
          tabRef.current = "resultados";
          setTab("resultados");
        }
        setHistory((current) => [
          {
            run_id: runId,
            label: `${new Date().toLocaleTimeString("pt-BR")} | ${(submittedFormRef.current.target_uf === "BR" || !submittedFormRef.current.target_uf) ? "Brasil" : submittedFormRef.current.target_uf} | p=${submittedFormRef.current.p}`,
            form: submittedFormRef.current,
            run: data,
            result: fullData,
          },
          ...current.filter((item) => item.run_id !== runId),
        ].slice(0, 8));
        window.clearInterval(timer);
      }
      if (data.status === "failed") {
        window.clearInterval(timer);
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [run?.status, runId]);

  useEffect(() => {
    if (resultView !== "mapas" || !runId || !activeResult || activeResult.map_payload.areas.length) return;
    const method = activeResult.method;
    let cancelled = false;
    setMapLoadingMethod(method);
    fetch(`${API_BASE}/api/runs/${runId}/results/${method}/map`)
      .then((response) => {
        if (!response.ok) throw new Error("Falha ao carregar mapa");
        return response.json() as Promise<MapPayload>;
      })
      .then((mapPayload) => {
        if (cancelled) return;
        setFullResult((current) => {
          if (!current) return current;
          return {
            ...current,
            results: current.results.map((result) =>
              result.method === method ? { ...result, map_payload: mapPayload } : result
            ),
          };
        });
      })
      .finally(() => {
        if (!cancelled) setMapLoadingMethod(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeResult, resultView, runId]);

  async function previewUpload(file: File, setter: (data: PreviewData | null) => void) {
    const body = new FormData();
    body.append("file", file);
    const response = await fetch(`${API_BASE}/api/files/preview`, { method: "POST", body });
    if (!response.ok) throw new Error(await response.text());
    setter((await response.json()) as PreviewData);
  }

  async function submitRun() {
    if (!canRun) return;
    const submittedForm: RunForm = {
      ...form,
      methods: [...selectedMethods],
      local_search: { ...form.local_search },
      vns: { ...form.vns },
      genetic: { ...form.genetic },
      exact: { ...form.exact },
    };
    submittedFormRef.current = submittedForm;
    setIsSubmitting(true);
    setFullResult(null);
    setSelectedMethod(null);
    setMapLoadingMethod(null);
    setFocusedMunicipioId(null);
    setMunicipioSearch("");
    setMapStatusFilter("all");
    setMapViewResetToken((t) => t + 1);
    setResultView("comparacao");
    try {
      const payload = {
        p: submittedForm.p,
        metric: submittedForm.metric,
        radius_km: submittedForm.metric === "distance" ? submittedForm.radius_km : Math.max(submittedForm.radius_km || 1, 1),
        max_time_h: submittedForm.metric === "time" ? submittedForm.max_time_h : Math.max(submittedForm.max_time_h || 1, 1),
        target_uf: (submittedForm.target_uf === "BR" || submittedForm.target_uf === "") 
          ? null 
          : submittedForm.target_uf,
        greenfield: submittedForm.greenfield,
        demand_col: submittedForm.demand_col,
        methods: selectedMethods,
        execution_mode: submittedForm.execution_mode,
        method_params: {
          local_search: submittedForm.local_search,
          vns: submittedForm.vns,
          genetic: { ...submittedForm.genetic, seed: submittedForm.genetic.seed ? Number(submittedForm.genetic.seed) : null },
          exact: submittedForm.exact,
        },
      };
      const hasUploads = demandFile || existingSitesFile;
      let response: Response;
      if (hasUploads) {
        const body = new FormData();
        body.append("payload", JSON.stringify(payload));
        if (demandFile) body.append("demand_file", demandFile);
        if (existingSitesFile) body.append("existing_sites_file", existingSitesFile);
        response = await fetch(`${API_BASE}/api/runs/upload`, { method: "POST", body });
      } else {
        response = await fetch(`${API_BASE}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      setRunId(data.run_id);
      setRun({ run_id: data.run_id, status: data.status, logs: [], results: [], progress: {} });
      changeTab("execucao");
    } catch (err: any) {
      const msg = (err && err.message) ? err.message : String(err);
      console.error("Erro ao iniciar execução:", msg);
      setRunId("error");
      setRun({
        run_id: "error",
        status: "failed",
        logs: [],
        results: [],
        progress: {},
        error: msg,
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  function toggleMethod(method: MethodName) {
    setForm((current) => {
      const selected = new Set(current.methods);
      if (selected.has(method)) {
        selected.delete(method);
        if (method === "greedy") {
          dependentHeuristics.forEach((item) => selected.delete(item));
        }
      } else {
        selected.add(method);
        if (dependentHeuristics.includes(method)) {
          selected.add("greedy");
        }
      }
      return {
        ...current,
        methods: normalizeSelectedMethods([...selected]),
      };
    });
    if (!form.methods.includes(method)) {
      setMethodConfigTab(method);
    } else if (methodConfigTab === method) {
      const next = form.methods.find((item) => item !== method) ?? "greedy";
      setMethodConfigTab(next);
    }
  }

  function selectMunicipio(value: string) {
    setMunicipioSearch(value);
    const found = municipioOptions.find((option) => option.label === value);
    setFocusedMunicipioId(found?.id ?? null);
  }

  function changeSelectedMethod(method: MethodName) {
    setSelectedMethod(method);
    setFocusedMunicipioId(null);
    setMunicipioSearch("");
    setMapStatusFilter("all");
    setMapViewResetToken((t) => t + 1);
  }

  function restoreHistoryItem(item: HistoryItem) {
    const currentMethod = selectedMethod;
    const nextMethod =
      currentMethod && item.result.results.some((result) => result.method === currentMethod)
        ? currentMethod
        : (item.result.results[0]?.method as MethodName | undefined) ?? null;
    setForm(item.form);
    setRunId(item.run_id);
    setRun(item.run);
    setFullResult(item.result);
    setSelectedMethod(nextMethod);
    setMapLoadingMethod(null);
    setFocusedMunicipioId(null);
    setMunicipioSearch("");
    setMapStatusFilter("all");
    setMapViewResetToken((t) => t + 1);
    tabRef.current = "resultados";
    setTab("resultados");
  }

  function resetSession() {
    // Limpa execução atual
    setRunId(null);
    setRun(null);
    setFullResult(null);
    setSelectedMethod(null);
    setMapLoadingMethod(null);
    setIsSubmitting(false);

    // Limpa o histórico da sessão
    setHistory([]);

    // Reseta formulário e uploads
    setForm(defaultForm);
    setDemandFile(null);
    setExistingSitesFile(null);
    setDemandPreview(null);
    setExistingPreview(null);

    // Reseta flags de confirmação
    setScenarioConfirmed(false);
    setMethodsConfirmed(false);
    setMethodConfigTab("local_search");

    // Limpa estados de visualização de resultados/mapa
    setResultView("comparacao");
    setMapMode("coverage");
    setMapStatusFilter("all");
    setMunicipioSearch("");
    setFocusedMunicipioId(null);
    setMapViewResetToken(0);

    // Volta para o início
    tabRef.current = "cenario";
    setTab("cenario");

    submittedFormRef.current = defaultForm;

    // Close any pending confirmation UI
    setShowResetConfirm(false);
  }

  function requestReset() {
    setShowResetConfirm(true);
  }

  function cancelReset() {
    setShowResetConfirm(false);
  }

  function historyScenarioDetails(item: HistoryItem) {
    const historyForm = item.form;
    const scenario = scenarioPresets[historyForm.scenario_preset]?.title ?? "Cenário";
    const scope = (historyForm.target_uf === "BR" || !historyForm.target_uf) ? "Brasil" : `UF ${historyForm.target_uf}`;
    const coverage = historyForm.metric === "distance" ? `raio ${historyForm.radius_km} km` : `tempo ${brNumber(historyForm.max_time_h, 1)} h`;
    const base = historyForm.greenfield ? "sem locais existentes" : "considerando locais existentes do cenário";
    const mode = historyForm.execution_mode === "sequential" ? "sequencial" : "independente";
    const methods = normalizeSelectedMethods(historyForm.methods).map((method) => methodLabels[method]).join(", ");
    return { scenario, scope, coverage, base, mode, methods };
  }

  const exportMethod = encodeURIComponent(activeResult?.method ?? "");

  function confirmScenario() {
    if (!canConfirmScenario) return;
    setScenarioConfirmed(true);
    tabRef.current = "metodos";
    setTab("metodos");
  }

  function confirmMethods() {
    setForm((current) => ({ ...current, methods: normalizeSelectedMethods(current.methods) }));
    setMethodsConfirmed(true);
    tabRef.current = "execucao";
    setTab("execucao");
  }

  function changeTab(nextTab: TabName) {
    if (!canAccessTab(nextTab)) return;
    tabRef.current = nextTab;
    setTab(nextTab);
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="app-title">
          {/* MCLP Logo Mark - coverage network icon */}
          <div className="logo-mark" aria-hidden="true">
            <svg width="110" height="110" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
              {/* Coverage rings (subtle) */}
              <circle cx="50" cy="50" r="53" stroke="#34d399" strokeOpacity="0.16" strokeWidth="2" />
              <circle cx="50" cy="50" r="41" stroke="#34d399" strokeOpacity="0.26" strokeWidth="2" />

              {/* Network connections */}
              <g stroke="#e2e8f0" strokeOpacity="0.6" strokeWidth="1.8" strokeLinecap="round">
                <line x1="50" y1="50" x2="50" y2="17" />
                <line x1="50" y1="50" x2="82" y2="30" />
                <line x1="50" y1="50" x2="79" y2="73" />
                <line x1="50" y1="50" x2="21" y2="73" />
                <line x1="50" y1="50" x2="18" y2="30" />
              </g>

              {/* Peripheral nodes (municipalities) */}
              <circle cx="50" cy="17" r="4.8" fill="#f1f5f9" />
              <circle cx="82" cy="30" r="4.8" fill="#f1f5f9" />
              <circle cx="79" cy="73" r="4.8" fill="#f1f5f9" />
              <circle cx="21" cy="73" r="4.8" fill="#f1f5f9" />
              <circle cx="18" cy="30" r="4.8" fill="#f1f5f9" />

              {/* Central optimal facility (selected) */}
              <circle cx="50" cy="50" r="11.5" fill="#34d399" />
              <circle cx="50" cy="50" r="11.5" fill="none" stroke="#0f766e" strokeWidth="2.2" />
            </svg>
          </div>

          <div className="title-text">
            <span className="eyebrow">Maximum Covering Location Problem</span>
            <h1>MCLP</h1>
            <div className="developed-credit">
              Developed by Matheus Costa Frade
              <span style={{ opacity: 0.55 }}>·</span>
              <a href="https://www.linkedin.com/in/matheus-frade" target="_blank" rel="noopener noreferrer">LinkedIn</a>
              <span style={{ opacity: 0.55 }}>·</span>
              <a href="https://github.com/matheuscfrade" target="_blank" rel="noopener noreferrer">GitHub</a>
            </div>
            <p className="header-tagline">
              Localize os locais para implantação de unidades de serviço
              <span className="tagline-second-line">com máxima cobertura em raio de distância ou tempo.</span>
            </p>
          </div>
        </div>

        <div className="topbar-actions">
          <span className={`status-pill ${statusClass(run?.status)}`}>{run?.status ?? "pronto"}</span>
          <span className="step-pill">Etapa {currentStep} de 4</span>
        </div>
      </header>

      {/* Non-blocking reset confirmation (replaces the old window.confirm) */}
      {showResetConfirm && (
        <div style={{
          maxWidth: 1480,
          margin: "0 auto 10px",
          background: "#fef2f2",
          border: "1px solid #fecaca",
          color: "#991b1b",
          borderRadius: 8,
          padding: "10px 14px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          fontSize: 13
        }}>
          <strong>Tem certeza?</strong>
          <span style={{ flex: 1 }}>Isso vai apagar todo o histórico da sessão atual e recomeçar do zero.</span>
          <button
            type="button"
            onClick={resetSession}
            style={{ background: "#b94a48", color: "white", border: "none", padding: "6px 14px", borderRadius: 6, fontWeight: 600, cursor: "pointer" }}
          >
            Sim, limpar tudo
          </button>
          <button
            type="button"
            onClick={cancelReset}
            style={{ background: "transparent", color: "#991b1b", border: "1px solid #fecaca", padding: "6px 12px", borderRadius: 6, fontWeight: 600, cursor: "pointer" }}
          >
            Cancelar
          </button>
        </div>
      )}

      <nav className="tabs">
        {tabs.map((item, index) => (
          <button
            key={item.id}
            className={tab === item.id ? "active" : ""}
            disabled={!canAccessTab(item.id)}
            onClick={() => changeTab(item.id)}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            {item.label}
          </button>
        ))}
      </nav>

      <section className="workspace full-width">
        {tab === "cenario" ? (
          <section className="panel">
            <div className="panel-heading">
              <div>
                <span className="panel-kicker">Etapa 1</span>
                <h2>Cenário e dados</h2>
              </div>
              <span className={scenarioConfirmed ? "check-badge ok" : "check-badge"}>{scenarioConfirmed ? "Validado" : "Pendente"}</span>
            </div>

            {/* Fundação fixa da ferramenta - contexto global */}
            <div className="info-banner" style={{ 
              background: "#f8fafc", 
              border: "1px solid #e2e8f0", 
              borderRadius: "8px", 
              padding: "12px 16px", 
              marginBottom: "24px",
              fontSize: "13px",
              color: "#475569"
            }}>
              <strong style={{ color: "#1e3a5f" }}>Fundação fixa da ferramenta:</strong> Matriz de distâncias rodoviárias + malha municipal de todos os municípios brasileiros (Carvalho, Amaral e Mendes, "Matrizes de distâncias e tempo de deslocamento rodoviário entre os municípios brasileiros: uma atualização metodológica para 2020", Cedeplar/UFMG - TD 630/2021; Malha Municipal Digital 2024, IBGE). Estes dados são usados em qualquer cenário ou upload que você fizer.
            </div>

            {/* === SEÇÃO 1: Escolha do Cenário (separada e mais clara) === */}
            <div className="scenario-choice-block">
              <div style={{ marginBottom: "12px" }}>
                <strong style={{ fontSize: "15px", color: "#0d4436" }}>Escolha do Cenário</strong>
                <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#2f4a3a" }}>
                  Selecione um cenário pré-cadastrado ou "Dados próprios". Você pode enviar arquivos de demanda e locais existentes para substituir os dados do cenário escolhido.
                </p>
              </div>

              <label style={{ display: "block", marginBottom: "12px" }} htmlFor="scenario-preset">
                <span>
                  <FieldTitle help={parameterHelp.scenarioPreset}>Modelo de cenário</FieldTitle>
                </span>
                <select id="scenario-preset" value={form.scenario_preset} onChange={(event) => {
                  const preset = event.target.value as ScenarioPreset;
                  setForm((current) => ({
                    ...current,
                    scenario_preset: preset,
                    demand_col: preset === "custom" ? current.demand_col : "Total",
                  }));
                  // Não limpa mais os arquivos automaticamente ao escolher um cenário pré-cadastrado.
                  // Uploads agora podem ser usados como substituição mesmo com cenário selecionado.
                  if (preset === "none") {
                    setDemandFile(null);
                    setExistingSitesFile(null);
                    setDemandPreview(null);
                    setExistingPreview(null);
                  }
                  setScenarioConfirmed(false);
                }} style={{ width: "100%", maxWidth: "420px" }}>
                  <option value="none">{scenarioPresets.none.title}</option>
                  <option value="custom">{scenarioPresets.custom.title}</option>
                  <option value="rfept">{scenarioPresets.rfept.title}</option>
                </select>
              </label>

              {/* Explicações do cenário */}
              {form.scenario_preset !== "none" && (
                <div style={{ marginTop: "12px" }}>
                  {/* Descrição geral do que o cenário trata */}
                  <div style={{ marginBottom: "12px" }}>
                    <p style={{ margin: "0", fontSize: "13.5px", color: "#1f3a2f", lineHeight: 1.45 }}>
                      {scenarioPresets[form.scenario_preset].description}
                    </p>
                  </div>

                  {/* Explicação da Demanda */}
                  <div style={{ marginBottom: "10px" }}>
                    <strong style={{ color: "#0d4436", fontSize: "13px" }}>Demanda</strong>
                    <p style={{ margin: "3px 0 0", fontSize: "13px", color: "#2a3f4a", lineHeight: 1.4 }}>
                      {scenarioPresets[form.scenario_preset].demandDescription}
                    </p>
                  </div>

                  {/* Explicação dos Locais Existentes / Cobertura Atual */}
                  <div>
                    <strong style={{ color: "#0d4436", fontSize: "13px" }}>Cobertura Atual (Locais Existentes)</strong>
                    <p style={{ margin: "3px 0 0", fontSize: "13px", color: "#2a3f4a", lineHeight: 1.4 }}>
                      {scenarioPresets[form.scenario_preset].existingSitesDescription}
                    </p>
                  </div>
                </div>
              )}

              {/* Nota pequena para sugestões de novos cenários (dentro do card) */}
              <p style={{ marginTop: "14px", fontSize: "12px", color: "#475569", fontStyle: "italic" }}>
                Envie sugestões de cadastro de novos cenários para <a href="mailto:matheuscfrade@gmail.com" style={{ color: "#176b52", fontWeight: 600, textDecoration: "underline" }}>matheuscfrade@gmail.com</a> ou <a href="mailto:matheus.frade@ifmg.edu.br" style={{ color: "#176b52", fontWeight: 600, textDecoration: "underline" }}>matheus.frade@ifmg.edu.br</a>
              </p>
            </div>

            {/* === SEÇÃO 2: Parâmetros da análise (bem compacto) === */}
            <div style={{ marginBottom: "4px" }}>
              <strong style={{ fontSize: "15px", color: "#1e3a5f" }}>Parâmetros da análise</strong>
            </div>

            {/* Grid de 5 colunas */}
            <div className="form-grid parameters-grid" style={{ 
              gridTemplateColumns: "repeat(5, minmax(0, 1fr))", 
              gap: "8px", 
              marginBottom: "16px",
              alignItems: "end"
            }}>
              {/* Novas unidades */}
              <label htmlFor="p-input">
                <span>
                  <FieldTitle help={parameterHelp.newUnits}>Novas unidades (p)</FieldTitle>
                </span>
                <input 
                  id="p-input"
                  type="number" 
                  min={1} 
                  value={form.p || ''} 
                  onChange={(event) => {
                    const val = event.target.value === '' ? 0 : Number(event.target.value);
                    setForm({ ...form, p: val });
                  }} 
                />
              </label>

              {/* Métrica */}
              <label htmlFor="metric-select">
                <span>
                  <FieldTitle help={parameterHelp.metric}>Métrica</FieldTitle>
                </span>
                <select 
                  id="metric-select"
                  value={form.metric} 
                  onChange={(event) => setForm({ ...form, metric: event.target.value as "" | "distance" | "time" })}
                  style={{
                    width: "100%",
                    minHeight: "40px",
                    fontSize: "13px",
                    padding: "9px 28px 9px 10px", /* extra right padding for custom arrow space */
                    border: "1px solid #bcc8d0",
                    borderRadius: "6px",
                    background: "var(--field)",
                    color: "var(--ink)",
                    cursor: "pointer",
                    transition: "border-color 160ms ease, box-shadow 160ms ease",
                    appearance: "none",
                    WebkitAppearance: "none"
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.borderColor = "#90a3ad"}
                  onMouseLeave={(e) => e.currentTarget.style.borderColor = "#bcc8d0"}
                >
                  <option value="">Selecione...</option>
                  <option value="distance">Distância (km)</option>
                  <option value="time">Tempo (h)</option>
                </select>
              </label>

              {/* Raio ou Tempo - sempre visível */}
              {form.metric === "distance" ? (
                <label htmlFor="radius-input">
                  <span>
                    <FieldTitle help={parameterHelp.radiusKm}>Raio máx. (km)</FieldTitle>
                  </span>
                  <input 
                    id="radius-input"
                    type="number" 
                    min={1} 
                    value={form.radius_km || ''} 
                    onChange={(event) => {
                      const val = event.target.value === '' ? 0 : Number(event.target.value);
                      setForm({ ...form, radius_km: val });
                    }} 
                  />
                </label>
              ) : form.metric === "time" ? (
                <label htmlFor="time-input">
                  <span>
                    <FieldTitle help={parameterHelp.maxTimeH}>Tempo máx. (h)</FieldTitle>
                  </span>
                  <input 
                    id="time-input"
                    type="number" 
                    min={0.1} 
                    step={0.1} 
                    value={form.max_time_h || ''} 
                    onChange={(event) => {
                      const val = event.target.value === '' ? 0 : Number(event.target.value);
                      setForm({ ...form, max_time_h: val });
                    }} 
                  />
                </label>
              ) : (
                <label>
                  <span>
                    <FieldTitle help={parameterHelp.radiusKm}>Raio / Tempo máx.</FieldTitle>
                  </span>
                  <input 
                    type="text" 
                    disabled 
                    placeholder="Selecione a métrica primeiro" 
                    style={{ background: "#f8fafc", color: "#94a3b8" }}
                  />
                </label>
              )}

              {/* UF (opcional) - dropdown customizado (sempre abre para baixo) */}
              <label style={{ position: "relative" }} ref={ufDropdownRef} id="uf-label">
                <span>
                  <FieldTitle help={parameterHelp.targetUf}>UF (opcional)</FieldTitle>
                </span>
                <button
                  type="button"
                  aria-labelledby="uf-label"
                  onClick={() => setUfDropdownOpen(!ufDropdownOpen)}
                  style={{
                    width: "100%",
                    minHeight: "40px",
                    fontSize: "13px",
                    padding: "9px 10px",
                    border: "1px solid #bcc8d0",
                    borderRadius: "6px",
                    background: "var(--field)",
                    color: "var(--ink)",
                    textAlign: "left",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    transition: "border-color 160ms ease, box-shadow 160ms ease"
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.borderColor = "#90a3ad"}
                  onMouseLeave={(e) => e.currentTarget.style.borderColor = "#bcc8d0"}
                >
                  <span>
                    {form.target_uf === "" 
                      ? "Selecione..." 
                      : (ufOptions.find(o => o.value === form.target_uf)?.label || "Selecione...")}
                  </span>
                  <span style={{ fontSize: "10px" }}>▼</span>
                </button>

                {ufDropdownOpen && (
                  <div
                    style={{
                      position: "absolute",
                      top: "100%",
                      left: 0,
                      right: 0,
                      marginTop: "4px",
                      background: "var(--field)",
                      border: "1px solid #bcc8d0",
                      borderRadius: "6px",
                      boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                      zIndex: 100,
                      maxHeight: "220px",
                      overflowY: "auto"
                    }}
                  >
                    {ufOptions.map((option) => (
                      <div
                        key={option.value}
                        onClick={() => {
                          setForm({ ...form, target_uf: option.value });
                          setUfDropdownOpen(false);
                        }}
                        style={{
                          padding: "8px 10px",
                          fontSize: "13px",
                          cursor: "pointer",
                          background: form.target_uf === option.value ? "#e8f0ed" : "var(--field)",
                          color: "var(--ink)"
                        }}
                        onMouseEnter={(e) => {
                          if (form.target_uf !== option.value) e.currentTarget.style.background = "#f0f4f3";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = form.target_uf === option.value ? "#e8f0ed" : "var(--field)";
                        }}
                      >
                        {option.label}
                      </div>
                    ))}
                  </div>
                )}
              </label>

              {/* Green field - nome original e ao lado da UF */}
              <label className="check-row" style={{ marginBottom: "2px" }} htmlFor="greenfield-check">
                <input id="greenfield-check" type="checkbox" checked={form.greenfield} onChange={(event) => setForm({ ...form, greenfield: event.target.checked })} />
                <span style={{ cursor: "pointer" }}>
                  <FieldTitle help={parameterHelp.greenfield} style={{ fontSize: "12px" }}>Iniciar sem locais existentes</FieldTitle>
                </span>
              </label>
            </div>
            {/* Seção de dados de entrada - uploads sempre disponíveis (podem substituir dados do cenário pré-cadastrado) */}
            <div className="split">
              {/* Bloco de Demanda */}
              <div>
                <div className="section-title">Demanda</div>

                <div className="button-row">
                  <a className="secondary-link" href={`${API_BASE}/api/templates/demand.csv`}>Baixar template</a>
                </div>

                {isCustomScenario && (
                  <p style={{ fontSize: "12.5px", color: "#475569", margin: "0 0 8px" }}>
                    Arquivo com a demanda que você quer maximizar (população, empresas, etc.).
                  </p>
                )}

                <label>
                  <span>
                    <FieldTitle help={isCustomScenario ? parameterHelp.demandUpload : parameterHelp.demandUploadReplace}>
                      Upload de demanda CSV/Parquet
                    </FieldTitle>
                  </span>
                </label>

                {/* Custom "Escolher arquivo" button with controlled large/precise clickable area.
                    The native file input is hidden; the button reliably opens the picker via ref.click().
                    This makes the hit area for the choose action explicit and generous (padding, size). */}
                <button
                  type="button"
                  className="file-choose-button"
                  onClick={() => demandFileInputRef.current?.click()}
                  disabled={false}
                >
                  Escolher arquivo
                </button>
                {demandFile && (
                  <span className="file-name" title={demandFile.name}>
                    {demandFile.name}
                  </span>
                )}
                <input
                  ref={demandFileInputRef}
                  id="demand-file"
                  type="file"
                  accept=".csv,.parquet"
                  style={{ display: "none" }}
                  onChange={async (event) => {
                    const file = event.target.files?.[0] ?? null;
                    setDemandFile(file);
                    if (file) {
                      await previewUpload(file, (data) => {
                        setDemandPreview(data);
                        setForm((current) => ({
                          ...current,
                          demand_col: data?.columns.includes(current.demand_col) ? current.demand_col : data?.columns[0] ?? "Total",
                        }));
                      });
                    } else {
                      setDemandPreview(null);
                      setForm((current) => ({ ...current, demand_col: "" }));
                    }
                  }}
                />
                {demandPreview ? (
                  <label htmlFor="demand-col">
                    <span>
                      <FieldTitle help={parameterHelp.demandColumn}>Coluna de demanda</FieldTitle>
                    </span>
                    <select 
                      id="demand-col"
                      value={form.demand_col} 
                      onChange={(event) => setForm({ ...form, demand_col: event.target.value })}
                    >
                      {demandPreview.columns.map((column) => <option key={column} value={column}>{column}</option>)}
                    </select>
                  </label>
                ) : null}
                <PreviewTable data={demandPreview} />
              </div>

              {/* Bloco de Locais Existentes */}
              <div>
                <div className="section-title">Locais existentes</div>

                <div className="button-row">
                  <a className="secondary-link" href={`${API_BASE}/api/templates/existing-sites.csv`}>Baixar template</a>
                </div>

                {isCustomScenario && (
                  <p style={{ fontSize: "12.5px", color: "#475569", margin: "0 0 8px" }}>
                    Arquivo com os locais que já existem e geram cobertura inicial (pode ser omitido se marcar "planejar do zero").
                  </p>
                )}

                <label>
                  <span>
                    <FieldTitle help={isCustomScenario ? parameterHelp.existingSitesUpload : parameterHelp.existingSitesUploadReplace}>
                      Upload de locais existentes CSV/Parquet
                    </FieldTitle>
                  </span>
                </label>

                {/* Custom "Escolher arquivo" button with controlled large/precise clickable area.
                    Hidden input triggered by the button for reliable hit area. Disabled when greenfield. */}
                <button
                  type="button"
                  className="file-choose-button"
                  onClick={() => existingSitesFileInputRef.current?.click()}
                  disabled={form.greenfield}
                >
                  Escolher arquivo
                </button>
                {existingSitesFile && (
                  <span className="file-name" title={existingSitesFile.name}>
                    {existingSitesFile.name}
                  </span>
                )}
                <input
                  ref={existingSitesFileInputRef}
                  id="existing-file"
                  type="file"
                  accept=".csv,.parquet"
                  style={{ display: "none" }}
                  disabled={form.greenfield}
                  onChange={async (event) => {
                    const file = event.target.files?.[0] ?? null;
                    setExistingSitesFile(file);
                    if (file) await previewUpload(file, setExistingPreview);
                    else setExistingPreview(null);
                  }}
                />
                <PreviewTable data={existingPreview} />
              </div>
            </div>
            {!canConfirmScenario ? (
              <p className="form-warning" style={{ marginTop: "16px" }}>
                {form.scenario_preset === "none"
                  ? "Escolha um cenário para continuar."
                  : !hasValidP 
                    ? "Informe a quantidade de novas unidades (p)."
                    : !hasValidMetric
                      ? "Selecione a métrica de cobertura (Distância ou Tempo)."
                      : !hasValidCoverage 
                        ? `Informe o ${form.metric === 'distance' ? 'raio máximo' : 'tempo máximo'} de cobertura.`
                        : "Para o cenário 'Dados próprios', é obrigatório enviar o arquivo de demanda."}
              </p>
            ) : null}
            <div className="flow-actions" style={{ marginTop: "12px" }}>
              <button className="primary" disabled={!canConfirmScenario} onClick={confirmScenario}>
                Continuar para os métodos de otimização →
              </button>
            </div>
          </section>
        ) : null}

        {tab === "metodos" ? (
          <section className="panel">
            <div className="panel-heading">
              <div>
                <span className="panel-kicker">Etapa 2</span>
                <h2>Métodos e parâmetros</h2>
              </div>
              <span className={methodsConfirmed ? "check-badge ok" : "check-badge"}>{methodsConfirmed ? "Validado" : "Pendente"}</span>
            </div>
            <div className="execution-mode">
              <div>
                <span className="panel-kicker">Modo de comparação</span>
                <strong>{form.execution_mode === "sequential" ? "Sequencial / refinamento" : "Independente / comparação"}</strong>
                <p>
                  {form.execution_mode === "sequential"
                    ? "Cada heurística posterior recebe a melhor solução anterior como ponto de partida (refinamento progressivo)."
                    : "No modo independente, Busca Local, VNS e Genético começam todos da mesma solução inicial do Greedy e não aproveitam as melhorias encontradas uns pelos outros."}
                </p>
              </div>
              <div className="mode-toggle" role="group" aria-label="Modo de execução dos métodos">
                <button
                  type="button"
                  className={form.execution_mode === "sequential" ? "active" : ""}
                  onClick={() => setForm({ ...form, execution_mode: "sequential" })}
                >
                  Sequencial
                </button>
                <button
                  type="button"
                  className={form.execution_mode === "independent" ? "active" : ""}
                  onClick={() => setForm({ ...form, execution_mode: "independent" })}
                >
                  Independente
                </button>
              </div>
            </div>
            <div className="method-grid">
              {methodOrder.map((method) => {
                const greedyLocked = method === "greedy" && dependentHeuristics.some((item) => selectedMethods.includes(item));
                return (
                  <button
                    className={`method-toggle ${methodConfigTab === method ? "active" : ""} ${greedyLocked ? "locked" : ""}`}
                    key={method}
                    type="button"
                    onClick={() => setMethodConfigTab(method)}
                  >
                    <input
                      type="checkbox"
                      checked={selectedMethods.includes(method)}
                      disabled={greedyLocked}
                      title={greedyLocked ? "Greedy é obrigatório para as heurísticas selecionadas" : undefined}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => toggleMethod(method)}
                    />
                    <span className="method-copy">
                      <strong>{methodLabels[method]}</strong>
                      <small>{greedyLocked ? "Base obrigatória das heurísticas selecionadas." : methodSummaries[method]}</small>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="method-settings">
              <div className="method-doc">
                <div>
                  <span className="panel-kicker">Como funciona</span>
                  <h3>{methodLabels[methodConfigTab]}</h3>
                  <p>{methodDetails[methodConfigTab].theory}</p>
                  <p>{methodDetails[methodConfigTab].runs}</p>
                </div>
                <div className="pseudo-block">
                  <span>Pseudocódigo</span>
                  <pre><code>{methodDetails[methodConfigTab].code}</code></pre>
                </div>
              </div>

              {methodConfigTab === "greedy" ? (
                <div className="subpanel method-empty">
                  <h3>Greedy</h3>
                  <p>Este método não exige parâmetros adicionais nesta versão.</p>
                </div>
              ) : null}

              {methodConfigTab === "local_search" ? (
                <div className="subpanel">
                  <h3>Busca Local</h3>
                  <div className="form-grid tight">
                    <label htmlFor="local-max-iter">
                      <span>
                        <FieldTitle help={parameterHelp.localMaxIter}>Máximo de iterações</FieldTitle>
                      </span>
                      <input 
                        id="local-max-iter"
                        type="number" 
                        min={1} 
                        value={form.local_search.max_iter} 
                        onChange={(event) => setForm({ ...form, local_search: { ...form.local_search, max_iter: Number(event.target.value) } })} 
                      />
                    </label>
                    <label htmlFor="local-strategy">
                      <span>
                        <FieldTitle help={parameterHelp.localStrategy}>Estratégia</FieldTitle>
                      </span>
                      <select 
                        id="local-strategy"
                        value={form.local_search.strategy} 
                        onChange={(event) => setForm({ ...form, local_search: { ...form.local_search, strategy: event.target.value } })}
                      >
                        <option value="best">Best improvement</option>
                        <option value="first">First improvement</option>
                      </select>
                    </label>
                  </div>
                </div>
              ) : null}

              {methodConfigTab === "vns" ? (
                <div className="subpanel">
                  <h3>VNS</h3>
                  <div className="form-grid tight">
                    <label htmlFor="vns-max-iter">
                      <span>
                        <FieldTitle help={parameterHelp.vnsMaxIter}>Iterações</FieldTitle>
                      </span>
                      <input 
                        id="vns-max-iter"
                        type="number" min={1} 
                        value={form.vns.max_iter} 
                        onChange={(event) => setForm({ ...form, vns: { ...form.vns, max_iter: Number(event.target.value) } })} 
                      />
                    </label>
                    <label htmlFor="vns-kmax">
                      <span>
                        <FieldTitle help={parameterHelp.vnsKMax}>k_max</FieldTitle>
                      </span>
                      <input 
                        id="vns-kmax"
                        type="number" min={1} max={form.p} 
                        value={form.vns.k_max} 
                        onChange={(event) => setForm({ ...form, vns: { ...form.vns, k_max: Number(event.target.value) } })} 
                      />
                    </label>
                    <label htmlFor="vns-no-improv">
                      <span>
                        <FieldTitle help={parameterHelp.vnsNoImprovement}>Sem melhoria</FieldTitle>
                      </span>
                      <input 
                        id="vns-no-improv"
                        type="number" min={1} 
                        value={form.vns.max_no_improv} 
                        onChange={(event) => setForm({ ...form, vns: { ...form.vns, max_no_improv: Number(event.target.value) } })} 
                      />
                    </label>
                    <label htmlFor="vns-time">
                      <span>
                        <FieldTitle help={parameterHelp.timeLimit}>Tempo s</FieldTitle>
                      </span>
                      <input 
                        id="vns-time"
                        type="number" min={1} 
                        value={form.vns.time_limit} 
                        onChange={(event) => setForm({ ...form, vns: { ...form.vns, time_limit: Number(event.target.value) } })} 
                      />
                    </label>
                    <label htmlFor="vns-strategy">
                      <span>
                        <FieldTitle help={parameterHelp.vnsStrategy}>Estratégia</FieldTitle>
                      </span>
                      <select 
                        id="vns-strategy"
                        value={form.vns.strategy} 
                        onChange={(event) => setForm({ ...form, vns: { ...form.vns, strategy: event.target.value } })}
                      >
                        <option value="best">Best</option>
                        <option value="first">First</option>
                      </select>
                    </label>
                  </div>
                </div>
              ) : null}

              {methodConfigTab === "genetic" ? (
                <div className="subpanel">
                  <h3>Algoritmo Genético</h3>
                  <div className="form-grid tight">
                    <label htmlFor="gen-pop">
                      <span>
                        <FieldTitle help={parameterHelp.population}>População</FieldTitle>
                      </span>
                      <input 
                        id="gen-pop"
                        type="number" min={4} 
                        value={form.genetic.population_size} 
                        onChange={(event) => setForm({ ...form, genetic: { ...form.genetic, population_size: Number(event.target.value) } })} 
                      />
                    </label>
                    <label htmlFor="gen-gens">
                      <span>
                        <FieldTitle help={parameterHelp.generations}>Gerações</FieldTitle>
                      </span>
                      <input 
                        id="gen-gens"
                        type="number" min={1} 
                        value={form.genetic.generations} 
                        onChange={(event) => setForm({ ...form, genetic: { ...form.genetic, generations: Number(event.target.value) } })} 
                      />
                    </label>
                    <label htmlFor="gen-cross">
                      <span>
                        <FieldTitle help={parameterHelp.crossover}>Crossover</FieldTitle>
                      </span>
                      <input 
                        id="gen-cross"
                        type="number" min={0} max={1} step={0.05} 
                        value={form.genetic.crossover_rate} 
                        onChange={(event) => setForm({ ...form, genetic: { ...form.genetic, crossover_rate: Number(event.target.value) } })} 
                      />
                    </label>
                    <label htmlFor="gen-mut">
                      <span>
                        <FieldTitle help={parameterHelp.mutation}>Mutação</FieldTitle>
                      </span>
                      <input 
                        id="gen-mut"
                        type="number" min={0} max={1} step={0.05} 
                        value={form.genetic.mutation_rate} 
                        onChange={(event) => setForm({ ...form, genetic: { ...form.genetic, mutation_rate: Number(event.target.value) } })} 
                      />
                    </label>
                    <label htmlFor="gen-elite">
                      <span>
                        <FieldTitle help={parameterHelp.elitism}>Elitismo</FieldTitle>
                      </span>
                      <input 
                        id="gen-elite"
                        type="number" min={1} 
                        value={form.genetic.elitism} 
                        onChange={(event) => setForm({ ...form, genetic: { ...form.genetic, elitism: Number(event.target.value) } })} 
                      />
                    </label>
                    <label htmlFor="gen-time">
                      <span>
                        <FieldTitle help={parameterHelp.timeLimit}>Tempo s</FieldTitle>
                      </span>
                      <input 
                        id="gen-time"
                        type="number" min={1} 
                        value={form.genetic.time_limit} 
                        onChange={(event) => setForm({ ...form, genetic: { ...form.genetic, time_limit: Number(event.target.value) } })} 
                      />
                    </label>
                    <label htmlFor="gen-seed">
                      <span>
                        <FieldTitle help={parameterHelp.seed}>Seed</FieldTitle>
                      </span>
                      <input 
                        id="gen-seed"
                        value={form.genetic.seed} 
                        onChange={(event) => setForm({ ...form, genetic: { ...form.genetic, seed: event.target.value } })} 
                        placeholder="Opcional" 
                      />
                    </label>
                  </div>
                </div>
              ) : null}

              {methodConfigTab === "exact" ? (
                <div className="subpanel">
                  <h3>Modelo matemático</h3>
                  <p style={{ fontSize: "12.5px", color: "#475569", marginBottom: "10px" }}>
                    Usado principalmente como referência para calcular o gap das heurísticas e provar otimalidade quando possível.
                  </p>
                  <label htmlFor="exact-time">
                    <span>
                      <FieldTitle help={parameterHelp.exactTimeLimit}>Tempo limite CBC s</FieldTitle>
                    </span>
                    <input 
                      id="exact-time"
                      type="number" min={1} 
                      value={form.exact.time_limit} 
                      onChange={(event) => setForm({ ...form, exact: { time_limit: Number(event.target.value) } })} 
                    />
                  </label>
                </div>
              ) : null}
            </div>
            <div className="flow-actions">
              <button className="secondary" onClick={() => changeTab("cenario")}>Voltar ao cenário</button>
              <button className="primary" disabled={selectedMethods.length === 0} onClick={confirmMethods}>
                OK, seguir para execução
              </button>
            </div>
          </section>
        ) : null}

        {tab === "execucao" ? (
          <section className="exec-section">
            <div className="panel">
              <div className="panel-heading">
                <div>
                  <span className="panel-kicker">Etapa 3</span>
                  <h2>Execução</h2>
                </div>
                <span className={`check-badge ${run?.status === "completed" ? "ok" : ""}`}>{run?.status ?? "Aguardando"}</span>
              </div>
              <div className="run-summary">
                <div><span>Cenário</span><strong>{(form.target_uf === "BR" || !form.target_uf) ? "Brasil" : form.target_uf} / p={form.p}</strong></div>
                <div><span>Método de cobertura</span><strong>{form.metric === "distance" ? `${form.radius_km} km` : `${form.max_time_h} h`}</strong></div>
                <div><span>Métodos ativos</span><strong>{selectedMethods.length}</strong></div>
                <div><span>Comparação</span><strong>{form.execution_mode === "sequential" ? "Sequencial" : "Independente"}</strong></div>
              </div>
              <button className="primary run-button" disabled={!canRun || isSubmitting} onClick={submitRun}>
                {isSubmitting ? "Enviando..." : "Executar otimização"}
              </button>
              <MethodProgressPanel run={run} methods={selectedMethods} executionMode={form.execution_mode} />
              <div className="log-box">
                {(run?.logs ?? []).map((line, index) => <p key={`${line}-${index}`}>{line}</p>)}
                {run?.error ? <p className="error">{run.error}</p> : null}
                {!run ? <p>Aguardando início da execução.</p> : null}
              </div>
            </div>
          </section>
        ) : null}

        {tab === "resultados" ? (
          <section className="panel results-panel">
            <div className="panel-heading">
              <div>
                <span className="panel-kicker">Etapa 4</span>
                <h2>Resultados</h2>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span className="check-badge ok">Concluido</span>
                {(history.length > 0 || runId) && (
                  <button
                    type="button"
                    onClick={requestReset}
                    title="Limpar histórico e recomeçar do zero"
                    style={{
                      background: "#b94a48",
                      color: "white",
                      border: "none",
                      padding: "5px 12px",
                      fontSize: "13px",
                      borderRadius: "6px",
                      cursor: "pointer",
                      fontWeight: 600
                    }}
                  >
                    Nova sessão
                  </button>
                )}
              </div>
            </div>

            <div className="metrics results-metrics">
              <article className="metric-card">
                <span>Melhor método</span>
                <strong>{best ? methodLabels[best.method as MethodName] ?? best.method : "-"}</strong>
              </article>
              <article className="metric-card">
                <span>Melhor Z</span>
                <strong style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  {best ? brNumber(best.z) : "-"}
                  {best && best.gap_to_optimal === 0 && (
                    <span
                      style={{
                        fontSize: "10px",
                        background: "#176b52",
                        color: "white",
                        padding: "1px 6px",
                        borderRadius: "999px",
                        fontWeight: 800,
                        letterSpacing: "0.3px",
                      }}
                    >
                      ÓTIMO PROVADO
                    </span>
                  )}
                </strong>
              </article>
              <article className="metric-card">
                <span>Cobertura</span>
                <strong>{best ? `${brNumber(best.coverage_percent, 2)}%` : "-"}</strong>
              </article>
              <article className="metric-card accent">
                <span>Cenário</span>
                <strong>{(form.target_uf === "BR" || !form.target_uf) ? "BR" : form.target_uf} / p={form.p}</strong>
              </article>
            </div>

            <div className="result-section history-section">
              <div className="section-heading">
                <h3>Histórico da sessão</h3>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span>Troque a rodada mantendo a visualização atual.</span>
                  {(history.length > 0 || runId) && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={requestReset}
                      title="Limpar todo o histórico da sessão e recomeçar do zero"
                      style={{ 
                        background: "#b94a48", 
                        color: "white", 
                        border: "none",
                        padding: "4px 10px",
                        fontSize: "12px",
                        borderRadius: "4px",
                        cursor: "pointer"
                      }}
                    >
                      Limpar tudo
                    </button>
                  )}
                </div>
              </div>
              <div className="site-list history-list">
                {history.map((item) => {
                  const bestHistoryResult = pickBestResult(item.result.results);
                  const details = historyScenarioDetails(item);
                  return (
                    <button className={`history-row ${item.run_id === runId ? "active" : ""}`} key={item.run_id} onClick={() => restoreHistoryItem(item)}>
                      <span>{item.label}</span>
                      <div className="history-details">
                        <span>{details.scenario}</span>
                        <span>{details.scope} | p={item.form.p} | {details.coverage}</span>
                        <span>{details.base} | {details.mode}</span>
                        <span>{details.methods}</span>
                      </div>
                      <strong>{bestHistoryResult ? `${methodLabels[bestHistoryResult.method as MethodName] ?? bestHistoryResult.method} | Z=${brNumber(bestHistoryResult.z)}` : "Abrir resultados"}</strong>
                    </button>
                  );
                })}
                {!history.length ? <div className="empty-state">Nenhuma execução concluída nesta sessão.</div> : null}
              </div>
            </div>

            <div className="result-tabs">
              <button className={resultView === "comparacao" ? "active" : ""} onClick={() => setResultView("comparacao")}>Comparação</button>
              <button className={resultView === "mapas" ? "active" : ""} onClick={() => setResultView("mapas")}>Mapas e locais</button>
              <button className={resultView === "exportacoes" ? "active" : ""} onClick={() => setResultView("exportacoes")}>Exportações</button>
            </div>

            {resultView === "comparacao" ? (
              <div className="result-section">
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Método</th>
                        <th>Z</th>
                        <th>Cobertura</th>
                        <th>Nova demanda</th>
                        <th>Tempo</th>
                        <th>Gap p/ Ótimo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(run?.results ?? []).map((result) => {
                        const gap = result.gap_to_optimal;
                        const hasReference = gap !== undefined && gap !== null;

                        let gapDisplay = "—";
                        if (hasReference) {
                          gapDisplay = `${brNumber(gap, 2)}%`;
                        }

                        const rowStyle =
                          gap === 0
                            ? { background: "#f0f7f4", fontWeight: 600 }
                            : undefined;

                        return (
                          <tr key={result.method} style={rowStyle}>
                            <td>{methodLabels[result.method as MethodName] ?? result.method}</td>
                            <td>{brNumber(result.z)}</td>
                            <td>{brNumber(result.coverage_percent, 2)}%</td>
                            <td>{brNumber(result.new_covered_demand)}</td>
                            <td>{brNumber(result.runtime_seconds, 2)}s</td>
                            <td
                              style={{
                                fontFamily: "monospace",
                                fontSize: "12.5px",
                                color: gap === 0 ? "#176b52" : gap && gap > 1 ? "#b94a48" : undefined,
                                fontWeight: gap === 0 ? 700 : undefined,
                              }}
                            >
                              {gapDisplay}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Small explanatory note when we have a reference from exact */}
                {(run?.results ?? []).some((r) => r.gap_to_optimal !== undefined) && (
                  <div style={{ fontSize: "12px", color: "#475569", marginTop: "6px" }}>
                    "Gap p/ Ótimo" é calculado em relação ao melhor Z reportado pelo modelo matemático.
                    Valores em verde indicam que a heurística igualou o resultado do modelo exato.
                  </div>
                )}

                <ProgressChart result={fullResult} executionMode={form.execution_mode} />
              </div>
            ) : null}

            {resultView === "mapas" ? (
              <div className="result-section">
                {/* Controles no topo (largura total) */}
                <div className="map-controls">
                  <label>Método<select value={activeResult?.method ?? ""} onChange={(event) => changeSelectedMethod(event.target.value as MethodName)} disabled={!fullResult?.results.length}>
                    {(fullResult?.results ?? []).map((result) => <option key={result.method} value={result.method}>{methodLabels[result.method as MethodName] ?? result.method}</option>)}
                  </select></label>
                  <label>Modo<select value={mapMode} onChange={(event) => { setMapMode(event.target.value as MapMode); setMapViewResetToken((t) => t + 1); }}><option value="coverage">Cobertura</option><option value="demand">Demanda</option></select></label>
                  <label>Filtro de cobertura<select value={mapStatusFilter} onChange={(event) => { setMapStatusFilter(event.target.value); setMapViewResetToken((t) => t + 1); }} disabled={!activeResult?.map_payload?.areas?.length}>
                    {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select></label>
                  <label>Buscar município<input list="municipios" value={municipioSearch} onChange={(event) => selectMunicipio(event.target.value)} disabled={!municipioOptions.length} placeholder="Digite para buscar..." />
                    <datalist id="municipios">{municipioOptions.map((option) => <option key={option.id} value={option.label} />)}</datalist>
                  </label>
                  <button className="secondary" onClick={() => { setFocusedMunicipioId(null); setMunicipioSearch(""); setMapViewResetToken((t) => t + 1); }}>Recentralizar</button>
                </div>

                {mapLoadingMethod === activeResult?.method ? (
                  <div className="empty-state">Carregando mapa de {methodLabels[activeResult.method as MethodName] ?? activeResult.method}...</div>
                ) : null}

                {/* Layout em duas colunas: Mapa + Locais selecionados */}
                <div className="map-sites-split">
                  {/* Coluna do Mapa */}
                  <div className="map-column">
                    <MclpLeafletMap
                      method={activeResult?.method ?? "none"}
                      areas={activeResult?.map_payload?.areas ?? []}
                      mode={mapMode}
                      statusFilter={mapStatusFilter}
                      focusedId={focusedMunicipioId}
                      mapResetToken={mapViewResetToken}
                      onFeatureClick={(id) => {
                        setFocusedMunicipioId(id);
                        if (!id) {
                          setMunicipioSearch("");
                        } else {
                          const found = (activeResult?.map_payload?.areas ?? []).find((a) => a.municipio_id === id);
                          setMunicipioSearch(found ? `${found.municipio_nome} - ${found.municipio_uf}` : "");
                        }
                      }}
                    />

                    {mapMode === "coverage" ? (
                      <div className="legend">
                        <span><i style={{ background: "#0b3c6f" }} />Existente</span>
                        <span><i style={{ background: "#4d8fcb" }} />Cobertura existente</span>
                        <span><i style={{ background: "#0f7b4d" }} />Novo</span>
                        <span><i style={{ background: "#db9f16" }} />Novo sobreposto</span>
                        <span><i style={{ background: "#7cc27e" }} />Nova cobertura</span>
                        <span><i style={{ background: "#c0c8cd" }} />Sem cobertura</span>
                      </div>
                    ) : (
                      <div className="legend"><span><i style={{ background: "#ebdcb4" }} />Baixa demanda</span><span><i style={{ background: "#eb2814" }} />Alta demanda</span></div>
                    )}
                  </div>

                  {/* Coluna dos Locais Selecionados */}
                  <div className="sites-column">
                    <div className="section-title">Locais selecionados</div>
                    <div className="site-list compact">
                      {[...(activeResult?.sites ?? [])]
                        .sort((a, b) => b.populacao_nova_coberta - a.populacao_nova_coberta)
                        .map((site) => (
                          <div className="site-row" key={`${activeResult?.method}-${site.municipio_id}`}>
                            <strong>{site.municipio_nome}</strong>
                            <span>{site.municipio_uf} | {brNumber(site.populacao_nova_coberta)} nova demanda</span>
                          </div>
                        ))}
                      {(!activeResult?.sites || activeResult.sites.length === 0) && (
                        <div className="empty-state" style={{ padding: "12px 0" }}>
                          Nenhum local selecionado ainda.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {resultView === "exportacoes" ? (
              <div className="result-section exports">
                <div className="export-grid">
                  <a className={!runId || run?.status !== "completed" ? "disabled" : ""} href={`${API_BASE}/api/runs/${runId}/exports/xlsx`}><span>Dados tabulares</span><strong>XLSX</strong></a>
                  <a className={!runId || run?.status !== "completed" ? "disabled" : ""} href={`${API_BASE}/api/runs/${runId}/exports/report`}><span>Relatório final</span><strong>PDF</strong></a>
                  <a className={!runId || run?.status !== "completed" ? "disabled" : ""} href={`${API_BASE}/api/runs/${runId}/exports/map-coverage?method=${exportMethod}`}><span>Mapa interativo</span><strong>Cobertura</strong></a>
                  <a className={!runId || run?.status !== "completed" ? "disabled" : ""} href={`${API_BASE}/api/runs/${runId}/exports/map-demand?method=${exportMethod}`}><span>Mapa interativo</span><strong>Demanda</strong></a>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}
      </section>
    </main>
  );
}

export default App;

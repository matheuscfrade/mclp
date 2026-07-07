import io
import random
import time

import numpy as np
from rich.console import Console
from rich.progress import BarColumn, Progress, SpinnerColumn, TaskProgressColumn, TextColumn
from scipy.sparse import coo_matrix

console = Console(file=io.StringIO(), force_terminal=False, no_color=True)

def build_coverage_map(distance_df, max_dist, max_time, use_km=True, candidates=None):
    """
    Constrói um dicionário mapeando cada local candidato j para o conjunto de nós de demanda i que ele cobre.
    Garante que cada candidato se cubra (auto-cobertura), mesmo se ausente na matriz de distância.
    """
    console.print("[bold blue]Building coverage map...[/bold blue]")
    if use_km:
        mask = distance_df['distancia'] <= max_dist
    else:
        mask = distance_df['tempo'] <= max_time
        
    valid_pairs = distance_df[mask]
    
    coverage = valid_pairs.groupby('origem')['destino'].apply(set).to_dict()
    
    # Garantir auto-cobertura para todos os candidatos
    if candidates is not None:
        console.print(f"Ensuring self-coverage for {len(candidates)} candidates...")
        for j in candidates:
            if j not in coverage:
                coverage[j] = set()
            coverage[j].add(j)
    
    return coverage

def build_sparse_structures(coverage_map, demand_dict, candidates, all_demand_nodes, pre_covered_nodes=None):
    """
    Constrói a Matriz de Cobertura usando Scipy SPARSE Matrix (CSR).
    Muito mais rápido e eficiente em memória para instâncias grandes.
    """
    # Mapear IDs para índices
    cand_to_idx = {c: i for i, c in enumerate(candidates)}
    node_to_idx = {n: i for i, n in enumerate(all_demand_nodes)}
    
    num_cand = len(candidates)
    num_nodes = len(all_demand_nodes)
    
    rows = []
    cols = []
    data = []
    console.print("[blue]Construindo matriz esparsa...[/blue]")
    
    for c in candidates:
        if c in coverage_map:
            c_idx = cand_to_idx[c]
            # Pegamos apenas os nós que existem no demand_dict/all_demand_nodes
            valid_nodes = [n for n in coverage_map[c] if n in node_to_idx]
            
            for n in valid_nodes:
                rows.append(c_idx)
                cols.append(node_to_idx[n])
                data.append(1) # 1 = Coberto
                
    cov_matrix_sparse = coo_matrix((data, (rows, cols)), shape=(num_cand, num_nodes), dtype=np.int8).tocsr()
    
    demand_vector = np.zeros(num_nodes, dtype=np.int32)
    for n, d in demand_dict.items():
        if n in node_to_idx:
            demand_vector[node_to_idx[n]] = d
            
    # Vetor de Cobertura Inicial
    initial_coverage = np.zeros(num_nodes, dtype=np.int32)
    if pre_covered_nodes:
        for n in pre_covered_nodes:
            if n in node_to_idx:
                initial_coverage[node_to_idx[n]] = 1
                
    return cov_matrix_sparse, demand_vector, cand_to_idx, node_to_idx, initial_coverage

def build_sparse_matrix_from_df(distance_df, demand_dict, candidates, all_demand_nodes, max_dist, max_time, use_km=True, pre_covered_nodes=None):
    """
    Constrói a Matriz Esparsa diretamente do DataFrame de distâncias filtrado.
    Evita a criação do dicionário intermediário gigante.
    """
    console.print("[blue]Construindo matriz esparsa via DataFrame...[/blue]")
    
    # 1. Mapear IDs para índices
    cand_to_idx = {c: i for i, c in enumerate(candidates)}
    node_to_idx = {n: i for i, n in enumerate(all_demand_nodes)}
    
    num_cand = len(candidates)
    num_nodes = len(all_demand_nodes)
    
    df_filtered = distance_df[
        distance_df['origem'].isin(cand_to_idx) & 
        distance_df['destino'].isin(node_to_idx)
    ].copy()
    
    if use_km:
        df_filtered = df_filtered[df_filtered['distancia'] <= max_dist]
    else:
        df_filtered = df_filtered[df_filtered['tempo'] <= max_time]
        
    row_indices = df_filtered['origem'].map(cand_to_idx).values
    col_indices = df_filtered['destino'].map(node_to_idx).values
    
    # Auto-Cobertura
    # Devemos garantir que cada candidato se cubra
    # Append self-coverage indices
    self_rows = []
    self_cols = []
    for c in candidates:
        if c in node_to_idx: # If candidate is also a demand node
            self_rows.append(cand_to_idx[c])
            self_cols.append(node_to_idx[c])
            
    # Combine
    all_rows = np.concatenate([row_indices, np.array(self_rows)])
    all_cols = np.concatenate([col_indices, np.array(self_cols)])
    
    # Dados são todos 1
    data = np.ones(len(all_rows), dtype=np.int8)
    
    cov_matrix = coo_matrix((data, (all_rows, all_cols)), shape=(num_cand, num_nodes), dtype=np.int8).tocsr()
    
    cov_matrix.data[:] = 1
    
    # Vetores
    demand_vector = np.zeros(num_nodes, dtype=np.int32)
    for n, d in demand_dict.items():
        if n in node_to_idx:
            demand_vector[node_to_idx[n]] = d
            
    initial_coverage = np.zeros(num_nodes, dtype=np.int32)
    if pre_covered_nodes:
        for n in pre_covered_nodes:
            if n in node_to_idx:
                initial_coverage[node_to_idx[n]] = 1
                
    return cov_matrix, demand_vector, cand_to_idx, node_to_idx, initial_coverage

def calculate_z(solution, cov_matrix, demand_vector, cand_to_idx, initial_coverage):
    """
    Calcula Z usando matriz esparsa.
    """
    # Índices
    sol_indices = [cand_to_idx[c] for c in solution if c in cand_to_idx]
    if not sol_indices:
        # Apenas cobertura inicial
        return np.sum(demand_vector[initial_coverage > 0])
        
    rows_sum = cov_matrix[sol_indices].sum(axis=0)
    
    current_coverage = initial_coverage + np.asarray(rows_sum).flatten()
    
    # Calcular Z
    return np.sum(demand_vector[current_coverage > 0])

def greedy_heuristic(candidates, p, cov_matrix, demand_vector, cand_to_idx, initial_coverage, progress_callback=None):
    """
    Heurística Greedy OTIMIZADA com Matrizes Esparsas.
    """
    console.print(f"\n[bold green]Running Greedy Heuristic (Sparse) (p={p})...[/bold green]")
    
    num_cand = cov_matrix.shape[0]
    
    sol_indices = []
    current_coverage = initial_coverage.copy() # Dense array 1D
    
    # Máscara de candidatos (True = Disponível)
    candidates_available = np.ones(num_cand, dtype=bool)
    
    # Remove candidates that are already fully pre-covered? 
    # Not strictly necessary but self-coverage logic implies. 
    # Just standard greedy: pick best gain.
    
    # Pré-calcular Z atual (opcional)
    current_z = np.sum(demand_vector[current_coverage > 0])
    
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        TextColumn("Z: {task.fields[z]}"),
        console=console
    ) as progress:
        task = progress.add_task("[cyan]Greedy Construction...", total=p, z=f"{current_z:,.0f}")
        
        for step in range(p):
            # 1. Identify Uncovered Demand
            # Dense boolean mask
            uncovered_mask = (current_coverage == 0)
            
            # 2. Demand Vector of Uncovered Nodes
            # Dense int array
            uncovered_demand_vector = demand_vector * uncovered_mask
            
            # 3. Calcular Ganhos Potenciais para TODOS os candidatos
            # Matriz (Candidatos x Nós) @ Vetor (Nós) -> Vetor (Candidatos)
            # Isso fornece exatamente quanto de demanda cada candidato cobriria entre os nós não cobertos
            gains = cov_matrix @ uncovered_demand_vector
            
            # 4. Mascarar candidatos já selecionados
            gains[~candidates_available] = -1
            
            # 5. Escolher o melhor
            best_idx = np.argmax(gains)
            best_gain = gains[best_idx]
            
            if best_gain <= 0:
                console.print(f"  [yellow]Step {step+1}: No more gain possible.[/yellow]")
                progress.update(task, completed=p)
                break
                
            # 6. Atualizar
            sol_indices.append(best_idx)
            candidates_available[best_idx] = False
            
            # Atualizar cobertura
            # Pegar linha do melhor candidato
            best_row = cov_matrix[best_idx].toarray().flatten()
            current_coverage = current_coverage + best_row # >0 implies covered
            # (We keep it as count or bool, here assumes int count but >0 check handles it)
            
            current_z += best_gain
            
            if progress_callback:
                progress_callback(step + 1, p, {'z': current_z})
            progress.update(task, advance=1, z=f"{current_z:,.0f}")
            
    # Converter índices de volta para IDs
    idx_to_cand = {v: k for k, v in cand_to_idx.items()}
    solution = [idx_to_cand[idx] for idx in sol_indices]
    
    return solution

def local_search(solution, candidates, cov_matrix_sparse, demand_vector, cand_to_idx, initial_coverage, max_iter=1000, strategy='best', show_progress=False, progress_callback=None, random_tie_break=False):
    """
    Busca Local OTIMIZADA para MATRIZES ESPARSAS.
    """
    # Índices
    # Índices com tipo inteiro explícito para evitar erros se array vazio
    sol_indices = np.array([cand_to_idx[c] for c in solution], dtype=int)
    all_cand_indices = np.array(list(cand_to_idx.values()), dtype=int)
    
    # Máscara do Pool
    is_in_sol = np.zeros(len(all_cand_indices), dtype=bool)
    is_in_sol[sol_indices] = True
    pool_indices = all_cand_indices[~is_in_sol]

    # Cobertura Atual
    current_coverage = initial_coverage.copy() + np.array(cov_matrix_sparse[sol_indices].sum(axis=0)).flatten()
    
    # Calcular Z
    current_z = np.sum(demand_vector[current_coverage > 0])

    improved = True
    iteration = 0
    
    if show_progress:
        console.print(f"\n[bold green]Running Local Search (Sparse/Optimized) ({strategy})...[/bold green]")
        console.print(f"  Initial Z: [bold]{current_z:,.0f}[/bold]")
        
    # Reportar estado inicial (A "Queda" do shaking)
    if progress_callback:
        progress_callback(0, max_iter, {'z': current_z})
        
    # Configurar barra de progresso se solicitado
    progress = None
    task = None
    
    if show_progress:
        progress = Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            TextColumn("Z: {task.fields[z]}"),
            console=console
        )
        progress.start()
        task = progress.add_task(f"[cyan]Local Search ({strategy})...", total=max_iter, z=f"{current_z:,.0f}")
    
    # 0. Pré-calcular Ganho Potencial Inicial
    uncovered_mask = (current_coverage == 0)
    uncovered_demand = demand_vector * uncovered_mask
    potential_gains = cov_matrix_sparse @ uncovered_demand

    try:
        while improved and iteration < max_iter:
            improved = False
            iteration += 1
            
            # Atualização incremental dos ganhos potenciais
            
            check_order = np.arange(len(sol_indices))
            if strategy == 'first':
                np.random.shuffle(check_order)
                
            best_delta = 0
            best_move = None 

            for i_rem in check_order:
                rem_idx = sol_indices[i_rem]
                
                rem_coverage_row = cov_matrix_sparse[rem_idx].toarray().flatten()
                
                is_unique_mask = (current_coverage == 1) & (rem_coverage_row == 1)
                loss = np.sum(demand_vector[is_unique_mask])
                
                unique_demand_vector = demand_vector * is_unique_mask
                
                recoveries = cov_matrix_sparse @ unique_demand_vector
                
                # C. Delta
                deltas = potential_gains - loss + recoveries
                
                # Verificar Pool
                pool_deltas = deltas[pool_indices]
                
                # --- Visualização: Amostrar algumas "tentativas" ---
                if progress_callback and iteration % 1 == 0: # Log frequently
                    # Escolher candidato aleatório ou o melhor até agora para mostrar "esforço"
                    best_batch_delta = 0
                    if pool_deltas.size > 0:
                         best_batch_delta = np.max(pool_deltas)
                         candidate_z = current_z + best_batch_delta
                         # We can pass a list of candidates or just one
                         progress_callback(iteration, max_iter, {'z': current_z, 'candidate_zs': [candidate_z]})
                # ---------------------------------------------
                
                if strategy == 'first':
                    positive_indices = np.where(pool_deltas > 0)[0]
                    if positive_indices.size > 0:
                        # Aleatoriedade: escolha randômica entre melhorias (First Improvement)
                        local_idx_in_pool = np.random.choice(positive_indices)
                        
                        add_idx = pool_indices[local_idx_in_pool]
                        delta = pool_deltas[local_idx_in_pool]
                        
                        # --- Preparação para Atualização Incremental ---
                        add_coverage_row = cov_matrix_sparse[add_idx].toarray().flatten()
                        rem_coverage_row = cov_matrix_sparse[rem_idx].toarray().flatten()

                        # Identificar nós que PERDEM cobertura (eram cobertos apenas pelo removido)
                        nodes_losing_coverage_mask = is_unique_mask
                        lost_demand_vector = demand_vector * nodes_losing_coverage_mask
                        
                        # Identificar nós que GANHAM cobertura (não eram cobertos OU ficaram livres e o novo cobriu)
                        # Fix: Incluir is_unique_mask para considerar nós transferidos diretamente de rem para add
                        nodes_gaining_coverage_mask = ((current_coverage == 0) | is_unique_mask) & (add_coverage_row == 1)
                        gained_demand_vector = demand_vector * nodes_gaining_coverage_mask
                        
                        # --- Aplicar Troca na Solução ---
                        current_coverage = current_coverage - rem_coverage_row + add_coverage_row
                        
                        sol_indices[i_rem] = add_idx
                        pool_indices[local_idx_in_pool] = rem_idx
                        
                        current_z += delta
                        improved = True
                        
                        # --- Aplicar Atualização Incremental nos Ganhos Potenciais ---
                        # O ganho AUMENTA para candidatos que cobrem nós que perdemos (nova oportunidade)
                        # O ganho DIMINUI para candidatos que cobrem nós que acabamos de cobrir (perda de oportunidade)
                        net_demand_change = lost_demand_vector - gained_demand_vector
                        potential_gains += cov_matrix_sparse @ net_demand_change
                        
                        break 
                
                else: # Best
                    if pool_deltas.size > 0:
                        
                        if random_tie_break:
                             # Best Improvement com desempate aleatório (VNS)
                            best_batch_delta = np.max(pool_deltas)
                            if best_batch_delta > best_delta:
                                best_delta = best_batch_delta
                                candidates_best_indices = np.where(pool_deltas == best_batch_delta)[0]
                                local_idx_in_pool = np.random.choice(candidates_best_indices)
                                add_idx = pool_indices[local_idx_in_pool]
                                best_move = (i_rem, add_idx, local_idx_in_pool)
                            
                        else:
                            # Best Improvement padrão (Determinístico)
                            max_idx = np.argmax(pool_deltas)
                            max_delta = pool_deltas[max_idx]
                            
                            if max_delta > best_delta:
                                best_delta = max_delta
                                add_idx = pool_indices[max_idx]
                                best_move = (i_rem, add_idx, max_idx)

            if strategy == 'best' and best_move:
                i_rem, add_idx, local_idx_in_pool = best_move
                rem_idx = sol_indices[i_rem]
                
                add_coverage_row = cov_matrix_sparse[add_idx].toarray().flatten()
                rem_coverage_row = cov_matrix_sparse[rem_idx].toarray().flatten()
                
                # --- Cálculo da Atualização Incremental (Reconstruir máscaras para o melhor movimento) ---
                is_unique_mask = (current_coverage == 1) & (rem_coverage_row == 1)
                nodes_losing_coverage_mask = is_unique_mask
                lost_demand_vector = demand_vector * nodes_losing_coverage_mask
                
                # Fix: Incluir is_unique_mask para considerar nós transferidos diretamente de rem para add
                nodes_gaining_coverage_mask = ((current_coverage == 0) | is_unique_mask) & (add_coverage_row == 1)
                gained_demand_vector = demand_vector * nodes_gaining_coverage_mask
                
                # Aplicar Troca
                current_coverage = current_coverage - rem_coverage_row + add_coverage_row
                sol_indices[i_rem] = add_idx
                pool_indices[local_idx_in_pool] = rem_idx
                
                current_z += best_delta
                
                # Aplicar Atualização Incremental
                net_demand_change = lost_demand_vector - gained_demand_vector
                potential_gains += cov_matrix_sparse @ net_demand_change
                
                improved = True
                
                if progress_callback:
                    progress_callback(iteration, max_iter, {'z': current_z})
                if progress:
                    progress.update(task, advance=1, z=f"{current_z:,.0f}")
            else:
                if progress:
                    progress.update(task, advance=1)
                    
            if progress and iteration >= max_iter:
                 progress.update(task, completed=max_iter, description="[yellow]Máx Iter Alcançado")

    finally:
        if progress:
            # properly close
            if improved:
                 progress.update(task, completed=max_iter, description="[green]Busca Local Finalizada")
            progress.stop()

    # Converter de volta
    idx_to_cand = {v: k for k, v in cand_to_idx.items()}
    final_solution = [idx_to_cand[idx] for idx in sol_indices]
    
    return final_solution, current_z


def get_random_neighbor(solution, candidates_set, k):

    s_list = list(solution)
    available_candidates = list(candidates_set - set(solution))
    if len(s_list) < k or len(available_candidates) < k:
        return s_list
    rem = random.sample(s_list, k)
    add = random.sample(available_candidates, k)
    new_sol_set = (set(s_list) - set(rem)) | set(add)
    return sorted(list(new_sol_set))


def vns(initial_solution, candidates, coverage_map, demand_dict, pre_covered_nodes, 
        k_max=10, max_iter=5000, max_no_improv=500, max_time_seconds=300, ls_strategy='best', progress_callback=None,
        sparse_structures=None):
    """
    VNS com Matrizes Esparsas e Limite de Tempo.
    Aceita sparse_structures pré-calculadas para evitar reprocessamento.
    """
    console.print(f"\n[bold green]Executando VNS (Esparso + Limite de Tempo {max_time_seconds}s + Estratégia {ls_strategy})...[/bold green]")
    
    start_time = time.time()
    
    candidates_set = set(candidates)
    
    # --- CONSTRUIR ESTRUTURAS ESPARSAS SE NÃO FORNECIDAS ---
    if sparse_structures:
        cov_matrix_sparse, demand_vector, cand_to_idx, node_to_idx, initial_coverage = sparse_structures
        console.print(f"  [blue]Usando Matriz Esparsa pré-construída: {cov_matrix_sparse.shape}[/blue]")
    else:
        # Se não fornecer estruturas, precisamos construir.
        # Isso pode ser lento se chamado repetidamente sem cache.
        all_demand_nodes = list(demand_dict.keys())
        # Tentar usar build_sparse_matrix_from_df se coverage_map não for suficiente ou reconstruir
        # Mas coverage_map é um dict. Melhor usar build_sparse_structures
        cov_matrix_sparse, demand_vector, cand_to_idx, node_to_idx, initial_coverage = build_sparse_structures(
            coverage_map, demand_dict, candidates, all_demand_nodes, pre_covered_nodes
        )
        console.print(f"  [blue]Formato da Matriz Esparsa: {cov_matrix_sparse.shape}[/blue]")

    # Cálculo de Z Inicial
    current_z = calculate_z(initial_solution, cov_matrix_sparse, demand_vector, cand_to_idx, initial_coverage)

    if len(initial_solution) <= 1 and k_max == 10 and max_iter == 5000: 
        if len(initial_solution) <= 1:
             return initial_solution, current_z
             
    current_solution = list(initial_solution)
    best_solution = list(current_solution)
    best_z = current_z
    
    sem_melhora = 0
    iter_count = 0
    
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        TextColumn("Melhor Z: {task.fields[z]}"),
        TextColumn("k: {task.fields[k]}"),
        TextColumn("Tempo: {task.fields[time]}s"),
        console=console
    ) as progress:
        task = progress.add_task("[magenta]VNS Executando...", total=max_iter, z=f"{current_z:,.0f}", k=1, time=0)
        
        while sem_melhora < max_no_improv and iter_count < max_iter:
            iter_count += 1
            elapsed = time.time() - start_time
            
            # VERIFICAR LIMITE DE TEMPO
            if max_time_seconds and elapsed > max_time_seconds:
                console.print(f"  [yellow]Limite de tempo alcançado ({max_time_seconds}s).[/yellow]")
                break
            
            k = 1
            progress.update(task, description=f"[magenta]Iter {iter_count} (NoImprov: {sem_melhora})", z=f"{best_z:,.0f}", k=k, time=f"{elapsed:.0f}")
            
            while k <= k_max:
                # Atualizar progresso para loop interno
                progress.update(task, k=k, z=f"{best_z:,.0f}")
                if progress_callback:
                    progress_callback(iter_count, max_iter, {
                        'z': best_z,
                        'k': k,
                        'time': elapsed,
                        'z_viz': current_z
                    })

                # 1. Agitação (Shaking)
                s_prime = get_random_neighbor(current_solution, candidates_set, k)
                
                # 2. Busca Local Esparsa
                # Passar progress_callback para ver a trajetória no gráfico
                # Random tie-break habilitado DENTRO DO VNS
                s_double_prime, z_double_prime = local_search(
                    s_prime, candidates, cov_matrix_sparse, demand_vector, cand_to_idx, initial_coverage,
                    max_iter=500, strategy=ls_strategy, show_progress=False,
                    progress_callback=progress_callback,
                    random_tie_break=True
                )
                
                # 3. Mudança de Vizinhança
                if z_double_prime > current_z:
                    current_solution = s_double_prime
                    current_z = z_double_prime
                    
                    if current_z > best_z:
                        best_z = current_z
                        best_solution = list(current_solution)
                        sem_melhora = 0
                        k = 1
                        console.print(f"  [green]New Best Z: {best_z:,.0f} (Iter {iter_count}, k={k})[/green]")
                    else:
                        k = 1 
                else:
                    k += 1
            
            sem_melhora += 1
            progress.advance(task)
            
            if progress_callback:
                progress_callback(iter_count, max_iter, {
                    'z': best_z,
                    'k': k,
                    'time': elapsed,
                    'z_viz': current_z
                })
            
    return best_solution, best_z

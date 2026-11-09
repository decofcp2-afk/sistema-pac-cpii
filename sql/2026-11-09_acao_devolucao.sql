-- Planejamento e Monitoramento Orçamentário — 09/11/2026
-- Retorno da reunião com a Reitoria:
--  1. Dotação por ação orçamentária (20RI e outras) e marca de "previsão"
--     (recursos próprios dependem da arrecadação).
--  2. Devolução de saldo à Reitoria: comando manual do Monitoramento, que
--     pode ser desfeito enquanto a Reitoria não redistribuiu o valor.

-- ═══ 1. Ação orçamentária e previsão ════════════════════════════════════════
create table if not exists public.acoes_orcamentarias (
  codigo text primary key check (codigo ~ '^[0-9A-Z]{4}$'),
  nome   text not null check (length(trim(nome)) >= 3),
  ativo  boolean not null default true
);
alter table public.acoes_orcamentarias enable row level security;
drop policy if exists acoes_leitura on public.acoes_orcamentarias;
create policy acoes_leitura on public.acoes_orcamentarias for select to authenticated using (true);
drop policy if exists acoes_inclusao on public.acoes_orcamentarias;
create policy acoes_inclusao on public.acoes_orcamentarias for insert to authenticated
  with check (public.sou_admin_global() or public.meu_papel()::text in ('chefia','ord_despesas','licitacoes'));
grant select, insert on public.acoes_orcamentarias to authenticated;
insert into public.acoes_orcamentarias (codigo, nome) values
  ('20RI', 'Funcionamento das Instituições Federais de Educação Básica')
on conflict (codigo) do nothing;

alter table public.dotacoes add column if not exists acao_codigo text references public.acoes_orcamentarias(codigo);
alter table public.dotacoes add column if not exists previsao boolean not null default false;
update public.dotacoes set acao_codigo = '20RI' where acao_codigo is null;

-- Uma dotação por unidade, exercício, origem, fonte e ação.
drop index if exists public.dotacoes_unidade_ex_origem_fonte_key;
create unique index if not exists dotacoes_unidade_ex_origem_fonte_acao_key
  on public.dotacoes (id_unidade_fk, exercicio, origem, coalesce(fonte_codigo, '----'), coalesce(acao_codigo, '----'));

-- ═══ 2. Devolução de saldo à Reitoria ═══════════════════════════════════════
-- Efeito: a demanda deixa de comprometer o valor devolvido e cada unidade da
-- cadeia (seção → diretoria → pró-reitoria) passa a ter recebido esse valor a
-- menos; a unidade raiz (Reitoria) o recupera como saldo livre. O saldo livre
-- das unidades intermediárias não muda.
create table if not exists public.devolucoes_saldo (
  id_devolucao    uuid primary key default gen_random_uuid(),
  id_demanda      uuid not null references public.demandas(id_demanda) on delete cascade,
  exercicio       smallint not null,
  valor           numeric(14,2) not null check (valor > 0),
  motivo          text not null check (motivo in ('economia','nao_requisitada','prazo_encerrado','restos_a_pagar','outro')),
  observacao      text,
  criado_por      uuid references public.perfis(id_usuario) on delete set null,
  data_criacao    timestamptz not null default now(),
  desfeita_em     timestamptz,
  desfeita_por    uuid references public.perfis(id_usuario) on delete set null,
  motivo_desfazer text
);
create index if not exists devolucoes_saldo_demanda_idx on public.devolucoes_saldo (id_demanda);
create index if not exists devolucoes_saldo_ativas_idx on public.devolucoes_saldo (exercicio) where desfeita_em is null;
alter table public.devolucoes_saldo enable row level security;   -- gravação só pelas funções dev_*
drop policy if exists dev_select on public.devolucoes_saldo;
create policy dev_select on public.devolucoes_saldo for select to authenticated
  using (public.sou_admin_global() or public.pode_ver_unidade(public.unidade_da_demanda(id_demanda)));
grant select on public.devolucoes_saldo to authenticated;

create or replace function public.devolvido_demanda(p_demanda uuid) returns numeric
language sql stable security definer set search_path to 'public' as $$
  select coalesce(sum(valor), 0) from public.devolucoes_saldo where id_demanda = p_demanda and desfeita_em is null
$$;

create or replace function public.devolvido_proprio(p_unidade uuid, p_exercicio smallint) returns numeric
language sql stable security definer set search_path to 'public' as $$
  select coalesce(sum(v.valor), 0) from public.devolucoes_saldo v join public.demandas d on d.id_demanda = v.id_demanda
   where d.id_unidade_fk = p_unidade and v.exercicio = p_exercicio and v.desfeita_em is null
$$;

create or replace function public.devolvido_subarvore(p_unidade uuid, p_exercicio smallint) returns numeric
language sql stable security definer set search_path to 'public' as $$
  select coalesce(sum(v.valor), 0) from public.devolucoes_saldo v join public.demandas d on d.id_demanda = v.id_demanda
   where d.id_unidade_fk in (select s.id_unidade from public.subordinadas(p_unidade) s)
     and v.exercicio = p_exercicio and v.desfeita_em is null
$$;

create or replace function public.raiz_unidade(p_unidade uuid) returns uuid
language sql stable security definer set search_path to 'public' as $$
  with recursive acima as (
    select id_unidade, id_unidade_pai, 0 as n from public.unidades where id_unidade = p_unidade
    union all
    select u.id_unidade, u.id_unidade_pai, a.n + 1 from public.unidades u join acima a on u.id_unidade = a.id_unidade_pai where a.n < 50
  )
  select id_unidade from acima where id_unidade_pai is null limit 1
$$;

-- Recebido: menos o que a própria subárvore devolveu (a raiz não perde nada).
create or replace function public.valor_alocado(p_unidade uuid, p_exercicio smallint) returns numeric
language sql stable security definer set search_path to 'public' as $$
  select coalesce((select sum(d.valor_total) from public.dotacoes d
                    where d.id_unidade_fk = p_unidade and d.exercicio = p_exercicio), 0)
       + coalesce((select sum(x.valor) from public.distribuicoes x
                     join public.dotacoes d on d.id_dotacao = x.id_dotacao_origem_fk
                    where x.id_unidade_destino_fk = p_unidade and d.exercicio = p_exercicio), 0)
       - case when (select id_unidade_pai from public.unidades where id_unidade = p_unidade) is null then 0
              else public.devolvido_subarvore(p_unidade, p_exercicio) end
$$;

-- Repassado: menos o que as subordinadas (e as abaixo delas) devolveram.
create or replace function public.valor_distribuido(p_unidade uuid, p_exercicio smallint) returns numeric
language sql stable security definer set search_path to 'public' as $$
  select coalesce((select sum(x.valor) from public.distribuicoes x
                     join public.dotacoes d on d.id_dotacao = x.id_dotacao_origem_fk
                     join public.unidades u on u.id_unidade = x.id_unidade_destino_fk
                    where u.id_unidade_pai = p_unidade and d.exercicio = p_exercicio), 0)
       - (public.devolvido_subarvore(p_unidade, p_exercicio) - public.devolvido_proprio(p_unidade, p_exercicio))
$$;

-- Comprometido pelas demandas da unidade: valor homologado menos o devolvido.
create or replace function public.saldo_livre_unidade(p_unidade uuid, p_exercicio smallint, p_excluir uuid default null)
returns numeric language sql stable security definer set search_path to 'public' as $$
  select public.saldo_unidade(p_unidade, p_exercicio)
       - coalesce((select sum(d.valor_estimado) from public.demandas d
                   where d.id_unidade_fk = p_unidade and d.exercicio = p_exercicio
                     and d.status in ('submetida','aprovada','priorizada','homologada')
                     and (p_excluir is null or d.id_demanda <> p_excluir)), 0)
       + public.devolvido_proprio(p_unidade, p_exercicio)
$$;

-- Quanto ainda pode ser devolvido: homologado − devolvido − o que as
-- requisições comprometem (valor real, se aprovadas; senão o requisitado).
create or replace function public.devolvivel_demanda(p_demanda uuid) returns numeric
language sql stable security definer set search_path to 'public' as $$
  select d.valor_estimado - public.devolvido_demanda(d.id_demanda)
       - coalesce((select sum(case when public.situacao_consome_instrumento(r.situacao) and r.valor_real is not null
                                   then r.valor_real else r.valor end)
                     from public.requisicoes r where r.id_demanda = d.id_demanda and r.situacao <> 'cancelada'), 0)
    from public.demandas d where d.id_demanda = p_demanda
$$;

-- Teto para requisitar: a devolução consome primeiro o resíduo (requisitado −
-- real) e só depois o saldo ainda não requisitado.
create or replace function public.limite_requisitavel(p_demanda uuid, p_exceto uuid, p_residuo_proprio numeric)
returns numeric language sql stable security definer set search_path to 'public' as $$
  select d.valor_estimado - greatest(public.devolvido_demanda(d.id_demanda)
           - coalesce((select sum(r.valor - r.valor_real) from public.requisicoes r
                        where r.id_demanda = d.id_demanda and r.id_requisicao is distinct from p_exceto
                          and r.situacao <> 'cancelada' and r.valor_real is not null
                          and public.situacao_consome_instrumento(r.situacao)), 0)
           - coalesce(p_residuo_proprio, 0), 0)
    from public.demandas d where d.id_demanda = p_demanda
$$;

-- Regra da requisição passa a usar o teto acima.
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.validar_requisicao()'::regprocedure);
  if position('limite_requisitavel' in v_def) = 0 then
    v_def := replace(v_def, 'declare d record; i record; v_valor numeric; v_qtd numeric; v_n integer;',
                            'declare d record; i record; v_valor numeric; v_qtd numeric; v_n integer; v_lim numeric;');
    v_def := replace(v_def, $o$    if v_valor + new.valor > d.valor_estimado then
      raise exception 'A demanda % tem R$ % de saldo para requisitar.', d.codigo, public.fmt_brl(d.valor_estimado - v_valor);$o$,
$n$    v_lim := public.limite_requisitavel(new.id_demanda, new.id_requisicao,
      case when new.valor_real is not null and public.situacao_consome_instrumento(new.situacao) then new.valor - new.valor_real else 0 end);
    if v_valor + new.valor > v_lim + 0.005 then
      raise exception 'A demanda % tem R$ % de saldo para requisitar%.', d.codigo, public.fmt_brl(greatest(v_lim - v_valor, 0)),
        case when public.devolvido_demanda(new.id_demanda) > 0
             then ' (R$ ' || public.fmt_brl(public.devolvido_demanda(new.id_demanda)) || ' foram devolvidos a Reitoria)' else '' end;$n$);
    if position('limite_requisitavel' in v_def) = 0 or position('v_lim numeric' in v_def) = 0 then
      raise exception 'validar_requisicao: trecho do saldo nao encontrado; nada foi alterado.';
    end if;
    execute v_def;
  end if;
end $$;

-- (Ajuste aplicado depois: a mensagem cita o valor devolvido à Reitoria.)
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.validar_requisicao()'::regprocedure);
  if position('foram devolvidos a Reitoria' in v_def) = 0 then
    v_def := replace(v_def, $o$      raise exception 'A demanda % tem R$ % de saldo para requisitar.', d.codigo, public.fmt_brl(greatest(v_lim - v_valor, 0));$o$,
$n$      raise exception 'A demanda % tem R$ % de saldo para requisitar%.', d.codigo, public.fmt_brl(greatest(v_lim - v_valor, 0)),
        case when public.devolvido_demanda(new.id_demanda) > 0
             then ' (R$ ' || public.fmt_brl(public.devolvido_demanda(new.id_demanda)) || ' foram devolvidos a Reitoria)' else '' end;$n$);
    if position('foram devolvidos a Reitoria' in v_def) = 0 then raise exception 'mensagem nao encontrada'; end if;
    execute v_def;
  end if;
end $$;

-- Devolver (Monitoramento do escopo ou administrador).
create or replace function public.dev_devolver(p_demanda uuid, p_valor numeric, p_motivo text, p_observacao text default null)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare d public.demandas; v_max numeric; v_id uuid;
begin
  select * into d from public.demandas where id_demanda = p_demanda for update;
  if d.id_demanda is null then raise exception 'Demanda nao encontrada.'; end if;
  if not public.pode_monitorar(d.id_unidade_fk) then
    raise exception 'Somente a equipe de Monitoramento pode devolver saldo a Reitoria.';
  end if;
  if d.status::text <> 'homologada' then raise exception 'So demandas homologadas tem saldo a devolver.'; end if;
  if p_motivo is null or p_motivo not in ('economia','nao_requisitada','prazo_encerrado','restos_a_pagar','outro') then
    raise exception 'Motivo invalido.';
  end if;
  if p_motivo = 'outro' and length(trim(coalesce(p_observacao, ''))) < 5 then
    raise exception 'Descreva o motivo da devolucao.';
  end if;
  if p_valor is null or p_valor <= 0 then raise exception 'Informe o valor a devolver.'; end if;
  v_max := public.devolvivel_demanda(p_demanda);
  if p_valor > v_max + 0.005 then
    raise exception 'A demanda % tem R$ % que pode ser devolvido.', d.codigo, public.fmt_brl(greatest(v_max, 0));
  end if;
  insert into public.devolucoes_saldo (id_demanda, exercicio, valor, motivo, observacao, criado_por)
    values (p_demanda, d.exercicio, round(p_valor, 2), p_motivo, nullif(trim(coalesce(p_observacao, '')), ''), auth.uid())
    returning id_devolucao into v_id;
  return v_id;
end $$;

-- Desfazer: só enquanto a Reitoria tiver o valor livre (não redistribuído).
create or replace function public.dev_desfazer(p_id uuid, p_motivo text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v public.devolucoes_saldo; d public.demandas; v_raiz uuid; v_livre numeric; v_sigla text;
begin
  select * into v from public.devolucoes_saldo where id_devolucao = p_id for update;
  if v.id_devolucao is null then raise exception 'Devolucao nao encontrada.'; end if;
  if v.desfeita_em is not null then raise exception 'Esta devolucao ja foi desfeita.'; end if;
  select * into d from public.demandas where id_demanda = v.id_demanda for update;
  if not public.pode_monitorar(d.id_unidade_fk) then
    raise exception 'Somente a equipe de Monitoramento pode desfazer a devolucao.';
  end if;
  if length(trim(coalesce(p_motivo, ''))) < 5 then raise exception 'Informe por que a devolucao sera desfeita.'; end if;
  v_raiz := public.raiz_unidade(d.id_unidade_fk);
  v_livre := public.saldo_livre_unidade(v_raiz, v.exercicio);
  if v_livre < v.valor - 0.005 then
    select sigla into v_sigla from public.unidades where id_unidade = v_raiz;
    raise exception 'O valor ja foi redistribuido: % tem R$ % livres e a devolucao e de R$ %. Para desfazer, a Reitoria precisa liberar o valor antes.',
      coalesce(v_sigla, 'A Reitoria'), public.fmt_brl(greatest(v_livre, 0)), public.fmt_brl(v.valor);
  end if;
  update public.devolucoes_saldo set desfeita_em = now(), desfeita_por = auth.uid(), motivo_desfazer = trim(p_motivo)
   where id_devolucao = p_id;
end $$;

-- Permissões das funções novas (nada para quem não tem login, exceto o que
-- a visão do painel usa).
revoke execute on function public.devolvido_demanda(uuid), public.devolvido_proprio(uuid, smallint),
  public.devolvido_subarvore(uuid, smallint), public.raiz_unidade(uuid), public.devolvivel_demanda(uuid),
  public.limite_requisitavel(uuid, uuid, numeric), public.dev_devolver(uuid, numeric, text, text),
  public.dev_desfazer(uuid, text) from public, anon;
grant execute on function public.devolvido_demanda(uuid), public.devolvido_proprio(uuid, smallint),
  public.devolvido_subarvore(uuid, smallint), public.raiz_unidade(uuid), public.devolvivel_demanda(uuid),
  public.limite_requisitavel(uuid, uuid, numeric), public.dev_devolver(uuid, numeric, text, text),
  public.dev_desfazer(uuid, text) to authenticated, service_role;
grant execute on function public.devolvido_subarvore(uuid, smallint) to anon;

-- Visões: v_saldos ganha "devolvido" (da subárvore); v_demandas_saldo passa a
-- descontar a devolução do saldo a requisitar e ganha "devolvido" e "devolvivel".
do $$
declare v_def text; v_cols text;
begin
  v_def := pg_get_viewdef('public.v_saldos'::regclass, true);
  if position('devolvido_subarvore' in v_def) = 0 then
    v_def := regexp_replace(v_def, ';\s*$', '');
    execute format('create or replace view public.v_saldos as select x.*, public.devolvido_subarvore(x.id_unidade, x.exercicio) as devolvido from (%s) x', v_def);
  end if;

  v_def := pg_get_viewdef('public.v_demandas_saldo'::regclass, true);
  if position('devolvido_demanda' in v_def) = 0 then
    v_def := regexp_replace(v_def, ';\s*$', '');
    select string_agg(case when attname = 'saldo'
                           then 'x.saldo - greatest(public.devolvido_demanda(x.id_demanda) - x.residuo, 0) as saldo'
                           else 'x.' || quote_ident(attname) end, ', ' order by attnum)
      into v_cols from pg_attribute where attrelid = 'public.v_demandas_saldo'::regclass and attnum > 0 and not attisdropped;
    execute format('create or replace view public.v_demandas_saldo with (security_invoker = on) as select %s, '
                || 'public.devolvido_demanda(x.id_demanda) as devolvido, public.devolvivel_demanda(x.id_demanda) as devolvivel from (%s) x',
                   v_cols, v_def);
  end if;
end $$;

select 'acao orcamentaria e devolucao de saldo aplicadas' as resultado;

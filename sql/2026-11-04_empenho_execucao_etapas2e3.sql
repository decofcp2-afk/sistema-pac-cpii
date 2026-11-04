-- Solicitação de empenho, Seção de Orçamento, empenhos N:N, liquidação e
-- pagamento, prazos para requisitar — etapas 2 e 3 — 04/11/2026
--
-- Decisões do gestor (proposta de 04/11/2026, seção 11):
--  3. uma solicitação de empenho por instrumento (bolsas, editais, diárias e
--     outros: uma por forma, montada pela própria unidade requerente);
--  5. o resíduo só é sinalizado;
--  8. a ação de governo é digitada pela Seção de Orçamento;
-- 10. os dados e as tabelas do monitoramento antigo (reserva de empenho e
--     pedido de execução) deixam de existir.
--
-- PASSO 1 (rodar sozinho, antes do resto):
--   alter type public.papel_usuario add value if not exists 'orcamento';

-- ═══ 0. Trava: só remove o modelo antigo se ele estiver vazio ═════════════════
do $$
declare n bigint;
begin
  select (select count(*) from public.empenhos) + (select count(*) from public.execucoes)
       + (select count(*) from public.empenho_demandas) + (select count(*) from public.marcos_calendario)
       + (select count(*) from public.marcos_demanda) + (select count(*) from public.cobrancas)
       + (select count(*) from public.execucao_demandas)
    into n;
  if n > 0 then
    raise exception 'Ha % registros no monitoramento antigo. Confira antes de remover o modelo antigo.', n;
  end if;
exception when undefined_table then null;
end $$;

drop view if exists public.v_execucao_demandas;
drop view if exists public.v_empenhos_saldo;
drop table if exists public.execucoes cascade;
drop table if exists public.empenho_demandas cascade;
drop table if exists public.execucao_demandas cascade;
drop table if exists public.empenho_movimentos cascade;
drop table if exists public.empenhos cascade;
drop table if exists public.marcos_demanda cascade;
drop table if exists public.marcos_calendario cascade;
drop table if exists public.cobrancas cascade;
drop function if exists public.validar_vinculo_empenho() cascade;
drop function if exists public.validar_execucao() cascade;
drop function if exists public.validar_valor_empenho() cascade;
drop function if exists public.validar_execucao_demanda() cascade;
drop function if exists public.empenho_visivel(uuid) cascade;
drop function if exists public.gestora_do_empenho(uuid) cascade;
drop function if exists public.demanda_do_vinculo(uuid) cascade;
drop function if exists public.valor_atual_empenho(uuid) cascade;

-- ═══ 1. Permissões de apoio ═══════════════════════════════════════════════════
create or replace function public.sou_orcamento() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.sou_admin_global() or public.meu_papel()::text = 'orcamento'
$$;
-- Quem lança liquidações e pagamentos: Monitoramento (no seu escopo) e administrador.
create or replace function public.pode_liquidar(p_unidade uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.pode_monitorar(p_unidade)
$$;
grant execute on function public.sou_orcamento(), public.pode_liquidar(uuid) to authenticated;

-- A Seção de Orçamento passa a enxergar as requisições (para registrar empenhos).
create or replace function public.requisicao_visivel(p_unidade uuid, p_gestora uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.pode_ver_unidade(p_unidade) or public.pode_gerir_pedidos(p_gestora)
      or public.meu_papel()::text in ('licitacoes','orcamento')
$$;

-- ═══ 2. Solicitação de empenho ════════════════════════════════════════════════
create table if not exists public.contador_solicitacoes (
  exercicio smallint primary key,
  ultimo    integer not null default 0
);

create table if not exists public.solicitacoes_empenho (
  id_solicitacao     uuid primary key default gen_random_uuid(),
  codigo             text unique not null,
  exercicio          smallint not null,
  id_instrumento     uuid references public.instrumentos(id_instrumento),
  forma              text not null check (forma in ('contrato','ata','bolsas_editais','diarias','outros')),
  id_unidade_gestora uuid not null references public.unidades(id_unidade),
  situacao           text not null default 'elaboracao'
                     check (situacao in ('elaboracao','enviada','devolvida','cancelada')),
  motivo             text,
  observacao         text,
  criado_por         uuid references public.perfis(id_usuario) on delete set null,
  data_criacao       timestamptz not null default now(),
  enviado_por        uuid references public.perfis(id_usuario) on delete set null,
  data_envio         timestamptz,
  data_situacao      timestamptz not null default now(),
  check (situacao <> 'devolvida' or length(trim(coalesce(motivo, ''))) >= 5)
);

alter table public.requisicoes add column if not exists id_solicitacao uuid
  references public.solicitacoes_empenho(id_solicitacao);
create index if not exists requisicoes_solicitacao_idx on public.requisicoes (id_solicitacao);

create table if not exists public.solicitacao_historico (
  id_evento      bigserial primary key,
  id_solicitacao uuid not null references public.solicitacoes_empenho(id_solicitacao) on delete cascade,
  acao           text not null,
  situacao       text not null,
  motivo         text,
  id_usuario     uuid references public.perfis(id_usuario) on delete set null,
  data_hora      timestamptz not null default now()
);

-- ═══ 3. Empenhos (Seção de Orçamento) ═════════════════════════════════════════
create table if not exists public.empenhos (
  id_empenho       uuid primary key default gen_random_uuid(),
  numero           text not null check (length(trim(numero)) > 0),
  exercicio        smallint not null check (exercicio between 2020 and 2100),
  data_emissao     date not null,
  origem           text check (origem in ('loa','emenda','suplementar','especial','extraordinario','descentralizacao','outra')),
  fonte_codigo     char(4) references public.fontes_recurso(codigo),
  acao_governo     text,
  natureza_despesa text,
  valor_empenhado  numeric(14,2) not null check (valor_empenhado > 0),
  id_instrumento   uuid references public.instrumentos(id_instrumento),
  favorecido_cnpj  text,
  favorecido_nome  text,
  observacao       text,
  criado_por       uuid references public.perfis(id_usuario) on delete set null,
  data_criacao     timestamptz not null default now()
);
create unique index if not exists empenhos_numero_key on public.empenhos (exercicio, upper(trim(numero)));

create table if not exists public.empenho_movimentos (
  id_movimento uuid primary key default gen_random_uuid(),
  id_empenho   uuid not null references public.empenhos(id_empenho) on delete cascade,
  tipo         text not null check (tipo in ('reforco','anulacao')),
  valor        numeric(14,2) not null check (valor > 0),
  data         date not null,
  documento    text,
  observacao   text,
  criado_por   uuid references public.perfis(id_usuario) on delete set null,
  data_criacao timestamptz not null default now()
);

-- O que cada empenho cobre: requisição × valor (N:N entre empenhos e solicitações).
create table if not exists public.empenho_cobertura (
  id_cobertura  uuid primary key default gen_random_uuid(),
  id_empenho    uuid not null references public.empenhos(id_empenho) on delete cascade,
  id_requisicao uuid not null references public.requisicoes(id_requisicao),
  valor         numeric(14,2) not null check (valor > 0),
  criado_por    uuid references public.perfis(id_usuario) on delete set null,
  data_criacao  timestamptz not null default now(),
  unique (id_empenho, id_requisicao)
);
create index if not exists cobertura_requisicao_idx on public.empenho_cobertura (id_requisicao);

-- ═══ 4. Liquidações e pagamentos (Monitoramento) ══════════════════════════════
create table if not exists public.liquidacoes (
  id_liquidacao uuid primary key default gen_random_uuid(),
  exercicio     smallint not null,
  data          date not null,
  documento     text not null check (length(trim(documento)) > 0),
  valor         numeric(14,2) not null check (valor > 0),
  observacao    text,
  criado_por    uuid references public.perfis(id_usuario) on delete set null,
  data_criacao  timestamptz not null default now()
);

create table if not exists public.liquidacao_itens (
  id_item       uuid primary key default gen_random_uuid(),
  id_liquidacao uuid not null references public.liquidacoes(id_liquidacao) on delete cascade,
  id_requisicao uuid not null references public.requisicoes(id_requisicao),
  valor         numeric(14,2) not null check (valor > 0),
  unique (id_liquidacao, id_requisicao)
);
create index if not exists liq_itens_requisicao_idx on public.liquidacao_itens (id_requisicao);

create table if not exists public.pagamentos (
  id_pagamento   uuid primary key default gen_random_uuid(),
  id_liquidacao  uuid not null references public.liquidacoes(id_liquidacao) on delete cascade,
  data           date not null,
  valor          numeric(14,2) not null check (valor > 0),
  ordem_bancaria text,
  observacao     text,
  criado_por     uuid references public.perfis(id_usuario) on delete set null,
  data_criacao   timestamptz not null default now()
);

-- ═══ 5. Prazos para requisitar, cobranças e encerramento ══════════════════════
create table if not exists public.prazos_requisicao (
  id_prazo          uuid primary key default gen_random_uuid(),
  exercicio         smallint not null,
  id_unidade_escopo uuid references public.unidades(id_unidade),        -- nulo = toda a instituição
  id_categoria      integer references public.categorias_despesa(id_categoria), -- nulo = todas
  data_limite       date not null,
  descricao         text,
  criado_por        uuid references public.perfis(id_usuario) on delete set null,
  data_criacao      timestamptz not null default now()
);
create unique index if not exists prazos_requisicao_key on public.prazos_requisicao
  (exercicio, coalesce(id_unidade_escopo, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(id_categoria, 0));

create table if not exists public.prazos_demanda (
  id_demanda  uuid primary key references public.demandas(id_demanda) on delete cascade,
  data_limite date not null,
  motivo      text,
  criado_por  uuid references public.perfis(id_usuario) on delete set null,
  data_criacao timestamptz not null default now()
);

create table if not exists public.cobrancas (
  id_cobranca   uuid primary key default gen_random_uuid(),
  id_demanda    uuid not null references public.demandas(id_demanda) on delete cascade,
  data_cobranca timestamptz not null default now(),
  canal         text not null default 'sei' check (canal in ('email','telefone','sei','presencial','outro')),
  registro      text not null check (length(trim(registro)) >= 5),
  resposta      text,
  data_resposta date,
  criado_por    uuid references public.perfis(id_usuario) on delete set null
);

-- Demanda com saldo que não será requisitada (sai das pendências; o saldo vai ao quadro de resíduos).
create table if not exists public.encerramentos_demanda (
  id_demanda  uuid primary key references public.demandas(id_demanda) on delete cascade,
  motivo      text not null check (length(trim(motivo)) >= 5),
  data        date not null default current_date,
  criado_por  uuid references public.perfis(id_usuario) on delete set null
);

-- ═══ 6. Somas (definer: usadas nas visões e nas regras) ═══════════════════════
create or replace function public.valor_atual_empenho(p_empenho uuid) returns numeric
language sql stable security definer set search_path to 'public' as $$
  select e.valor_empenhado
       + coalesce((select sum(case when m.tipo = 'reforco' then m.valor else -m.valor end)
                   from public.empenho_movimentos m where m.id_empenho = e.id_empenho), 0)
  from public.empenhos e where e.id_empenho = p_empenho
$$;
create or replace function public.empenhado_requisicao(p_req uuid) returns numeric
language sql stable security definer set search_path to 'public' as $$
  select coalesce(sum(valor), 0) from public.empenho_cobertura where id_requisicao = p_req
$$;
create or replace function public.liquidado_requisicao(p_req uuid) returns numeric
language sql stable security definer set search_path to 'public' as $$
  select coalesce(sum(valor), 0) from public.liquidacao_itens where id_requisicao = p_req
$$;
-- Pago: cada liquidação reparte o que foi pago entre as requisições, na proporção do valor liquidado.
create or replace function public.pago_requisicao(p_req uuid) returns numeric
language sql stable security definer set search_path to 'public' as $$
  select coalesce(round(sum(i.valor * least(1, coalesce(p.pago, 0) / l.valor)), 2), 0)
    from public.liquidacao_itens i
    join public.liquidacoes l on l.id_liquidacao = i.id_liquidacao
    left join lateral (select sum(valor) as pago from public.pagamentos where id_liquidacao = l.id_liquidacao) p on true
   where i.id_requisicao = p_req
$$;
grant execute on function public.valor_atual_empenho(uuid), public.empenhado_requisicao(uuid),
  public.liquidado_requisicao(uuid), public.pago_requisicao(uuid) to authenticated;

-- ═══ 7. Regras ════════════════════════════════════════════════════════════════
-- Situação da requisição segue o que foi empenhado, liquidado e pago.
create or replace function public.atualizar_execucao_requisicao(p_req uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
declare r public.requisicoes; v_emp numeric; v_liq numeric; v_pago numeric; v_nova text;
begin
  select * into r from public.requisicoes where id_requisicao = p_req;
  if r.id_requisicao is null or r.situacao not in ('em_solicitacao','empenhada','liquidada','paga') then return; end if;
  v_emp := public.empenhado_requisicao(p_req);
  v_liq := public.liquidado_requisicao(p_req);
  v_pago := public.pago_requisicao(p_req);
  v_nova := case when v_emp >= r.valor_real - 0.005 then
                   case when v_liq >= r.valor_real - 0.005 then
                          case when v_pago >= r.valor_real - 0.005 then 'paga' else 'liquidada' end
                        else 'empenhada' end
                 else 'em_solicitacao' end;
  if v_nova <> r.situacao then
    update public.requisicoes set situacao = v_nova where id_requisicao = p_req;
    insert into public.requisicao_historico (id_requisicao, acao, situacao, valor, valor_real, id_usuario)
      values (p_req, 'execucao', v_nova, r.valor, r.valor_real, auth.uid());
  end if;
end $$;

-- Requisição: empenhado ≤ valor real; liquidado ≤ empenhado.
create or replace function public.checar_requisicao_execucao(p_req uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
declare r public.requisicoes; v_emp numeric; v_liq numeric;
begin
  select * into r from public.requisicoes where id_requisicao = p_req;
  if r.id_requisicao is null then return; end if;
  v_emp := public.empenhado_requisicao(p_req);
  v_liq := public.liquidado_requisicao(p_req);
  if v_emp > coalesce(r.valor_real, 0) + 0.005 then
    raise exception 'O empenhado na requisicao % (R$ %) passaria do valor real dela (R$ %).',
      r.codigo, public.fmt_brl(v_emp), public.fmt_brl(coalesce(r.valor_real, 0));
  end if;
  if v_liq > v_emp + 0.005 then
    raise exception 'O liquidado na requisicao % (R$ %) passaria do que foi empenhado para ela (R$ %).',
      r.codigo, public.fmt_brl(v_liq), public.fmt_brl(v_emp);
  end if;
  perform public.atualizar_execucao_requisicao(p_req);
end $$;

-- Empenho: o que ele cobre ≤ valor atual (empenhado + reforços − anulações).
create or replace function public.checar_empenho(p_emp uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_atual numeric; v_cob numeric; v_num text;
begin
  select numero into v_num from public.empenhos where id_empenho = p_emp;
  if v_num is null then return; end if;
  v_atual := public.valor_atual_empenho(p_emp);
  select coalesce(sum(valor), 0) into v_cob from public.empenho_cobertura where id_empenho = p_emp;
  if v_atual <= 0 then raise exception 'O empenho % ficaria com valor zero ou negativo.', v_num; end if;
  if v_cob > v_atual + 0.005 then
    raise exception 'O empenho % (R$ %) cobriria R$ % em requisicoes.', v_num, public.fmt_brl(v_atual), public.fmt_brl(v_cob);
  end if;
end $$;

-- Liquidação: itens ≤ valor; pagamentos ≤ valor.
create or replace function public.checar_liquidacao(p_liq uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
declare l public.liquidacoes; v_itens numeric; v_pago numeric;
begin
  select * into l from public.liquidacoes where id_liquidacao = p_liq;
  if l.id_liquidacao is null then return; end if;
  select coalesce(sum(valor), 0) into v_itens from public.liquidacao_itens where id_liquidacao = p_liq;
  select coalesce(sum(valor), 0) into v_pago from public.pagamentos where id_liquidacao = p_liq;
  if v_itens > l.valor + 0.005 then
    raise exception 'As requisicoes somam R$ %, acima do valor da liquidacao % (R$ %).',
      public.fmt_brl(v_itens), l.documento, public.fmt_brl(l.valor);
  end if;
  if v_pago > l.valor + 0.005 then
    raise exception 'O pago (R$ %) passaria do valor liquidado em % (R$ %).',
      public.fmt_brl(v_pago), l.documento, public.fmt_brl(l.valor);
  end if;
end $$;

-- Gatilhos de checagem (adiados para o fim da transação: as operações gravam
-- cabeçalho e itens juntos).
create or replace function public.trg_cobertura_checar() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if tg_op in ('UPDATE','DELETE') then
    perform public.checar_empenho(old.id_empenho);
    perform public.checar_requisicao_execucao(old.id_requisicao);
  end if;
  if tg_op in ('INSERT','UPDATE') then
    perform public.checar_empenho(new.id_empenho);
    perform public.checar_requisicao_execucao(new.id_requisicao);
  end if;
  return null;
end $$;
drop trigger if exists trg_cobertura_checar on public.empenho_cobertura;
create constraint trigger trg_cobertura_checar after insert or update or delete on public.empenho_cobertura
  deferrable initially deferred for each row execute function public.trg_cobertura_checar();

-- Só se empenha requisição de solicitação enviada ao Orçamento.
create or replace function public.trg_cobertura_validar() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_sit text; v_cod text;
begin
  if tg_op = 'INSERT' and exists (select 1 from public.empenho_cobertura x where x.id_empenho = new.id_empenho
                                    and x.id_requisicao = new.id_requisicao and x.valor >= new.valor) then
    return new;   -- upsert que não aumenta o que já estava coberto
  end if;
  if tg_op = 'INSERT' or new.valor > old.valor then
    select s.situacao, r.codigo into v_sit, v_cod from public.requisicoes r
      left join public.solicitacoes_empenho s on s.id_solicitacao = r.id_solicitacao
     where r.id_requisicao = new.id_requisicao;
    if v_sit is distinct from 'enviada' then
      raise exception 'A requisicao % nao esta em solicitacao de empenho enviada ao Orcamento.', coalesce(v_cod, '');
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_cobertura_validar on public.empenho_cobertura;
create trigger trg_cobertura_validar before insert or update on public.empenho_cobertura
  for each row execute function public.trg_cobertura_validar();

create or replace function public.trg_empenho_checar() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.checar_empenho(coalesce(new.id_empenho, old.id_empenho));
  return null;
end $$;
drop trigger if exists trg_empenho_checar on public.empenhos;
create constraint trigger trg_empenho_checar after update on public.empenhos
  deferrable initially deferred for each row execute function public.trg_empenho_checar();
drop trigger if exists trg_movimento_checar on public.empenho_movimentos;
create constraint trigger trg_movimento_checar after insert or update or delete on public.empenho_movimentos
  deferrable initially deferred for each row execute function public.trg_empenho_checar();

create or replace function public.trg_liq_item_checar() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if tg_op in ('UPDATE','DELETE') then
    perform public.checar_liquidacao(old.id_liquidacao);
    perform public.checar_requisicao_execucao(old.id_requisicao);
  end if;
  if tg_op in ('INSERT','UPDATE') then
    perform public.checar_liquidacao(new.id_liquidacao);
    perform public.checar_requisicao_execucao(new.id_requisicao);
  end if;
  return null;
end $$;
drop trigger if exists trg_liq_item_checar on public.liquidacao_itens;
create constraint trigger trg_liq_item_checar after insert or update or delete on public.liquidacao_itens
  deferrable initially deferred for each row execute function public.trg_liq_item_checar();

-- Liquidação ou pagamento alterado: confere a liquidação e atualiza as requisições dela.
create or replace function public.trg_liq_checar() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_liq uuid := coalesce(new.id_liquidacao, old.id_liquidacao); r record;
begin
  perform public.checar_liquidacao(v_liq);
  for r in select id_requisicao from public.liquidacao_itens where id_liquidacao = v_liq loop
    perform public.atualizar_execucao_requisicao(r.id_requisicao);
  end loop;
  return null;
end $$;
drop trigger if exists trg_liq_checar on public.liquidacoes;
create constraint trigger trg_liq_checar after update on public.liquidacoes
  deferrable initially deferred for each row execute function public.trg_liq_checar();
drop trigger if exists trg_pag_checar on public.pagamentos;
create constraint trigger trg_pag_checar after insert or update or delete on public.pagamentos
  deferrable initially deferred for each row execute function public.trg_liq_checar();

-- ═══ 8. Operações: solicitação de empenho (seção gestora) ═════════════════════
create or replace function public.sol_gerar(p_requisicoes uuid[], p_observacao text) returns json
language plpgsql security definer set search_path to 'public' as $$
declare r record; v_first public.requisicoes; v_n integer; s public.solicitacoes_empenho; v_qtd integer := 0;
begin
  if p_requisicoes is null or array_length(p_requisicoes, 1) is null then
    raise exception 'Marque ao menos uma requisicao aprovada.';
  end if;
  for r in select * from public.requisicoes where id_requisicao = any(p_requisicoes) order by codigo for update loop
    v_qtd := v_qtd + 1;
    if r.situacao <> 'aprovada' or r.id_solicitacao is not null then
      raise exception 'A requisicao % nao esta aprovada aguardando solicitacao.', r.codigo;
    end if;
    if not public.pode_gerir_pedidos(r.id_unidade_gestora) then
      raise exception 'Somente a secao gestora pode solicitar o empenho da requisicao %.', r.codigo;
    end if;
    if v_qtd = 1 then
      v_first := r;
    elsif r.id_instrumento is distinct from v_first.id_instrumento
       or r.id_unidade_gestora <> v_first.id_unidade_gestora
       or r.exercicio <> v_first.exercicio
       or (r.id_instrumento is null and r.forma <> v_first.forma) then
      raise exception 'Uma solicitacao reune requisicoes de um unico instrumento (ou de uma unica forma de atendimento direto) e de um unico exercicio.';
    end if;
  end loop;
  if v_qtd <> array_length(p_requisicoes, 1) then raise exception 'Requisicao nao encontrada.'; end if;

  insert into public.contador_solicitacoes as c (exercicio, ultimo) values (v_first.exercicio, 1)
    on conflict (exercicio) do update set ultimo = c.ultimo + 1 returning ultimo into v_n;
  insert into public.solicitacoes_empenho (codigo, exercicio, id_instrumento, forma, id_unidade_gestora,
                                           observacao, criado_por)
  values ('SOL-' || v_first.exercicio || '-' || lpad(v_n::text, 4, '0'), v_first.exercicio, v_first.id_instrumento,
          case when v_first.forma in ('contrato','ata','bolsas_editais','diarias','outros') then v_first.forma else 'outros' end,
          v_first.id_unidade_gestora, nullif(trim(p_observacao), ''), auth.uid())
  returning * into s;
  insert into public.solicitacao_historico (id_solicitacao, acao, situacao, id_usuario)
    values (s.id_solicitacao, 'gerada', s.situacao, auth.uid());

  update public.requisicoes set situacao = 'em_solicitacao', id_solicitacao = s.id_solicitacao
   where id_requisicao = any(p_requisicoes);
  insert into public.requisicao_historico (id_requisicao, acao, situacao, motivo, id_usuario)
    select unnest(p_requisicoes), 'solicitacao', 'em_solicitacao', 'Solicitacao de empenho ' || s.codigo, auth.uid();
  return json_build_object('id_solicitacao', s.id_solicitacao, 'codigo', s.codigo);
end $$;

-- Gestor: enviar, cancelar ou retirar uma requisição. Orçamento: devolver.
create or replace function public.sol_acao(p_id uuid, p_acao text, p_motivo text, p_requisicao uuid default null) returns json
language plpgsql security definer set search_path to 'public' as $$
declare s public.solicitacoes_empenho; v_cob numeric; v_tot numeric; v_n integer;
begin
  select * into s from public.solicitacoes_empenho where id_solicitacao = p_id for update;
  if s.id_solicitacao is null then raise exception 'Solicitacao nao encontrada.'; end if;

  if p_acao = 'devolver' then
    if not public.sou_orcamento() then raise exception 'Somente a Secao de Orcamento pode devolver a solicitacao.'; end if;
    if s.situacao <> 'enviada' then raise exception 'So uma solicitacao enviada pode ser devolvida.'; end if;
    if length(trim(coalesce(p_motivo, ''))) < 5 then raise exception 'Informe o motivo da devolucao.'; end if;
    select coalesce(sum(public.empenhado_requisicao(id_requisicao)), 0), coalesce(sum(valor_real), 0)
      into v_cob, v_tot from public.requisicoes where id_solicitacao = p_id;
    if v_tot > 0 and v_cob >= v_tot - 0.005 then raise exception 'A solicitacao ja esta totalmente empenhada.'; end if;
    update public.solicitacoes_empenho set situacao = 'devolvida', motivo = trim(p_motivo), data_situacao = now()
     where id_solicitacao = p_id returning * into s;

  else
    if not public.pode_gerir_pedidos(s.id_unidade_gestora) then
      raise exception 'Somente a secao gestora pode alterar esta solicitacao.';
    end if;
    if p_acao = 'enviar' then
      if s.situacao not in ('elaboracao','devolvida') then raise exception 'Esta solicitacao ja foi enviada.'; end if;
      update public.solicitacoes_empenho set situacao = 'enviada', motivo = null, data_situacao = now(),
             data_envio = now(), enviado_por = auth.uid()
       where id_solicitacao = p_id returning * into s;
    elsif p_acao = 'cancelar' then
      if s.situacao = 'cancelada' then raise exception 'A solicitacao ja esta cancelada.'; end if;
      select coalesce(sum(public.empenhado_requisicao(id_requisicao)), 0) into v_cob
        from public.requisicoes where id_solicitacao = p_id;
      if v_cob > 0 then raise exception 'A solicitacao ja tem empenho registrado e nao pode ser cancelada.'; end if;
      insert into public.requisicao_historico (id_requisicao, acao, situacao, motivo, id_usuario)
        select id_requisicao, 'solicitacao_cancelada', 'aprovada', 'Solicitacao ' || s.codigo || ' cancelada', auth.uid()
          from public.requisicoes where id_solicitacao = p_id;
      update public.requisicoes set situacao = 'aprovada', id_solicitacao = null where id_solicitacao = p_id;
      update public.solicitacoes_empenho set situacao = 'cancelada', motivo = nullif(trim(p_motivo), ''), data_situacao = now()
       where id_solicitacao = p_id returning * into s;
    elsif p_acao = 'retirar' then
      if s.situacao not in ('elaboracao','devolvida') then
        raise exception 'So se retira requisicao de solicitacao em elaboracao ou devolvida.';
      end if;
      if not exists (select 1 from public.requisicoes where id_requisicao = p_requisicao and id_solicitacao = p_id) then
        raise exception 'A requisicao nao pertence a esta solicitacao.';
      end if;
      if public.empenhado_requisicao(p_requisicao) > 0 then
        raise exception 'A requisicao ja tem empenho registrado.';
      end if;
      update public.requisicoes set situacao = 'aprovada', id_solicitacao = null where id_requisicao = p_requisicao;
      insert into public.requisicao_historico (id_requisicao, acao, situacao, motivo, id_usuario)
        values (p_requisicao, 'retirada_da_solicitacao', 'aprovada', 'Retirada da solicitacao ' || s.codigo, auth.uid());
      select count(*) into v_n from public.requisicoes where id_solicitacao = p_id;
      if v_n = 0 then
        update public.solicitacoes_empenho set situacao = 'cancelada', motivo = 'Sem requisicoes', data_situacao = now()
         where id_solicitacao = p_id returning * into s;
      end if;
    else
      raise exception 'Acao invalida.';
    end if;
  end if;
  insert into public.solicitacao_historico (id_solicitacao, acao, situacao, motivo, id_usuario)
    values (p_id, p_acao, s.situacao, coalesce(s.motivo, nullif(trim(p_motivo), '')), auth.uid());
  return json_build_object('id_solicitacao', s.id_solicitacao, 'situacao', s.situacao);
end $$;

-- ═══ 9. Operações: empenhos (Seção de Orçamento) ══════════════════════════════
-- p_dados: {numero, data_emissao, origem, fonte_codigo, acao_governo, natureza_despesa,
--           valor_empenhado, id_instrumento, favorecido_cnpj, favorecido_nome, observacao}
-- p_cobertura: [{id_requisicao, valor}] — substitui o que o empenho cobre.
create or replace function public.emp_salvar(p_id uuid, p_dados json, p_cobertura json) returns json
language plpgsql security definer set search_path to 'public' as $$
declare e public.empenhos; v_num text; v_data date; v_valor numeric; i record; v_ids uuid[] := '{}';
begin
  if not public.sou_orcamento() then raise exception 'Somente a Secao de Orcamento registra empenhos.'; end if;
  v_num := upper(trim(coalesce(p_dados->>'numero', '')));
  v_data := nullif(p_dados->>'data_emissao', '')::date;
  v_valor := nullif(p_dados->>'valor_empenhado', '')::numeric;
  if v_num = '' then raise exception 'Informe o numero do empenho.'; end if;
  if v_data is null then raise exception 'Informe a data de emissao.'; end if;
  if v_valor is null or v_valor <= 0 then raise exception 'Informe o valor empenhado.'; end if;

  if p_id is null then
    insert into public.empenhos (numero, exercicio, data_emissao, origem, fonte_codigo, acao_governo, natureza_despesa,
                                 valor_empenhado, id_instrumento, favorecido_cnpj, favorecido_nome, observacao, criado_por)
    values (v_num, extract(year from v_data)::smallint, v_data, nullif(p_dados->>'origem', ''),
            nullif(p_dados->>'fonte_codigo', ''), nullif(trim(p_dados->>'acao_governo'), ''),
            nullif(trim(p_dados->>'natureza_despesa'), ''), v_valor, nullif(p_dados->>'id_instrumento', '')::uuid,
            nullif(trim(p_dados->>'favorecido_cnpj'), ''), nullif(trim(p_dados->>'favorecido_nome'), ''),
            nullif(trim(p_dados->>'observacao'), ''), auth.uid())
    returning * into e;
  else
    update public.empenhos set numero = v_num, exercicio = extract(year from v_data)::smallint, data_emissao = v_data,
           origem = nullif(p_dados->>'origem', ''), fonte_codigo = nullif(p_dados->>'fonte_codigo', ''),
           acao_governo = nullif(trim(p_dados->>'acao_governo'), ''),
           natureza_despesa = nullif(trim(p_dados->>'natureza_despesa'), ''), valor_empenhado = v_valor,
           id_instrumento = nullif(p_dados->>'id_instrumento', '')::uuid,
           favorecido_cnpj = nullif(trim(p_dados->>'favorecido_cnpj'), ''),
           favorecido_nome = nullif(trim(p_dados->>'favorecido_nome'), ''),
           observacao = nullif(trim(p_dados->>'observacao'), '')
     where id_empenho = p_id returning * into e;
    if e.id_empenho is null then raise exception 'Empenho nao encontrado.'; end if;
  end if;

  if p_cobertura is not null then
    for i in select (x->>'id_requisicao')::uuid as id_requisicao, round((x->>'valor')::numeric, 2) as valor
               from json_array_elements(p_cobertura) x loop
      if i.valor is null or i.valor <= 0 then continue; end if;
      v_ids := v_ids || i.id_requisicao;
      insert into public.empenho_cobertura (id_empenho, id_requisicao, valor, criado_por)
      values (e.id_empenho, i.id_requisicao, i.valor, auth.uid())
      on conflict (id_empenho, id_requisicao) do update set valor = excluded.valor
        where public.empenho_cobertura.valor is distinct from excluded.valor;
    end loop;
    delete from public.empenho_cobertura where id_empenho = e.id_empenho and not (id_requisicao = any(v_ids));
  end if;
  return json_build_object('id_empenho', e.id_empenho, 'numero', e.numero);
exception when unique_violation then
  raise exception 'Ja existe o empenho % neste exercicio.', v_num;
end $$;

create or replace function public.emp_excluir(p_id uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.sou_orcamento() then raise exception 'Somente a Secao de Orcamento exclui empenhos.'; end if;
  delete from public.empenhos where id_empenho = p_id;   -- a cobertura sai junto; as regras conferem as liquidações
end $$;

create or replace function public.emp_movimento(p_empenho uuid, p_tipo text, p_valor numeric, p_data date,
                                                p_documento text, p_observacao text) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.sou_orcamento() then raise exception 'Somente a Secao de Orcamento lanca reforcos e anulacoes.'; end if;
  insert into public.empenho_movimentos (id_empenho, tipo, valor, data, documento, observacao, criado_por)
  values (p_empenho, p_tipo, p_valor, p_data, nullif(trim(p_documento), ''), nullif(trim(p_observacao), ''), auth.uid());
end $$;

create or replace function public.emp_excluir_movimento(p_id uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.sou_orcamento() then raise exception 'Somente a Secao de Orcamento exclui reforcos e anulacoes.'; end if;
  delete from public.empenho_movimentos where id_movimento = p_id;
end $$;

-- ═══ 10. Operações: liquidações e pagamentos (Monitoramento) ══════════════════
-- p_itens: [{id_requisicao, valor}] — substitui as requisições que a liquidação cobre.
create or replace function public.liq_salvar(p_id uuid, p_data date, p_documento text, p_valor numeric,
                                             p_observacao text, p_itens json) returns json
language plpgsql security definer set search_path to 'public' as $$
declare l public.liquidacoes; i record; v_ids uuid[] := '{}'; v_unid uuid; v_cod text;
begin
  if public.meu_papel()::text <> 'monitoramento' and not public.sou_admin_global() then
    raise exception 'Somente o Monitoramento lanca liquidacoes.';
  end if;
  if p_data is null then raise exception 'Informe a data da liquidacao.'; end if;
  if length(trim(coalesce(p_documento, ''))) = 0 then raise exception 'Informe a nota fiscal ou o documento.'; end if;
  if p_valor is null or p_valor <= 0 then raise exception 'Informe o valor liquidado.'; end if;
  if p_itens is null or json_array_length(p_itens) = 0 then raise exception 'Marque ao menos uma requisicao.'; end if;

  if p_id is not null then
    for i in select r.id_unidade, r.codigo from public.liquidacao_itens li
               join public.requisicoes r on r.id_requisicao = li.id_requisicao where li.id_liquidacao = p_id loop
      if not public.pode_liquidar(i.id_unidade) then raise exception 'A requisicao % esta fora do seu escopo.', i.codigo; end if;
    end loop;
    update public.liquidacoes set data = p_data, exercicio = extract(year from p_data)::smallint,
           documento = trim(p_documento), valor = round(p_valor, 2), observacao = nullif(trim(p_observacao), '')
     where id_liquidacao = p_id returning * into l;
    if l.id_liquidacao is null then raise exception 'Liquidacao nao encontrada.'; end if;
  else
    insert into public.liquidacoes (exercicio, data, documento, valor, observacao, criado_por)
    values (extract(year from p_data)::smallint, p_data, trim(p_documento), round(p_valor, 2),
            nullif(trim(p_observacao), ''), auth.uid())
    returning * into l;
  end if;

  for i in select (x->>'id_requisicao')::uuid as id_requisicao, round((x->>'valor')::numeric, 2) as valor
             from json_array_elements(p_itens) x loop
    if i.valor is null or i.valor <= 0 then continue; end if;
    select id_unidade, codigo into v_unid, v_cod from public.requisicoes where id_requisicao = i.id_requisicao;
    if v_unid is null then raise exception 'Requisicao nao encontrada.'; end if;
    if not public.pode_liquidar(v_unid) then raise exception 'A requisicao % esta fora do seu escopo.', v_cod; end if;
    v_ids := v_ids || i.id_requisicao;
    insert into public.liquidacao_itens (id_liquidacao, id_requisicao, valor)
    values (l.id_liquidacao, i.id_requisicao, i.valor)
    on conflict (id_liquidacao, id_requisicao) do update set valor = excluded.valor
      where public.liquidacao_itens.valor is distinct from excluded.valor;
  end loop;
  if array_length(v_ids, 1) is null then raise exception 'Marque ao menos uma requisicao.'; end if;
  delete from public.liquidacao_itens where id_liquidacao = l.id_liquidacao and not (id_requisicao = any(v_ids));
  return json_build_object('id_liquidacao', l.id_liquidacao);
end $$;

create or replace function public.liq_excluir(p_id uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
declare i record;
begin
  if public.meu_papel()::text <> 'monitoramento' and not public.sou_admin_global() then
    raise exception 'Somente o Monitoramento exclui liquidacoes.';
  end if;
  if exists (select 1 from public.pagamentos where id_liquidacao = p_id) then
    raise exception 'Exclua os pagamentos desta liquidacao antes.';
  end if;
  for i in select r.id_unidade, r.codigo from public.liquidacao_itens li
             join public.requisicoes r on r.id_requisicao = li.id_requisicao where li.id_liquidacao = p_id loop
    if not public.pode_liquidar(i.id_unidade) then raise exception 'A requisicao % esta fora do seu escopo.', i.codigo; end if;
  end loop;
  delete from public.liquidacao_itens where id_liquidacao = p_id;
  delete from public.liquidacoes where id_liquidacao = p_id;
end $$;

create or replace function public.pag_salvar(p_id uuid, p_liquidacao uuid, p_data date, p_valor numeric,
                                             p_ordem_bancaria text, p_observacao text) returns void
language plpgsql security definer set search_path to 'public' as $$
declare i record;
begin
  if public.meu_papel()::text <> 'monitoramento' and not public.sou_admin_global() then
    raise exception 'Somente o Monitoramento lanca pagamentos.';
  end if;
  if p_data is null or p_valor is null or p_valor <= 0 then raise exception 'Informe data e valor do pagamento.'; end if;
  for i in select r.id_unidade, r.codigo from public.liquidacao_itens li
             join public.requisicoes r on r.id_requisicao = li.id_requisicao where li.id_liquidacao = p_liquidacao loop
    if not public.pode_liquidar(i.id_unidade) then raise exception 'A requisicao % esta fora do seu escopo.', i.codigo; end if;
  end loop;
  if p_id is null then
    insert into public.pagamentos (id_liquidacao, data, valor, ordem_bancaria, observacao, criado_por)
    values (p_liquidacao, p_data, round(p_valor, 2), nullif(trim(p_ordem_bancaria), ''), nullif(trim(p_observacao), ''), auth.uid());
  else
    update public.pagamentos set data = p_data, valor = round(p_valor, 2),
           ordem_bancaria = nullif(trim(p_ordem_bancaria), ''), observacao = nullif(trim(p_observacao), '')
     where id_pagamento = p_id and id_liquidacao = p_liquidacao;
  end if;
end $$;

create or replace function public.pag_excluir(p_id uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_liq uuid; i record;
begin
  if public.meu_papel()::text <> 'monitoramento' and not public.sou_admin_global() then
    raise exception 'Somente o Monitoramento exclui pagamentos.';
  end if;
  select id_liquidacao into v_liq from public.pagamentos where id_pagamento = p_id;
  for i in select r.id_unidade, r.codigo from public.liquidacao_itens li
             join public.requisicoes r on r.id_requisicao = li.id_requisicao where li.id_liquidacao = v_liq loop
    if not public.pode_liquidar(i.id_unidade) then raise exception 'A requisicao % esta fora do seu escopo.', i.codigo; end if;
  end loop;
  delete from public.pagamentos where id_pagamento = p_id;
end $$;

grant execute on function public.sol_gerar(uuid[], text), public.sol_acao(uuid, text, text, uuid),
  public.emp_salvar(uuid, json, json), public.emp_excluir(uuid),
  public.emp_movimento(uuid, text, numeric, date, text, text), public.emp_excluir_movimento(uuid),
  public.liq_salvar(uuid, date, text, numeric, text, json), public.liq_excluir(uuid),
  public.pag_salvar(uuid, uuid, date, numeric, text, text), public.pag_excluir(uuid) to authenticated;
revoke execute on function public.atualizar_execucao_requisicao(uuid), public.checar_requisicao_execucao(uuid),
  public.checar_empenho(uuid), public.checar_liquidacao(uuid) from public, anon, authenticated;

-- ═══ 11. Permissões (RLS) ═════════════════════════════════════════════════════
alter table public.contador_solicitacoes enable row level security;
alter table public.solicitacoes_empenho  enable row level security;
alter table public.solicitacao_historico enable row level security;
alter table public.empenhos              enable row level security;
alter table public.empenho_movimentos    enable row level security;
alter table public.empenho_cobertura     enable row level security;
alter table public.liquidacoes           enable row level security;
alter table public.liquidacao_itens      enable row level security;
alter table public.pagamentos            enable row level security;
alter table public.prazos_requisicao     enable row level security;
alter table public.prazos_demanda        enable row level security;
alter table public.cobrancas             enable row level security;
alter table public.encerramentos_demanda enable row level security;

grant select on public.solicitacoes_empenho, public.solicitacao_historico, public.empenhos, public.empenho_movimentos,
  public.empenho_cobertura, public.liquidacoes, public.liquidacao_itens, public.pagamentos to authenticated;
grant select, insert, update, delete on public.prazos_requisicao, public.prazos_demanda, public.cobrancas,
  public.encerramentos_demanda to authenticated;

create or replace function public.solicitacao_visivel(p_sol uuid, p_gestora uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.sou_orcamento() or public.pode_gerir_pedidos(p_gestora) or public.pode_ver_unidade(p_gestora)
      or exists (select 1 from public.requisicoes r where r.id_solicitacao = p_sol
                   and public.requisicao_visivel(r.id_unidade, r.id_unidade_gestora))
$$;
create or replace function public.empenho_visivel(p_emp uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.sou_orcamento() or public.meu_papel()::text = 'ord_despesas'
      or (public.meu_papel()::text = 'monitoramento' and public.pai_da_unidade(public.minha_unidade()) is null)
      or exists (select 1 from public.empenho_cobertura c join public.requisicoes r on r.id_requisicao = c.id_requisicao
                  where c.id_empenho = p_emp and public.requisicao_visivel(r.id_unidade, r.id_unidade_gestora))
$$;
create or replace function public.liquidacao_visivel(p_liq uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.sou_orcamento() or public.meu_papel()::text = 'ord_despesas'
      or exists (select 1 from public.liquidacao_itens i join public.requisicoes r on r.id_requisicao = i.id_requisicao
                  where i.id_liquidacao = p_liq and public.requisicao_visivel(r.id_unidade, r.id_unidade_gestora))
$$;
grant execute on function public.solicitacao_visivel(uuid, uuid), public.empenho_visivel(uuid),
  public.liquidacao_visivel(uuid) to authenticated;

drop policy if exists sol_select on public.solicitacoes_empenho;
create policy sol_select on public.solicitacoes_empenho for select to authenticated
  using (public.solicitacao_visivel(id_solicitacao, id_unidade_gestora));
drop policy if exists solh_select on public.solicitacao_historico;
create policy solh_select on public.solicitacao_historico for select to authenticated
  using (exists (select 1 from public.solicitacoes_empenho s where s.id_solicitacao = solicitacao_historico.id_solicitacao));
drop policy if exists emp_select on public.empenhos;
create policy emp_select on public.empenhos for select to authenticated using (public.empenho_visivel(id_empenho));
drop policy if exists mov_select on public.empenho_movimentos;
create policy mov_select on public.empenho_movimentos for select to authenticated using (public.empenho_visivel(id_empenho));
drop policy if exists cob_emp_select on public.empenho_cobertura;
create policy cob_emp_select on public.empenho_cobertura for select to authenticated
  using (public.sou_orcamento() or exists (select 1 from public.requisicoes r where r.id_requisicao = empenho_cobertura.id_requisicao));
drop policy if exists liq_select on public.liquidacoes;
create policy liq_select on public.liquidacoes for select to authenticated using (public.liquidacao_visivel(id_liquidacao));
drop policy if exists liqi_select on public.liquidacao_itens;
create policy liqi_select on public.liquidacao_itens for select to authenticated
  using (public.sou_orcamento() or exists (select 1 from public.requisicoes r where r.id_requisicao = liquidacao_itens.id_requisicao));
drop policy if exists pag_select on public.pagamentos;
create policy pag_select on public.pagamentos for select to authenticated using (public.liquidacao_visivel(id_liquidacao));

-- Prazos para requisitar: a Reitoria cria os da instituição e de qualquer unidade;
-- o Monitoramento de um campus, só os da sua estrutura.
drop policy if exists przr_select on public.prazos_requisicao;
create policy przr_select on public.prazos_requisicao for select to authenticated using (true);
drop policy if exists przr_write on public.prazos_requisicao;
create policy przr_write on public.prazos_requisicao for all to authenticated
  using (public.sou_admin_global()
         or (public.meu_papel()::text = 'monitoramento' and (
               (id_unidade_escopo is not null and id_unidade_escopo in (select public.escopo_unidades()))
            or (id_unidade_escopo is null and public.pai_da_unidade(public.minha_unidade()) is null))))
  with check (public.sou_admin_global()
         or (public.meu_papel()::text = 'monitoramento' and (
               (id_unidade_escopo is not null and id_unidade_escopo in (select public.escopo_unidades()))
            or (id_unidade_escopo is null and public.pai_da_unidade(public.minha_unidade()) is null))));

drop policy if exists przd_select on public.prazos_demanda;
create policy przd_select on public.prazos_demanda for select to authenticated
  using (public.pode_ver_unidade(public.unidade_da_demanda(id_demanda)));
drop policy if exists przd_write on public.prazos_demanda;
create policy przd_write on public.prazos_demanda for all to authenticated
  using (public.pode_monitorar(public.unidade_da_demanda(id_demanda)))
  with check (public.pode_monitorar(public.unidade_da_demanda(id_demanda)));

drop policy if exists cob_select on public.cobrancas;
create policy cob_select on public.cobrancas for select to authenticated
  using (public.pode_ver_unidade(public.unidade_da_demanda(id_demanda)));
drop policy if exists cob_write on public.cobrancas;
create policy cob_write on public.cobrancas for all to authenticated
  using (public.pode_monitorar(public.unidade_da_demanda(id_demanda)))
  with check (public.pode_monitorar(public.unidade_da_demanda(id_demanda)));

drop policy if exists enc_select on public.encerramentos_demanda;
create policy enc_select on public.encerramentos_demanda for select to authenticated
  using (public.pode_ver_unidade(public.unidade_da_demanda(id_demanda)));
drop policy if exists enc_write on public.encerramentos_demanda;
create policy enc_write on public.encerramentos_demanda for all to authenticated
  using (public.pode_monitorar(public.unidade_da_demanda(id_demanda)))
  with check (public.pode_monitorar(public.unidade_da_demanda(id_demanda)));

-- ═══ 12. Visões ═══════════════════════════════════════════════════════════════
-- Requisições com solicitação, empenhado, liquidado e pago (filtro de visibilidade aqui mesmo).
drop view if exists public.v_requisicoes;
create view public.v_requisicoes as
select r.*, d.codigo as codigo_demanda, d.descricao_objeto, d.unidade_medida,
       d.quantidade as quantidade_demanda, d.valor_estimado as valor_demanda,
       u.sigla as sigla_unidade, u.nome as nome_unidade,
       g.sigla as sigla_gestora,
       i.tipo as tipo_instrumento, i.numero as numero_instrumento, i.objeto as objeto_instrumento,
       i.fornecedor_nome,
       case when r.valor_real is not null and public.situacao_consome_instrumento(r.situacao)
            then r.valor - r.valor_real else 0 end as residuo,
       c.nome as categoria, c.natureza_despesa,
       s.codigo as codigo_solicitacao, s.situacao as situacao_solicitacao,
       public.empenhado_requisicao(r.id_requisicao) as empenhado,
       public.liquidado_requisicao(r.id_requisicao) as liquidado,
       public.pago_requisicao(r.id_requisicao) as pago,
       (current_date - r.data_situacao::date) as dias_situacao
from public.requisicoes r
join public.demandas d on d.id_demanda = r.id_demanda
join public.unidades u on u.id_unidade = r.id_unidade
join public.unidades g on g.id_unidade = r.id_unidade_gestora
left join public.instrumentos i on i.id_instrumento = r.id_instrumento
left join public.categorias_despesa c on c.id_categoria = d.id_categoria_fk
left join public.solicitacoes_empenho s on s.id_solicitacao = r.id_solicitacao
where public.requisicao_visivel(r.id_unidade, r.id_unidade_gestora);

-- Demandas homologadas: saldo a requisitar e a cadeia de valores.
drop view if exists public.v_demandas_saldo;
create view public.v_demandas_saldo with (security_invoker = on) as
select d.id_demanda, d.codigo, d.exercicio, d.descricao_objeto, d.justificativa, d.quantidade, d.unidade_medida,
       d.valor_estimado, d.id_unidade_fk, u.sigla as sigla_unidade, u.nome as nome_unidade,
       c.nome as categoria, c.natureza_despesa, d.id_categoria_fk, d.gut_pontuacao,
       coalesce(q.valor, 0) as requisitado, coalesce(q.quantidade, 0) as quantidade_requisitada,
       d.valor_estimado - coalesce(q.valor, 0) as saldo,
       case when d.quantidade is null then null else d.quantidade - coalesce(q.quantidade, 0) end as saldo_quantidade,
       coalesce(q.n, 0) as n_requisicoes, coalesce(q.residuo, 0) as residuo,
       coalesce(q.aprovado, 0) as aprovado, coalesce(q.empenhado, 0) as empenhado,
       coalesce(q.liquidado, 0) as liquidado, coalesce(q.pago, 0) as pago,
       q.primeira_requisicao, q.ultima_requisicao,
       (en.id_demanda is not null) as encerrada, en.motivo as motivo_encerramento, en.data as data_encerramento
from public.demandas d
join public.unidades u on u.id_unidade = d.id_unidade_fk
left join public.categorias_despesa c on c.id_categoria = d.id_categoria_fk
left join public.encerramentos_demanda en on en.id_demanda = d.id_demanda
left join lateral (select sum(r.valor) as valor, sum(r.quantidade) as quantidade, count(*) as n,
                          sum(case when r.valor_real is not null and public.situacao_consome_instrumento(r.situacao)
                                   then r.valor - r.valor_real else 0 end) as residuo,
                          sum(case when public.situacao_consome_instrumento(r.situacao) then r.valor_real else 0 end) as aprovado,
                          sum(public.empenhado_requisicao(r.id_requisicao)) as empenhado,
                          sum(public.liquidado_requisicao(r.id_requisicao)) as liquidado,
                          sum(public.pago_requisicao(r.id_requisicao)) as pago,
                          min(r.data_criacao) as primeira_requisicao, max(r.data_criacao) as ultima_requisicao
                     from public.requisicoes r where r.id_demanda = d.id_demanda and r.situacao <> 'cancelada') q on true
where d.status = 'homologada';

-- Solicitações com instrumento, totais e situação de exibição.
drop view if exists public.v_solicitacoes;
create view public.v_solicitacoes as
select s.*, g.sigla as sigla_gestora, g.nome as nome_gestora,
       i.tipo as tipo_instrumento, i.numero as numero_instrumento, i.objeto as objeto_instrumento,
       i.fornecedor_nome, i.fornecedor_cnpj, i.vigencia_inicio, i.vigencia_fim,
       i.processo_sei as processo_sei_instrumento, i.valor_limite,
       case when i.valor_limite is null then null else i.valor_limite - public.consumo_instrumento(i.id_instrumento) end as saldo_instrumento,
       coalesce(t.n, 0) as n_requisicoes, coalesce(t.previsto, 0) as total_previsto,
       coalesce(t.real, 0) as total_real, coalesce(t.empenhado, 0) as empenhado,
       coalesce(t.real, 0) - coalesce(t.empenhado, 0) as a_empenhar,
       case when s.situacao = 'enviada' and coalesce(t.real, 0) > 0 and coalesce(t.empenhado, 0) >= t.real - 0.005 then 'empenhada'
            when s.situacao = 'enviada' and coalesce(t.empenhado, 0) > 0 then 'empenhada_parcial'
            else s.situacao end as situacao_exibicao,
       pc.nome as nome_criador, pc.matricula_siape as siape_criador,
       pe.nome as nome_envio, pe.matricula_siape as siape_envio
from public.solicitacoes_empenho s
join public.unidades g on g.id_unidade = s.id_unidade_gestora
left join public.instrumentos i on i.id_instrumento = s.id_instrumento
left join public.perfis pc on pc.id_usuario = s.criado_por
left join public.perfis pe on pe.id_usuario = s.enviado_por
left join lateral (select count(*) as n, sum(r.valor) as previsto, sum(r.valor_real) as real,
                          sum(public.empenhado_requisicao(r.id_requisicao)) as empenhado
                     from public.requisicoes r where r.id_solicitacao = s.id_solicitacao) t on true
where public.solicitacao_visivel(s.id_solicitacao, s.id_unidade_gestora);

-- Empenhos com valor atual, o que cobrem e o que está sem vínculo.
drop view if exists public.v_empenhos;
create view public.v_empenhos as
select e.*, public.valor_atual_empenho(e.id_empenho) as valor_atual,
       coalesce(c.coberto, 0) as coberto,
       public.valor_atual_empenho(e.id_empenho) - coalesce(c.coberto, 0) as sem_vinculo,
       coalesce(c.n, 0) as n_requisicoes, c.solicitacoes,
       f.nome as fonte_nome, i.numero as numero_instrumento, i.tipo as tipo_instrumento
from public.empenhos e
left join public.fontes_recurso f on f.codigo = e.fonte_codigo
left join public.instrumentos i on i.id_instrumento = e.id_instrumento
left join lateral (select sum(x.valor) as coberto, count(*) as n,
                          string_agg(distinct s.codigo, ', ') as solicitacoes
                     from public.empenho_cobertura x
                     join public.requisicoes r on r.id_requisicao = x.id_requisicao
                     left join public.solicitacoes_empenho s on s.id_solicitacao = r.id_solicitacao
                    where x.id_empenho = e.id_empenho) c on true
where public.empenho_visivel(e.id_empenho);

-- Liquidações com o que cobrem e o que foi pago.
drop view if exists public.v_liquidacoes;
create view public.v_liquidacoes as
select l.*, coalesce(t.coberto, 0) as coberto, l.valor - coalesce(t.coberto, 0) as sem_vinculo,
       coalesce(t.n, 0) as n_requisicoes, t.requisicoes,
       coalesce(p.pago, 0) as pago, l.valor - coalesce(p.pago, 0) as a_pagar, p.ultimo_pagamento
from public.liquidacoes l
left join lateral (select sum(i.valor) as coberto, count(*) as n, string_agg(r.codigo, ', ' order by r.codigo) as requisicoes
                     from public.liquidacao_itens i join public.requisicoes r on r.id_requisicao = i.id_requisicao
                    where i.id_liquidacao = l.id_liquidacao) t on true
left join lateral (select sum(valor) as pago, max(data) as ultimo_pagamento
                     from public.pagamentos where id_liquidacao = l.id_liquidacao) p on true
where public.liquidacao_visivel(l.id_liquidacao);

grant select on public.v_requisicoes, public.v_demandas_saldo, public.v_solicitacoes, public.v_empenhos,
  public.v_liquidacoes to authenticated;

-- ═══ 13. Painel público (etapa 4): só valores e situações ═════════════════════
-- Sem número de empenho, fornecedor ou nota fiscal (decisão 9).
drop view if exists public.execucao_publica;
create view public.execucao_publica with (security_invoker = off) as
select r.id_requisicao, r.id_demanda, r.exercicio, r.codigo, r.situacao, r.id_unidade,
       r.valor as requisitado,
       case when r.situacao in ('aprovada','em_solicitacao','empenhada','liquidada','paga') then r.valor_real else 0 end as aprovado,
       coalesce(c.v, 0) as empenhado, coalesce(li.v, 0) as liquidado
from public.requisicoes r
join public.demandas d on d.id_demanda = r.id_demanda and d.status = 'homologada'
left join lateral (select sum(valor) as v from public.empenho_cobertura where id_requisicao = r.id_requisicao) c on true
left join lateral (select sum(valor) as v from public.liquidacao_itens where id_requisicao = r.id_requisicao) li on true
where r.situacao <> 'cancelada';
grant select on public.execucao_publica to anon, authenticated;

select 'etapas 2 e 3 criadas' as resultado;

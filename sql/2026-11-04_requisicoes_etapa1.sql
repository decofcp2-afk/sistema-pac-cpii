-- Requisições, instrumentos e gestão de pedidos — etapa 1 — 04/11/2026
-- Decisões do gestor (proposta de 04/11/2026, seção 11):
--  1. o valor da requisição (o que o requerente pede) abate o saldo da demanda;
--  2. o saldo da demanda também é controlado em quantidade;
--  3. uma solicitação de empenho por instrumento (etapa 2);
--  4. bolsas, editais, diárias e outros não têm instrumento: a própria unidade
--     requerente é a gestora e encaminha ao empenho;
--  5. o resíduo (requisitado − real) só é sinalizado;
--  6. sem visto da chefia: a requisição vai direto ao gestor;
--  7. requisitam chefe de seção e chefia (a chefia também pelas subordinadas);
--  9. painel público só com valores e situações (etapa 4).

-- ═══ Permissões de apoio ══════════════════════════════════════════════════════
create or replace function public.pode_requisitar(p_unidade uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.sou_admin_global()
      or (public.meu_papel() in ('chefe_secao','chefia') and p_unidade in (select public.escopo_unidades()))
$$;
-- Gestão de pedidos: chefe de seção, chefia, ordenador (e Licitações) da seção gestora.
create or replace function public.pode_gerir_pedidos(p_unidade_gestora uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.sou_admin_global()
      or (public.meu_papel() in ('chefe_secao','chefia','ord_despesas','licitacoes')
          and p_unidade_gestora is not null and public.minha_unidade() = p_unidade_gestora)
$$;
create or replace function public.pode_cadastrar_instrumento() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.sou_admin_global() or public.meu_papel() = 'licitacoes'
$$;
grant execute on function public.pode_requisitar(uuid), public.pode_gerir_pedidos(uuid),
  public.pode_cadastrar_instrumento() to authenticated;

-- ═══ Instrumentos: contratos, atas e processos de contratação ════════════════
create table if not exists public.instrumentos (
  id_instrumento     uuid primary key default gen_random_uuid(),
  tipo               text not null check (tipo in ('contrato','ata','processo')),
  numero             text not null check (length(trim(numero)) > 0),
  objeto             text not null check (length(trim(objeto)) > 0),
  fornecedor_cnpj    text,
  fornecedor_nome    text,
  vigencia_inicio    date,
  vigencia_fim       date,
  valor_limite       numeric(14,2) check (valor_limite is null or valor_limite > 0),
  processo_sei       text,
  modalidade         text,
  situacao           text not null default 'vigente'
                     check (situacao in ('vigente','encerrado','em_andamento','concluido','fracassado')),
  id_unidade_gestora uuid not null references public.unidades(id_unidade),
  id_processo_origem uuid references public.instrumentos(id_instrumento),
  observacao         text,
  criado_por         uuid references public.perfis(id_usuario) on delete set null,
  data_criacao       timestamptz not null default now(),
  check (tipo = 'processo' or valor_limite is not null),
  check (tipo <> 'processo' or situacao in ('em_andamento','concluido','fracassado')),
  check (tipo = 'processo' or situacao in ('vigente','encerrado')),
  check (vigencia_fim is null or vigencia_inicio is null or vigencia_fim >= vigencia_inicio)
);
create unique index if not exists instrumentos_tipo_numero_key on public.instrumentos (tipo, upper(trim(numero)));

-- ═══ Requisições ═════════════════════════════════════════════════════════════
create table if not exists public.contador_requisicoes (
  exercicio smallint primary key,
  ultimo    integer not null default 0
);

create table if not exists public.requisicoes (
  id_requisicao      uuid primary key default gen_random_uuid(),
  codigo             text unique,
  exercicio          smallint not null,
  id_demanda         uuid not null references public.demandas(id_demanda) on delete restrict,
  id_unidade         uuid not null references public.unidades(id_unidade),
  quantidade         numeric(14,3) not null check (quantidade > 0),
  valor              numeric(14,2) not null check (valor > 0),
  forma              text not null check (forma in ('contrato','ata','nova_contratacao','bolsas_editais','diarias','outros')),
  id_instrumento     uuid references public.instrumentos(id_instrumento),
  declaracao_sem_instrumento boolean not null default false,
  observacao         text,
  id_unidade_gestora uuid not null references public.unidades(id_unidade),
  situacao           text not null default 'aguardando_gestor'
                     check (situacao in ('aguardando_contratacao','aguardando_gestor','pendente','aprovada',
                                         'em_solicitacao','empenhada','liquidada','paga','cancelada')),
  motivo             text,
  valor_real         numeric(14,2) check (valor_real is null or valor_real > 0),
  data_aprovacao     timestamptz,
  aprovado_por       uuid references public.perfis(id_usuario) on delete set null,
  criado_por         uuid references public.perfis(id_usuario) on delete set null,
  data_criacao       timestamptz not null default now(),
  data_situacao      timestamptz not null default now()
);
create index if not exists requisicoes_demanda_idx on public.requisicoes (id_demanda);
create index if not exists requisicoes_instrumento_idx on public.requisicoes (id_instrumento);
create index if not exists requisicoes_gestora_idx on public.requisicoes (id_unidade_gestora, situacao);

create table if not exists public.requisicao_historico (
  id_evento     bigserial primary key,
  id_requisicao uuid not null references public.requisicoes(id_requisicao) on delete cascade,
  acao          text not null,
  situacao      text not null,
  motivo        text,
  valor         numeric(14,2),
  valor_real    numeric(14,2),
  id_usuario    uuid references public.perfis(id_usuario) on delete set null,
  data_hora     timestamptz not null default now()
);

-- Situações que seguram valor do instrumento (aprovadas em diante).
create or replace function public.situacao_consome_instrumento(p text) returns boolean
language sql immutable as $$ select p in ('aprovada','em_solicitacao','empenhada','liquidada','paga') $$;

create or replace function public.consumo_instrumento(p_instrumento uuid, p_exceto uuid default null) returns numeric
language sql stable security definer set search_path to 'public' as $$
  select coalesce(sum(valor_real), 0) from public.requisicoes
   where id_instrumento = p_instrumento and public.situacao_consome_instrumento(situacao)
     and id_requisicao is distinct from p_exceto
$$;
grant execute on function public.consumo_instrumento(uuid, uuid), public.situacao_consome_instrumento(text) to authenticated;

-- ═══ Regras da requisição (validam qualquer gravação) ════════════════════════
create or replace function public.validar_requisicao() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare d record; i record; v_valor numeric; v_qtd numeric; v_n integer;
begin
  select * into d from public.demandas where id_demanda = new.id_demanda;
  if d.id_demanda is null then raise exception 'Demanda nao encontrada.'; end if;

  if tg_op = 'INSERT' then
    if d.status::text <> 'homologada' then
      raise exception 'So demandas homologadas podem ser requisitadas.';
    end if;
    new.exercicio  := d.exercicio;
    new.id_unidade := d.id_unidade_fk;
    insert into public.contador_requisicoes as c (exercicio, ultimo) values (d.exercicio, 1)
      on conflict (exercicio) do update set ultimo = c.ultimo + 1 returning ultimo into v_n;
    new.codigo := 'REQ-' || d.exercicio || '-' || lpad(v_n::text, 4, '0');
  else
    new.codigo := old.codigo; new.exercicio := old.exercicio;
    new.id_unidade := old.id_unidade; new.id_demanda := old.id_demanda;
  end if;

  -- Saldo da demanda (valor e quantidade), sem contar canceladas nem a própria.
  if new.situacao <> 'cancelada' then
    select coalesce(sum(valor), 0), coalesce(sum(quantidade), 0) into v_valor, v_qtd
      from public.requisicoes
     where id_demanda = new.id_demanda and situacao <> 'cancelada' and id_requisicao <> new.id_requisicao;
    if v_valor + new.valor > d.valor_estimado then
      raise exception 'A demanda % tem R$ % de saldo para requisitar.', d.codigo, public.fmt_brl(d.valor_estimado - v_valor);
    end if;
    if d.quantidade is not null and v_qtd + new.quantidade > d.quantidade then
      raise exception 'A demanda % tem % % de saldo para requisitar.', d.codigo,
        trim(to_char(d.quantidade - v_qtd, 'FM999G999G990D###')), coalesce(d.unidade_medida, 'unidade(s)');
    end if;
  end if;

  -- Forma de atendimento × instrumento × gestora.
  if new.forma in ('contrato','ata','nova_contratacao') then
    if new.id_instrumento is null then raise exception 'Escolha o contrato, a ata ou o processo de contratacao.'; end if;
    select * into i from public.instrumentos where id_instrumento = new.id_instrumento;
    new.id_unidade_gestora := i.id_unidade_gestora;
    if tg_op = 'INSERT' or new.id_instrumento is distinct from old.id_instrumento or new.forma is distinct from old.forma then
      if new.forma = 'nova_contratacao' and i.tipo <> 'processo' then
        raise exception 'Para nova contratacao, escolha um processo de contratacao.';
      end if;
      if new.forma in ('contrato','ata') and i.tipo <> new.forma then
        raise exception 'O instrumento escolhido nao e um(a) %.', new.forma;
      end if;
      if i.tipo = 'processo' and i.situacao <> 'em_andamento' then
        raise exception 'O processo % nao esta em andamento.', i.numero;
      end if;
      if i.tipo <> 'processo' and (i.situacao <> 'vigente' or (i.vigencia_fim is not null and i.vigencia_fim < current_date)) then
        raise exception 'O instrumento % nao esta vigente.', i.numero;
      end if;
    end if;
    if new.forma = 'nova_contratacao' and not new.declaracao_sem_instrumento then
      raise exception 'Para nova contratacao, confirme que verificou nao haver contrato ou ata vigente para o objeto.';
    end if;
  else
    new.id_instrumento := null;
    new.id_unidade_gestora := new.id_unidade;   -- decisão 4: a própria unidade é a gestora
  end if;

  -- Aprovação: valor real informado, dentro do requisitado e do saldo do instrumento.
  if public.situacao_consome_instrumento(new.situacao) then
    if new.valor_real is null then raise exception 'Informe o valor real antes de aprovar.'; end if;
    if new.valor_real > new.valor then
      raise exception 'O valor real (R$ %) supera o requisitado (R$ %). Devolva a requisicao para readequacao.',
        public.fmt_brl(new.valor_real), public.fmt_brl(new.valor);
    end if;
    if new.id_instrumento is not null then
      select * into i from public.instrumentos where id_instrumento = new.id_instrumento;
      if i.valor_limite is not null and public.consumo_instrumento(i.id_instrumento, new.id_requisicao) + new.valor_real > i.valor_limite then
        raise exception 'O instrumento % tem R$ % de saldo.', i.numero,
          public.fmt_brl(i.valor_limite - public.consumo_instrumento(i.id_instrumento, new.id_requisicao));
      end if;
    end if;
  end if;
  if new.situacao = 'pendente' and length(trim(coalesce(new.motivo, ''))) < 5 then
    raise exception 'Informe o motivo da pendencia.';
  end if;
  if tg_op = 'INSERT' or new.situacao is distinct from old.situacao then new.data_situacao := now(); end if;
  return new;
end $$;
drop trigger if exists trg_validar_requisicao on public.requisicoes;
create trigger trg_validar_requisicao before insert or update on public.requisicoes
  for each row execute function public.validar_requisicao();

-- O limite do instrumento não pode cair abaixo do já aprovado.
create or replace function public.validar_limite_instrumento() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_consumo numeric;
begin
  if new.valor_limite is not null then
    v_consumo := public.consumo_instrumento(new.id_instrumento);
    if new.valor_limite < v_consumo then
      raise exception 'O limite nao pode ficar abaixo do ja aprovado em requisicoes (R$ %).', public.fmt_brl(v_consumo);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_limite_instrumento on public.instrumentos;
create trigger trg_limite_instrumento before update of valor_limite on public.instrumentos
  for each row execute function public.validar_limite_instrumento();

-- Processo de contratação: ao gerar contrato/ata, as requisições que aguardavam
-- passam para o novo instrumento; se fracassar, voltam pendentes ao requerente.
create or replace function public.processo_para_instrumento() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare r record;
begin
  if tg_op = 'INSERT' and new.id_processo_origem is not null and new.tipo in ('contrato','ata') then
    update public.instrumentos set situacao = 'concluido' where id_instrumento = new.id_processo_origem and situacao = 'em_andamento';
    for r in select id_requisicao from public.requisicoes
              where id_instrumento = new.id_processo_origem and situacao = 'aguardando_contratacao' loop
      update public.requisicoes set id_instrumento = new.id_instrumento, forma = new.tipo,
             situacao = 'aguardando_gestor', motivo = null
       where id_requisicao = r.id_requisicao;
      insert into public.requisicao_historico (id_requisicao, acao, situacao, motivo, id_usuario)
        values (r.id_requisicao, 'contratacao_concluida', 'aguardando_gestor',
                'Processo concluido: ' || new.tipo || ' ' || new.numero, auth.uid());
    end loop;
  elsif tg_op = 'UPDATE' and new.tipo = 'processo' and new.situacao = 'fracassado' and old.situacao <> 'fracassado' then
    for r in select id_requisicao from public.requisicoes
              where id_instrumento = new.id_instrumento and situacao = 'aguardando_contratacao' loop
      update public.requisicoes set situacao = 'pendente',
             motivo = 'O processo de contratacao ' || new.numero || ' fracassou. Escolha outra forma de atendimento ou cancele.'
       where id_requisicao = r.id_requisicao;
      insert into public.requisicao_historico (id_requisicao, acao, situacao, motivo, id_usuario)
        values (r.id_requisicao, 'contratacao_fracassada', 'pendente', 'Processo ' || new.numero || ' fracassado', auth.uid());
    end loop;
  end if;
  return null;
end $$;
drop trigger if exists trg_processo_instrumento on public.instrumentos;
create trigger trg_processo_instrumento after insert or update of situacao on public.instrumentos
  for each row execute function public.processo_para_instrumento();

-- ═══ Operações (as únicas formas de gravar uma requisição) ═══════════════════
create or replace function public.req_salvar(
  p_id uuid, p_demanda uuid, p_quantidade numeric, p_valor numeric, p_forma text,
  p_instrumento uuid, p_declaracao boolean, p_observacao text) returns json
language plpgsql security definer set search_path to 'public' as $$
declare r public.requisicoes; v_unidade uuid; v_sit text;
begin
  if p_forma = 'nova_contratacao' then v_sit := 'aguardando_contratacao'; else v_sit := 'aguardando_gestor'; end if;
  if p_id is null then
    select id_unidade_fk into v_unidade from public.demandas where id_demanda = p_demanda;
    if not public.pode_requisitar(v_unidade) then raise exception 'Voce nao pode requisitar demandas desta unidade.'; end if;
    insert into public.requisicoes (id_demanda, id_unidade, quantidade, valor, forma, id_instrumento,
                                    declaracao_sem_instrumento, observacao, id_unidade_gestora, situacao, criado_por)
    values (p_demanda, v_unidade, p_quantidade, p_valor, p_forma, p_instrumento, coalesce(p_declaracao, false),
            nullif(trim(p_observacao), ''), v_unidade, v_sit, auth.uid())
    returning * into r;
    insert into public.requisicao_historico (id_requisicao, acao, situacao, valor, id_usuario)
      values (r.id_requisicao, 'enviada', r.situacao, r.valor, auth.uid());
  else
    select * into r from public.requisicoes where id_requisicao = p_id for update;
    if not public.pode_requisitar(r.id_unidade) then raise exception 'Voce nao pode alterar esta requisicao.'; end if;
    if r.situacao not in ('pendente','aguardando_gestor','aguardando_contratacao') then
      raise exception 'Esta requisicao ja foi aprovada e nao pode ser alterada.';
    end if;
    update public.requisicoes set quantidade = p_quantidade, valor = p_valor, forma = p_forma,
           id_instrumento = p_instrumento, declaracao_sem_instrumento = coalesce(p_declaracao, false),
           observacao = nullif(trim(p_observacao), ''), situacao = v_sit, motivo = null, valor_real = null
     where id_requisicao = p_id returning * into r;
    insert into public.requisicao_historico (id_requisicao, acao, situacao, valor, id_usuario)
      values (r.id_requisicao, 'reenviada', r.situacao, r.valor, auth.uid());
  end if;
  return json_build_object('id_requisicao', r.id_requisicao, 'codigo', r.codigo, 'situacao', r.situacao);
end $$;

create or replace function public.req_cancelar(p_id uuid, p_motivo text) returns void
language plpgsql security definer set search_path to 'public' as $$
declare r public.requisicoes;
begin
  select * into r from public.requisicoes where id_requisicao = p_id for update;
  if not public.pode_requisitar(r.id_unidade) then raise exception 'Voce nao pode cancelar esta requisicao.'; end if;
  if r.situacao not in ('pendente','aguardando_gestor','aguardando_contratacao') then
    raise exception 'So requisicoes ainda nao aprovadas podem ser canceladas.';
  end if;
  update public.requisicoes set situacao = 'cancelada', motivo = nullif(trim(p_motivo), '') where id_requisicao = p_id;
  insert into public.requisicao_historico (id_requisicao, acao, situacao, motivo, id_usuario)
    values (p_id, 'cancelada', 'cancelada', nullif(trim(p_motivo), ''), auth.uid());
end $$;

-- Gestor: aprovar (com valor real), devolver (pendente, com motivo) ou desfazer a aprovação.
create or replace function public.req_analisar(p_id uuid, p_acao text, p_valor_real numeric, p_motivo text) returns json
language plpgsql security definer set search_path to 'public' as $$
declare r public.requisicoes;
begin
  select * into r from public.requisicoes where id_requisicao = p_id for update;
  if r.id_requisicao is null then raise exception 'Requisicao nao encontrada.'; end if;
  if not public.pode_gerir_pedidos(r.id_unidade_gestora) then
    raise exception 'Somente a secao gestora pode analisar esta requisicao.';
  end if;
  if p_acao = 'aprovar' then
    if r.situacao <> 'aguardando_gestor' then raise exception 'A requisicao nao esta aguardando analise.'; end if;
    update public.requisicoes set valor_real = p_valor_real, situacao = 'aprovada', motivo = null,
           data_aprovacao = now(), aprovado_por = auth.uid()
     where id_requisicao = p_id returning * into r;
  elsif p_acao = 'devolver' then
    if r.situacao not in ('aguardando_gestor','aprovada') then raise exception 'Esta requisicao nao pode ser devolvida agora.'; end if;
    update public.requisicoes set situacao = 'pendente', motivo = p_motivo,
           valor_real = coalesce(p_valor_real, valor_real), data_aprovacao = null, aprovado_por = null
     where id_requisicao = p_id returning * into r;
  elsif p_acao = 'desfazer' then
    if r.situacao <> 'aprovada' then raise exception 'So uma requisicao aprovada (fora de solicitacao) pode voltar para analise.'; end if;
    update public.requisicoes set situacao = 'aguardando_gestor', data_aprovacao = null, aprovado_por = null
     where id_requisicao = p_id returning * into r;
  else
    raise exception 'Acao invalida.';
  end if;
  insert into public.requisicao_historico (id_requisicao, acao, situacao, motivo, valor, valor_real, id_usuario)
    values (p_id, p_acao, r.situacao, r.motivo, r.valor, r.valor_real, auth.uid());
  return json_build_object('id_requisicao', r.id_requisicao, 'situacao', r.situacao, 'residuo', r.valor - coalesce(r.valor_real, r.valor));
end $$;

grant execute on function public.req_salvar(uuid, uuid, numeric, numeric, text, uuid, boolean, text),
  public.req_cancelar(uuid, text), public.req_analisar(uuid, text, numeric, text) to authenticated;

-- ═══ Permissões (RLS) ═════════════════════════════════════════════════════════
alter table public.instrumentos         enable row level security;
alter table public.requisicoes          enable row level security;
alter table public.requisicao_historico enable row level security;
alter table public.contador_requisicoes enable row level security;
grant select, insert, update, delete on public.instrumentos to authenticated;
grant select on public.requisicoes, public.requisicao_historico to authenticated;

drop policy if exists inst_select on public.instrumentos;
create policy inst_select on public.instrumentos for select to authenticated using (true);
drop policy if exists inst_write on public.instrumentos;
create policy inst_write on public.instrumentos for all to authenticated
  using (public.pode_cadastrar_instrumento()) with check (public.pode_cadastrar_instrumento());

create or replace function public.requisicao_visivel(p_unidade uuid, p_gestora uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.pode_ver_unidade(p_unidade) or public.pode_gerir_pedidos(p_gestora)
      or (public.meu_papel() = 'licitacoes')
$$;
grant execute on function public.requisicao_visivel(uuid, uuid) to authenticated;

drop policy if exists req_select on public.requisicoes;
create policy req_select on public.requisicoes for select to authenticated
  using (public.requisicao_visivel(id_unidade, id_unidade_gestora));
drop policy if exists reqh_select on public.requisicao_historico;
create policy reqh_select on public.requisicao_historico for select to authenticated
  using (exists (select 1 from public.requisicoes r where r.id_requisicao = requisicao_historico.id_requisicao));

-- ═══ Visões ══════════════════════════════════════════════════════════════════
create or replace view public.v_instrumentos with (security_invoker = on) as
select i.*, u.sigla as sigla_gestora, u.nome as nome_gestora,
       public.consumo_instrumento(i.id_instrumento) as consumido,
       case when i.valor_limite is null then null else i.valor_limite - public.consumo_instrumento(i.id_instrumento) end as saldo,
       (i.tipo <> 'processo' and i.situacao = 'vigente' and (i.vigencia_fim is null or i.vigencia_fim >= current_date)) as disponivel,
       p.numero as numero_processo_origem
from public.instrumentos i
join public.unidades u on u.id_unidade = i.id_unidade_gestora
left join public.instrumentos p on p.id_instrumento = i.id_processo_origem;

-- Sem security_invoker: o gestor precisa ver a demanda de outra unidade; o filtro
-- de visibilidade é aplicado aqui mesmo.
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
       c.nome as categoria, c.natureza_despesa
from public.requisicoes r
join public.demandas d on d.id_demanda = r.id_demanda
join public.unidades u on u.id_unidade = r.id_unidade
join public.unidades g on g.id_unidade = r.id_unidade_gestora
left join public.instrumentos i on i.id_instrumento = r.id_instrumento
left join public.categorias_despesa c on c.id_categoria = d.id_categoria_fk
where public.requisicao_visivel(r.id_unidade, r.id_unidade_gestora);

-- Demandas homologadas com o saldo a requisitar.
create or replace view public.v_demandas_saldo with (security_invoker = on) as
select d.id_demanda, d.codigo, d.exercicio, d.descricao_objeto, d.justificativa, d.quantidade, d.unidade_medida,
       d.valor_estimado, d.id_unidade_fk, u.sigla as sigla_unidade, u.nome as nome_unidade,
       c.nome as categoria, c.natureza_despesa,
       coalesce(q.valor, 0) as requisitado, coalesce(q.quantidade, 0) as quantidade_requisitada,
       d.valor_estimado - coalesce(q.valor, 0) as saldo,
       case when d.quantidade is null then null else d.quantidade - coalesce(q.quantidade, 0) end as saldo_quantidade,
       coalesce(q.n, 0) as n_requisicoes, coalesce(q.residuo, 0) as residuo
from public.demandas d
join public.unidades u on u.id_unidade = d.id_unidade_fk
left join public.categorias_despesa c on c.id_categoria = d.id_categoria_fk
left join lateral (select sum(r.valor) as valor, sum(r.quantidade) as quantidade, count(*) as n,
                          sum(case when r.valor_real is not null and public.situacao_consome_instrumento(r.situacao)
                                   then r.valor - r.valor_real else 0 end) as residuo
                     from public.requisicoes r where r.id_demanda = d.id_demanda and r.situacao <> 'cancelada') q on true
where d.status = 'homologada';

grant select on public.v_instrumentos, public.v_requisicoes, public.v_demandas_saldo to authenticated;

select 'requisicoes etapa 1 criada' as resultado;

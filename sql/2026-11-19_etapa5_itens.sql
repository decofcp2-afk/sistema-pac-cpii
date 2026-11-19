-- Planejamento e Monitoramento Orçamentário — etapa 5 — 19/11/2026
-- Itens nos contratos e atas, participação por polo, DFD e requisição por itens.
-- Decisões do gestor (19/11/2026):
--  1. itens obrigatórios na requisição de contrato/ata (a demanda continua livre);
--  2. o teto da requisição é o saldo da demanda em valor (Σ quantidade × valor
--     unitário); a quantidade da demanda deixa de ser abatida quando há itens;
--  3. acréscimo, supressão e reajuste com histórico; a requisição guarda o preço
--     do momento;
--  4. controle por polo: cada seção pertence à Reitoria ou a um campus e só
--     acessa contratos, atas e DFDs do seu polo; numa ata, cada participante
--     (polo) tem a sua seção gestora e as suas quantidades;
--  5. nova contratação: a requisição fica "aguardando processo de contratação",
--     vinculada a um DFD (cadastrado pela Licitações); ao gerar o contrato/ata, a
--     requisição volta para a seção escolher os itens.

-- ═══ 1. Polo da unidade ══════════════════════════════════════════════════════
-- Polo = o campus acima da unidade (ou ela mesma); fora de campus, a raiz (Reitoria).
create or replace function public.polo_unidade(p_unidade uuid) returns uuid
language sql stable security definer set search_path to 'public' as $$
  with recursive acima as (
    select id_unidade, id_unidade_pai, tipo::text as tipo, 0 as n from public.unidades where id_unidade = p_unidade
    union all
    select u.id_unidade, u.id_unidade_pai, u.tipo::text, a.n + 1 from public.unidades u
      join acima a on u.id_unidade = a.id_unidade_pai where a.n < 50
  )
  select coalesce((select id_unidade from acima where tipo = 'campus' order by n limit 1),
                  (select id_unidade from acima where id_unidade_pai is null limit 1))
$$;

-- Polos das unidades do escopo do usuário.
-- (o polo da própria unidade e os campi que estiverem dentro do escopo)
create or replace function public.meus_polos() returns table (id_polo uuid)
language sql stable security definer set search_path to 'public' as $$
  select public.polo_unidade(public.minha_unidade()) where public.minha_unidade() is not null
  union
  select e.id_unidade from public.escopo_unidades() e join public.unidades u on u.id_unidade = e.id_unidade
   where u.tipo::text = 'campus'
$$;

-- ═══ 2. Instrumentos: DFD no lugar de "processo"; polo; campos do DFD ═══════
alter table public.instrumentos drop constraint if exists instrumentos_check;
alter table public.instrumentos drop constraint if exists instrumentos_check1;
alter table public.instrumentos drop constraint if exists instrumentos_check2;
alter table public.instrumentos drop constraint if exists instrumentos_tipo_check;
alter table public.instrumentos drop constraint if exists instrumentos_situacao_check;
alter table public.instrumentos add column if not exists id_polo uuid references public.unidades(id_unidade);
alter table public.instrumentos add column if not exists data_dfd date;
alter table public.instrumentos add column if not exists valor_estimado numeric(14,2) check (valor_estimado is null or valor_estimado > 0);
alter table public.instrumentos add column if not exists id_unidade_demandante uuid references public.unidades(id_unidade);

update public.instrumentos set tipo = 'dfd' where tipo = 'processo';
update public.instrumentos set situacao = 'em_contratacao' where tipo = 'dfd' and situacao = 'em_andamento';
update public.instrumentos set situacao = 'cancelado' where tipo = 'dfd' and situacao = 'fracassado';
update public.instrumentos set id_polo = public.polo_unidade(coalesce(id_unidade_demandante, id_unidade_gestora)) where id_polo is null;
update public.instrumentos set id_unidade_demandante = id_unidade_gestora where tipo = 'dfd' and id_unidade_demandante is null;

alter table public.instrumentos add constraint instrumentos_tipo_check check (tipo in ('contrato','ata','dfd'));
alter table public.instrumentos add constraint instrumentos_situacao_check check (
  (tipo = 'dfd' and situacao in ('em_elaboracao','em_contratacao','concluido','cancelado'))
  or (tipo <> 'dfd' and situacao in ('vigente','encerrado')));
alter table public.instrumentos alter column id_polo set not null;

drop index if exists public.instrumentos_tipo_numero_key;
create unique index if not exists instrumentos_tipo_polo_numero_key on public.instrumentos (tipo, id_polo, upper(trim(numero)));

-- ═══ 3. Participantes (polos), itens e quantidades ═══════════════════════════
create table if not exists public.instrumento_participantes (
  id_participacao    uuid primary key default gen_random_uuid(),
  id_instrumento     uuid not null references public.instrumentos(id_instrumento) on delete cascade,
  id_polo            uuid not null references public.unidades(id_unidade),
  id_unidade_gestora uuid not null references public.unidades(id_unidade),
  unique (id_instrumento, id_polo)
);

create table if not exists public.instrumento_itens (
  id_item          uuid primary key default gen_random_uuid(),
  id_instrumento   uuid not null references public.instrumentos(id_instrumento) on delete cascade,
  grupo            text,
  numero_item      text not null check (length(trim(numero_item)) > 0),
  descricao        text not null check (length(trim(descricao)) > 0),
  unidade_medida   text not null check (length(trim(unidade_medida)) > 0),
  valor_unitario   numeric(14,4) not null check (valor_unitario > 0),
  natureza_despesa text,
  ordem            integer not null default 0
);
create unique index if not exists instrumento_itens_num_key
  on public.instrumento_itens (id_instrumento, upper(coalesce(trim(grupo), '')), upper(trim(numero_item)));

create table if not exists public.instrumento_quantidades (
  id_participacao uuid not null references public.instrumento_participantes(id_participacao) on delete cascade,
  id_item         uuid not null references public.instrumento_itens(id_item) on delete cascade,
  quantidade      numeric(14,3) not null check (quantidade >= 0),
  primary key (id_participacao, id_item)
);

create table if not exists public.instrumento_alteracoes (
  id_alteracao      bigserial primary key,
  id_instrumento    uuid not null references public.instrumentos(id_instrumento) on delete cascade,
  id_item           uuid references public.instrumento_itens(id_item) on delete set null,
  id_participacao   uuid references public.instrumento_participantes(id_participacao) on delete set null,
  tipo              text not null check (tipo in ('acrescimo','supressao','reajuste','inclusao_item','correcao')),
  quantidade_antes  numeric(14,3),
  quantidade_depois numeric(14,3),
  valor_antes       numeric(14,4),
  valor_depois      numeric(14,4),
  documento         text,
  data              date,
  observacao        text,
  criado_por        uuid references public.perfis(id_usuario) on delete set null,
  data_hora         timestamptz not null default now()
);
create index if not exists instrumento_alteracoes_inst_idx on public.instrumento_alteracoes (id_instrumento);

-- ═══ 4. Requisição por itens ═════════════════════════════════════════════════
alter table public.requisicoes add column if not exists id_participacao uuid references public.instrumento_participantes(id_participacao);

-- Dados anteriores (sem itens): cada contrato/ata ganha a participação do polo da
-- sua gestora e a de cada polo que já requisitou, para continuarem funcionando.
insert into public.instrumento_participantes (id_instrumento, id_polo, id_unidade_gestora)
select i.id_instrumento, public.polo_unidade(i.id_unidade_gestora), i.id_unidade_gestora
  from public.instrumentos i where i.tipo <> 'dfd'
on conflict (id_instrumento, id_polo) do nothing;
insert into public.instrumento_participantes (id_instrumento, id_polo, id_unidade_gestora)
select distinct r.id_instrumento, public.polo_unidade(r.id_unidade), r.id_unidade_gestora
  from public.requisicoes r join public.instrumentos i on i.id_instrumento = r.id_instrumento where i.tipo <> 'dfd'
on conflict (id_instrumento, id_polo) do nothing;
update public.requisicoes r set id_participacao = pp.id_participacao
  from public.instrumento_participantes pp
 where pp.id_instrumento = r.id_instrumento and pp.id_polo = public.polo_unidade(r.id_unidade) and r.id_participacao is null;
alter table public.requisicoes alter column quantidade drop not null;
alter table public.requisicoes drop constraint if exists requisicoes_quantidade_check;
alter table public.requisicoes add constraint requisicoes_quantidade_check check (quantidade is null or quantidade > 0);

create table if not exists public.requisicao_itens (
  id_req_item         uuid primary key default gen_random_uuid(),
  id_requisicao       uuid not null references public.requisicoes(id_requisicao) on delete cascade,
  id_item             uuid not null references public.instrumento_itens(id_item),
  quantidade          numeric(14,3) not null check (quantidade > 0),
  quantidade_aprovada numeric(14,3) check (quantidade_aprovada is null or quantidade_aprovada >= 0),
  valor_unitario      numeric(14,4) not null check (valor_unitario > 0),
  unique (id_requisicao, id_item)
);
create index if not exists requisicao_itens_item_idx on public.requisicao_itens (id_item);

-- Quantidade de um item já aprovada para o polo (requisições aprovadas em diante).
create or replace function public.item_aprovado(p_participacao uuid, p_item uuid, p_exceto uuid default null) returns numeric
language sql stable security definer set search_path to 'public' as $$
  select coalesce(sum(coalesce(ri.quantidade_aprovada, 0)), 0)
    from public.requisicao_itens ri join public.requisicoes r on r.id_requisicao = ri.id_requisicao
   where r.id_participacao = p_participacao and ri.id_item = p_item
     and public.situacao_consome_instrumento(r.situacao) and r.id_requisicao is distinct from p_exceto
$$;
-- Quantidade pedida aguardando o gestor (informativo).
create or replace function public.item_em_analise(p_participacao uuid, p_item uuid) returns numeric
language sql stable security definer set search_path to 'public' as $$
  select coalesce(sum(ri.quantidade), 0)
    from public.requisicao_itens ri join public.requisicoes r on r.id_requisicao = ri.id_requisicao
   where r.id_participacao = p_participacao and ri.id_item = p_item and r.situacao = 'aguardando_gestor'
$$;
create or replace function public.item_registrado(p_participacao uuid, p_item uuid) returns numeric
language sql stable security definer set search_path to 'public' as $$
  select coalesce((select quantidade from public.instrumento_quantidades
                    where id_participacao = p_participacao and id_item = p_item), 0)
$$;

-- Valor total do instrumento = Σ quantidades × valor unitário (todos os polos).
create or replace function public.recalcular_valor_instrumento(p_instrumento uuid) returns void
language sql security definer set search_path to 'public' as $$
  update public.instrumentos i set valor_limite = nullif((
    select round(coalesce(sum(q.quantidade * it.valor_unitario), 0), 2)
      from public.instrumento_itens it join public.instrumento_quantidades q on q.id_item = it.id_item
     where it.id_instrumento = p_instrumento), 0)
   where i.id_instrumento = p_instrumento and i.tipo <> 'dfd'
$$;

-- ═══ 5. Regras da requisição ═════════════════════════════════════════════════
create or replace function public.validar_requisicao() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare d record; i public.instrumentos; p public.instrumento_participantes; v_valor numeric; v_qtd numeric; v_n integer; v_lim numeric; v_polo uuid;
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

  -- Saldo da demanda: valor sempre; quantidade só quando a requisição não é por itens.
  if new.situacao <> 'cancelada' then
    select coalesce(sum(valor), 0), coalesce(sum(quantidade), 0) into v_valor, v_qtd
      from public.requisicoes
     where id_demanda = new.id_demanda and situacao <> 'cancelada' and id_requisicao <> new.id_requisicao;
    v_lim := public.limite_requisitavel(new.id_demanda, new.id_requisicao,
      case when new.valor_real is not null and public.situacao_consome_instrumento(new.situacao) then new.valor - new.valor_real else 0 end);
    if v_valor + new.valor > v_lim + 0.005 then
      raise exception 'A demanda % tem R$ % de saldo para requisitar%.', d.codigo, public.fmt_brl(greatest(v_lim - v_valor, 0)),
        case when public.devolvido_demanda(new.id_demanda) > 0
             then ' (R$ ' || public.fmt_brl(public.devolvido_demanda(new.id_demanda)) || ' foram devolvidos a Reitoria)' else '' end;
    end if;
    if d.quantidade is not null and new.quantidade is not null and v_qtd + new.quantidade > d.quantidade then
      raise exception 'A demanda % tem % % de saldo para requisitar.', d.codigo,
        trim(to_char(d.quantidade - v_qtd, 'FM999G999G990D###')), coalesce(d.unidade_medida, 'unidade(s)');
    end if;
  end if;

  v_polo := public.polo_unidade(new.id_unidade);

  -- Forma de atendimento × instrumento × polo × gestora.
  if new.forma in ('contrato','ata') then
    if new.id_instrumento is null then raise exception 'Escolha o contrato ou a ata.'; end if;
    select * into i from public.instrumentos where id_instrumento = new.id_instrumento;
    if i.tipo <> new.forma then raise exception 'O instrumento escolhido nao e um(a) %.', new.forma; end if;
    select * into p from public.instrumento_participantes where id_instrumento = i.id_instrumento and id_polo = v_polo;
    if p.id_participacao is null then
      raise exception 'O % % nao tem participacao do polo desta secao.', i.tipo, i.numero;
    end if;
    new.id_participacao := p.id_participacao;
    new.id_unidade_gestora := p.id_unidade_gestora;
    if tg_op = 'INSERT' or new.id_instrumento is distinct from old.id_instrumento or new.forma is distinct from old.forma
       or (new.situacao = 'aguardando_gestor' and old.situacao is distinct from 'aguardando_gestor') then
      if i.situacao <> 'vigente' or (i.vigencia_fim is not null and i.vigencia_fim < current_date) then
        raise exception 'O instrumento % nao esta vigente.', i.numero;
      end if;
    end if;
  elsif new.forma = 'nova_contratacao' then
    new.id_participacao := null;
    new.id_unidade_gestora := new.id_unidade;
    if new.id_instrumento is not null then
      select * into i from public.instrumentos where id_instrumento = new.id_instrumento;
      if i.tipo <> 'dfd' then raise exception 'Para nova contratacao, escolha um DFD.'; end if;
      if tg_op = 'INSERT' or new.id_instrumento is distinct from old.id_instrumento or new.forma is distinct from old.forma then
        if i.situacao not in ('em_elaboracao','em_contratacao') then
          raise exception 'O DFD % nao esta em elaboracao nem em contratacao.', i.numero;
        end if;
        if i.id_polo <> v_polo then raise exception 'O DFD % e de outro polo.', i.numero; end if;
      end if;
    end if;
    if not new.declaracao_sem_instrumento then
      raise exception 'Para nova contratacao, confirme que verificou nao haver contrato ou ata vigente para o objeto.';
    end if;
  else
    new.id_instrumento := null;
    new.id_participacao := null;
    new.id_unidade_gestora := new.id_unidade;   -- bolsas, editais, diárias e outros: a própria unidade é a gestora
  end if;

  -- Aprovação: valor real informado, dentro do requisitado e do valor total do instrumento.
  if public.situacao_consome_instrumento(new.situacao) then
    if new.valor_real is null then raise exception 'Informe o valor real antes de aprovar.'; end if;
    if new.valor_real > new.valor + 0.005 then
      raise exception 'O valor real (R$ %) supera o requisitado (R$ %). Devolva a requisicao para readequacao.',
        public.fmt_brl(new.valor_real), public.fmt_brl(new.valor);
    end if;
    -- (o limite do contrato/ata agora é a quantidade de cada item no polo, conferida em req_salvar e req_analisar)
  end if;
  if new.situacao = 'pendente' and length(trim(coalesce(new.motivo, ''))) < 5 then
    raise exception 'Informe o motivo da pendencia.';
  end if;
  if tg_op = 'INSERT' or new.situacao is distinct from old.situacao then new.data_situacao := now(); end if;
  return new;
end $$;

-- O trigger antigo de "processo → instrumento" sai: a passagem do DFD para o
-- contrato/ata agora acontece em inst_salvar, depois de gravados polos e itens.
drop trigger if exists trg_processo_instrumento on public.instrumentos;
drop function if exists public.processo_para_instrumento();
-- O valor total passa a ser a soma dos itens; o controle é por quantidade de item.
drop trigger if exists trg_limite_instrumento on public.instrumentos;

-- ═══ 6. Visibilidade por polo ════════════════════════════════════════════════
create or replace function public.instrumento_visivel(p_instrumento uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.sou_admin_global()
      or public.meu_papel()::text in ('licitacoes','orcamento','monitoramento','ord_despesas')
      or exists (select 1 from public.instrumentos i where i.id_instrumento = p_instrumento
                   and i.id_polo in (select id_polo from public.meus_polos()))
      or exists (select 1 from public.instrumento_participantes pp where pp.id_instrumento = p_instrumento
                   and (pp.id_polo in (select id_polo from public.meus_polos()) or pp.id_unidade_gestora = public.minha_unidade()))
$$;

alter table public.instrumento_participantes enable row level security;
alter table public.instrumento_itens        enable row level security;
alter table public.instrumento_quantidades  enable row level security;
alter table public.instrumento_alteracoes   enable row level security;
alter table public.requisicao_itens         enable row level security;
grant select on public.instrumento_participantes, public.instrumento_itens, public.instrumento_quantidades,
  public.instrumento_alteracoes, public.requisicao_itens to authenticated;
-- Gravação só pelas funções inst_* e req_* (security definer).
revoke insert, update, delete on public.instrumentos from authenticated;
drop policy if exists inst_write on public.instrumentos;
drop policy if exists inst_select on public.instrumentos;
create policy inst_select on public.instrumentos for select to authenticated using (public.instrumento_visivel(id_instrumento));
drop policy if exists ipart_select on public.instrumento_participantes;
create policy ipart_select on public.instrumento_participantes for select to authenticated using (public.instrumento_visivel(id_instrumento));
drop policy if exists iitem_select on public.instrumento_itens;
create policy iitem_select on public.instrumento_itens for select to authenticated using (public.instrumento_visivel(id_instrumento));
drop policy if exists iqtd_select on public.instrumento_quantidades;
create policy iqtd_select on public.instrumento_quantidades for select to authenticated
  using (exists (select 1 from public.instrumento_participantes pp where pp.id_participacao = instrumento_quantidades.id_participacao
                   and public.instrumento_visivel(pp.id_instrumento)));
drop policy if exists ialt_select on public.instrumento_alteracoes;
create policy ialt_select on public.instrumento_alteracoes for select to authenticated using (public.instrumento_visivel(id_instrumento));
drop policy if exists reqi_select on public.requisicao_itens;
create policy reqi_select on public.requisicao_itens for select to authenticated
  using (exists (select 1 from public.requisicoes r where r.id_requisicao = requisicao_itens.id_requisicao));

-- ═══ 7. Visões ═══════════════════════════════════════════════════════════════
drop view if exists public.v_instrumentos;
create view public.v_instrumentos with (security_invoker = on) as
select i.*, u.sigla as sigla_gestora, u.nome as nome_gestora,
       po.sigla as sigla_polo, po.nome as nome_polo,
       dm.sigla as sigla_demandante, dm.nome as nome_demandante,
       public.consumo_instrumento(i.id_instrumento) as consumido,
       case when i.valor_limite is null then null else i.valor_limite - public.consumo_instrumento(i.id_instrumento) end as saldo,
       (i.tipo <> 'dfd' and i.situacao = 'vigente' and (i.vigencia_fim is null or i.vigencia_fim >= current_date)) as disponivel,
       p.numero as numero_processo_origem,
       (select count(*) from public.instrumento_itens it where it.id_instrumento = i.id_instrumento) as n_itens,
       (select coalesce(json_agg(json_build_object('id_participacao', pp.id_participacao, 'id_polo', pp.id_polo,
                 'sigla_polo', up.sigla, 'nome_polo', up.nome, 'id_unidade_gestora', pp.id_unidade_gestora,
                 'sigla_gestora', ug.sigla, 'nome_gestora', ug.nome) order by up.tipo::text desc, up.sigla), '[]'::json)
          from public.instrumento_participantes pp
          join public.unidades up on up.id_unidade = pp.id_polo
          join public.unidades ug on ug.id_unidade = pp.id_unidade_gestora
         where pp.id_instrumento = i.id_instrumento) as participantes
from public.instrumentos i
join public.unidades u on u.id_unidade = i.id_unidade_gestora
join public.unidades po on po.id_unidade = i.id_polo
left join public.unidades dm on dm.id_unidade = i.id_unidade_demandante
left join public.instrumentos p on p.id_instrumento = i.id_processo_origem;

-- Saldo por item e polo.
create or replace view public.v_instrumento_saldos with (security_invoker = on) as
select pp.id_instrumento, pp.id_participacao, pp.id_polo, pp.id_unidade_gestora,
       it.id_item, it.grupo, it.numero_item, it.descricao, it.unidade_medida, it.valor_unitario, it.natureza_despesa, it.ordem,
       coalesce(q.quantidade, 0) as registrado,
       public.item_aprovado(pp.id_participacao, it.id_item) as aprovado,
       public.item_em_analise(pp.id_participacao, it.id_item) as em_analise,
       coalesce(q.quantidade, 0) - public.item_aprovado(pp.id_participacao, it.id_item) as saldo
from public.instrumento_participantes pp
join public.instrumento_itens it on it.id_instrumento = pp.id_instrumento
left join public.instrumento_quantidades q on q.id_participacao = pp.id_participacao and q.id_item = it.id_item;

grant select on public.v_instrumentos, public.v_instrumento_saldos to authenticated;

-- ═══ 8. Operações: instrumentos e DFD (Licitações e administrador) ═══════════
-- p_dados: campos do instrumento. p_participantes: [{id_polo, id_unidade_gestora}].
-- p_itens: [{id_item?, grupo, numero_item, descricao, unidade_medida, valor_unitario,
--            natureza_despesa, quantidades: {"<id_polo>": qtd}}].
-- Depois que o instrumento tem requisições aprovadas, quantidade e preço só mudam
-- por inst_alterar (aditivo/apostilamento), que guarda o histórico.
create or replace function public.inst_salvar(p_id uuid, p_dados json, p_participantes json, p_itens json) returns json
language plpgsql security definer set search_path to 'public' as $$
declare inst public.instrumentos; v_tipo text; v_polo uuid; v_demand uuid; v_sit_ant text; x json; y record;
        v_ids_part uuid[] := '{}'; v_ids_item uuid[] := '{}'; v_part uuid; v_item uuid; v_qtd numeric; v_ordem int := 0;
        v_usado boolean; it public.instrumento_itens; v_q_ant numeric; r record; v_dfd public.instrumentos;
begin
  if not public.pode_cadastrar_instrumento() then raise exception 'Somente a Licitacoes cadastra contratos, atas e DFDs.'; end if;
  v_tipo := p_dados->>'tipo';
  if v_tipo not in ('contrato','ata','dfd') then raise exception 'Tipo invalido.'; end if;
  if length(trim(coalesce(p_dados->>'numero', ''))) = 0 then raise exception 'Informe o numero.'; end if;
  if length(trim(coalesce(p_dados->>'objeto', ''))) = 0 then raise exception 'Informe o objeto.'; end if;

  if p_id is not null then
    select * into inst from public.instrumentos where id_instrumento = p_id for update;
    if inst.id_instrumento is null then raise exception 'Instrumento nao encontrado.'; end if;
    if inst.tipo <> v_tipo then raise exception 'O tipo do instrumento nao pode ser alterado.'; end if;
    v_sit_ant := inst.situacao;
  end if;

  if v_tipo = 'dfd' then
    v_demand := nullif(p_dados->>'id_unidade_demandante', '')::uuid;
    if v_demand is null then raise exception 'Informe a unidade demandante do DFD.'; end if;
    v_polo := public.polo_unidade(v_demand);
  else
    if p_participantes is null or json_array_length(p_participantes) = 0 then
      raise exception 'Informe o polo participante e a secao gestora.';
    end if;
    if v_tipo = 'contrato' and json_array_length(p_participantes) > 1 then
      raise exception 'O contrato tem um unico participante (polo e secao gestora).';
    end if;
    v_polo := coalesce(nullif(p_dados->>'id_polo', '')::uuid, (p_participantes->0->>'id_polo')::uuid);
    if not exists (select 1 from json_array_elements(p_participantes) z where (z->>'id_polo')::uuid = v_polo) then
      raise exception 'O polo gerenciador precisa estar entre os participantes.';
    end if;
    if p_itens is null or json_array_length(p_itens) = 0 then raise exception 'Cadastre ao menos um item.'; end if;
  end if;

  if p_id is null then
    insert into public.instrumentos (tipo, numero, objeto, fornecedor_cnpj, fornecedor_nome, vigencia_inicio, vigencia_fim,
           processo_sei, modalidade, situacao, id_unidade_gestora, id_processo_origem, observacao, criado_por,
           id_polo, data_dfd, valor_estimado, id_unidade_demandante)
    values (v_tipo, trim(p_dados->>'numero'), trim(p_dados->>'objeto'), nullif(trim(p_dados->>'fornecedor_cnpj'), ''),
            nullif(trim(p_dados->>'fornecedor_nome'), ''), nullif(p_dados->>'vigencia_inicio', '')::date,
            nullif(p_dados->>'vigencia_fim', '')::date, nullif(trim(p_dados->>'processo_sei'), ''),
            nullif(trim(p_dados->>'modalidade'), ''),
            coalesce(nullif(p_dados->>'situacao', ''), case when v_tipo = 'dfd' then 'em_elaboracao' else 'vigente' end),
            coalesce(v_demand, (p_participantes->0->>'id_unidade_gestora')::uuid),
            nullif(p_dados->>'id_processo_origem', '')::uuid, nullif(trim(p_dados->>'observacao'), ''), auth.uid(),
            v_polo, nullif(p_dados->>'data_dfd', '')::date, nullif(p_dados->>'valor_estimado', '')::numeric, v_demand)
    returning * into inst;
  else
    update public.instrumentos set numero = trim(p_dados->>'numero'), objeto = trim(p_dados->>'objeto'),
           fornecedor_cnpj = nullif(trim(p_dados->>'fornecedor_cnpj'), ''), fornecedor_nome = nullif(trim(p_dados->>'fornecedor_nome'), ''),
           vigencia_inicio = nullif(p_dados->>'vigencia_inicio', '')::date, vigencia_fim = nullif(p_dados->>'vigencia_fim', '')::date,
           processo_sei = nullif(trim(p_dados->>'processo_sei'), ''), modalidade = nullif(trim(p_dados->>'modalidade'), ''),
           situacao = coalesce(nullif(p_dados->>'situacao', ''), situacao),
           observacao = nullif(trim(p_dados->>'observacao'), ''), id_polo = v_polo,
           data_dfd = nullif(p_dados->>'data_dfd', '')::date, valor_estimado = nullif(p_dados->>'valor_estimado', '')::numeric,
           id_unidade_demandante = v_demand,
           id_unidade_gestora = coalesce(v_demand, (p_participantes->0->>'id_unidade_gestora')::uuid)
     where id_instrumento = p_id returning * into inst;
  end if;

  if v_tipo <> 'dfd' then
    -- Participantes
    for x in select * from json_array_elements(p_participantes) loop
      if public.polo_unidade((x->>'id_unidade_gestora')::uuid) <> (x->>'id_polo')::uuid then
        raise exception 'A secao gestora % nao pertence ao polo informado.',
          (select sigla from public.unidades where id_unidade = (x->>'id_unidade_gestora')::uuid);
      end if;
      insert into public.instrumento_participantes as pp (id_instrumento, id_polo, id_unidade_gestora)
        values (inst.id_instrumento, (x->>'id_polo')::uuid, (x->>'id_unidade_gestora')::uuid)
        on conflict (id_instrumento, id_polo) do update set id_unidade_gestora = excluded.id_unidade_gestora
        returning id_participacao into v_part;
      -- Requisições ainda em análise acompanham a nova gestora.
      update public.requisicoes set id_unidade_gestora = (x->>'id_unidade_gestora')::uuid
       where id_participacao = v_part and situacao in ('aguardando_gestor','pendente');
      v_ids_part := v_ids_part || v_part;
    end loop;
    for y in select pp.id_participacao, u.sigla from public.instrumento_participantes pp join public.unidades u on u.id_unidade = pp.id_polo
              where pp.id_instrumento = inst.id_instrumento and not (pp.id_participacao = any(v_ids_part)) loop
      if exists (select 1 from public.requisicoes where id_participacao = y.id_participacao and situacao <> 'cancelada') then
        raise exception 'O polo % ja tem requisicoes neste instrumento e nao pode sair.', y.sigla;
      end if;
      delete from public.instrumento_participantes where id_participacao = y.id_participacao;
    end loop;

    -- Itens e quantidades
    for x in select * from json_array_elements(p_itens) loop
      v_ordem := v_ordem + 1;
      v_item := nullif(x->>'id_item', '')::uuid;
      if (x->>'valor_unitario') is null or (x->>'valor_unitario')::numeric <= 0 then
        raise exception 'Item %: informe o valor unitario.', coalesce(x->>'numero_item', '?');
      end if;
      if v_item is not null then
        select * into it from public.instrumento_itens where id_item = v_item and id_instrumento = inst.id_instrumento;
        if it.id_item is null then raise exception 'Item nao encontrado neste instrumento.'; end if;
        v_usado := exists (select 1 from public.requisicao_itens ri join public.requisicoes rq on rq.id_requisicao = ri.id_requisicao
                            where ri.id_item = v_item and rq.situacao <> 'cancelada');
        if v_usado and abs(it.valor_unitario - (x->>'valor_unitario')::numeric) > 0.00001 then
          raise exception 'Item %: ja ha requisicoes; mude o preco por "Registrar alteracao" (reajuste).', it.numero_item;
        end if;
        update public.instrumento_itens set grupo = nullif(trim(x->>'grupo'), ''), numero_item = trim(x->>'numero_item'),
               descricao = trim(x->>'descricao'), unidade_medida = trim(x->>'unidade_medida'),
               valor_unitario = (x->>'valor_unitario')::numeric, natureza_despesa = nullif(trim(x->>'natureza_despesa'), ''),
               ordem = v_ordem
         where id_item = v_item;
      else
        v_usado := false;
        insert into public.instrumento_itens (id_instrumento, grupo, numero_item, descricao, unidade_medida, valor_unitario, natureza_despesa, ordem)
        values (inst.id_instrumento, nullif(trim(x->>'grupo'), ''), trim(x->>'numero_item'), trim(x->>'descricao'),
                trim(x->>'unidade_medida'), (x->>'valor_unitario')::numeric, nullif(trim(x->>'natureza_despesa'), ''), v_ordem)
        returning id_item into v_item;
        if p_id is not null and exists (select 1 from public.requisicoes where id_instrumento = inst.id_instrumento and situacao <> 'cancelada') then
          insert into public.instrumento_alteracoes (id_instrumento, id_item, tipo, valor_depois, observacao, criado_por)
            values (inst.id_instrumento, v_item, 'inclusao_item', (x->>'valor_unitario')::numeric, 'Item incluido no cadastro', auth.uid());
        end if;
      end if;
      v_ids_item := v_ids_item || v_item;
      -- quantidades por polo
      for y in select pp.id_participacao, pp.id_polo, u.sigla from public.instrumento_participantes pp
                 join public.unidades u on u.id_unidade = pp.id_polo where pp.id_instrumento = inst.id_instrumento loop
        v_qtd := coalesce(nullif(x->'quantidades'->>(y.id_polo::text), '')::numeric, 0);
        if v_qtd < 0 then raise exception 'Item %: quantidade negativa.', x->>'numero_item'; end if;
        v_q_ant := public.item_registrado(y.id_participacao, v_item);
        if v_usado and abs(v_q_ant - v_qtd) > 0.0001 then
          raise exception 'Item % (%): ja ha requisicoes; mude a quantidade por "Registrar alteracao" (acrescimo ou supressao).', x->>'numero_item', y.sigla;
        end if;
        insert into public.instrumento_quantidades (id_participacao, id_item, quantidade) values (y.id_participacao, v_item, v_qtd)
          on conflict (id_participacao, id_item) do update set quantidade = excluded.quantidade;
      end loop;
    end loop;
    for y in select id_item, numero_item from public.instrumento_itens where id_instrumento = inst.id_instrumento and not (id_item = any(v_ids_item)) loop
      if exists (select 1 from public.requisicao_itens where id_item = y.id_item) then
        raise exception 'O item % ja foi requisitado e nao pode ser excluido.', y.numero_item;
      end if;
      delete from public.instrumento_itens where id_item = y.id_item;
    end loop;
    perform public.recalcular_valor_instrumento(inst.id_instrumento);

    -- Gerado a partir de um DFD: DFD concluído; as requisições que aguardavam
    -- voltam para a seção escolher os itens (ou mudar a forma, se o polo não participa).
    if p_id is null and inst.id_processo_origem is not null then
      select * into v_dfd from public.instrumentos where id_instrumento = inst.id_processo_origem;
      if v_dfd.tipo <> 'dfd' then raise exception 'O instrumento de origem precisa ser um DFD.'; end if;
      update public.instrumentos set situacao = 'concluido' where id_instrumento = v_dfd.id_instrumento and situacao <> 'cancelado';
      for r in select rq.id_requisicao, rq.id_unidade from public.requisicoes rq
                where rq.id_instrumento = v_dfd.id_instrumento and rq.situacao = 'aguardando_contratacao' loop
        if exists (select 1 from public.instrumento_participantes where id_instrumento = inst.id_instrumento
                    and id_polo = public.polo_unidade(r.id_unidade)) then
          update public.requisicoes set id_instrumento = inst.id_instrumento, forma = inst.tipo, situacao = 'pendente',
                 motivo = 'O DFD ' || v_dfd.numero || ' gerou o(a) ' || inst.tipo || ' ' || inst.numero
                          || '. Escolha os itens e as quantidades e reenvie.'
           where id_requisicao = r.id_requisicao;
        else
          update public.requisicoes set situacao = 'pendente',
                 motivo = 'O DFD ' || v_dfd.numero || ' gerou o(a) ' || inst.tipo || ' ' || inst.numero
                          || ', mas o polo desta secao nao participa. Escolha outra forma de atendimento ou cancele.'
           where id_requisicao = r.id_requisicao;
        end if;
        insert into public.requisicao_historico (id_requisicao, acao, situacao, motivo, id_usuario)
          values (r.id_requisicao, 'contratacao_concluida', 'pendente', 'DFD ' || v_dfd.numero || ' → ' || inst.tipo || ' ' || inst.numero, auth.uid());
      end loop;
    end if;
  else
    -- DFD cancelado: requisições que aguardavam voltam à seção.
    if inst.situacao = 'cancelado' and coalesce(v_sit_ant, '') <> 'cancelado' then
      for r in select id_requisicao from public.requisicoes where id_instrumento = inst.id_instrumento and situacao = 'aguardando_contratacao' loop
        update public.requisicoes set situacao = 'pendente',
               motivo = 'O DFD ' || inst.numero || ' foi cancelado. Escolha outra forma de atendimento ou cancele.'
         where id_requisicao = r.id_requisicao;
        insert into public.requisicao_historico (id_requisicao, acao, situacao, motivo, id_usuario)
          values (r.id_requisicao, 'contratacao_fracassada', 'pendente', 'DFD ' || inst.numero || ' cancelado', auth.uid());
      end loop;
    end if;
  end if;
  return json_build_object('id_instrumento', inst.id_instrumento, 'numero', inst.numero);
exception when unique_violation then
  raise exception 'Ja existe % com este numero neste polo (ou item repetido no mesmo grupo).', v_tipo;
end $$;

-- Aditivo/apostilamento: acréscimo, supressão (quantidade de um polo) ou reajuste (preço).
-- p_itens: [{id_item, id_polo?, quantidade?, valor_unitario?}]
create or replace function public.inst_alterar(p_instrumento uuid, p_tipo text, p_itens json, p_documento text,
                                               p_data date, p_observacao text) returns void
language plpgsql security definer set search_path to 'public' as $$
declare x json; it public.instrumento_itens; v_part uuid; v_ant numeric; v_novo numeric; v_apr numeric; v_sigla text;
begin
  if not public.pode_cadastrar_instrumento() then raise exception 'Somente a Licitacoes registra alteracoes.'; end if;
  if p_tipo not in ('acrescimo','supressao','reajuste','correcao') then raise exception 'Tipo de alteracao invalido.'; end if;
  if length(trim(coalesce(p_documento, ''))) < 3 then raise exception 'Informe o documento (termo aditivo, apostilamento etc.).'; end if;
  if p_itens is null or json_array_length(p_itens) = 0 then raise exception 'Informe ao menos um item.'; end if;
  for x in select * from json_array_elements(p_itens) loop
    select * into it from public.instrumento_itens where id_item = (x->>'id_item')::uuid and id_instrumento = p_instrumento for update;
    if it.id_item is null then raise exception 'Item nao encontrado neste instrumento.'; end if;
    if p_tipo = 'reajuste' or (p_tipo = 'correcao' and x->>'valor_unitario' is not null) then
      v_novo := (x->>'valor_unitario')::numeric;
      if v_novo is null or v_novo <= 0 then raise exception 'Item %: informe o novo valor unitario.', it.numero_item; end if;
      insert into public.instrumento_alteracoes (id_instrumento, id_item, tipo, valor_antes, valor_depois, documento, data, observacao, criado_por)
        values (p_instrumento, it.id_item, p_tipo, it.valor_unitario, v_novo, trim(p_documento), p_data, nullif(trim(p_observacao), ''), auth.uid());
      update public.instrumento_itens set valor_unitario = v_novo where id_item = it.id_item;
    end if;
    if p_tipo in ('acrescimo','supressao') or (p_tipo = 'correcao' and x->>'quantidade' is not null) then
      select pp.id_participacao, u.sigla into v_part, v_sigla from public.instrumento_participantes pp
        join public.unidades u on u.id_unidade = pp.id_polo
       where pp.id_instrumento = p_instrumento and pp.id_polo = (x->>'id_polo')::uuid;
      if v_part is null then raise exception 'Polo nao participa deste instrumento.'; end if;
      v_novo := (x->>'quantidade')::numeric;
      if v_novo is null or v_novo < 0 then raise exception 'Item %: informe a nova quantidade.', it.numero_item; end if;
      v_ant := public.item_registrado(v_part, it.id_item);
      if p_tipo = 'acrescimo' and v_novo <= v_ant then raise exception 'Item % (%): acrescimo precisa aumentar a quantidade.', it.numero_item, v_sigla; end if;
      if p_tipo = 'supressao' and v_novo >= v_ant then raise exception 'Item % (%): supressao precisa reduzir a quantidade.', it.numero_item, v_sigla; end if;
      v_apr := public.item_aprovado(v_part, it.id_item);
      if v_novo < v_apr then
        raise exception 'Item % (%): ja foram aprovadas % unidades; a quantidade nao pode ficar abaixo disso.', it.numero_item, v_sigla, v_apr;
      end if;
      insert into public.instrumento_alteracoes (id_instrumento, id_item, id_participacao, tipo, quantidade_antes, quantidade_depois,
                                                 documento, data, observacao, criado_por)
        values (p_instrumento, it.id_item, v_part, p_tipo, v_ant, v_novo, trim(p_documento), p_data, nullif(trim(p_observacao), ''), auth.uid());
      insert into public.instrumento_quantidades (id_participacao, id_item, quantidade) values (v_part, it.id_item, v_novo)
        on conflict (id_participacao, id_item) do update set quantidade = excluded.quantidade;
    end if;
  end loop;
  perform public.recalcular_valor_instrumento(p_instrumento);
end $$;

create or replace function public.inst_excluir(p_id uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.pode_cadastrar_instrumento() then raise exception 'Somente a Licitacoes exclui instrumentos.'; end if;
  if exists (select 1 from public.requisicoes where id_instrumento = p_id) then
    raise exception 'Este instrumento ja tem requisicoes e nao pode ser excluido. Marque-o como encerrado (ou o DFD como cancelado).';
  end if;
  if exists (select 1 from public.instrumentos where id_processo_origem = p_id) then
    raise exception 'Ha contrato ou ata gerado a partir deste DFD.';
  end if;
  delete from public.instrumentos where id_instrumento = p_id;
end $$;

-- Licitações vincula ao DFD uma requisição de nova contratação que ainda não tem DFD.
create or replace function public.dfd_vincular(p_requisicao uuid, p_dfd uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
declare r public.requisicoes; d public.instrumentos;
begin
  if not public.pode_cadastrar_instrumento() then raise exception 'Somente a Licitacoes vincula requisicoes a DFDs.'; end if;
  select * into r from public.requisicoes where id_requisicao = p_requisicao for update;
  if r.forma <> 'nova_contratacao' or r.situacao <> 'aguardando_contratacao' then
    raise exception 'So requisicoes de nova contratacao aguardando processo podem ser vinculadas.';
  end if;
  select * into d from public.instrumentos where id_instrumento = p_dfd;
  if d.tipo <> 'dfd' then raise exception 'Escolha um DFD.'; end if;
  update public.requisicoes set id_instrumento = p_dfd where id_requisicao = p_requisicao;
  insert into public.requisicao_historico (id_requisicao, acao, situacao, motivo, id_usuario)
    values (p_requisicao, 'vinculada_dfd', r.situacao, 'DFD ' || d.numero, auth.uid());
end $$;

-- ═══ 9. Operações: requisição por itens ══════════════════════════════════════
-- p_itens: [{id_item, quantidade}] (contrato/ata). Valor = Σ quantidade × valor unitário vigente.
drop function if exists public.req_salvar(uuid, uuid, numeric, numeric, text, uuid, boolean, text);
create or replace function public.req_salvar(
  p_id uuid, p_demanda uuid, p_quantidade numeric, p_valor numeric, p_forma text,
  p_instrumento uuid, p_declaracao boolean, p_observacao text, p_itens json default null) returns json
language plpgsql security definer set search_path to 'public' as $$
declare r public.requisicoes; v_unidade uuid; v_sit text; v_valor numeric; v_qtd numeric; x json; it public.instrumento_itens;
        v_part uuid; v_saldo numeric; v_n int := 0;
begin
  v_sit := case when p_forma = 'nova_contratacao' then 'aguardando_contratacao' else 'aguardando_gestor' end;
  if p_id is null then
    select id_unidade_fk into v_unidade from public.demandas where id_demanda = p_demanda;
  else
    select * into r from public.requisicoes where id_requisicao = p_id for update;
    v_unidade := r.id_unidade;
  end if;
  if not public.pode_requisitar(v_unidade) then raise exception 'Voce nao pode requisitar demandas desta unidade.'; end if;

  if p_forma in ('contrato','ata') then
    if p_instrumento is null then raise exception 'Escolha o contrato ou a ata.'; end if;
    if p_itens is null or json_array_length(p_itens) = 0 then raise exception 'Escolha ao menos um item e a quantidade.'; end if;
    select id_participacao into v_part from public.instrumento_participantes
     where id_instrumento = p_instrumento and id_polo = public.polo_unidade(v_unidade);
    if v_part is null then raise exception 'Este instrumento nao tem participacao do polo desta secao.'; end if;
    v_valor := 0;
    for x in select * from json_array_elements(p_itens) loop
      if coalesce((x->>'quantidade')::numeric, 0) <= 0 then continue; end if;
      select * into it from public.instrumento_itens where id_item = (x->>'id_item')::uuid and id_instrumento = p_instrumento;
      if it.id_item is null then raise exception 'Item nao pertence ao instrumento escolhido.'; end if;
      v_saldo := public.item_registrado(v_part, it.id_item) - public.item_aprovado(v_part, it.id_item, p_id);
      if (x->>'quantidade')::numeric > v_saldo + 0.0001 then
        raise exception 'Item %: o saldo do polo e de % %.', it.numero_item, trim(to_char(greatest(v_saldo, 0), 'FM999G999G990D###')), it.unidade_medida;
      end if;
      v_valor := v_valor + (x->>'quantidade')::numeric * it.valor_unitario;
      v_n := v_n + 1;
    end loop;
    if v_n = 0 then raise exception 'Escolha ao menos um item e a quantidade.'; end if;
    v_valor := round(v_valor, 2);
    v_qtd := null;
  else
    v_valor := p_valor; v_qtd := p_quantidade;
    if v_valor is null or v_valor <= 0 then raise exception 'Informe o valor.'; end if;
  end if;

  if p_id is null then
    insert into public.requisicoes (id_demanda, id_unidade, quantidade, valor, forma, id_instrumento,
                                    declaracao_sem_instrumento, observacao, id_unidade_gestora, situacao, criado_por)
    values (p_demanda, v_unidade, v_qtd, v_valor, p_forma, p_instrumento, coalesce(p_declaracao, false),
            nullif(trim(p_observacao), ''), v_unidade, v_sit, auth.uid())
    returning * into r;
    insert into public.requisicao_historico (id_requisicao, acao, situacao, valor, id_usuario)
      values (r.id_requisicao, 'enviada', r.situacao, r.valor, auth.uid());
  else
    if r.situacao not in ('pendente','aguardando_gestor','aguardando_contratacao') then
      raise exception 'Esta requisicao ja foi aprovada e nao pode ser alterada.';
    end if;
    update public.requisicoes set quantidade = v_qtd, valor = v_valor, forma = p_forma,
           id_instrumento = p_instrumento, declaracao_sem_instrumento = coalesce(p_declaracao, false),
           observacao = nullif(trim(p_observacao), ''), situacao = v_sit, motivo = null, valor_real = null
     where id_requisicao = p_id returning * into r;
    insert into public.requisicao_historico (id_requisicao, acao, situacao, valor, id_usuario)
      values (r.id_requisicao, 'reenviada', r.situacao, r.valor, auth.uid());
  end if;

  delete from public.requisicao_itens where id_requisicao = r.id_requisicao;
  if p_forma in ('contrato','ata') then
    insert into public.requisicao_itens (id_requisicao, id_item, quantidade, valor_unitario)
    select r.id_requisicao, it2.id_item, (z->>'quantidade')::numeric, it2.valor_unitario
      from json_array_elements(p_itens) z join public.instrumento_itens it2 on it2.id_item = (z->>'id_item')::uuid
     where coalesce((z->>'quantidade')::numeric, 0) > 0;
  end if;
  return json_build_object('id_requisicao', r.id_requisicao, 'codigo', r.codigo, 'situacao', r.situacao);
end $$;

-- Gestor: aprovar (por item, ou valor real nas formas sem instrumento), devolver ou desfazer.
-- p_itens: [{id_item, quantidade_aprovada}]
drop function if exists public.req_analisar(uuid, text, numeric, text);
create or replace function public.req_analisar(p_id uuid, p_acao text, p_valor_real numeric, p_motivo text,
                                               p_itens json default null) returns json
language plpgsql security definer set search_path to 'public' as $$
declare r public.requisicoes; v_real numeric := 0; ri record; v_qa numeric; v_saldo numeric; v_tem_itens boolean;
begin
  select * into r from public.requisicoes where id_requisicao = p_id for update;
  if r.id_requisicao is null then raise exception 'Requisicao nao encontrada.'; end if;
  if not public.pode_gerir_pedidos(r.id_unidade_gestora) then
    raise exception 'Somente a secao gestora pode analisar esta requisicao.';
  end if;
  v_tem_itens := exists (select 1 from public.requisicao_itens where id_requisicao = p_id);
  if p_acao = 'aprovar' then
    if r.situacao <> 'aguardando_gestor' then raise exception 'A requisicao nao esta aguardando analise.'; end if;
    if v_tem_itens then
      if p_itens is null then raise exception 'Informe a quantidade aprovada de cada item.'; end if;
      for ri in select x.id_req_item, x.id_item, x.quantidade, x.valor_unitario, it.numero_item, it.unidade_medida
                  from public.requisicao_itens x join public.instrumento_itens it on it.id_item = x.id_item
                 where x.id_requisicao = p_id loop
        select (z->>'quantidade_aprovada')::numeric into v_qa from json_array_elements(p_itens) z
         where (z->>'id_item')::uuid = ri.id_item;
        v_qa := coalesce(v_qa, 0);
        if v_qa < 0 then raise exception 'Item %: quantidade invalida.', ri.numero_item; end if;
        if v_qa > ri.quantidade + 0.0001 then
          raise exception 'Item %: a quantidade aprovada passa da pedida (%).', ri.numero_item, ri.quantidade;
        end if;
        v_saldo := public.item_registrado(r.id_participacao, ri.id_item) - public.item_aprovado(r.id_participacao, ri.id_item, p_id);
        if v_qa > v_saldo + 0.0001 then
          raise exception 'Item %: o saldo do polo e de % %.', ri.numero_item, trim(to_char(greatest(v_saldo, 0), 'FM999G999G990D###')), ri.unidade_medida;
        end if;
        update public.requisicao_itens set quantidade_aprovada = v_qa where id_req_item = ri.id_req_item;
        v_real := v_real + v_qa * ri.valor_unitario;
      end loop;
      v_real := round(v_real, 2);
      if v_real <= 0 then raise exception 'Nenhuma quantidade aprovada. Para recusar, devolva a requisicao com o motivo.'; end if;
    else
      v_real := p_valor_real;
    end if;
    update public.requisicoes set valor_real = v_real, situacao = 'aprovada', motivo = null,
           data_aprovacao = now(), aprovado_por = auth.uid()
     where id_requisicao = p_id returning * into r;
  elsif p_acao = 'devolver' then
    if r.situacao not in ('aguardando_gestor','aprovada') then raise exception 'Esta requisicao nao pode ser devolvida agora.'; end if;
    update public.requisicao_itens set quantidade_aprovada = null where id_requisicao = p_id;
    update public.requisicoes set situacao = 'pendente', motivo = p_motivo,
           valor_real = case when v_tem_itens then null else coalesce(p_valor_real, valor_real) end,
           data_aprovacao = null, aprovado_por = null
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

-- ═══ 10. Permissões das funções ══════════════════════════════════════════════
revoke execute on function public.polo_unidade(uuid), public.meus_polos(), public.item_aprovado(uuid, uuid, uuid),
  public.item_em_analise(uuid, uuid), public.item_registrado(uuid, uuid), public.recalcular_valor_instrumento(uuid),
  public.instrumento_visivel(uuid), public.inst_salvar(uuid, json, json, json),
  public.inst_alterar(uuid, text, json, text, date, text), public.inst_excluir(uuid), public.dfd_vincular(uuid, uuid),
  public.req_salvar(uuid, uuid, numeric, numeric, text, uuid, boolean, text, json),
  public.req_analisar(uuid, text, numeric, text, json) from public, anon;
grant execute on function public.polo_unidade(uuid), public.meus_polos(), public.item_aprovado(uuid, uuid, uuid),
  public.item_em_analise(uuid, uuid), public.item_registrado(uuid, uuid), public.instrumento_visivel(uuid),
  public.inst_salvar(uuid, json, json, json), public.inst_alterar(uuid, text, json, text, date, text),
  public.inst_excluir(uuid), public.dfd_vincular(uuid, uuid),
  public.req_salvar(uuid, uuid, numeric, numeric, text, uuid, boolean, text, json),
  public.req_analisar(uuid, text, numeric, text, json) to authenticated, service_role;

select 'etapa 5 (itens, polos, DFD) aplicada' as resultado;

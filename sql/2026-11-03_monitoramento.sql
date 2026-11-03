-- Módulo de Monitoramento da Execução — 03/11/2026
-- Decisões do gestor (proposta de 03/11/2026):
--  • perfil Monitoramento: o da Reitoria vê tudo (com seletor por unidade); o do
--    campus vê só o seu campus — é o escopo da unidade do perfil;
--  • só o Monitoramento lança empenhos, vínculos e pedidos de execução;
--  • o Monitoramento cria o calendário de marcos; amarelo a 15 dias do prazo;
--  • sem e-mail e sem execução no painel público, por ora.
--
-- PASSO 1 (rodar sozinho, antes do resto):
--   alter type public.papel_usuario add value if not exists 'monitoramento';

-- ═══ Funções de apoio ════════════════════════════════════════════════════════
-- Quem enxerga uma unidade: o administrador global e quem tem a unidade no escopo.
create or replace function public.pode_ver_unidade(p_unidade uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.sou_admin_global() or p_unidade in (select public.escopo_unidades())
$$;
-- Quem opera o monitoramento de uma unidade.
create or replace function public.pode_monitorar(p_unidade uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.sou_admin_global()
      or (public.meu_papel() = 'monitoramento' and p_unidade in (select public.escopo_unidades()))
$$;
create or replace function public.unidade_da_demanda(p_demanda uuid) returns uuid
language sql stable security definer set search_path to 'public' as $$
  select id_unidade_fk from public.demandas where id_demanda = p_demanda
$$;
grant execute on function public.pode_ver_unidade(uuid), public.pode_monitorar(uuid),
  public.unidade_da_demanda(uuid) to authenticated;

-- ═══ Empenhos ════════════════════════════════════════════════════════════════
create table if not exists public.empenhos (
  id_empenho            uuid primary key default gen_random_uuid(),
  numero                text not null check (length(trim(numero)) > 0),
  exercicio             smallint not null check (exercicio between 2020 and 2100),
  id_unidade_gestora_fk uuid not null references public.unidades(id_unidade),
  ug_codigo             text,
  data_emissao          date not null,
  favorecido_cnpj       text,
  favorecido_nome       text,
  natureza_despesa      text,
  fonte_codigo          char(4) references public.fontes_recurso(codigo),
  processo_sei          text,
  tipo                  text not null default 'estimativo' check (tipo in ('ordinario','estimativo','global')),
  valor_empenhado       numeric(14,2) not null check (valor_empenhado > 0),
  observacao            text,
  criado_por            uuid references public.perfis(id_usuario) on delete set null,
  data_criacao          timestamptz not null default now()
);
create unique index if not exists empenhos_numero_ug_key on public.empenhos (upper(numero), coalesce(ug_codigo, ''));

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

create or replace function public.valor_atual_empenho(p_empenho uuid) returns numeric
language sql stable security definer set search_path to 'public' as $$
  select e.valor_empenhado
       + coalesce((select sum(case when m.tipo = 'reforco' then m.valor else -m.valor end)
                   from public.empenho_movimentos m where m.id_empenho = e.id_empenho), 0)
  from public.empenhos e where e.id_empenho = p_empenho
$$;

-- Reserva de parte do empenho para uma demanda homologada.
create table if not exists public.empenho_demandas (
  id_vinculo      uuid primary key default gen_random_uuid(),
  id_empenho      uuid not null references public.empenhos(id_empenho) on delete restrict,
  id_demanda      uuid not null references public.demandas(id_demanda) on delete restrict,
  valor_reservado numeric(14,2) not null check (valor_reservado > 0),
  observacao      text,
  criado_por      uuid references public.perfis(id_usuario) on delete set null,
  data_criacao    timestamptz not null default now(),
  unique (id_empenho, id_demanda)
);

-- Pedido de execução (ordem de fornecimento/serviço, requisição) contra a reserva.
create table if not exists public.execucoes (
  id_execucao      uuid primary key default gen_random_uuid(),
  id_vinculo       uuid not null references public.empenho_demandas(id_vinculo) on delete restrict,
  data_pedido      date not null,
  valor            numeric(14,2) not null check (valor > 0),
  tipo_documento   text not null default 'ordem_fornecimento'
                   check (tipo_documento in ('ordem_fornecimento','ordem_servico','requisicao','outro')),
  numero_documento text,
  descricao        text,
  nota_fiscal      text,
  data_liquidacao  date,
  valor_liquidado  numeric(14,2) not null default 0 check (valor_liquidado >= 0),
  data_pagamento   date,
  valor_pago       numeric(14,2) not null default 0 check (valor_pago >= 0),
  criado_por       uuid references public.perfis(id_usuario) on delete set null,
  data_criacao     timestamptz not null default now(),
  check (valor_liquidado <= valor),
  check (valor_pago <= valor_liquidado)
);

-- Dados de execução de cada demanda (processo, encerramento).
create table if not exists public.execucao_demandas (
  id_demanda                 uuid primary key references public.demandas(id_demanda) on delete cascade,
  processo_sei               text,
  data_abertura_processo     date,
  data_envio_processo        date,
  encerramento               text check (encerramento in ('concluida','nao_executada')),
  justificativa_encerramento text,
  data_encerramento          date,
  atualizado_por             uuid references public.perfis(id_usuario) on delete set null,
  data_atualizacao           timestamptz not null default now(),
  check (encerramento is null or data_encerramento is not null),
  check (encerramento is distinct from 'nao_executada' or length(trim(coalesce(justificativa_encerramento,''))) >= 5)
);

-- ═══ Marcos e cobranças ═══════════════════════════════════════════════════════
-- Tipos: abertura_processo, envio_processo, empenho, primeiro_pedido, conclusao.
create table if not exists public.marcos_calendario (
  id_marco          uuid primary key default gen_random_uuid(),
  exercicio         smallint not null,
  tipo              text not null check (tipo in ('abertura_processo','envio_processo','empenho','primeiro_pedido','conclusao')),
  id_unidade_escopo uuid references public.unidades(id_unidade),   -- nulo = toda a instituição
  data_limite       date not null,
  descricao         text,
  criado_por        uuid references public.perfis(id_usuario) on delete set null,
  data_criacao      timestamptz not null default now()
);
create unique index if not exists marcos_calendario_key
  on public.marcos_calendario (exercicio, tipo, coalesce(id_unidade_escopo, '00000000-0000-0000-0000-000000000000'::uuid));

create table if not exists public.marcos_demanda (
  id_demanda  uuid not null references public.demandas(id_demanda) on delete cascade,
  tipo        text not null check (tipo in ('abertura_processo','envio_processo','empenho','primeiro_pedido','conclusao')),
  data_limite date not null,
  motivo      text,
  criado_por  uuid references public.perfis(id_usuario) on delete set null,
  primary key (id_demanda, tipo)
);

create table if not exists public.cobrancas (
  id_cobranca   uuid primary key default gen_random_uuid(),
  id_demanda    uuid not null references public.demandas(id_demanda) on delete cascade,
  tipo_marco    text check (tipo_marco in ('abertura_processo','envio_processo','empenho','primeiro_pedido','conclusao')),
  data_cobranca timestamptz not null default now(),
  canal         text not null default 'sei' check (canal in ('email','telefone','sei','presencial','outro')),
  registro      text not null check (length(trim(registro)) >= 5),
  resposta      text,
  data_resposta date,
  criado_por    uuid references public.perfis(id_usuario) on delete set null
);

-- ═══ Regras de saldo ══════════════════════════════════════════════════════════
create or replace function public.validar_vinculo_empenho() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_status text; v_atual numeric; v_reservado numeric; v_pedido numeric; v_num text;
begin
  select status::text into v_status from public.demandas where id_demanda = new.id_demanda;
  if v_status is distinct from 'homologada' then
    raise exception 'So demandas homologadas podem receber empenho.';
  end if;
  v_atual := public.valor_atual_empenho(new.id_empenho);
  select coalesce(sum(valor_reservado), 0) into v_reservado from public.empenho_demandas
   where id_empenho = new.id_empenho and id_vinculo <> new.id_vinculo;
  if v_reservado + new.valor_reservado > v_atual then
    select numero into v_num from public.empenhos where id_empenho = new.id_empenho;
    raise exception 'O empenho % tem R$ % disponiveis para reservar.', v_num, public.fmt_brl(v_atual - v_reservado);
  end if;
  if tg_op = 'UPDATE' then
    select coalesce(sum(valor), 0) into v_pedido from public.execucoes where id_vinculo = new.id_vinculo;
    if new.valor_reservado < v_pedido then
      raise exception 'A reserva nao pode ficar abaixo do que ja foi pedido (R$ %).', public.fmt_brl(v_pedido);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_validar_vinculo on public.empenho_demandas;
create trigger trg_validar_vinculo before insert or update on public.empenho_demandas
  for each row execute function public.validar_vinculo_empenho();

create or replace function public.validar_execucao() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_reservado numeric; v_pedido numeric;
begin
  select valor_reservado into v_reservado from public.empenho_demandas where id_vinculo = new.id_vinculo;
  select coalesce(sum(valor), 0) into v_pedido from public.execucoes
   where id_vinculo = new.id_vinculo and id_execucao <> new.id_execucao;
  if v_pedido + new.valor > v_reservado then
    raise exception 'Saldo da reserva insuficiente: disponivel R$ %, pedido R$ %.',
      public.fmt_brl(v_reservado - v_pedido), public.fmt_brl(new.valor);
  end if;
  return new;
end $$;
drop trigger if exists trg_validar_execucao on public.execucoes;
create trigger trg_validar_execucao before insert or update on public.execucoes
  for each row execute function public.validar_execucao();

-- Anulação ou redução do valor não pode deixar o empenho abaixo do que já foi reservado.
create or replace function public.validar_valor_empenho() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_emp uuid := coalesce(new.id_empenho, old.id_empenho); v_atual numeric; v_reservado numeric;
begin
  v_atual := public.valor_atual_empenho(v_emp);
  select coalesce(sum(valor_reservado), 0) into v_reservado from public.empenho_demandas where id_empenho = v_emp;
  if v_atual < v_reservado then
    raise exception 'O empenho ficaria com R$ %, abaixo do ja reservado para demandas (R$ %).',
      public.fmt_brl(v_atual), public.fmt_brl(v_reservado);
  end if;
  return null;
end $$;
drop trigger if exists trg_valor_empenho on public.empenhos;
create constraint trigger trg_valor_empenho after update of valor_empenhado on public.empenhos
  for each row execute function public.validar_valor_empenho();
drop trigger if exists trg_valor_movimento on public.empenho_movimentos;
create constraint trigger trg_valor_movimento after insert or update or delete on public.empenho_movimentos
  for each row execute function public.validar_valor_empenho();

-- A unidade informa o processo; encerrar (concluir / não executada) é do Monitoramento.
create or replace function public.validar_execucao_demanda() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if ((tg_op = 'INSERT' and new.encerramento is not null)
      or (tg_op = 'UPDATE' and (new.encerramento, new.justificativa_encerramento, new.data_encerramento)
                               is distinct from (old.encerramento, old.justificativa_encerramento, old.data_encerramento)))
     and not public.pode_monitorar(public.unidade_da_demanda(new.id_demanda)) then
    raise exception 'Somente o Monitoramento pode encerrar a execucao de uma demanda.';
  end if;
  new.atualizado_por := auth.uid();
  new.data_atualizacao := now();
  return new;
end $$;
drop trigger if exists trg_execucao_demanda on public.execucao_demandas;
create trigger trg_execucao_demanda before insert or update on public.execucao_demandas
  for each row execute function public.validar_execucao_demanda();

-- ═══ Permissões (RLS) ═════════════════════════════════════════════════════════
create or replace function public.empenho_visivel(p_empenho uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.empenhos e where e.id_empenho = p_empenho
                   and public.pode_ver_unidade(e.id_unidade_gestora_fk))
      or exists (select 1 from public.empenho_demandas v join public.demandas d on d.id_demanda = v.id_demanda
                  where v.id_empenho = p_empenho and public.pode_ver_unidade(d.id_unidade_fk))
$$;
create or replace function public.gestora_do_empenho(p_empenho uuid) returns uuid
language sql stable security definer set search_path to 'public' as $$
  select id_unidade_gestora_fk from public.empenhos where id_empenho = p_empenho
$$;
create or replace function public.demanda_do_vinculo(p_vinculo uuid) returns uuid
language sql stable security definer set search_path to 'public' as $$
  select id_demanda from public.empenho_demandas where id_vinculo = p_vinculo
$$;
grant execute on function public.empenho_visivel(uuid), public.gestora_do_empenho(uuid),
  public.demanda_do_vinculo(uuid), public.valor_atual_empenho(uuid) to authenticated;

alter table public.empenhos           enable row level security;
alter table public.empenho_movimentos enable row level security;
alter table public.empenho_demandas   enable row level security;
alter table public.execucoes          enable row level security;
alter table public.execucao_demandas  enable row level security;
alter table public.marcos_calendario  enable row level security;
alter table public.marcos_demanda     enable row level security;
alter table public.cobrancas          enable row level security;
grant select, insert, update, delete on public.empenhos, public.empenho_movimentos, public.empenho_demandas,
  public.execucoes, public.execucao_demandas, public.marcos_calendario, public.marcos_demanda, public.cobrancas
  to authenticated;

drop policy if exists emp_select on public.empenhos;
create policy emp_select on public.empenhos for select to authenticated using (public.empenho_visivel(id_empenho));
drop policy if exists emp_write on public.empenhos;
create policy emp_write on public.empenhos for all to authenticated
  using (public.pode_monitorar(id_unidade_gestora_fk)) with check (public.pode_monitorar(id_unidade_gestora_fk));

drop policy if exists mov_select on public.empenho_movimentos;
create policy mov_select on public.empenho_movimentos for select to authenticated using (public.empenho_visivel(id_empenho));
drop policy if exists mov_write on public.empenho_movimentos;
create policy mov_write on public.empenho_movimentos for all to authenticated
  using (public.pode_monitorar(public.gestora_do_empenho(id_empenho)))
  with check (public.pode_monitorar(public.gestora_do_empenho(id_empenho)));

drop policy if exists vinc_select on public.empenho_demandas;
create policy vinc_select on public.empenho_demandas for select to authenticated
  using (public.empenho_visivel(id_empenho) or public.pode_ver_unidade(public.unidade_da_demanda(id_demanda)));
drop policy if exists vinc_write on public.empenho_demandas;
create policy vinc_write on public.empenho_demandas for all to authenticated
  using (public.pode_monitorar(public.gestora_do_empenho(id_empenho)) and public.pode_monitorar(public.unidade_da_demanda(id_demanda)))
  with check (public.pode_monitorar(public.gestora_do_empenho(id_empenho)) and public.pode_monitorar(public.unidade_da_demanda(id_demanda)));

drop policy if exists exec_select on public.execucoes;
create policy exec_select on public.execucoes for select to authenticated
  using (public.pode_ver_unidade(public.unidade_da_demanda(public.demanda_do_vinculo(id_vinculo))));
drop policy if exists exec_write on public.execucoes;
create policy exec_write on public.execucoes for all to authenticated
  using (public.pode_monitorar(public.unidade_da_demanda(public.demanda_do_vinculo(id_vinculo))))
  with check (public.pode_monitorar(public.unidade_da_demanda(public.demanda_do_vinculo(id_vinculo))));

drop policy if exists exd_select on public.execucao_demandas;
create policy exd_select on public.execucao_demandas for select to authenticated
  using (public.pode_ver_unidade(public.unidade_da_demanda(id_demanda)));
drop policy if exists exd_write on public.execucao_demandas;
create policy exd_write on public.execucao_demandas for all to authenticated
  using (public.pode_ver_unidade(public.unidade_da_demanda(id_demanda))
         and public.meu_papel() in ('monitoramento','chefe_secao','chefia','licitacoes','ord_despesas'))
  with check (public.pode_ver_unidade(public.unidade_da_demanda(id_demanda))
         and public.meu_papel() in ('monitoramento','chefe_secao','chefia','licitacoes','ord_despesas'));

drop policy if exists cal_select on public.marcos_calendario;
create policy cal_select on public.marcos_calendario for select to authenticated using (true);
drop policy if exists cal_write on public.marcos_calendario;
create policy cal_write on public.marcos_calendario for all to authenticated
  using (public.sou_admin_global()
         or (public.meu_papel() = 'monitoramento' and (
               (id_unidade_escopo is not null and id_unidade_escopo in (select public.escopo_unidades()))
            or (id_unidade_escopo is null and public.pai_da_unidade(public.minha_unidade()) is null))))
  with check (public.sou_admin_global()
         or (public.meu_papel() = 'monitoramento' and (
               (id_unidade_escopo is not null and id_unidade_escopo in (select public.escopo_unidades()))
            or (id_unidade_escopo is null and public.pai_da_unidade(public.minha_unidade()) is null))));

drop policy if exists md_select on public.marcos_demanda;
create policy md_select on public.marcos_demanda for select to authenticated
  using (public.pode_ver_unidade(public.unidade_da_demanda(id_demanda)));
drop policy if exists md_write on public.marcos_demanda;
create policy md_write on public.marcos_demanda for all to authenticated
  using (public.pode_monitorar(public.unidade_da_demanda(id_demanda)))
  with check (public.pode_monitorar(public.unidade_da_demanda(id_demanda)));

drop policy if exists cob_select on public.cobrancas;
create policy cob_select on public.cobrancas for select to authenticated
  using (public.pode_ver_unidade(public.unidade_da_demanda(id_demanda)));
drop policy if exists cob_write on public.cobrancas;
create policy cob_write on public.cobrancas for all to authenticated
  using (public.pode_monitorar(public.unidade_da_demanda(id_demanda)))
  with check (public.pode_monitorar(public.unidade_da_demanda(id_demanda)));

-- ═══ Visões de execução (respeitam as permissões de quem consulta) ════════════
create or replace view public.v_execucao_demandas with (security_invoker = on) as
select d.id_demanda, d.codigo, d.exercicio, d.descricao_objeto, d.valor_estimado, d.gut_pontuacao,
       d.id_unidade_fk, u.sigla as sigla_unidade, u.nome as nome_unidade,
       c.nome as categoria, c.grupo as categoria_grupo, c.natureza_despesa,
       coalesce(r.reservado, 0) as reservado, coalesce(r.n_empenhos, 0) as n_empenhos, r.primeira_reserva,
       coalesce(x.pedido, 0) as pedido, coalesce(x.liquidado, 0) as liquidado, coalesce(x.pago, 0) as pago,
       x.primeiro_pedido, x.ultimo_pedido,
       e.processo_sei, e.data_abertura_processo, e.data_envio_processo,
       e.encerramento, e.justificativa_encerramento, e.data_encerramento
from public.demandas d
join public.unidades u on u.id_unidade = d.id_unidade_fk
left join public.categorias_despesa c on c.id_categoria = d.id_categoria_fk
left join public.execucao_demandas e on e.id_demanda = d.id_demanda
left join lateral (select sum(v.valor_reservado) as reservado, count(*) as n_empenhos,
                          min(em.data_emissao) as primeira_reserva
                     from public.empenho_demandas v join public.empenhos em on em.id_empenho = v.id_empenho
                    where v.id_demanda = d.id_demanda) r on true
left join lateral (select sum(x.valor) as pedido, sum(x.valor_liquidado) as liquidado, sum(x.valor_pago) as pago,
                          min(x.data_pedido) as primeiro_pedido, max(x.data_pedido) as ultimo_pedido
                     from public.execucoes x join public.empenho_demandas v on v.id_vinculo = x.id_vinculo
                    where v.id_demanda = d.id_demanda) x on true
where d.status = 'homologada';

create or replace view public.v_empenhos_saldo with (security_invoker = on) as
select e.*, u.sigla as sigla_gestora,
       public.valor_atual_empenho(e.id_empenho) as valor_atual,
       coalesce(r.reservado, 0) as reservado, coalesce(r.n_demandas, 0) as n_demandas,
       coalesce(x.pedido, 0) as pedido, coalesce(x.liquidado, 0) as liquidado, coalesce(x.pago, 0) as pago,
       public.valor_atual_empenho(e.id_empenho) - coalesce(x.pedido, 0) as saldo_empenho,
       public.valor_atual_empenho(e.id_empenho) - coalesce(r.reservado, 0) as saldo_a_reservar
from public.empenhos e
join public.unidades u on u.id_unidade = e.id_unidade_gestora_fk
left join lateral (select sum(valor_reservado) as reservado, count(*) as n_demandas
                     from public.empenho_demandas v where v.id_empenho = e.id_empenho) r on true
left join lateral (select sum(x.valor) as pedido, sum(x.valor_liquidado) as liquidado, sum(x.valor_pago) as pago
                     from public.execucoes x join public.empenho_demandas v on v.id_vinculo = x.id_vinculo
                    where v.id_empenho = e.id_empenho) x on true;

grant select on public.v_execucao_demandas, public.v_empenhos_saldo to authenticated;

select 'monitoramento criado' as resultado;

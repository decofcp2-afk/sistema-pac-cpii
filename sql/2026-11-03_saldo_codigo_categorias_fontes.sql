-- Planejamento e Monitoramento Orçamentário — alterações de 03/11/2026
--  1. Envio de demanda exige saldo disponível na unidade.
--  3. Código único da demanda (DEM-AAAA-NNNN) e categoria de despesa.
--  4. Origem do crédito e fonte de recursos na dotação.

-- ═══ 1. Saldo livre para novas demandas ═════════════════════════════════════
-- Saldo livre = recebido − repassado às subordinadas − demandas já enviadas
-- da própria unidade (submetida, de acordo, priorizada, homologada).
-- Demandas reprovadas, rascunhos e excluídas não comprometem saldo.
create or replace function public.saldo_livre_unidade(p_unidade uuid, p_exercicio smallint, p_excluir uuid default null)
returns numeric language sql stable security definer set search_path to 'public' as $$
  select public.saldo_unidade(p_unidade, p_exercicio)
       - coalesce((select sum(d.valor_estimado) from public.demandas d
                   where d.id_unidade_fk = p_unidade and d.exercicio = p_exercicio
                     and d.status in ('submetida','aprovada','priorizada','homologada')
                     and (p_excluir is null or d.id_demanda <> p_excluir)), 0)
$$;
grant execute on function public.saldo_livre_unidade(uuid, smallint, uuid) to authenticated;

-- Confere o saldo no envio (vale para todos os perfis, inclusive o administrador).
create or replace function public.validar_saldo_envio()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  v_recebido numeric; v_livre numeric; v_sigla text;
begin
  if new.status = 'submetida' and old.status is distinct from 'submetida'
     and old.status in ('rascunho','reprovada') then
    select sigla into v_sigla from public.unidades where id_unidade = new.id_unidade_fk;
    v_recebido := public.valor_alocado(new.id_unidade_fk, new.exercicio);
    if coalesce(v_recebido, 0) <= 0 then
      raise exception 'A unidade % nao recebeu orcamento para o exercicio %. Solicite a dotacao a sua chefia antes de enviar demandas.',
        coalesce(v_sigla, ''), new.exercicio;
    end if;
    v_livre := public.saldo_livre_unidade(new.id_unidade_fk, new.exercicio, new.id_demanda);
    if new.valor_estimado > v_livre then
      raise exception 'Saldo insuficiente em % para o exercicio %: disponivel R$ %, demanda R$ %.',
        coalesce(v_sigla, ''), new.exercicio,
        to_char(greatest(v_livre, 0), 'FM999G999G990D00'), to_char(new.valor_estimado, 'FM999G999G990D00');
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_saldo_envio on public.demandas;
create trigger trg_saldo_envio before update of status on public.demandas
  for each row execute function public.validar_saldo_envio();

-- Repasses: um repasse não pode deixar abaixo das demandas já enviadas
--  • a unidade de destino, quando o repasse é reduzido ou removido;
--  • a unidade que repassa (pai do destino), quando o repasse é criado ou aumentado.
-- Só bloqueia quando a alteração piora a situação (dados antigos já negativos
-- não travam repasses que os melhoram).
create or replace function public.validar_comprometido_distribuicao()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  v_destino uuid := coalesce(new.id_unidade_destino_fk, old.id_unidade_destino_fk);
  v_pai uuid;
  v_delta numeric := coalesce(case when tg_op = 'DELETE' then 0 else new.valor end, 0)
                   - coalesce(case when tg_op = 'INSERT' then 0 else old.valor end, 0);
  v_ex smallint; v_livre numeric; v_sigla text;
begin
  select d.exercicio into v_ex from public.dotacoes d
   where d.id_dotacao = coalesce(new.id_dotacao_origem_fk, old.id_dotacao_origem_fk);
  if v_delta < 0 then
    v_livre := public.saldo_livre_unidade(v_destino, v_ex);
    if v_livre < 0 then
      select sigla into v_sigla from public.unidades where id_unidade = v_destino;
      raise exception 'A alteracao deixaria % com menos orcamento que as demandas ja enviadas (faltariam R$ %). Reprove ou reduza as demandas antes.',
        coalesce(v_sigla,''), to_char(-v_livre, 'FM999G999G990D00');
    end if;
  elsif v_delta > 0 then
    select id_unidade_pai into v_pai from public.unidades where id_unidade = v_destino;
    v_livre := public.saldo_livre_unidade(v_pai, v_ex);
    if v_livre < 0 then
      select sigla into v_sigla from public.unidades where id_unidade = v_pai;
      raise exception 'Saldo insuficiente em %: o repasse invadiria R$ % reservados para demandas ja enviadas pela propria unidade.',
        coalesce(v_sigla,''), to_char(-v_livre, 'FM999G999G990D00');
    end if;
  end if;
  return null;
end $$;
drop trigger if exists b_validar_comprometido on public.distribuicoes;
create constraint trigger b_validar_comprometido after insert or update or delete on public.distribuicoes
  for each row execute function public.validar_comprometido_distribuicao();

-- ═══ 3a. Código único da demanda ═════════════════════════════════════════════
alter table public.demandas add column if not exists codigo text;

create table if not exists public.contador_demandas (
  exercicio smallint primary key,
  ultimo    integer not null default 0
);
alter table public.contador_demandas enable row level security;  -- só os gatilhos (security definer) mexem

create or replace function public.gerar_codigo_demanda()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_n integer;
begin
  if tg_op = 'INSERT' then
    insert into public.contador_demandas as c (exercicio, ultimo) values (new.exercicio, 1)
      on conflict (exercicio) do update set ultimo = c.ultimo + 1
      returning ultimo into v_n;
    new.codigo := 'DEM-' || new.exercicio || '-' || lpad(v_n::text, 4, '0');
  else
    new.codigo := old.codigo;   -- o código nunca muda
  end if;
  return new;
end $$;
drop trigger if exists trg_codigo_demanda on public.demandas;
create trigger trg_codigo_demanda before insert or update on public.demandas
  for each row execute function public.gerar_codigo_demanda();

-- Códigos para as demandas já existentes, na ordem de criação.
alter table public.demandas disable trigger user;
with numeradas as (
  select id_demanda, exercicio,
         row_number() over (partition by exercicio order by data_criacao, id_demanda) as n
  from public.demandas where codigo is null
)
update public.demandas d
   set codigo = 'DEM-' || n.exercicio || '-' || lpad(n.n::text, 4, '0')
  from numeradas n where n.id_demanda = d.id_demanda;
alter table public.demandas enable trigger user;
insert into public.contador_demandas (exercicio, ultimo)
  select exercicio, count(*) from public.demandas group by exercicio
  on conflict (exercicio) do update set ultimo = greatest(public.contador_demandas.ultimo, excluded.ultimo);
alter table public.demandas alter column codigo set not null;
create unique index if not exists demandas_codigo_key on public.demandas (codigo);

-- ═══ 3b. Categoria de despesa ════════════════════════════════════════════════
-- A natureza de despesa é referência para o monitoramento (elemento/subitem do
-- ementário federal); novas categorias podem ser incluídas pelo Table Editor.
create table if not exists public.categorias_despesa (
  id_categoria     serial primary key,
  nome             text not null unique,
  grupo            text not null,
  natureza_despesa text,
  gnd              smallint check (gnd in (3, 4)),
  ordem            smallint not null default 100,
  ativo            boolean not null default true
);
alter table public.categorias_despesa enable row level security;
drop policy if exists categorias_leitura on public.categorias_despesa;
create policy categorias_leitura on public.categorias_despesa for select to anon, authenticated using (true);
grant select on public.categorias_despesa to anon, authenticated;

insert into public.categorias_despesa (nome, grupo, natureza_despesa, gnd, ordem) values
  ('Apoio administrativo, técnico e operacional (mão de obra terceirizada)', 'Serviços com mão de obra', '3.3.90.37.01', 3, 10),
  ('Limpeza e conservação',                         'Serviços com mão de obra', '3.3.90.37.02', 3, 11),
  ('Vigilância',                                    'Serviços com mão de obra', '3.3.90.37.03', 3, 12),
  ('Manutenção e conservação de imóveis',           'Serviços de terceiros',    '3.3.90.39.16', 3, 20),
  ('Manutenção de máquinas e equipamentos',         'Serviços de terceiros',    '3.3.90.39.17', 3, 21),
  ('Locação de imóveis',                            'Serviços de terceiros',    '3.3.90.39.10', 3, 22),
  ('Energia elétrica',                              'Serviços públicos',        '3.3.90.39.43', 3, 30),
  ('Água e esgoto',                                 'Serviços públicos',        '3.3.90.39.44', 3, 31),
  ('Telecomunicações',                              'Serviços públicos',        '3.3.90.39.58', 3, 32),
  ('Capacitação e treinamento',                     'Serviços de terceiros',    '3.3.90.39.48', 3, 40),
  ('Serviços de tecnologia da informação',          'Serviços de terceiros',    '3.3.90.40',    3, 41),
  ('Outros serviços de terceiros — pessoa jurídica','Serviços de terceiros',    '3.3.90.39',    3, 49),
  ('Serviços de terceiros — pessoa física',         'Serviços de terceiros',    '3.3.90.36',    3, 50),
  ('Material de expediente',                        'Material de consumo',      '3.3.90.30.16', 3, 60),
  ('Gêneros alimentícios',                          'Material de consumo',      '3.3.90.30.07', 3, 61),
  ('Material de limpeza e higienização',            'Material de consumo',      '3.3.90.30.22', 3, 62),
  ('Material de copa e cozinha',                    'Material de consumo',      '3.3.90.30.21', 3, 63),
  ('Material de processamento de dados',            'Material de consumo',      '3.3.90.30.17', 3, 64),
  ('Material para manutenção de imóveis',           'Material de consumo',      '3.3.90.30.24', 3, 65),
  ('Combustíveis e lubrificantes',                  'Material de consumo',      '3.3.90.30.01', 3, 66),
  ('Outros materiais de consumo',                   'Material de consumo',      '3.3.90.30',    3, 69),
  ('Diárias',                                       'Deslocamentos',            '3.3.90.14',    3, 70),
  ('Passagens e locomoção',                         'Deslocamentos',            '3.3.90.33',    3, 71),
  ('Equipamentos e material permanente',            'Investimentos',            '4.4.90.52',    4, 80),
  ('Obras e instalações',                           'Investimentos',            '4.4.90.51',    4, 81),
  ('Outros',                                        'Outros',                   null,           null, 99)
on conflict (nome) do nothing;

alter table public.demandas add column if not exists id_categoria_fk integer references public.categorias_despesa(id_categoria);

-- ═══ 4. Origem do crédito e fonte de recursos na dotação ═════════════════════
-- Fonte: código federal de 4 dígitos (1º dígito = grupo: 1 exercício corrente,
-- 3 exercícios anteriores, 7 operações de crédito/regra de ouro, 9 condicionados;
-- 3 dígitos seguintes = especificação). Outras fontes podem ser incluídas pelo
-- Table Editor.
create table if not exists public.fontes_recurso (
  codigo char(4) primary key check (codigo ~ '^[1379][0-9]{3}$'),
  nome   text not null,
  ativo  boolean not null default true
);
alter table public.fontes_recurso enable row level security;
drop policy if exists fontes_leitura on public.fontes_recurso;
create policy fontes_leitura on public.fontes_recurso for select to anon, authenticated using (true);
grant select on public.fontes_recurso to anon, authenticated;
insert into public.fontes_recurso (codigo, nome) values
  ('1000', 'Recursos Livres da União'),
  ('3000', 'Recursos Livres da União — exercícios anteriores'),
  ('1050', 'Recursos Próprios Livres da UO'),
  ('3050', 'Recursos Próprios Livres da UO — exercícios anteriores')
on conflict (codigo) do nothing;

alter table public.dotacoes add column if not exists origem text
  check (origem in ('loa','emenda','suplementar','especial','extraordinario','descentralizacao','outra'));
alter table public.dotacoes add column if not exists fonte_codigo char(4) references public.fontes_recurso(codigo);
update public.dotacoes set origem = 'loa' where origem is null;
alter table public.dotacoes alter column origem set default 'loa';
alter table public.dotacoes alter column origem set not null;

-- Uma unidade pode ter mais de uma dotação no exercício, uma por origem e fonte.
alter table public.dotacoes drop constraint if exists dotacoes_id_unidade_fk_exercicio_key;
create unique index if not exists dotacoes_unidade_ex_origem_fonte_key
  on public.dotacoes (id_unidade_fk, exercicio, origem, coalesce(fonte_codigo, '----'));
-- O controle de saldo é por unidade (gatilho a_validar_saldo, que soma todas as
-- dotações); a checagem por dotação isolada impediria repasses com mais de uma.
alter table public.dotacoes drop constraint if exists nao_distribuir_alem_do_total;

-- Dotação de origem dos repasses: a mais antiga do ancestral mais próximo.
create or replace function public.dotacao_de_origem(p_unidade uuid, p_exercicio smallint)
returns uuid language sql stable security definer set search_path to 'public' as $$
  with recursive anc as (
    select id_unidade, id_unidade_pai, 0 as nivel from public.unidades where id_unidade = p_unidade
    union all
    select u.id_unidade, u.id_unidade_pai, a.nivel + 1 from public.unidades u join anc a on u.id_unidade = a.id_unidade_pai
  )
  select d.id_dotacao from anc join public.dotacoes d on d.id_unidade_fk = anc.id_unidade and d.exercicio = p_exercicio
  order by anc.nivel, d.data_criacao limit 1
$$;

-- Painel público: código e categoria da demanda.
drop view if exists public.pac_publico;
create view public.pac_publico with (security_invoker = off) as
select d.id_demanda, u.nome as unidade, u.sigla as unidade_sigla, d.exercicio,
       d.descricao_objeto, d.quantidade, d.unidade_medida, d.valor_estimado, d.gut_pontuacao,
       d.status::text as status, d.justificativa, d.id_unidade_fk as id_unidade,
       d.gut_gravidade, d.gut_urgencia, d.gut_tendencia,
       d.codigo, c.nome as categoria, c.natureza_despesa
from public.demandas d
join public.unidades u on u.id_unidade = d.id_unidade_fk
left join public.categorias_despesa c on c.id_categoria = d.id_categoria_fk
where d.status in ('submetida','aprovada','reprovada','priorizada','homologada');
grant select on public.pac_publico to anon, authenticated;

select 'migracao aplicada' as resultado;

-- ═══ Ajuste: valores em formato brasileiro nas mensagens (R$ 110.000,00) ═════
create or replace function public.fmt_brl(v numeric) returns text
language sql immutable as $$ select translate(to_char(v, 'FM999G999G999G990D00'), ',.', '.,') $$;
do $$
declare f text; d text;
begin
  foreach f in array array['validar_saldo_envio','validar_comprometido_distribuicao','validar_saldo_distribuicao'] loop
    select pg_get_functiondef(('public.' || f)::regproc) into d;
    d := regexp_replace(d, 'to_char\(([^,()]+(\([^()]*\))?), ''FM999G999G990D00''\)', 'public.fmt_brl(\1)', 'g');
    execute d;
  end loop;
end $$;
select 'formato ajustado' as resultado;

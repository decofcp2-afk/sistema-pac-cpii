-- Planejamento e Monitoramento Orçamentário — 09/11/2026
-- Painel: acesso só para usuários logados, com chave para reabrir ao público.
--
-- A chave fica em public.configuracoes ('painel_publico_aberto'). Com ela
-- desligada (padrão), as visões do painel não devolvem linhas para quem não
-- tem sessão; usuários logados continuam vendo tudo. O administrador liga ou
-- desliga a chave na tela Usuários (função definir_painel_publico).

create table if not exists public.configuracoes (
  chave            text primary key,
  valor            jsonb not null,
  atualizado_por   uuid references public.perfis(id_usuario) on delete set null,
  data_atualizacao timestamptz not null default now()
);
alter table public.configuracoes enable row level security;   -- leitura e escrita só pelas funções abaixo

insert into public.configuracoes (chave, valor) values ('painel_publico_aberto', 'false')
  on conflict (chave) do update set valor = 'false', data_atualizacao = now();

create or replace function public.painel_publico_aberto()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce((select (valor #>> '{}')::boolean from public.configuracoes
                    where chave = 'painel_publico_aberto'), false)
$$;
grant execute on function public.painel_publico_aberto() to anon, authenticated;

create or replace function public.pode_ver_painel()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select public.painel_publico_aberto() or auth.uid() is not null
$$;
grant execute on function public.pode_ver_painel() to anon, authenticated;

create or replace function public.definir_painel_publico(p_aberto boolean)
returns boolean language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.sou_admin_global() then
    raise exception 'Apenas o administrador pode abrir ou fechar o painel ao publico.';
  end if;
  insert into public.configuracoes (chave, valor, atualizado_por, data_atualizacao)
    values ('painel_publico_aberto', to_jsonb(coalesce(p_aberto, false)), auth.uid(), now())
    on conflict (chave) do update set valor = excluded.valor,
      atualizado_por = excluded.atualizado_por, data_atualizacao = excluded.data_atualizacao;
  return coalesce(p_aberto, false);
end $$;
revoke execute on function public.definir_painel_publico(boolean) from public, anon;
grant execute on function public.definir_painel_publico(boolean) to authenticated;

-- Visões lidas pelo painel: passam a filtrar por pode_ver_painel().
-- Mantém colunas e opções de cada visão; não reaplica se já tiver o filtro.
do $$
declare v text; d text; opts text;
begin
  foreach v in array array['unidades_publicas','pac_publico','pac_publico_tramitacao','saldos_publicos','execucao_publica'] loop
    if to_regclass('public.' || v) is null then continue; end if;
    d := pg_get_viewdef(('public.' || v)::regclass, true);
    if d ilike '%pode_ver_painel%' then continue; end if;
    d := regexp_replace(d, ';\s*$', '');
    select coalesce(' with (' || array_to_string(c.reloptions, ', ') || ')', '') into opts
      from pg_class c where c.oid = ('public.' || v)::regclass;
    execute format('create or replace view public.%I%s as select * from (%s) _painel where public.pode_ver_painel()', v, opts, d);
  end loop;
end $$;

-- Funções: quem não tem login só executa as duas da chave do painel.
-- (No Postgres toda função nasce executável por PUBLIC; aqui o acesso de
-- usuários logados é preservado exatamente como estava.)
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as assinatura
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prorettype <> 'trigger'::regtype
       and has_function_privilege('anon', p.oid, 'execute')
       and p.proname not in ('painel_publico_aberto', 'pode_ver_painel')
  loop
    if has_function_privilege('authenticated', f.assinatura, 'execute') then
      execute format('grant execute on function %s to authenticated, service_role', f.assinatura);
    end if;
    execute format('revoke execute on function %s from public, anon', f.assinatura);
  end loop;
end $$;
alter default privileges in schema public revoke execute on functions from public, anon;
-- Funções usadas dentro das visões do painel (v_saldos) são checadas com o
-- papel de quem consulta: sem isto o painel reaberto daria erro sem login.
grant execute on function public.saldo_unidade(uuid,smallint), public.valor_alocado(uuid,smallint),
  public.valor_distribuido(uuid,smallint) to anon;

select 'painel restrito a usuarios logados' as resultado;

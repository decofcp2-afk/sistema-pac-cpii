-- Planejamento e Monitoramento Orçamentário — 09/11/2026
-- Empenho com valor maior que as requisições vinculadas: continua permitido
-- (o registro reflete a NE emitida), mas a diferença "sem vínculo" passa a
-- exigir justificativa escrita (mínimo 10 caracteres). Vale para o registro,
-- a edição da cobertura e o reforço.

alter table public.empenhos add column if not exists justificativa_sem_vinculo text;

create or replace function public.checar_empenho(p_emp uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_atual numeric; v_cob numeric; v_num text; v_just text;
begin
  select numero, justificativa_sem_vinculo into v_num, v_just from public.empenhos where id_empenho = p_emp;
  if v_num is null then return; end if;
  v_atual := public.valor_atual_empenho(p_emp);
  select coalesce(sum(valor), 0) into v_cob from public.empenho_cobertura where id_empenho = p_emp;
  if v_atual <= 0 then raise exception 'O empenho % ficaria com valor zero ou negativo.', v_num; end if;
  if v_cob > v_atual + 0.005 then
    raise exception 'O empenho % (R$ %) cobriria R$ % em requisicoes.', v_num, public.fmt_brl(v_atual), public.fmt_brl(v_cob);
  end if;
  if v_atual - v_cob > 0.005 and length(trim(coalesce(v_just, ''))) < 10 then
    raise exception 'O empenho % fica com R$ % sem vinculo a requisicoes. Justifique a diferenca (minimo 10 caracteres).',
      v_num, public.fmt_brl(v_atual - v_cob);
  end if;
end $$;

-- emp_salvar grava a justificativa enviada em p_dados.
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.emp_salvar(uuid, json, json)'::regprocedure);
  if position('justificativa_sem_vinculo' in v_def) = 0 then
    v_def := replace(v_def, '  if p_cobertura is not null then',
'  update public.empenhos set justificativa_sem_vinculo = nullif(trim(coalesce(p_dados->>''justificativa_sem_vinculo'', '''')), '''')
   where id_empenho = e.id_empenho;

  if p_cobertura is not null then');
    if position('justificativa_sem_vinculo' in v_def) = 0 then raise exception 'emp_salvar: trecho nao encontrado'; end if;
    execute v_def;
  end if;
end $$;

-- Reforço: aceita a justificativa da parte que ficar sem vínculo.
drop function if exists public.emp_movimento(uuid, text, numeric, date, text, text);
create or replace function public.emp_movimento(p_empenho uuid, p_tipo text, p_valor numeric, p_data date,
                                                p_documento text, p_observacao text, p_justificativa text default null) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.sou_orcamento() then raise exception 'Somente a Secao de Orcamento lanca reforcos e anulacoes.'; end if;
  insert into public.empenho_movimentos (id_empenho, tipo, valor, data, documento, observacao, criado_por)
  values (p_empenho, p_tipo, p_valor, p_data, nullif(trim(p_documento), ''), nullif(trim(p_observacao), ''), auth.uid());
  if length(trim(coalesce(p_justificativa, ''))) > 0 then
    update public.empenhos set justificativa_sem_vinculo = trim(p_justificativa) where id_empenho = p_empenho;
  end if;
end $$;
revoke execute on function public.emp_movimento(uuid, text, numeric, date, text, text, text) from public, anon;
grant execute on function public.emp_movimento(uuid, text, numeric, date, text, text, text) to authenticated, service_role;

-- v_empenhos passa a trazer a justificativa.
do $$
declare v_def text; v_opts text;
begin
  v_def := pg_get_viewdef('public.v_empenhos'::regclass, true);
  if position('justificativa_sem_vinculo' in v_def) = 0 then
    v_def := regexp_replace(v_def, ';\s*$', '');
    select coalesce(' with (' || array_to_string(reloptions, ', ') || ')', '') into v_opts from pg_class where oid = 'public.v_empenhos'::regclass;
    execute format('create or replace view public.v_empenhos%s as select x.*, e2.justificativa_sem_vinculo from (%s) x '
                || 'join public.empenhos e2 on e2.id_empenho = x.id_empenho', v_opts, v_def);
  end if;
end $$;

select 'justificativa do empenho sem vinculo aplicada' as resultado;

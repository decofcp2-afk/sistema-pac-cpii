-- Correções do fluxo do PAC — encontradas no teste ponta a ponta de 27/10/2026
-- (exercício 2024, dados fictícios). Aplicar no SQL Editor do Supabase.
--
-- 1. Repasse em cascata: hoje só quem gere a unidade dona da dotação (Reitoria)
--    consegue repassar. A PROAD não consegue repassar às diretorias, nem as
--    diretorias às seções. Passa a valer: cada unidade repassa às suas
--    subordinadas diretas; Ordenador e Licitações podem repassar dentro do seu
--    escopo. O saldo continua sendo conferido pelo gatilho a_validar_saldo.
-- 2. Priorização GUT: hoje só a chefia imediatamente superior pode priorizar.
--    Passa a valer como no sistema antigo e nas telas: Ordenador de Despesas e
--    Seção de Licitações (dentro do seu escopo), além da chefia superior; e as
--    notas de uma demanda já priorizada podem ser revistas.
-- 3. Homologação: hoje só a Seção de Licitações pode homologar. Passa a valer:
--    Ordenador de Despesas e Seção de Licitações (dentro do seu escopo).
-- 4. Correções de engano (botões "Cancelar envio", "Revisar" e "↩"): voltar uma
--    etapa, com as mesmas restrições de quem pode avançar.

-- (já aplicado em 27/10/2026) dotação de onde vem o dinheiro de uma unidade
create or replace function public.dotacao_de_origem(p_unidade uuid, p_exercicio smallint)
returns uuid language sql stable security definer set search_path to 'public' as $$
  with recursive anc as (
    select id_unidade, id_unidade_pai, 0 as nivel from public.unidades where id_unidade = p_unidade
    union all
    select u.id_unidade, u.id_unidade_pai, a.nivel + 1 from public.unidades u join anc a on u.id_unidade = a.id_unidade_pai
  )
  select d.id_dotacao from anc join public.dotacoes d on d.id_unidade_fk = anc.id_unidade and d.exercicio = p_exercicio
  order by anc.nivel limit 1
$$;
grant execute on function public.dotacao_de_origem(uuid, smallint) to authenticated;

-- 1. Repasse em cascata ---------------------------------------------------------
create or replace function public.pai_da_unidade(p uuid) returns uuid
language sql stable security definer set search_path to 'public' as $$
  select id_unidade_pai from public.unidades where id_unidade = p
$$;

drop policy if exists distrib_write on public.distribuicoes;
create policy distrib_write on public.distribuicoes for all to authenticated
using (
  meu_papel() in ('chefia','ord_despesas','licitacoes') and (
    sou_admin_global()
    or public.pai_da_unidade(id_unidade_destino_fk) = minha_unidade()
    or (meu_papel() in ('ord_despesas','licitacoes')
        and public.pai_da_unidade(id_unidade_destino_fk) in (select escopo_unidades()))
  )
)
with check (
  meu_papel() in ('chefia','ord_despesas','licitacoes') and (
    sou_admin_global()
    or public.pai_da_unidade(id_unidade_destino_fk) = minha_unidade()
    or (meu_papel() in ('ord_despesas','licitacoes')
        and public.pai_da_unidade(id_unidade_destino_fk) in (select escopo_unidades()))
  )
);

-- 2, 3 e 4. Regras de mudança de status -------------------------------------------
create or replace function public.validar_transicao_demanda()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  v_papel    papel_usuario := public.meu_papel();
  v_admin    boolean       := public.sou_admin_global();
  v_superior boolean       := public.eh_superior_direto(old.id_unidade_fk);
  v_dono     boolean;
  v_gestao   boolean;
begin
  v_dono   := old.id_unidade_fk in (select e.id_unidade from public.escopo_unidades() e);
  v_gestao := v_papel in ('ord_despesas','licitacoes') and v_dono;
  if v_admin then return new; end if;

  if new.status = old.status then
    if old.status = 'rascunho' then
      if not v_dono then raise exception 'Demanda fora do seu escopo.'; end if;
      return new;
    end if;
    -- revisão das notas GUT (só as notas; o conteúdo da demanda não muda)
    if old.status in ('aprovada','priorizada') and (v_gestao or v_superior)
       and (new.descricao_objeto, new.justificativa, new.quantidade, new.unidade_medida,
            new.valor_estimado, new.id_unidade_fk, new.exercicio)
           is not distinct from
           (old.descricao_objeto, old.justificativa, old.quantidade, old.unidade_medida,
            old.valor_estimado, old.id_unidade_fk, old.exercicio) then
      return new;
    end if;
    raise exception 'Somente demandas em rascunho podem ser editadas.';
  end if;

  case
    when old.status = 'rascunho' and new.status = 'submetida' then
      if not v_dono then raise exception 'Somente a unidade responsavel pode enviar a demanda.'; end if;
      new.data_envio := coalesce(new.data_envio, now());
    when old.status = 'submetida' and new.status in ('aprovada','reprovada') then
      if not v_superior then
        raise exception 'Apenas a chefia imediatamente superior pode aprovar ou reprovar. Nao e permitido decidir sobre demanda da propria unidade.';
      end if;
      if v_papel not in ('chefia','ord_despesas','licitacoes') then
        raise exception 'Seu perfil nao pode julgar demandas.';
      end if;
    when old.status = 'aprovada' and new.status = 'priorizada' then
      if not (v_gestao or v_superior) then
        raise exception 'Somente o Ordenador de Despesas, a Secao de Licitacoes ou a chefia superior podem priorizar esta demanda.';
      end if;
    when old.status = 'priorizada' and new.status = 'homologada' then
      if not v_gestao then
        raise exception 'Somente o Ordenador de Despesas ou a Secao de Licitacoes podem homologar.';
      end if;
    -- correções: voltar uma etapa
    when old.status = 'submetida' and new.status = 'rascunho' then
      if not v_dono then raise exception 'Somente a unidade responsavel pode cancelar o envio.'; end if;
    when old.status = 'reprovada' and new.status = 'rascunho' then
      if not v_dono then raise exception 'Somente a unidade responsavel pode revisar a demanda.'; end if;
    when old.status = 'aprovada' and new.status = 'submetida' then
      if not (v_superior or v_gestao) then raise exception 'Somente quem deu o de acordo ou a gestao podem desfaze-lo.'; end if;
    when old.status = 'priorizada' and new.status = 'aprovada' then
      if not (v_gestao or v_superior) then raise exception 'Somente a gestao pode desfazer a priorizacao.'; end if;
    when old.status = 'homologada' and new.status = 'priorizada' then
      if not v_gestao then raise exception 'Somente o Ordenador de Despesas ou a Secao de Licitacoes podem desfazer a homologacao.'; end if;
    when new.status = 'excluida' then
      if old.status <> 'rascunho' or not v_dono then
        raise exception 'Somente rascunhos da sua unidade podem ser excluidos.';
      end if;
    else
      raise exception 'Transicao de status invalida: % para %', old.status, new.status;
  end case;
  return new;
end;
$function$;

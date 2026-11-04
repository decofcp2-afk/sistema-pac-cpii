-- Limpeza para novas simulações — 04/11/2026
-- Apaga TODAS as demandas, aprovações, dotações, distribuições, requisições,
-- instrumentos e dados de execução/monitoramento, de todos os exercícios.
-- Mantém: usuários (perfis), unidades, categorias de despesa, fontes de recurso e configuração.
-- Não pode ser desfeito.
truncate table
  public.cobrancas, public.marcos_demanda, public.marcos_calendario,
  public.execucoes, public.empenho_demandas, public.empenho_movimentos, public.empenhos,
  public.execucao_demandas, public.requisicao_historico, public.requisicoes, public.instrumentos,
  public.responsaveis_tecnicos, public.aprovacoes, public.demandas,
  public.distribuicoes, public.dotacoes,
  public.contador_demandas, public.contador_requisicoes
restart identity;

select (select count(*) from public.demandas)     as demandas,
       (select count(*) from public.dotacoes)     as dotacoes,
       (select count(*) from public.distribuicoes) as distribuicoes,
       (select count(*) from public.requisicoes)  as requisicoes,
       (select count(*) from public.perfis)       as usuarios_mantidos,
       (select count(*) from public.unidades)     as unidades_mantidas;

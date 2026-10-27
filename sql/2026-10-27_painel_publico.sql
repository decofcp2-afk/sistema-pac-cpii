-- Painel público: distribuição orçamentária + justificativas da tramitação
-- Aplicado no Supabase (projeto sistema-pac-cpii) em 27/10/2026.
--
-- 1. pac_publico passa a expor todas as demandas já enviadas (submetida em
--    diante), com status, justificativa da demanda e id da unidade.
--    Rascunhos e excluídas continuam fora.
-- 2. pac_publico_tramitacao expõe as manifestações (aprovação, de acordo,
--    priorização, homologação, reprovação) com suas justificativas, SEM
--    identificar o servidor que assinou.
-- 3. saldos_publicos expõe o recebido, o repassado e o saldo final de cada
--    unidade por exercício (a partir de v_saldos), para o gráfico.

create or replace view public.pac_publico with (security_invoker = off) as
select d.id_demanda, u.nome as unidade, u.sigla as unidade_sigla, d.exercicio,
       d.descricao_objeto, d.quantidade, d.unidade_medida, d.valor_estimado, d.gut_pontuacao,
       d.status::text as status, d.justificativa, d.id_unidade_fk as id_unidade,
       d.gut_gravidade, d.gut_urgencia, d.gut_tendencia
from public.demandas d
join public.unidades u on u.id_unidade = d.id_unidade_fk
where d.status in ('submetida','aprovada','reprovada','priorizada','homologada');

create or replace view public.pac_publico_tramitacao with (security_invoker = off) as
select a.id_demanda_fk as id_demanda, a.acao::text as acao, a.nivel::text as nivel,
       a.justificativa, a.data_hora
from public.aprovacoes a
join public.demandas d on d.id_demanda = a.id_demanda_fk
where d.status in ('submetida','aprovada','reprovada','priorizada','homologada');

create or replace view public.saldos_publicos with (security_invoker = off) as
select id_unidade, id_unidade_pai, exercicio, alocado, distribuido, saldo
from public.v_saldos;

grant select on public.pac_publico, public.pac_publico_tramitacao, public.saldos_publicos
  to anon, authenticated;

-- Para voltar a expor só as homologadas, recrie pac_publico com
--   where d.status = 'homologada'
-- (mantendo as colunas novas no fim, ou usando DROP VIEW antes).

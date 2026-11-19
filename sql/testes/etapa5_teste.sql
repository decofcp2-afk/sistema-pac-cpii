begin;
create temp table res (n serial, k text, v text);
create temp table ids (k text primary key, v uuid);
grant all on res, ids to authenticated;
grant usage on sequence res_n_seq to authenticated;
create function pg_temp.como(p_uid uuid, p_sql text) returns text language plpgsql as $f$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    execute p_sql into r;
    execute 'set constraints all immediate'; execute 'set constraints all deferred';
  exception when others then r := 'ERRO: ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return coalesce(r, 'ok');
end $f$;
-- usuários
-- LIC = 8dbc4083 (licitacoes CPII) | CHEFE = 4d75c6a8 (DECOF-LIC) | CAMPUS = 6bec0762 movido para CT1-SAE
update perfis set id_unidade_fk = '40834583-faa3-421e-ae79-ebe554e54c75' where id_usuario = '6bec0762-4471-45c7-9bc7-e0996eed3098';
-- 1. Ata com Reitoria (gestora DECOF-LIC) e CT1 (gestora CT1-SAE)
insert into res(k,v) values ('ata', pg_temp.como('8dbc4083-c561-40d9-b18f-74d11975d9de', $q$
 select (public.inst_salvar(null,
   json_build_object('tipo','ata','numero','15/2026','objeto','Material de expediente','fornecedor_nome','Papelaria X','situacao','vigente',
                     'id_polo','fc430939-53f6-43e2-840e-aca35c6adf73'),
   json_build_array(json_build_object('id_polo','fc430939-53f6-43e2-840e-aca35c6adf73','id_unidade_gestora','03bced43-5116-4ed0-85eb-6864b31c5d53'),
                    json_build_object('id_polo','b0f874fb-1e1a-4773-8209-fa69c44fb25c','id_unidade_gestora','40834583-faa3-421e-ae79-ebe554e54c75')),
   json_build_array(
     json_build_object('grupo','1','numero_item','1','descricao','Resma A4','unidade_medida','resma','valor_unitario',25.5,'natureza_despesa','3.3.90.30',
        'quantidades', json_build_object('fc430939-53f6-43e2-840e-aca35c6adf73',100,'b0f874fb-1e1a-4773-8209-fa69c44fb25c',50)),
     json_build_object('grupo','1','numero_item','2','descricao','Caneta azul','unidade_medida','caixa','valor_unitario',30,
        'quantidades', json_build_object('fc430939-53f6-43e2-840e-aca35c6adf73',20,'b0f874fb-1e1a-4773-8209-fa69c44fb25c',10)))
 )->>'id_instrumento')$q$));
insert into ids select 'ata', id_instrumento from instrumentos where numero = '15/2026';
insert into ids select 'it1', id_item from instrumento_itens where numero_item='1' and id_instrumento=(select v from ids where k='ata');
insert into ids select 'it2', id_item from instrumento_itens where numero_item='2' and id_instrumento=(select v from ids where k='ata');
insert into res(k,v) select 'valor ata', valor_limite::text from instrumentos where id_instrumento=(select v from ids where k='ata');
insert into res(k,v) values ('chefe cadastra ata', pg_temp.como('4d75c6a8-0210-427f-b6a5-d8946ba95d1f', $q$select public.inst_salvar(null, json_build_object('tipo','dfd','numero','x','objeto','y','id_unidade_demandante','03bced43-5116-4ed0-85eb-6864b31c5d53'), null, null)::text$q$));
-- 2. Visibilidade por polo
insert into res(k,v) values ('chefe ve ata', pg_temp.como('4d75c6a8-0210-427f-b6a5-d8946ba95d1f', $q$select count(*)::text from instrumentos where numero='15/2026'$q$));
insert into res(k,v) values ('campus ve ata', pg_temp.como('6bec0762-4471-45c7-9bc7-e0996eed3098', $q$select count(*)::text || ' contrato00009:' || (select count(*) from instrumentos where numero='00009/2026') from instrumentos where numero='15/2026'$q$));
insert into res(k,v) values ('campus saldos', pg_temp.como('6bec0762-4471-45c7-9bc7-e0996eed3098', $q$select string_agg(numero_item||'='||registrado, ',') from v_instrumento_saldos where id_instrumento=(select v from ids where k='ata')$q$));
-- 3. Requisição por itens (DEM-2026-0004, DECOF-LIC, 50 mil)
insert into res(k,v) values ('req acima saldo item', pg_temp.como('4d75c6a8-0210-427f-b6a5-d8946ba95d1f', format($q$select public.req_salvar(null,'719953fb-d109-4fdd-a00a-a7b986281cae',null,null,'ata',%L,false,'',json_build_array(json_build_object('id_item',%L,'quantidade',101)))::text$q$, (select v from ids where k='ata'), (select v from ids where k='it1'))));
insert into res(k,v) values ('req ok', pg_temp.como('4d75c6a8-0210-427f-b6a5-d8946ba95d1f', format($q$select public.req_salvar(null,'719953fb-d109-4fdd-a00a-a7b986281cae',null,null,'ata',%L,false,'',json_build_array(json_build_object('id_item',%L,'quantidade',80),json_build_object('id_item',%L,'quantidade',10)))->>'codigo'$q$, (select v from ids where k='ata'), (select v from ids where k='it1'), (select v from ids where k='it2'))));
insert into ids select 'req', id_requisicao from requisicoes where id_instrumento=(select v from ids where k='ata');
insert into res(k,v) select 'req valor/gestora', valor || ' ' || (select sigla from unidades where id_unidade=id_unidade_gestora) || ' qtd=' || coalesce(quantidade::text,'null') from requisicoes where id_requisicao=(select v from ids where k='req');
insert into res(k,v) values ('req acima demanda', pg_temp.como('4d75c6a8-0210-427f-b6a5-d8946ba95d1f', format($q$select public.req_salvar(null,'719953fb-d109-4fdd-a00a-a7b986281cae',null,null,'ata',%L,false,'',json_build_array(json_build_object('id_item',%L,'quantidade',20)))::text$q$, (select v from ids where k='ata'), (select v from ids where k='it1'))));
-- 4. Aprovação por item
insert into res(k,v) values ('aprovar acima pedido', pg_temp.como('4d75c6a8-0210-427f-b6a5-d8946ba95d1f', format($q$select public.req_analisar(%L,'aprovar',null,null,json_build_array(json_build_object('id_item',%L,'quantidade_aprovada',90),json_build_object('id_item',%L,'quantidade_aprovada',10)))::text$q$, (select v from ids where k='req'), (select v from ids where k='it1'), (select v from ids where k='it2'))));
insert into res(k,v) values ('aprovar reduzido', pg_temp.como('4d75c6a8-0210-427f-b6a5-d8946ba95d1f', format($q$select public.req_analisar(%L,'aprovar',null,null,json_build_array(json_build_object('id_item',%L,'quantidade_aprovada',70),json_build_object('id_item',%L,'quantidade_aprovada',0)))->>'situacao'$q$, (select v from ids where k='req'), (select v from ids where k='it1'), (select v from ids where k='it2'))));
insert into res(k,v) select 'real', valor_real::text || ' residuo=' || (valor - valor_real) from requisicoes where id_requisicao=(select v from ids where k='req');
insert into res(k,v) select 'saldo it1 reitoria', saldo::text || ' aprovado=' || aprovado from v_instrumento_saldos where id_item=(select v from ids where k='it1') and id_polo='fc430939-53f6-43e2-840e-aca35c6adf73';
-- 5. Alterações
insert into res(k,v) values ('supressao abaixo', pg_temp.como('8dbc4083-c561-40d9-b18f-74d11975d9de', format($q$select public.inst_alterar(%L,'supressao',json_build_array(json_build_object('id_item',%L,'id_polo','fc430939-53f6-43e2-840e-aca35c6adf73','quantidade',60)),'TA 1/2026',current_date,'')::text$q$, (select v from ids where k='ata'), (select v from ids where k='it1'))));
insert into res(k,v) values ('acrescimo', pg_temp.como('8dbc4083-c561-40d9-b18f-74d11975d9de', format($q$select coalesce(public.inst_alterar(%L,'acrescimo',json_build_array(json_build_object('id_item',%L,'id_polo','fc430939-53f6-43e2-840e-aca35c6adf73','quantidade',125)),'TA 1/2026',current_date,'25%%')::text,'ok')$q$, (select v from ids where k='ata'), (select v from ids where k='it1'))));
insert into res(k,v) values ('reajuste', pg_temp.como('8dbc4083-c561-40d9-b18f-74d11975d9de', format($q$select coalesce(public.inst_alterar(%L,'reajuste',json_build_array(json_build_object('id_item',%L,'valor_unitario',27)),'Apostila 1',current_date,'IPCA')::text,'ok')$q$, (select v from ids where k='ata'), (select v from ids where k='it1'))));
insert into res(k,v) select 'apos alteracoes', 'vu=' || valor_unitario || ' total=' || (select valor_limite from instrumentos where id_instrumento=(select v from ids where k='ata')) || ' hist=' || (select count(*) from instrumento_alteracoes where id_instrumento=(select v from ids where k='ata')) from instrumento_itens where id_item=(select v from ids where k='it1');
insert into res(k,v) values ('editar preco direto', pg_temp.como('8dbc4083-c561-40d9-b18f-74d11975d9de', format($q$select public.inst_salvar(%L,
   json_build_object('tipo','ata','numero','15/2026','objeto','Material de expediente','situacao','vigente','id_polo','fc430939-53f6-43e2-840e-aca35c6adf73'),
   json_build_array(json_build_object('id_polo','fc430939-53f6-43e2-840e-aca35c6adf73','id_unidade_gestora','03bced43-5116-4ed0-85eb-6864b31c5d53'),
                    json_build_object('id_polo','b0f874fb-1e1a-4773-8209-fa69c44fb25c','id_unidade_gestora','40834583-faa3-421e-ae79-ebe554e54c75')),
   json_build_array(json_build_object('id_item',%L,'grupo','1','numero_item','1','descricao','Resma A4','unidade_medida','resma','valor_unitario',20,
        'quantidades', json_build_object('fc430939-53f6-43e2-840e-aca35c6adf73',125,'b0f874fb-1e1a-4773-8209-fa69c44fb25c',50)),
     json_build_object('id_item',%L,'grupo','1','numero_item','2','descricao','Caneta azul','unidade_medida','caixa','valor_unitario',30,
        'quantidades', json_build_object('fc430939-53f6-43e2-840e-aca35c6adf73',20,'b0f874fb-1e1a-4773-8209-fa69c44fb25c',10))))::text$q$,
   (select v from ids where k='ata'), (select v from ids where k='it1'), (select v from ids where k='it2'))));
-- 6. Campus requisita da ata (polo CT1): precisa de demanda homologada do campus; testa só o bloqueio de polo errado
insert into res(k,v) values ('chefe ve DFD outro polo', 'n/a');
-- 7. DFD → contrato
insert into res(k,v) values ('dfd', pg_temp.como('8dbc4083-c561-40d9-b18f-74d11975d9de', $q$select public.inst_salvar(null, json_build_object('tipo','dfd','numero','DFD 3/2026','objeto','Cadeiras','id_unidade_demandante','03bced43-5116-4ed0-85eb-6864b31c5d53','valor_estimado',10000,'situacao','em_contratacao'), null, null)->>'numero'$q$));
insert into ids select 'dfd', id_instrumento from instrumentos where numero='DFD 3/2026';
insert into res(k,v) values ('req nova contratacao', pg_temp.como('4d75c6a8-0210-427f-b6a5-d8946ba95d1f', format($q$select public.req_salvar(null,'719953fb-d109-4fdd-a00a-a7b986281cae',1,5000,'nova_contratacao',%L,true,'')->>'situacao'$q$, (select v from ids where k='dfd'))));
insert into res(k,v) values ('contrato do dfd', pg_temp.como('8dbc4083-c561-40d9-b18f-74d11975d9de', format($q$select public.inst_salvar(null,
   json_build_object('tipo','contrato','numero','20/2026','objeto','Cadeiras','situacao','vigente','id_processo_origem',%L),
   json_build_array(json_build_object('id_polo','fc430939-53f6-43e2-840e-aca35c6adf73','id_unidade_gestora','03bced43-5116-4ed0-85eb-6864b31c5d53')),
   json_build_array(json_build_object('numero_item','1','descricao','Cadeira','unidade_medida','unidade','valor_unitario',450,'quantidades',json_build_object('fc430939-53f6-43e2-840e-aca35c6adf73',10))))->>'numero'$q$, (select v from ids where k='dfd'))));
insert into res(k,v) select 'req apos contrato', r.situacao || ' forma=' || r.forma || ' inst=' || i.numero || ' | ' || left(r.motivo, 60) from requisicoes r join instrumentos i on i.id_instrumento=r.id_instrumento where r.forma <> 'ata' and r.id_demanda='719953fb-d109-4fdd-a00a-a7b986281cae' and r.data_criacao > now() - interval '1 hour';
insert into res(k,v) select 'dfd situacao', situacao from instrumentos where id_instrumento=(select v from ids where k='dfd');
select string_agg(k || ' => ' || coalesce(v,'(nulo)'), ' \n ' order by n) r from res where n > 16;
rollback;

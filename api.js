/*
 * api.js — Ponte google.script.run -> Supabase   [encapsulado em IIFE]
 * ============================================================================
 * TUDO abaixo roda dentro de uma funcao anonima. Isso e deliberado: na versao
 * anterior este arquivo declarava 16 identificadores no escopo global
 * (_erro, _meuPerfil, _exercicioAtual, ACOES, sb...). Como as paginas HTML
 * tambem declaram seus proprios globais, bastou uma coincidencia de nome
 * — Orcamento.html ja tinha `_exercicioAtual` — para o navegador lancar
 * "Identifier has already been declared" e abortar a pagina inteira.
 *
 * Encapsulando, o arquivo exporta APENAS os tres nomes que as paginas usam:
 *   window.google.script.run   — o shim de chamadas
 *   window._pacUrlPagina       — resolucao de nome de pagina
 *   window.APPS_SCRIPT_URL     — compatibilidade (ver nota abaixo)
 * Qualquer outro nome interno deixa de existir para fora deste arquivo.
 * ============================================================================
 */
(function () {
const SUPABASE_URL  = 'https://moitotympuemxudzdeit.supabase.co';
const SUPABASE_KEY  = 'sb_publishable_36ZcT_xq_sljUuJJ0zodvw_Z4lbQdbB';

// ─── Compatibilidade: APPS_SCRIPT_URL ────────────────────────────────────────
// As 8 paginas HTML abrem seu script inline com `const appUrl = APPS_SCRIPT_URL;`
// — resquicio de uma versao anterior que fazia fetch direto. A variavel NAO e
// usada em lugar nenhum (zero chamadas a fetch() nas paginas), mas a simples
// referencia a um global inexistente lanca ReferenceError e aborta TODO o
// script da pagina. Era por isso que nada carregava.
//
// Aponta para o Supabase, e nao para o Apps Script: se algum codigo futuro
// tentar usa-la, deve falhar de forma visivel em vez de voltar silenciosamente
// para o backend antigo, que sera desativado.
window.APPS_SCRIPT_URL = SUPABASE_URL;

// ─── Carregamento do supabase-js ─────────────────────────────────────────────
let _sb = null;
const _prontoSupabase = (async () => {
  if (!window.supabase) {
    await new Promise((ok, err) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
      s.onload = ok;
      s.onerror = () => err(new Error('Falha ao carregar supabase-js'));
      document.head.appendChild(s);
    });
  }
  _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'pac-cpii-auth' },
  });
  return _sb;
})();

const sb = async () => _sb || (await _prontoSupabase);


// ─── Cache do perfil do usuário logado ───────────────────────────────────────
let _perfil = null;

async function _meuPerfil() {
  if (_perfil) return _perfil;
  const c = await sb();
  const { data: { user } } = await c.auth.getUser();
  if (!user) return null;
  const { data } = await c.from('perfis').select('*').eq('id_usuario', user.id).single();
  _perfil = data;
  return _perfil;
}

async function _exercicioAtual() {
  const c = await sb();
  const { data } = await c.from('config').select('valor').eq('chave', 'exercicio_atual').single();
  return data ? data.valor : String(new Date().getFullYear());
}

// Gestão de usuários passa pela Edge Function `admin-usuarios`, que roda no
// servidor com a chave de serviço (criar conta no Auth, definir senha
// temporária, alterar perfis). O navegador só envia a sessão do usuário logado;
// a função confere se ele é administrador antes de fazer qualquer coisa.
async function _adminUsuarios(corpo) {
  const c = await sb();
  const { data, error } = await c.functions.invoke('admin-usuarios', { body: corpo });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); if (j && j.erro) msg = j.erro; } catch (e) {}
    return { ok: false, erro: msg };
  }
  return data || { ok: false, erro: 'Resposta vazia do servidor.' };
}

// No banco, o "de acordo" da chefia grava status 'aprovada'; as telas usam
// 'de_acordo' (vocabulário do sistema antigo). A tradução fica toda aqui.
const _statusTela  = s => (s === 'aprovada' ? 'de_acordo' : s);
const _statusBanco = s => (s === 'de_acordo' ? 'aprovada' : s);

// Ações que as telas "assinam" com a senha: confere a senha antes de gravar.
// Sem senha informada, segue (a tela é que decide se pede).
async function _confirmarSenha(senha) {
  if (!senha) return null;
  const p = await _meuPerfil();
  if (!p) return 'Sessão expirada.';
  const c = await sb();
  const { error } = await c.auth.signInWithPassword({ email: p.email, password: senha });
  return error ? 'Senha incorreta.' : null;
}

// Unidades e subárvores (para somas por estrutura).
async function _arvore() {
  const c = await sb();
  const { data } = await c.from('unidades').select('id_unidade,nome,sigla,tipo,id_unidade_pai');
  const lista = data || [];
  const filhos = {};
  lista.forEach(u => (filhos[u.id_unidade_pai] = filhos[u.id_unidade_pai] || []).push(u.id_unidade));
  const sub = (raiz) => { const out = [], fila = [raiz]; while (fila.length) { const id = fila.shift(); if (out.includes(id)) continue; out.push(id); (filhos[id] || []).forEach(f => fila.push(f)); } return out; };
  const pai = Object.fromEntries(lista.map(u => [u.id_unidade, u.id_unidade_pai]));
  return { lista, filhos, sub, pai, porId: Object.fromEntries(lista.map(u => [u.id_unidade, u])) };
}

// Converte erro do PostgREST em mensagem legível. Violação de policy volta como
// zero linhas ou 42501; violação de trigger traz a mensagem que escrevemos.
function _erro(e) {
  if (!e) return 'Erro desconhecido.';
  const m = e.message || String(e);
  if (/row-level security|42501/i.test(m))
    return 'Você não tem permissão para esta operação.';
  return m.replace(/^new row violates.*?:\s*/i, '');
}


// =============================================================================
// AÇÕES
// =============================================================================

const ACOES = {

  // ─── Sessão ────────────────────────────────────────────────────────────────
  async login({ email, senha }) {
    const c = await sb();
    const { data, error } = await c.auth.signInWithPassword({ email, password: senha });
    if (error) return { ok: false, erro: 'E-mail ou senha incorretos.' };
    _perfil = null;
    const p = await _meuPerfil();
    if (!p)      return { ok: false, erro: 'Perfil não encontrado. Procure o administrador.' };
    if (!p.ativo) { await c.auth.signOut(); return { ok: false, erro: 'Usuário inativo.' }; }
    // O token deixa de ser um valor que o front guarda: quem cuida disso é o
    // supabase-js. Devolvemos o access_token só para não quebrar as telas.
    // Usuário criado (ou com senha resetada) pelo sistema recebe senha
    // temporária e precisa trocá-la no primeiro acesso.
    const trocar = !!(data.user && data.user.user_metadata && data.user.user_metadata.deve_trocar_senha);
    return { ok: true, token: data.session.access_token, papel: p.papel, nome: p.nome,
             primeiro_acesso: trocar, deve_trocar_senha: trocar };
  },

  async logout() {
    const c = await sb();
    await c.auth.signOut();
    _perfil = null;
    return { ok: true };
  },

  async dados_usuario() {
    const p = await _meuPerfil();
    if (!p) return { ok: false, erro: 'Sessão expirada.' };
    let unidade = null;
    if (p.id_unidade_fk) {
      const c = await sb();
      const { data } = await c.from('unidades').select('nome,sigla')
                              .eq('id_unidade', p.id_unidade_fk).single();
      unidade = data;
    }
    return {
      ok: true,
      usuario: {
        id: p.id_usuario, nome: p.nome, email: p.email, papel: p.papel,
        unidade: unidade ? unidade.nome : 'Administrador Global',
        sigla:   unidade ? unidade.sigla : '',
        id_unidade_fk: p.id_unidade_fk || '',
      },
    };
  },

  async trocar_senha({ senha_atual, senha_nova, senha_confirmacao }) {
    if (senha_atual) {
      const e = await _confirmarSenha(senha_atual);
      if (e) return { ok: false, erro: 'Senha atual incorreta.' };
    }
    if (senha_nova !== senha_confirmacao)
      return { ok: false, erro: 'A confirmação não confere.' };
    if (String(senha_nova).length < 8)
      return { ok: false, erro: 'A senha deve ter ao menos 8 caracteres.' };
    const c = await sb();
    const { error } = await c.auth.updateUser({ password: senha_nova, data: { deve_trocar_senha: false } });
    if (error && /same|different from the old/i.test(error.message))
      return { ok: false, erro: 'A nova senha deve ser diferente da senha temporária.' };
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  // ─── Unidades ──────────────────────────────────────────────────────────────
  async listar_unidades() {
    const c = await sb();
    const { data, error } = await c.from('unidades')
      .select('id_unidade,nome,sigla,tipo,id_unidade_pai,ativo').order('nome');
    return error ? { ok: false, erro: _erro(error) } : { ok: true, unidades: data };
  },

  // ─── Demandas ──────────────────────────────────────────────────────────────
  async listar_demandas({ exercicio, status, para_aprovacao } = {}) {
    const c = await sb();
    const ex = exercicio || await _exercicioAtual();

    let q = c.from('demandas')
      .select('*, unidades!inner(nome,sigla), responsaveis_tecnicos(papel,nome_responsavel)')
      .eq('exercicio', Number(ex))
      .neq('status', 'excluida');

    // O RLS já limita ao escopo do usuário. `para_aprovacao` estreita ainda mais,
    // para as subordinadas DIRETAS — que é o que a chefia pode julgar.
    if (para_aprovacao) {
      const p = await _meuPerfil();
      if (p && p.id_unidade_fk) {
        const { data: filhas } = await c.from('unidades')
          .select('id_unidade').eq('id_unidade_pai', p.id_unidade_fk);
        const ids = (filhas || []).map(f => f.id_unidade);
        if (!ids.length) return { ok: true, demandas: [], exercicio: ex };
        q = q.in('id_unidade_fk', ids);
      }
    }
    if (status) {
      const lista = (Array.isArray(status) ? status : [status]).map(_statusBanco);
      q = lista.length > 1 ? q.in('status', lista) : q.eq('status', lista[0]);
    }

    const { data, error } = await q.order('data_criacao', { ascending: false });
    if (error) return { ok: false, erro: _erro(error) };

    const RESP = { gestor_titular: '_gestor_tit', gestor_substituto: '_gestor_sub',
                   fiscal_titular: '_fiscal_tit', fiscal_substituto: '_fiscal_sub' };
    const demandas = (data || []).map(d => {
      const out = {
        ...d,
        status: _statusTela(d.status),
        nome_unidade: d.unidades ? d.unidades.nome : d.id_unidade_fk,
        sigla_unidade: d.unidades ? d.unidades.sigla : '',
        gut_g: d.gut_gravidade, gut_u: d.gut_urgencia,
        gut_t: d.gut_tendencia, gut_total: d.gut_pontuacao,
        data_ultima_atualizacao: d.data_ultima_atualizacao || d.data_envio || d.data_criacao,
      };
      (d.responsaveis_tecnicos || []).forEach(r => { if (RESP[r.papel]) out[RESP[r.papel]] = r.nome_responsavel; });
      delete out.responsaveis_tecnicos;
      return out;
    });
    return { ok: true, demandas, exercicio: ex, exercicio_atual: await _exercicioAtual() };
  },

  async salvar_demanda({ demanda }) {
    const c = await sb();
    const p = await _meuPerfil();
    if (!p) return { ok: false, erro: 'Sessão expirada.' };

    const resp = {
      gestor_titular:     demanda._gestor_tit,
      gestor_substituto:  demanda._gestor_sub,
      fiscal_titular:     demanda._fiscal_tit,
      fiscal_substituto:  demanda._fiscal_sub,
    };
    const d = { ...demanda };
    ['_gestor_tit','_gestor_sub','_fiscal_tit','_fiscal_sub'].forEach(k => delete d[k]);

    // As telas usam gut_g/u/t; o banco calcula gut_pontuacao sozinho.
    if ('gut_g' in d) { d.gut_gravidade = d.gut_g || null; delete d.gut_g; }
    if ('gut_u' in d) { d.gut_urgencia  = d.gut_u || null; delete d.gut_u; }
    if ('gut_t' in d) { d.gut_tendencia = d.gut_t || null; delete d.gut_t; }
    delete d.gut_total; delete d.gut_pontuacao; delete d.nome_unidade; delete d.unidades;
    delete d.sigla_unidade; delete d.tramitacao; delete d.responsaveis_tecnicos;
    if (d.status) d.status = _statusBanco(d.status);

    let id = d.id_demanda;
    if (id) {
      // "Revisar" uma demanda reprovada: ela volta a rascunho com as correções.
      const { data: atual } = await c.from('demandas').select('status').eq('id_demanda', id).single();
      if (atual && atual.status === 'reprovada') d.status = 'rascunho';
      const { error } = await c.from('demandas').update(d).eq('id_demanda', id);
      if (error) return { ok: false, erro: _erro(error) };
    } else {
      if (!d.exercicio)
        return { ok: false, erro: 'Exercício não informado. Selecione o ano no topo antes de salvar.' };
      d.id_unidade_fk       = p.id_unidade_fk;
      d.id_usuario_criou_fk = p.id_usuario;
      d.status              = 'rascunho';
      const { data, error } = await c.from('demandas').insert(d).select('id_demanda').single();
      if (error) return { ok: false, erro: _erro(error) };
      id = data.id_demanda;
    }

    // Responsáveis técnicos: nome livre, não usuário do sistema.
    for (const [papel, nome] of Object.entries(resp)) {
      if (!nome) continue;
      await c.from('responsaveis_tecnicos')
        .upsert({ id_demanda_fk: id, papel, nome_responsavel: nome },
                { onConflict: 'id_demanda_fk,papel' });
    }
    return { ok: true, id_demanda: id };
  },

  // Envio exige a senha como assinatura do ato. Reautenticamos contra o Auth —
  // equivalente ao conferir o hash que o sistema antigo fazia, porém sem que a
  // aplicação jamais veja a senha armazenada.
  async enviar_demanda({ id_demanda, senha }) {
    const c = await sb();
    const p = await _meuPerfil();
    if (!p) return { ok: false, erro: 'Sessão expirada.' };

    const { error: eAuth } = await c.auth.signInWithPassword({ email: p.email, password: senha });
    if (eAuth) return { ok: false, erro: 'Senha incorreta. A demanda não foi enviada.' };

    const { error } = await c.from('demandas')
      .update({ status: 'submetida', data_envio: new Date().toISOString() })
      .eq('id_demanda', id_demanda);
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async excluir_demanda({ id_demanda }) {
    const c = await sb();
    const { error } = await c.from('demandas')
      .update({ status: 'excluida' }).eq('id_demanda', id_demanda);
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  // ─── Julgamento ────────────────────────────────────────────────────────────
  // O trigger validar_transicao_demanda barra autoaprovação e transições
  // inválidas. Aqui conferimos a senha (assinatura do ato), gravamos o novo
  // status e a trilha em `aprovacoes`.
  async aprovar_demanda({ id_demanda, senha, justificativa }) {
    const e = await _confirmarSenha(senha); if (e) return { ok: false, erro: e };
    return _decidir(id_demanda, 'aprovada', 'de_acordo', justificativa || 'De acordo.');
  },

  async reprovar_demanda({ id_demanda, justificativa, senha }) {
    if (!justificativa || !String(justificativa).trim())
      return { ok: false, erro: 'Justificativa é obrigatória para reprovar.' };
    const e = await _confirmarSenha(senha); if (e) return { ok: false, erro: e };
    return _decidir(id_demanda, 'reprovada', 'reprovacao', justificativa);
  },

  // Priorização: grava as notas G, U e T e leva a demanda de "de acordo" para
  // "priorizada"; uma demanda já priorizada pode ter as notas revistas.
  async salvar_gut({ id_demanda, gut_g, gut_u, gut_t, senha }) {
    const g = Number(gut_g), u = Number(gut_u), t = Number(gut_t);
    if (![g, u, t].every(n => n >= 1 && n <= 5))
      return { ok: false, erro: 'Informe notas de 1 a 5 para Gravidade, Urgência e Tendência.' };
    const e = await _confirmarSenha(senha); if (e) return { ok: false, erro: e };
    const c = await sb();
    const p = await _meuPerfil();
    const { data: d } = await c.from('demandas').select('status').eq('id_demanda', id_demanda).single();
    if (!d) return { ok: false, erro: 'Demanda não encontrada.' };
    if (!['aprovada', 'priorizada'].includes(d.status))
      return { ok: false, erro: 'Só demandas com "de acordo" da chefia podem ser priorizadas.' };
    const { error } = await c.from('demandas').update({
      gut_gravidade: g, gut_urgencia: u, gut_tendencia: t, status: 'priorizada',
    }).eq('id_demanda', id_demanda);
    if (error) return { ok: false, erro: _erro(error) };
    await c.from('aprovacoes').insert({
      id_demanda_fk: id_demanda, id_usuario_fk: p.id_usuario, acao: 'priorizacao',
      nivel: p.papel === 'ord_despesas' ? 'ordenador' : 'chefia',
      justificativa: `GUT: G ${g} U ${u} T ${t} → ${g * u * t}`,
    });
    return { ok: true, gut_total: g * u * t };
  },

  // Lista da tela de prioridades: as que aguardam nota e as já priorizadas.
  async listar_demandas_gut({ exercicio }) {
    const r = await ACOES.listar_demandas({ exercicio, status: ['aprovada', 'priorizada'] });
    if (!r.ok) return r;
    r.demandas.sort((a, b) =>
      (a.status === b.status ? 0 : a.status === 'priorizada' ? -1 : 1)
      || (b.gut_total || 0) - (a.gut_total || 0));
    return r;
  },

  async homologar_demandas({ ids_demandas, ids, senha }) {
    const e = await _confirmarSenha(senha); if (e) return { ok: false, erro: e };
    const lista = ids_demandas || ids || [];
    if (!lista.length) return { ok: false, erro: 'Selecione ao menos uma demanda.' };
    const c = await sb();
    const p = await _meuPerfil();
    let feitas = 0; const falhas = [];
    for (const id of lista) {
      const { data: d } = await c.from('demandas').select('status,descricao_objeto').eq('id_demanda', id).single();
      if (!d || d.status !== 'priorizada') continue;
      const { error } = await c.from('demandas').update({ status: 'homologada' }).eq('id_demanda', id);
      if (error) { falhas.push((d.descricao_objeto || id) + ': ' + _erro(error)); continue; }
      await c.from('aprovacoes').insert({
        id_demanda_fk: id, id_usuario_fk: p.id_usuario, acao: 'homologacao',
        nivel: 'ordenador', justificativa: 'Homologado pelo Ordenador de Despesas.',
      });
      feitas++;
    }
    if (!feitas && falhas.length) return { ok: false, erro: falhas.join(' | ') };
    // Homologacao.html le `resp.homologadas`, nao `resp.total`.
    return {
      ok: true, homologadas: feitas, falhas,
      exercicio: await _exercicioAtual(), data_hora: new Date().toISOString(),
    };
  },

  // Volta uma etapa (correção de engano). O banco decide quem pode.
  async reverter_status({ id_demanda, novo_status }) {
    const c = await sb();
    const destino = _statusBanco(novo_status);
    const { data: d } = await c.from('demandas').select('status').eq('id_demanda', id_demanda).single();
    if (!d) return { ok: false, erro: 'Demanda não encontrada.' };
    const permitido = { submetida: 'rascunho', aprovada: 'submetida', priorizada: 'aprovada', homologada: 'priorizada' };
    if (permitido[d.status] !== destino)
      return { ok: false, erro: 'Não é possível voltar de "' + _statusTela(d.status) + '" para "' + novo_status + '".' };
    const extra = destino === 'aprovada' ? { gut_gravidade: null, gut_urgencia: null, gut_tendencia: null } : {};
    const { error } = await c.from('demandas').update({ status: destino, ...extra }).eq('id_demanda', id_demanda);
    if (error) return { ok: false, erro: _erro(error) };
    return { ok: true };
  },

  async get_justificativa_reprovacao({ id_demanda }) {
    const c = await sb();
    const { data } = await c.from('aprovacoes')
      .select('justificativa,data_hora,perfis(nome)')
      .eq('id_demanda_fk', id_demanda).eq('acao', 'reprovacao')
      .order('data_hora', { ascending: false }).limit(1);
    if (!data || !data.length) return { ok: false, erro: 'Justificativa não encontrada.' };
    return {
      ok: true, justificativa: data[0].justificativa, data_hora: data[0].data_hora,
      autor: data[0].perfis ? data[0].perfis.nome : 'Chefia',
    };
  },

  // ─── Orçamento ─────────────────────────────────────────────────────────────
  // Modelo: uma dotação por exercício (em geral na Reitoria) e repasses em
  // cascata — cada unidade repassa às subordinadas diretas. Os saldos vêm da
  // view v_saldos: recebido (alocado), repassado às filhas diretas
  // (distribuido) e saldo próprio. A tela trabalha com "linhas de dotação":
  // uma por unidade que o usuário gere, identificada por "<dotação>::<unidade>".
  async listar_dotacoes({ exercicio }) {
    const c = await sb();
    const ex = Number(exercicio || await _exercicioAtual());
    const p = await _meuPerfil();
    const [{ data: saldos, error }, arv, { data: dots }] = await Promise.all([
      c.from('v_saldos').select('*').eq('exercicio', ex),
      _arvore(),
      c.from('dotacoes').select('*').eq('exercicio', ex),
    ]);
    if (error) return { ok: false, erro: _erro(error) };
    const saldoDe = id => (saldos || []).find(s => s.id_unidade === id);

    // Unidades cujas linhas aparecem: a do usuário; para o administrador
    // global (sem unidade), as unidades donas de dotação no exercício.
    let unidadesLinha = p && p.id_unidade_fk ? [p.id_unidade_fk]
                      : [...new Set((dots || []).map(d => d.id_unidade_fk))];
    unidadesLinha = unidadesLinha.filter(id => saldoDe(id));

    // Demandas do exercício (RLS já limita ao escopo) para "Total solicitado".
    const { data: dems } = await c.from('demandas').select('id_unidade_fk,valor_estimado,status')
      .eq('exercicio', ex).in('status', ['submetida', 'aprovada', 'priorizada', 'homologada']);

    const dotacoes = [];
    for (const id of unidadesLinha) {
      const s = saldoDe(id);
      const { data: idDot } = await c.rpc('dotacao_de_origem', { p_unidade: id, p_exercicio: ex });
      const propria = (dots || []).find(d => d.id_unidade_fk === id);
      const sub = arv.sub(id);
      const solicitado = (dems || []).filter(d => sub.includes(d.id_unidade_fk))
        .reduce((t, d) => t + Number(d.valor_estimado || 0), 0);
      dotacoes.push({
        id_dotacao:                idDot ? idDot + '::' + id : '',
        id_dotacao_real:           idDot,
        id_unidade_fk:             id,
        nome_unidade:              s.nome,
        sigla:                     s.sigla,
        exercicio:                 ex,
        status:                    propria ? propria.status : 'aberto',
        e_dono:                    !!propria,
        valor_recebido:            Number(s.alocado || 0),
        valor_distribuido_proprio: Number(s.distribuido || 0),
        saldo_proprio:             Number(s.saldo || 0),
        valor_solicitado:          solicitado,
        // nomes antigos, usados por outras telas
        valor_total:               Number(s.alocado || 0),
        valor_distribuido:         Number(s.distribuido || 0),
        saldo:                     Number(s.saldo || 0),
      });
    }
    return { ok: true, dotacoes, saldos, exercicio: ex };
  },

  // Repasses feitos pela unidade da linha às suas subordinadas diretas.
  async listar_distribuicoes({ id_dotacao, exercicio }) {
    const c = await sb();
    const [idDot, idUnidade] = String(id_dotacao || '').split('::');
    const arv = await _arvore();
    let q = c.from('distribuicoes')
      .select('*, unidades!distribuicoes_id_unidade_destino_fk_fkey(nome,sigla)')
      .order('data_hora', { ascending: false });
    if (idDot) q = q.eq('id_dotacao_origem_fk', idDot);
    const { data, error } = await q;
    if (error) return { ok: false, erro: _erro(error) };
    const distribuicoes = (data || []).filter(d => !idUnidade || arv.pai[d.id_unidade_destino_fk] === idUnidade);
    return { ok: true, distribuicoes };
  },

  async salvar_dotacao(params) {
    const x = params.dotacao || params;
    const c = await sb();
    const p = await _meuPerfil();
    const ex = Number(x.exercicio);
    if (!x.id_unidade_fk || !ex || !(Number(x.valor_total) > 0))
      return { ok: false, erro: 'Informe unidade, exercício e valor.' };
    const { data: existe } = await c.from('dotacoes').select('id_dotacao')
      .eq('id_unidade_fk', x.id_unidade_fk).eq('exercicio', ex);
    if (existe && existe.length)
      return { ok: false, erro: 'Já existe dotação desta unidade para ' + ex + '. Use os repasses para ajustar a distribuição.' };
    const { error } = await c.from('dotacoes').insert({
      id_unidade_fk: x.id_unidade_fk, exercicio: ex, valor_total: Number(x.valor_total),
      observacao: x.observacao || null, id_usuario_criou_fk: p.id_usuario,
    });
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  // O trigger a_validar_saldo devolve mensagem pronta se faltar saldo.
  async distribuir_orcamento(params) {
    const e = await _confirmarSenha(params.senha); if (e) return { ok: false, erro: e };
    const idDot = String(params.id_dotacao_origem_fk || params.id_dotacao || '').split('::')[0];
    const destino = params.id_unidade_destino_fk || params.id_unidade_destino;
    if (!idDot) return { ok: false, erro: 'Não há dotação para este exercício. Cadastre a dotação antes de repassar.' };
    if (!destino) return { ok: false, erro: 'Selecione a subunidade.' };
    const c = await sb();
    const p = await _meuPerfil();
    const { error } = await c.from('distribuicoes').insert({
      id_dotacao_origem_fk: idDot, id_unidade_destino_fk: destino,
      valor: Number(params.valor), observacao: params.observacao || null, id_usuario_fk: p.id_usuario,
    });
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async editar_distribuicao({ id_distribuicao, valor, observacao, senha }) {
    const e = await _confirmarSenha(senha); if (e) return { ok: false, erro: e };
    const c = await sb();
    const { error } = await c.from('distribuicoes')
      .update({ valor: Number(valor), observacao }).eq('id_distribuicao', id_distribuicao);
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async excluir_distribuicao({ id_distribuicao, senha }) {
    const e = await _confirmarSenha(senha); if (e) return { ok: false, erro: e };
    const c = await sb();
    const { error } = await c.from('distribuicoes')
      .delete().eq('id_distribuicao', id_distribuicao);
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  // Devolve parte de um repasse ao saldo de quem repassou. Só o que a unidade
  // de destino ainda não comprometeu (demandas ativas) nem repassou adiante.
  async cancelar_saldo_subordinada({ id_distribuicao, valor_cancelar, justificativa, senha }) {
    if (!justificativa || String(justificativa).trim().length < 5)
      return { ok: false, erro: 'Justificativa obrigatória (mínimo 5 caracteres).' };
    const e = await _confirmarSenha(senha); if (e) return { ok: false, erro: e };
    const c = await sb();
    const { data: dist } = await c.from('distribuicoes').select('*').eq('id_distribuicao', id_distribuicao).single();
    if (!dist) return { ok: false, erro: 'Repasse não encontrado.' };
    // O exercício é o selecionado na tela (o mesmo da dotação de origem).
    let exercicio = null;
    try { exercicio = Number(sessionStorage.getItem('pac_exercicio')) || null; } catch (x) {}
    exercicio = exercicio || Number(await _exercicioAtual());
    const { data: linhas } = await c.from('v_saldos').select('saldo')
      .eq('id_unidade', dist.id_unidade_destino_fk).eq('exercicio', exercicio);
    const linha = (linhas || [])[0] || {};
    const { data: dems } = await c.from('demandas').select('valor_estimado')
      .eq('id_unidade_fk', dist.id_unidade_destino_fk)
      .in('status', ['submetida', 'aprovada', 'priorizada', 'homologada'])
      .eq('exercicio', exercicio);
    const comprometido = (dems || []).reduce((t, d) => t + Number(d.valor_estimado || 0), 0);
    const livre = Math.min(Number(dist.valor), Number(linha.saldo || 0) - comprometido);
    const v = Number(valor_cancelar);
    if (!(v > 0) || v > livre)
      return { ok: false, erro: 'Valor maior que o saldo livre da subunidade (R$ ' + Math.max(livre, 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) + ').' };
    const obs = (dist.observacao ? dist.observacao + ' ' : '') +
      '[CANCELAMENTO PARCIAL R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) + '] ' + justificativa;
    const { error } = await c.from('distribuicoes')
      .update({ valor: Number(dist.valor) - v, observacao: obs }).eq('id_distribuicao', id_distribuicao);
    if (error) return { ok: false, erro: _erro(error) };
    return { ok: true, valor_devolvido: v, saldo_livre_anterior: livre };
  },

  // ─── Administração de usuários ─────────────────────────────────────────────
  // O embed precisa nomear a FK: existem DUAS relacoes entre perfis e unidades
  // (perfis.id_unidade_fk -> unidades, e unidades.id_ordenador_fk -> perfis).
  // Sem qualificar, o PostgREST recusa com "more than one relationship was found".
  async listar_usuarios() {
    const c = await sb();
    const { data, error } = await c.from('perfis')
      .select('*, unidades!perfis_id_unidade_fk_fkey(nome,sigla)').order('nome');
    if (error) return { ok: false, erro: _erro(error) };
    const usuarios = (data || []).map(u => ({
      ...u,
      nome_unidade: u.unidades ? u.unidades.nome : '',
      sigla_unidade: u.unidades ? u.unidades.sigla : '',
    }));
    return { ok: true, usuarios };
  },

  async salvar_usuario({ usuario }) {
    if (!usuario.id_usuario) return _adminUsuarios({ acao: 'criar', usuario });
    return _adminUsuarios({ acao: 'editar', usuario });
  },

  async deletar_usuario({ id_usuario }) {
    return _adminUsuarios({ acao: 'editar', usuario: { id_usuario, ativo: false } });
  },

  // Exclusão definitiva: só para quem não tem registros no PAC.
  async excluir_usuario({ id_usuario }) {
    return _adminUsuarios({ acao: 'excluir', id_usuario });
  },

  // Gera nova senha temporária, exibida ao administrador; o usuário troca no
  // próximo acesso. (O reset por e-mail não funciona sem SMTP próprio.)
  async resetar_senha({ id_usuario }) {
    return _adminUsuarios({ acao: 'resetar', id_usuario });
  },

  // ─── Configuração e consulta pública ───────────────────────────────────────
  async get_config_exercicio() {
    return { ok: true, exercicio: await _exercicioAtual() };
  },

  // Publico.html consome OITO campos desta resposta, nao so `demandas`. Faltando
  // qualquer um deles a tela fica em branco sem erro visivel.
  //
  // Diferenca deliberada em relacao ao Apps Script: aquele expunha publicamente
  // demandas em qualquer status (menos rascunho) E o nome + SIAPE de cada
  // servidor que assinou cada etapa. Aqui a view `pac_publico` limita a consulta
  // anonima as demandas HOMOLOGADAS e nao devolve dado pessoal algum. As
  // assinaturas vem vazias — ver nota no final da conversa.
  async dados_publicos_pac({ exercicio, id_unidade, id_setor, status, busca } = {}) {
    const c = await sb();
    const exAtual = await _exercicioAtual();
    const ex = String(exercicio || exAtual);

    const { data: unidades, error: eU } = await c.from('unidades_publicas')
      .select('id_unidade,nome,sigla,tipo,id_unidade_pai');
    if (eU) return { ok: false, erro: _erro(eU) };

    // Reconstroi a subarvore no cliente (a funcao subordinadas() do banco nao
    // esta exposta ao papel anon).
    const filhos = {};
    (unidades || []).forEach(u => {
      (filhos[u.id_unidade_pai] = filhos[u.id_unidade_pai] || []).push(u.id_unidade);
    });
    const subarvore = (raiz) => {
      const out = [], fila = [raiz];
      while (fila.length) {
        const id = fila.shift();
        if (out.includes(id)) continue;
        out.push(id);
        (filhos[id] || []).forEach(f => fila.push(f));
      }
      return out;
    };

    let escopo = id_unidade ? subarvore(id_unidade) : (unidades || []).map(u => u.id_unidade);
    if (id_setor) {
      const s = subarvore(id_setor);
      escopo = escopo.filter(id => s.includes(id));
    }

    // pac_publico expoe as demandas ja enviadas (submetida em diante), sem
    // rascunhos nem excluidas. Nenhum dado pessoal: so a unidade.
    const [{ data: pub, error: eD }, { data: saldos, error: eS }] = await Promise.all([
      c.from('pac_publico').select('*').eq('exercicio', Number(ex)),
      c.from('saldos_publicos').select('*').eq('exercicio', Number(ex)),
    ]);
    if (eD) return { ok: false, erro: _erro(eD) };
    if (eS) return { ok: false, erro: _erro(eS) };

    const porId = Object.fromEntries((unidades || []).map(u => [u.id_unidade, u]));
    // No banco a manifestacao da chefia gera status 'aprovada'; a tela chama de 'de_acordo'.
    const statusTela = s => (s === 'aprovada' ? 'de_acordo' : s);

    let demandas = (pub || []).filter(d => escopo.includes(d.id_unidade));
    if (status) demandas = demandas.filter(d => statusTela(d.status) === status);
    if (busca) {
      const b = String(busca).toLowerCase();
      demandas = demandas.filter(d => String(d.descricao_objeto || '').toLowerCase().includes(b));
    }

    // Tramitacao (de acordo, priorizacao, homologacao, reprovacao) com as
    // justificativas registradas em cada etapa — sem identificar o servidor.
    const tramPorDemanda = {};
    if (demandas.length) {
      const { data: tram } = await c.from('pac_publico_tramitacao').select('*')
        .in('id_demanda', demandas.map(d => d.id_demanda))
        .order('data_hora', { ascending: true });
      (tram || []).forEach(t => (tramPorDemanda[t.id_demanda] = tramPorDemanda[t.id_demanda] || []).push(t));
    }

    demandas = demandas.map(d => {
      const tramitacao = tramPorDemanda[d.id_demanda] || [];
      const rep = tramitacao.filter(t => t.acao === 'reprovacao').pop();
      return {
        ...d,
        status:        statusTela(d.status),
        nome_unidade:  d.unidade,
        sigla_unidade: d.unidade_sigla,
        gut_total:     d.gut_pontuacao,
        gut_g: d.gut_gravidade, gut_u: d.gut_urgencia, gut_t: d.gut_tendencia,
        tramitacao,
        // Assinaturas omitidas: identificam servidores nominalmente.
        ass_envio: null, ass_de_acordo: null, ass_priorizacao: null,
        ass_homologacao: null, ass_reprovacao: null,
        justificativa_reprovacao: rep ? (rep.justificativa || '') : '',
        data_reprovacao: rep ? rep.data_hora : null,
      };
    });

    // Arvore orcamentaria da estrutura selecionada (setor, se houver; senao a
    // unidade ordenadora). Cada no traz o SALDO que ficou com ele depois de
    // repassar as filhas. Como alocado = saldo proprio + repasses, a soma dos
    // saldos de toda a subarvore e igual ao que a raiz recebeu.
    const saldoPorId = Object.fromEntries((saldos || []).map(s => [s.id_unidade, s]));
    const montarNo = (id) => {
      const u = porId[id] || {};
      const s = saldoPorId[id] || {};
      const filhosNos = (filhos[id] || [])
        .map(montarNo)
        .filter(n => n.recebido || n.saldo || n.filhos.length)
        .sort((a, b) => String(a.sigla || a.nome).localeCompare(String(b.sigla || b.nome)));
      return {
        id, nome: u.nome || '', sigla: u.sigla || '',
        recebido:  Number(s.alocado || 0),
        repassado: Number(s.distribuido || 0),
        saldo:     Number(s.saldo || 0),
        filhos:    filhosNos,
      };
    };
    const raizOrc = id_setor || id_unidade;
    const arvoreOrcamento = raizOrc && porId[raizOrc] ? [montarNo(raizOrc)] : [];

    // Grafico: soma por filha direta da unidade selecionada.
    const dadosGrafico = {};
    if (id_unidade) {
      (filhos[id_unidade] || []).forEach(idFilha => {
        const ids = subarvore(idFilha);
        const total = demandas
          .filter(d => d.status === 'homologada' && ids.includes(d.id_unidade))
          .reduce((s, d) => s + Number(d.valor_estimado || 0), 0);
        if (total > 0) {
          const u = porId[idFilha];
          dadosGrafico[(u && (u.sigla || u.nome)) || idFilha] = total;
        }
      });
    }

    const ordenadoras = (unidades || [])
      .filter(u => ['reitoria', 'pro_reitoria', 'campus'].includes(u.tipo))
      .sort((a, b) => a.nome.localeCompare(b.nome))
      .map(u => ({ id: u.id_unidade, nome: u.nome, sigla: u.sigla, tipo: u.tipo }));

    const chefias = id_unidade
      ? (unidades || [])
          .filter(u => escopo.includes(u.id_unidade) && u.id_unidade !== id_unidade)
          .sort((a, b) => a.nome.localeCompare(b.nome))
          .map(u => ({ id: u.id_unidade, nome: u.nome, sigla: u.sigla }))
      : [];

    const base = Number(exAtual) || new Date().getFullYear();
    const anos = [];
    for (let a = base - 3; a <= base + 1; a++) anos.push(a);

    return {
      ok: true,
      demandas,
      dadosGrafico,
      ordenadoras,
      chefias,
      anos,
      exercicio: ex,
      arvoreOrcamento,
      total_valor: demandas.reduce((s, d) => s + Number(d.valor_estimado || 0), 0),
    };
  },

  async listar_unidades_publico() {
    const c = await sb();
    const { data, error } = await c.from('unidades_publicas')
      .select('id_unidade,nome,sigla,tipo,id_unidade_pai').order('nome');
    return error ? { ok: false, erro: _erro(error) } : { ok: true, unidades: data };
  },

  // Tela de homologação: demandas priorizadas e homologadas (ordem GUT) + resumo.
  async resumo_plano({ exercicio }) {
    const r = await ACOES.listar_demandas({ exercicio });
    if (!r.ok) return r;
    const soma = l => l.reduce((t, d) => t + Number(d.valor_estimado || 0), 0);
    const por = st => r.demandas.filter(d => d.status === st);
    const demandas = r.demandas.filter(d => ['priorizada', 'homologada'].includes(d.status))
      .sort((a, b) => (a.status === b.status ? 0 : a.status === 'priorizada' ? -1 : 1) || (b.gut_total || 0) - (a.gut_total || 0));
    return {
      ok: true, exercicio: r.exercicio, demandas,
      resumo: {
        total: r.demandas.length, submetidas: por('submetida').length, de_acordo: por('de_acordo').length,
        priorizadas: por('priorizada').length, homologadas: por('homologada').length, reprovadas: por('reprovada').length,
        valor_total: soma(r.demandas), valor_homologado: soma(por('homologada')),
        plano_ja_homologado: por('homologada').length > 0 && !por('priorizada').length,
      },
    };
  },
};


async function _decidir(id_demanda, novoStatus, acao, justificativa) {
  const c = await sb();
  const p = await _meuPerfil();
  if (!p) return { ok: false, erro: 'Sessão expirada.' };

  const { error } = await c.from('demandas')
    .update({ status: novoStatus }).eq('id_demanda', id_demanda);
  if (error) return { ok: false, erro: _erro(error) };

  // De acordo / reprovação são atos da chefia imediata, mesmo quando quem
  // assina é o ordenador (ex.: demandas das pró-reitorias, subordinadas à Reitoria).
  const nivel = p.papel === 'chefe_secao' ? 'chefe_secao' : 'chefia';
  const { error: e2 } = await c.from('aprovacoes').insert({
    id_demanda_fk: id_demanda, id_usuario_fk: p.id_usuario,
    acao, justificativa: justificativa || null, nivel,
  });
  if (e2) return { ok: false, erro: _erro(e2) };
  return { ok: true };
}


// =============================================================================
// SHIM google.script.run
// =============================================================================
// Mesma superfície de antes: withSuccessHandler / withFailureHandler encadeáveis
// e chamada por nome. As páginas HTML não percebem a troca de backend.

function _despachar(fnName, args, onSuccess, onFailure) {
  let acao, params;

  switch (fnName) {
    case 'chamarAcao': {
      const [, nome, paramsJson] = args;           // o token não é mais usado
      acao = nome; params = JSON.parse(paramsJson || '{}');
      break;
    }
    case 'chamarAcaoPublica': {
      const [nome, paramsJson] = args;
      acao = nome; params = JSON.parse(paramsJson || '{}');
      break;
    }
    case 'acaoLogin': {
      const [email, senha] = args;
      acao = 'login'; params = { email, senha };
      break;
    }
    case 'acaoTrocarSenha': {
      const [, senha_atual, senha_nova, senha_confirmacao] = args;
      acao = 'trocar_senha'; params = { senha_atual, senha_nova, senha_confirmacao };
      break;
    }
    default:
      if (onFailure) onFailure({ message: 'Função não suportada: ' + fnName });
      return;
  }

  const fn = ACOES[acao];
  if (!fn) {
    if (onFailure) onFailure({ message: 'Ação desconhecida: ' + acao });
    return;
  }

  Promise.resolve()
    .then(() => fn(params))
    .then(r => { if (onSuccess) onSuccess(r); })
    .catch(e => {
      const msg = _erro(e);
      // Falha de rede/permissão é devolvida no mesmo formato de antes, para que
      // as telas continuem exibindo o erro onde já exibiam.
      if (onSuccess) onSuccess({ ok: false, erro: msg });
      else if (onFailure) onFailure({ message: msg });
    });
}

function _criarRunner(onSuccess, onFailure) {
  return new Proxy({}, {
    get(_, prop) {
      if (prop === 'withSuccessHandler') return cb => _criarRunner(cb, onFailure);
      if (prop === 'withFailureHandler') return cb => _criarRunner(onSuccess, cb);
      return (...args) => _despachar(prop, args, onSuccess, onFailure);
    },
  });
}

// Mapa de páginas — o GitHub Pages diferencia maiúsculas de minúsculas.
const PAGE_FILE_MAP = {
  admin: 'Admin.html', aprovacoes: 'Aprovacoes.html', dashboard: 'Dashboard.html',
  demandas: 'Demandas.html', homologacao: 'Homologacao.html', login: 'Login.html',
  orcamento: 'Orcamento.html', prioridades: 'Prioridades.html',
  publico: 'Publico.html', index: 'index.html',
};

function _pacUrlPagina(page) {
  const limpo = String(page || '').replace(/\.html$/i, '').toLowerCase();
  return PAGE_FILE_MAP[limpo] || (page + '.html');
}

window._pacUrlPagina = _pacUrlPagina;

window.google = window.google || {};
window.google.script = window.google.script || {};
window.google.script.run = _criarRunner(null, null);

// Páginas protegidas: sem sessão, volta para o login. O RLS já impediria a
// leitura de qualquer dado, mas redirecionar evita telas vazias sem explicação.
(async () => {
  const c = await sb();
  const pagina = (location.pathname.split('/').pop() || '').toLowerCase();
  const publicas = ['publico.html', 'login.html', 'index.html', ''];
  if (publicas.includes(pagina)) return;
  const { data: { session } } = await c.auth.getSession();
  if (!session) { location.href = _pacUrlPagina('login'); return; }
  // Senha temporária ainda não trocada: nenhuma tela interna antes da troca.
  const md = session.user && session.user.user_metadata;
  if (md && md.deve_trocar_senha) location.href = _pacUrlPagina('login') + '?trocar=1';
})();

})();

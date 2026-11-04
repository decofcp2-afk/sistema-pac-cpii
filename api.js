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
// Origem do crédito da dotação (Lei 4.320/64, arts. 40–41; MCASP).
const ORIGENS_DOTACAO = [
  { valor: 'loa',              nome: 'Dotação inicial — LOA' },
  { valor: 'emenda',           nome: 'Emenda parlamentar (LOA)' },
  { valor: 'suplementar',      nome: 'Crédito adicional suplementar' },
  { valor: 'especial',         nome: 'Crédito adicional especial' },
  { valor: 'extraordinario',   nome: 'Crédito adicional extraordinário' },
  { valor: 'descentralizacao', nome: 'Descentralização de crédito recebida (TED)' },
  { valor: 'outra',            nome: 'Outra' },
];
const _nomeOrigem = v => (ORIGENS_DOTACAO.find(o => o.valor === v) || {}).nome || v || '';

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

// ─── Monitoramento: marcos, situação e semáforo ──────────────────────────────
const TIPOS_MARCO = [
  { valor: 'abertura_processo', nome: 'Abertura do processo' },
  { valor: 'envio_processo',    nome: 'Envio do processo' },
  { valor: 'empenho',           nome: 'Empenho' },
  { valor: 'primeiro_pedido',   nome: 'Primeiro pedido' },
  { valor: 'conclusao',         nome: 'Conclusão' },
];
const _nomeMarco = t => (TIPOS_MARCO.find(x => x.valor === t) || {}).nome || t || '';
const DIAS_ALERTA = 15;   // amarelo: vence em até 15 dias (decisão do gestor)
const SITUACOES = {
  aguardando: 'Aguardando início', em_contratacao: 'Em contratação', empenhada: 'Empenhada',
  em_execucao: 'Em execução', concluida: 'Concluída', nao_executada: 'Não executada',
};

// Filtro da chave seletora: 'todos', 'reitoria' (fora de qualquer campus) ou o id de um campus.
function _filtroEscopo(arv, escopo) {
  const cadeia = id => { const out = []; let x = id, i = 0; while (x && i++ < 30) { out.push(x); x = arv.pai[x]; } return out; };
  if (!escopo || escopo === 'todos') return () => true;
  if (escopo === 'reitoria') return id => !cadeia(id).some(u => (arv.porId[u] || {}).tipo === 'campus');
  return id => cadeia(id).includes(escopo);
}

function _dias(iso) {
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  return Math.round((d - hoje) / 864e5);
}

// Junta os dados de execução de uma demanda com prazos (próprios ou do calendário).
function _montarExecucao(d, arv, cal, overr, cobs) {
  const n = k => Number(d[k] || 0);
  const v = { ...d, valor_estimado: n('valor_estimado'), reservado: n('reservado'), pedido: n('pedido'),
              liquidado: n('liquidado'), pago: n('pago') };
  v.situacao = d.encerramento === 'nao_executada' ? 'nao_executada'
             : d.encerramento === 'concluida'     ? 'concluida'
             : v.pedido > 0                       ? 'em_execucao'
             : v.reservado > 0                    ? 'empenhada'
             : d.processo_sei                     ? 'em_contratacao'
             : 'aguardando';
  v.situacao_nome = SITUACOES[v.situacao];
  v.empenho_parcial = v.reservado > 0 && v.reservado < v.valor_estimado;
  v.pct_execucao = v.valor_estimado ? Math.round(v.pedido / v.valor_estimado * 100) : 0;

  const cadeia = []; let x = d.id_unidade_fk, i = 0;
  while (x && i++ < 30) { cadeia.push(x); x = arv.pai[x]; }
  const prazoCal = tipo => {
    for (const u of cadeia) { const m = cal.find(c => c.tipo === tipo && c.id_unidade_escopo === u && c.exercicio === d.exercicio); if (m) return m.data_limite; }
    const g = cal.find(c => c.tipo === tipo && !c.id_unidade_escopo && c.exercicio === d.exercicio);
    return g ? g.data_limite : null;
  };
  const feito = {
    abertura_processo: d.data_abertura_processo || (d.processo_sei ? 'informado' : null),
    envio_processo: d.data_envio_processo,
    empenho: d.primeira_reserva,
    primeiro_pedido: d.primeiro_pedido,
    conclusao: d.encerramento === 'concluida' ? d.data_encerramento : null,
  };
  const ordem = { vencido: 5, a_vencer: 4, no_prazo: 3, sem_prazo: 2, cumprido_atraso: 1, cumprido: 0, nao_aplica: -1 };
  v.marcos = TIPOS_MARCO.map(t => {
    const proprio = overr.find(o => o.id_demanda === d.id_demanda && o.tipo === t.valor);
    const prazo = proprio ? proprio.data_limite : prazoCal(t.valor);
    const cumprido = feito[t.valor];
    let estado, dias = null;
    if (cumprido) estado = (prazo && cumprido !== 'informado' && String(cumprido) > String(prazo)) ? 'cumprido_atraso' : 'cumprido';
    else if (d.encerramento) estado = 'nao_aplica';
    else if (!prazo) estado = 'sem_prazo';
    else { dias = _dias(prazo); estado = dias < 0 ? 'vencido' : dias <= DIAS_ALERTA ? 'a_vencer' : 'no_prazo'; }
    return { tipo: t.valor, nome: t.nome, prazo, prazo_proprio: !!proprio, cumprido_em: cumprido, estado, dias };
  });
  v.pior_estado = v.marcos.reduce((a, m) => (ordem[m.estado] > ordem[a] ? m.estado : a), 'nao_aplica');
  v.proximo_marco = v.marcos.find(m => ['vencido', 'a_vencer', 'no_prazo', 'sem_prazo'].includes(m.estado)) || null;
  v.cobrancas_por_marco = {};
  cobs.filter(c => c.id_demanda === d.id_demanda).forEach(c => {
    const k = c.tipo_marco || 'geral';
    if (!v.cobrancas_por_marco[k]) v.cobrancas_por_marco[k] = c.data_cobranca;
  });
  v.n_cobrancas = cobs.filter(c => c.id_demanda === d.id_demanda).length;
  return v;
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

const MSG_SEM_CONEXAO = 'Não foi possível conectar ao banco de dados do PAC. '
  + 'Ele pode estar pausado ou em manutenção — tente de novo em alguns minutos '
  + 'ou avise o administrador do sistema.';

// Converte erro do PostgREST em mensagem legível. Violação de policy volta como
// zero linhas ou 42501; violação de trigger traz a mensagem que escrevemos.
function _erro(e) {
  if (!e) return 'Erro desconhecido.';
  const m = e.message || String(e);
  if (/failed to fetch|networkerror|load failed|fetch failed|timeout|503|502|504|ECONN/i.test(m))
    return MSG_SEM_CONEXAO;
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
    if (error) {
      // Só é "senha errada" quando o servidor de fato recusou as credenciais.
      // Sem resposta (banco pausado, sem internet) a mensagem tem de dizer isso.
      const recusou = error.status === 400 || /invalid.*credentials|invalid login/i.test(error.message || '');
      return { ok: false, erro: recusou ? 'E-mail ou senha incorretos.' : MSG_SEM_CONEXAO };
    }
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
      .select('*, unidades!inner(nome,sigla), categorias_despesa(nome,grupo,natureza_despesa), responsaveis_tecnicos(papel,nome_responsavel)')
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
        categoria: d.categorias_despesa ? d.categorias_despesa.nome : '',
        categoria_grupo: d.categorias_despesa ? d.categorias_despesa.grupo : '',
        natureza_despesa: d.categorias_despesa ? d.categorias_despesa.natureza_despesa : '',
      };
      delete out.categorias_despesa;
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
    delete d.codigo; delete d.categoria; delete d.categoria_grupo; delete d.natureza_despesa;
    delete d.categorias_despesa; delete d.data_ultima_atualizacao;
    if ('id_categoria_fk' in d) d.id_categoria_fk = Number(d.id_categoria_fk) || null;
    if (d.status) d.status = _statusBanco(d.status);

    let id = d.id_demanda, codigo = null;
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
      const { data, error } = await c.from('demandas').insert(d).select('id_demanda,codigo').single();
      if (error) return { ok: false, erro: _erro(error) };
      id = data.id_demanda;
      codigo = data.codigo;
    }

    // Responsáveis técnicos: nome livre, não usuário do sistema.
    for (const [papel, nome] of Object.entries(resp)) {
      if (!nome) continue;
      await c.from('responsaveis_tecnicos')
        .upsert({ id_demanda_fk: id, papel, nome_responsavel: nome },
                { onConflict: 'id_demanda_fk,papel' });
    }
    return { ok: true, id_demanda: id, codigo };
  },

  // ─── Tabelas de apoio ──────────────────────────────────────────────────────
  async listar_categorias() {
    const c = await sb();
    const { data, error } = await c.from('categorias_despesa')
      .select('id_categoria,nome,grupo,natureza_despesa,gnd').eq('ativo', true).order('ordem');
    return error ? { ok: false, erro: _erro(error) } : { ok: true, categorias: data };
  },

  async listar_fontes() {
    const c = await sb();
    const { data, error } = await c.from('fontes_recurso').select('codigo,nome').eq('ativo', true).order('codigo');
    return error ? { ok: false, erro: _erro(error) } : { ok: true, fontes: data, origens: ORIGENS_DOTACAO };
  },

  // Saldo que a unidade ainda pode usar em novas demandas no exercício.
  async saldo_livre({ exercicio, id_unidade } = {}) {
    const c = await sb();
    const p = await _meuPerfil();
    const un = id_unidade || (p && p.id_unidade_fk);
    if (!un) return { ok: true, saldo_livre: null };
    const ex = Number(exercicio || await _exercicioAtual());
    const { data, error } = await c.rpc('saldo_livre_unidade', { p_unidade: un, p_exercicio: ex });
    return error ? { ok: false, erro: _erro(error) } : { ok: true, saldo_livre: Number(data || 0) };
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
    // O banco é quem barra (gatilho validar_saldo_envio); a mensagem dele já
    // diz se falta dotação ou saldo e quanto há disponível.

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
      const proprias = (dots || []).filter(d => d.id_unidade_fk === id);
      const propria = proprias[0];
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
        // dotações cadastradas diretamente nesta unidade (origem e fonte)
        dotacoes_proprias:         proprias.map(d => ({
          id_dotacao: d.id_dotacao, valor_total: Number(d.valor_total || 0),
          origem: d.origem, origem_nome: _nomeOrigem(d.origem), fonte_codigo: d.fonte_codigo,
          observacao: d.observacao || '',
        })),
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
    const origem = x.origem || 'loa';
    const fonte = x.fonte_codigo || null;
    if (!ORIGENS_DOTACAO.some(o => o.valor === origem)) return { ok: false, erro: 'Origem inválida.' };
    if (!fonte) return { ok: false, erro: 'Selecione a fonte de recursos.' };
    let q = c.from('dotacoes').select('id_dotacao')
      .eq('id_unidade_fk', x.id_unidade_fk).eq('exercicio', ex).eq('origem', origem).eq('fonte_codigo', fonte);
    const { data: existe } = await q;
    if (existe && existe.length)
      return { ok: false, erro: 'Já existe dotação desta unidade em ' + ex + ' com a mesma origem e fonte. Cadastre outra origem/fonte ou ajuste os repasses.' };
    const { error } = await c.from('dotacoes').insert({
      id_unidade_fk: x.id_unidade_fk, exercicio: ex, valor_total: Number(x.valor_total),
      origem, fonte_codigo: fonte,
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

  // ─── Monitoramento da execução ─────────────────────────────────────────────
  // Permissões ficam no banco (RLS + gatilhos): o Monitoramento da Reitoria
  // enxerga tudo, o de um campus só o seu campus; demais perfis só leem o que
  // está no seu escopo. Aqui só montamos os dados e calculamos situação/semáforo.
  async mon_contexto() {
    const p = await _meuPerfil();
    if (!p) return { ok: false, erro: 'Sessão expirada.' };
    const arv = await _arvore();
    const un = p.id_unidade_fk ? arv.porId[p.id_unidade_fk] : null;
    const raiz = !un || !un.id_unidade_pai;
    const campi = arv.lista.filter(u => u.tipo === 'campus').sort((a, b) => a.nome.localeCompare(b.nome));
    const opcoes = raiz
      ? [{ valor: 'todos', nome: 'Toda a instituição' }, { valor: 'reitoria', nome: 'Reitoria (sem os campi)' },
         ...campi.map(c => ({ valor: c.id_unidade, nome: (c.sigla ? c.sigla + ' — ' : '') + c.nome.replace(/^[^–]*–\s*/, '') }))]
      : [];
    return {
      ok: true, papel: p.papel, raiz, opcoes_escopo: opcoes,
      unidade: un ? { id: un.id_unidade, sigla: un.sigla, nome: un.nome } : null,
      pode_editar: p.papel === 'monitoramento' || (p.papel === 'licitacoes' && !p.id_unidade_fk),
      tipos_marco: TIPOS_MARCO, exercicio: await _exercicioAtual(),
      unidades: arv.lista.map(u => ({ id: u.id_unidade, sigla: u.sigla, nome: u.nome, tipo: u.tipo, pai: u.id_unidade_pai })),
    };
  },

  async mon_dados({ exercicio, escopo } = {}) {
    const c = await sb();
    const ex = Number(exercicio || await _exercicioAtual());
    const arv = await _arvore();
    const dentro = _filtroEscopo(arv, escopo);
    const [{ data: execs, error: e1 }, { data: emps, error: e2 }, { data: cal }, { data: overr },
           { data: cobs }, { data: vincs }] = await Promise.all([
      c.from('v_execucao_demandas').select('*').eq('exercicio', ex).order('codigo'),
      c.from('v_empenhos_saldo').select('*').eq('exercicio', ex).order('data_emissao', { ascending: false }),
      c.from('marcos_calendario').select('*').eq('exercicio', ex),
      c.from('marcos_demanda').select('*'),
      c.from('cobrancas').select('id_cobranca,id_demanda,tipo_marco,data_cobranca,canal').order('data_cobranca', { ascending: false }),
      c.from('empenho_demandas').select('id_empenho,id_demanda'),
    ]);
    if (e1) return { ok: false, erro: _erro(e1) };
    if (e2) return { ok: false, erro: _erro(e2) };

    const demandas = (execs || []).filter(d => dentro(d.id_unidade_fk))
      .map(d => _montarExecucao(d, arv, cal || [], overr || [], cobs || []));
    const idsDem = new Set(demandas.map(d => d.id_demanda));
    const empComDemanda = new Set((vincs || []).filter(v => idsDem.has(v.id_demanda)).map(v => v.id_empenho));
    const empenhos = (emps || []).filter(e => dentro(e.id_unidade_gestora_fk) || empComDemanda.has(e.id_empenho))
      .map(e => ({ ...e, ...['valor_empenhado','valor_atual','reservado','pedido','liquidado','pago','saldo_empenho','saldo_a_reservar']
        .reduce((o, k) => (o[k] = Number(e[k] || 0), o), {}) }));

    // Calendário: a Reitoria vê e edita todos os marcos; um campus vê os da
    // instituição e os da sua estrutura, e edita só os da sua estrutura.
    const eu = await _meuPerfil();
    const minha = eu && eu.id_unidade_fk;
    const raiz = !minha || !arv.pai[minha];
    const minhaSub = minha ? arv.sub(minha) : [];
    const acima = []; { let x = minha, i = 0; while (x && i++ < 30) { acima.push(x); x = arv.pai[x]; } }
    const editor = eu && (eu.papel === 'monitoramento' || (eu.papel === 'licitacoes' && !eu.id_unidade_fk));
    const calendario = (cal || [])
      .filter(m => raiz || !m.id_unidade_escopo || minhaSub.includes(m.id_unidade_escopo) || acima.includes(m.id_unidade_escopo))
      .map(m => ({
        ...m, tipo_nome: _nomeMarco(m.tipo),
        escopo_nome: m.id_unidade_escopo ? ((arv.porId[m.id_unidade_escopo] || {}).sigla || '') : 'Toda a instituição',
        editavel: !!editor && (raiz || (!!m.id_unidade_escopo && minhaSub.includes(m.id_unidade_escopo))),
      })).sort((a, b) => String(a.data_limite).localeCompare(String(b.data_limite)));

    const soma = (l, k) => l.reduce((t, d) => t + Number(d[k] || 0), 0);
    const agrupar = chave => {
      const g = {};
      demandas.forEach(d => {
        const k = d[chave] || 'Sem categoria';
        const x = g[k] = g[k] || { nome: k, n: 0, planejado: 0, reservado: 0, pedido: 0, pago: 0, atrasadas: 0 };
        x.n++; x.planejado += d.valor_estimado; x.reservado += d.reservado; x.pedido += d.pedido; x.pago += d.pago;
        if (d.pior_estado === 'vencido') x.atrasadas++;
      });
      return Object.values(g).sort((a, b) => b.planejado - a.planejado);
    };
    const porSituacao = {};
    demandas.forEach(d => { porSituacao[d.situacao] = (porSituacao[d.situacao] || 0) + 1; });
    const pendencias = [];
    demandas.forEach(d => d.marcos.forEach(m => {
      if (m.estado === 'vencido' || m.estado === 'a_vencer')
        pendencias.push({ id_demanda: d.id_demanda, codigo: d.codigo, descricao_objeto: d.descricao_objeto,
          sigla_unidade: d.sigla_unidade, id_unidade_fk: d.id_unidade_fk, ...m, ultima_cobranca: d.cobrancas_por_marco[m.tipo] || null });
    }));
    pendencias.sort((a, b) => (a.estado === b.estado ? 0 : a.estado === 'vencido' ? -1 : 1) || String(a.prazo).localeCompare(String(b.prazo)));

    return {
      ok: true, exercicio: ex, demandas, empenhos, calendario, pendencias,
      resumo: {
        n: demandas.length, planejado: soma(demandas, 'valor_estimado'), reservado: soma(demandas, 'reservado'),
        pedido: soma(demandas, 'pedido'), liquidado: soma(demandas, 'liquidado'), pago: soma(demandas, 'pago'),
        por_situacao: porSituacao, por_unidade: agrupar('sigla_unidade'), por_categoria: agrupar('categoria'),
        vencidos: pendencias.filter(p => p.estado === 'vencido').length,
        a_vencer: pendencias.filter(p => p.estado === 'a_vencer').length,
      },
    };
  },

  async mon_ficha({ id_demanda }) {
    const c = await sb();
    const arv = await _arvore();
    const [{ data: ex, error }, { data: cal }, { data: overr }, { data: cobs }, { data: vincs }] = await Promise.all([
      c.from('v_execucao_demandas').select('*').eq('id_demanda', id_demanda).maybeSingle(),
      c.from('marcos_calendario').select('*'),
      c.from('marcos_demanda').select('*').eq('id_demanda', id_demanda),
      c.from('cobrancas').select('*, perfis(nome)').eq('id_demanda', id_demanda).order('data_cobranca', { ascending: false }),
      c.from('empenho_demandas').select('*, empenhos(numero,data_emissao,favorecido_nome,natureza_despesa,tipo), execucoes(*)')
        .eq('id_demanda', id_demanda).order('data_criacao'),
    ]);
    if (error) return { ok: false, erro: _erro(error) };
    if (!ex) return { ok: false, erro: 'Demanda não encontrada ou não homologada.' };
    const demanda = _montarExecucao(ex, arv, (cal || []).filter(m => m.exercicio === ex.exercicio), overr || [], cobs || []);
    const vinculos = (vincs || []).map(v => {
      const execucoes = (v.execucoes || []).sort((a, b) => String(a.data_pedido).localeCompare(String(b.data_pedido)))
        .map(x => ({ ...x, valor: Number(x.valor), valor_liquidado: Number(x.valor_liquidado), valor_pago: Number(x.valor_pago) }));
      const pedido = execucoes.reduce((t, x) => t + x.valor, 0);
      return { id_vinculo: v.id_vinculo, id_empenho: v.id_empenho, valor_reservado: Number(v.valor_reservado),
               observacao: v.observacao, empenho: v.empenhos || {}, execucoes, pedido,
               saldo_reserva: Number(v.valor_reservado) - pedido };
    });
    return {
      ok: true, demanda, vinculos,
      cobrancas: (cobs || []).map(x => ({ ...x, autor: x.perfis ? x.perfis.nome : '', tipo_nome: _nomeMarco(x.tipo_marco) })),
      prazos_proprios: overr || [],
    };
  },

  async mon_empenho({ id_empenho }) {
    const c = await sb();
    const [{ data: e, error }, { data: movs }, { data: vincs }] = await Promise.all([
      c.from('v_empenhos_saldo').select('*').eq('id_empenho', id_empenho).maybeSingle(),
      c.from('empenho_movimentos').select('*').eq('id_empenho', id_empenho).order('data'),
      c.from('empenho_demandas').select('*, demandas(codigo,descricao_objeto,valor_estimado,unidades(sigla)), execucoes(*)')
        .eq('id_empenho', id_empenho).order('data_criacao'),
    ]);
    if (error) return { ok: false, erro: _erro(error) };
    if (!e) return { ok: false, erro: 'Empenho não encontrado.' };
    const vinculos = (vincs || []).map(v => {
      const xs = (v.execucoes || []).sort((a, b) => String(a.data_pedido).localeCompare(String(b.data_pedido)));
      const pedido = xs.reduce((t, x) => t + Number(x.valor), 0);
      const d = v.demandas || {};
      return {
        id_vinculo: v.id_vinculo, id_demanda: v.id_demanda, codigo: d.codigo, descricao_objeto: d.descricao_objeto,
        sigla_unidade: d.unidades ? d.unidades.sigla : '', valor_estimado: Number(d.valor_estimado || 0),
        valor_reservado: Number(v.valor_reservado), pedido,
        liquidado: xs.reduce((t, x) => t + Number(x.valor_liquidado), 0), pago: xs.reduce((t, x) => t + Number(x.valor_pago), 0),
        saldo_reserva: Number(v.valor_reservado) - pedido,
        ultimo_pedido: xs.length ? xs[xs.length - 1].data_pedido : null,
        execucoes: xs.map(x => ({ ...x, valor: Number(x.valor), valor_liquidado: Number(x.valor_liquidado), valor_pago: Number(x.valor_pago) })),
      };
    });
    const num = k => Number(e[k] || 0);
    return {
      ok: true,
      empenho: { ...e, valor_empenhado: num('valor_empenhado'), valor_atual: num('valor_atual'), reservado: num('reservado'),
                 pedido: num('pedido'), liquidado: num('liquidado'), pago: num('pago'),
                 saldo_empenho: num('saldo_empenho'), saldo_a_reservar: num('saldo_a_reservar') },
      movimentos: (movs || []).map(m => ({ ...m, valor: Number(m.valor) })),
      vinculos,
    };
  },

  async mon_salvar_empenho({ empenho }) {
    const c = await sb();
    const p = await _meuPerfil();
    const x = { ...empenho };
    ['numero', 'data_emissao', 'id_unidade_gestora_fk', 'valor_empenhado'].forEach(k => { if (typeof x[k] === 'string') x[k] = x[k].trim(); });
    if (!x.numero) return { ok: false, erro: 'Informe o número do empenho.' };
    if (!x.data_emissao) return { ok: false, erro: 'Informe a data de emissão.' };
    if (!x.id_unidade_gestora_fk) return { ok: false, erro: 'Informe a unidade gestora.' };
    if (!(Number(x.valor_empenhado) > 0)) return { ok: false, erro: 'Informe o valor empenhado.' };
    x.numero = x.numero.toUpperCase();
    x.valor_empenhado = Number(x.valor_empenhado);
    x.exercicio = Number(x.exercicio || String(x.data_emissao).slice(0, 4));
    if (!x.fonte_codigo) x.fonte_codigo = null;
    const campos = ['numero','exercicio','id_unidade_gestora_fk','ug_codigo','data_emissao','favorecido_cnpj','favorecido_nome',
                    'natureza_despesa','fonte_codigo','processo_sei','tipo','valor_empenhado','observacao'];
    const dados = Object.fromEntries(campos.filter(k => k in x).map(k => [k, x[k] === '' ? null : x[k]]));
    let r;
    if (x.id_empenho) r = await c.from('empenhos').update(dados).eq('id_empenho', x.id_empenho).select('id_empenho').single();
    else r = await c.from('empenhos').insert({ ...dados, criado_por: p.id_usuario }).select('id_empenho').single();
    if (r.error) return { ok: false, erro: /duplicate|unique/i.test(r.error.message) ? 'Já existe um empenho com este número nesta UG.' : _erro(r.error) };
    return { ok: true, id_empenho: r.data.id_empenho };
  },

  async mon_movimento({ id_empenho, tipo, valor, data, documento, observacao }) {
    const c = await sb();
    const p = await _meuPerfil();
    if (!['reforco', 'anulacao'].includes(tipo)) return { ok: false, erro: 'Tipo inválido.' };
    if (!(Number(valor) > 0) || !data) return { ok: false, erro: 'Informe valor e data.' };
    const { error } = await c.from('empenho_movimentos').insert({
      id_empenho, tipo, valor: Number(valor), data, documento: documento || null, observacao: observacao || null, criado_por: p.id_usuario });
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async mon_excluir_movimento({ id_movimento }) {
    const c = await sb();
    const { error } = await c.from('empenho_movimentos').delete().eq('id_movimento', id_movimento);
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async mon_vincular({ id_empenho, id_demanda, codigo, valor_reservado, observacao }) {
    const c = await sb();
    const p = await _meuPerfil();
    let idDem = id_demanda;
    if (!idDem && codigo) {
      const { data } = await c.from('demandas').select('id_demanda,status').eq('codigo', String(codigo).trim().toUpperCase()).maybeSingle();
      if (!data) return { ok: false, erro: 'Demanda ' + codigo + ' não encontrada no seu escopo.' };
      idDem = data.id_demanda;
    }
    if (!idDem) return { ok: false, erro: 'Informe a demanda.' };
    if (!(Number(valor_reservado) > 0)) return { ok: false, erro: 'Informe o valor a reservar.' };
    const { error } = await c.from('empenho_demandas').insert({
      id_empenho, id_demanda: idDem, valor_reservado: Number(valor_reservado), observacao: observacao || null, criado_por: p.id_usuario });
    if (error && /duplicate|unique/i.test(error.message)) return { ok: false, erro: 'Esta demanda já tem reserva neste empenho; altere o valor da reserva existente.' };
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async mon_editar_vinculo({ id_vinculo, valor_reservado }) {
    const c = await sb();
    if (!(Number(valor_reservado) > 0)) return { ok: false, erro: 'Informe o valor a reservar.' };
    const { error } = await c.from('empenho_demandas').update({ valor_reservado: Number(valor_reservado) }).eq('id_vinculo', id_vinculo);
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async mon_excluir_vinculo({ id_vinculo }) {
    const c = await sb();
    const { error } = await c.from('empenho_demandas').delete().eq('id_vinculo', id_vinculo);
    if (error && /foreign key|violates/i.test(error.message)) return { ok: false, erro: 'A reserva já tem pedidos lançados; exclua os pedidos antes.' };
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async mon_pedido(params) {
    const c = await sb();
    const p = await _meuPerfil();
    const x = params.pedido || params;
    if (!x.id_vinculo) return { ok: false, erro: 'Selecione a reserva (empenho e demanda).' };
    if (!x.data_pedido || !(Number(x.valor) > 0)) return { ok: false, erro: 'Informe data e valor do pedido.' };
    const dados = {
      id_vinculo: x.id_vinculo, data_pedido: x.data_pedido, valor: Number(x.valor),
      tipo_documento: x.tipo_documento || 'ordem_fornecimento', numero_documento: x.numero_documento || null,
      descricao: x.descricao || null, nota_fiscal: x.nota_fiscal || null,
      data_liquidacao: x.data_liquidacao || null, valor_liquidado: Number(x.valor_liquidado || 0),
      data_pagamento: x.data_pagamento || null, valor_pago: Number(x.valor_pago || 0),
    };
    if (dados.valor_liquidado > dados.valor) return { ok: false, erro: 'O valor liquidado não pode passar do valor do pedido.' };
    if (dados.valor_pago > dados.valor_liquidado) return { ok: false, erro: 'O valor pago não pode passar do liquidado.' };
    let r;
    if (x.id_execucao) r = await c.from('execucoes').update(dados).eq('id_execucao', x.id_execucao);
    else r = await c.from('execucoes').insert({ ...dados, criado_por: p.id_usuario });
    return r.error ? { ok: false, erro: _erro(r.error) } : { ok: true };
  },

  async mon_excluir_pedido({ id_execucao }) {
    const c = await sb();
    const { error } = await c.from('execucoes').delete().eq('id_execucao', id_execucao);
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  // Processo (unidade ou Monitoramento) e encerramento (só Monitoramento — o banco confere).
  async mon_salvar_execucao(params) {
    const c = await sb();
    const x = params.execucao || params;
    if (!x.id_demanda) return { ok: false, erro: 'Demanda não informada.' };
    const campos = ['processo_sei','data_abertura_processo','data_envio_processo','encerramento','justificativa_encerramento','data_encerramento'];
    const dados = { id_demanda: x.id_demanda };
    campos.forEach(k => { if (k in x) dados[k] = x[k] === '' ? null : x[k]; });
    if (dados.processo_sei && !dados.data_abertura_processo && !('data_abertura_processo' in x))
      dados.data_abertura_processo = new Date().toISOString().slice(0, 10);
    if (dados.encerramento === 'nao_executada' && String(dados.justificativa_encerramento || '').trim().length < 5)
      return { ok: false, erro: 'Justifique por que a demanda não será executada.' };
    if (dados.encerramento && !dados.data_encerramento) dados.data_encerramento = new Date().toISOString().slice(0, 10);
    const { error } = await c.from('execucao_demandas').upsert(dados, { onConflict: 'id_demanda' });
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async mon_salvar_marco(params) {
    const c = await sb();
    const p = await _meuPerfil();
    const x = params.marco || params;
    if (!TIPOS_MARCO.some(t => t.valor === x.tipo)) return { ok: false, erro: 'Selecione o marco.' };
    if (!x.data_limite) return { ok: false, erro: 'Informe a data limite.' };
    const dados = { exercicio: Number(x.exercicio), tipo: x.tipo, id_unidade_escopo: x.id_unidade_escopo || null,
                    data_limite: x.data_limite, descricao: x.descricao || null };
    let r;
    if (x.id_marco) r = await c.from('marcos_calendario').update(dados).eq('id_marco', x.id_marco);
    else r = await c.from('marcos_calendario').insert({ ...dados, criado_por: p.id_usuario });
    if (r.error && /duplicate|unique/i.test(r.error.message)) return { ok: false, erro: 'Já existe esse marco para este exercício e escopo; edite o existente.' };
    if (r.error && /row-level|42501/i.test(r.error.message))
      return { ok: false, erro: 'Você só pode criar marcos para a sua unidade' + (p.id_unidade_fk ? '' : '') + '; marcos de toda a instituição são da Reitoria.' };
    return r.error ? { ok: false, erro: _erro(r.error) } : { ok: true };
  },

  async mon_excluir_marco({ id_marco }) {
    const c = await sb();
    const { error } = await c.from('marcos_calendario').delete().eq('id_marco', id_marco);
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  // Prazo específico de uma demanda (substitui o do calendário). data_limite vazia = volta ao calendário.
  async mon_prazo_demanda({ id_demanda, tipo, data_limite, motivo }) {
    const c = await sb();
    const p = await _meuPerfil();
    let r;
    if (!data_limite) r = await c.from('marcos_demanda').delete().eq('id_demanda', id_demanda).eq('tipo', tipo);
    else r = await c.from('marcos_demanda').upsert({ id_demanda, tipo, data_limite, motivo: motivo || null, criado_por: p.id_usuario },
                                                     { onConflict: 'id_demanda,tipo' });
    return r.error ? { ok: false, erro: _erro(r.error) } : { ok: true };
  },

  async mon_cobrar({ id_demanda, tipo_marco, canal, registro }) {
    const c = await sb();
    const p = await _meuPerfil();
    if (String(registro || '').trim().length < 5) return { ok: false, erro: 'Descreva a cobrança (mínimo 5 caracteres).' };
    const { error } = await c.from('cobrancas').insert({
      id_demanda, tipo_marco: tipo_marco || null, canal: canal || 'sei', registro: String(registro).trim(), criado_por: p.id_usuario });
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async mon_resposta_cobranca({ id_cobranca, resposta, data_resposta }) {
    const c = await sb();
    const { error } = await c.from('cobrancas').update({
      resposta: resposta || null, data_resposta: data_resposta || new Date().toISOString().slice(0, 10) }).eq('id_cobranca', id_cobranca);
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  // ─── Requisições, instrumentos e gestão de pedidos (etapa 1 — 04/11/2026) ──
  // Contexto de quem está logado: o que pode fazer em cada uma das três telas.
  async req_contexto() {
    const p = await _meuPerfil();
    if (!p) return { ok: false, erro: 'Sessão expirada.' };
    const arv = await _arvore();
    const adminGlobal = p.papel === 'licitacoes' && !p.id_unidade_fk;
    const un = p.id_unidade_fk ? arv.porId[p.id_unidade_fk] : null;
    const requisitaveis = adminGlobal ? arv.lista.map(u => u.id_unidade)
      : p.papel === 'chefe_secao' && un ? [un.id_unidade]
      : p.papel === 'chefia' && un ? arv.sub(un.id_unidade) : [];
    return {
      ok: true, papel: p.papel, admin_global: adminGlobal,
      unidade: un ? { id: un.id_unidade, sigla: un.sigla, nome: un.nome } : null,
      pode_requisitar: requisitaveis.length > 0,
      pode_gerir: adminGlobal || (['chefe_secao','chefia','ord_despesas','licitacoes'].includes(p.papel) && !!un),
      pode_cadastrar: p.papel === 'licitacoes',
      unidades_requisitaveis: requisitaveis,
      exercicio: await _exercicioAtual(),
      unidades: arv.lista.map(u => ({ id: u.id_unidade, sigla: u.sigla, nome: u.nome, tipo: u.tipo, pai: u.id_unidade_pai })),
    };
  },

  // Tela Requisições: as requisições das unidades que o usuário pode requisitar,
  // as demandas homologadas com saldo e os instrumentos disponíveis.
  async req_dados({ exercicio } = {}) {
    const ctx = await ACOES.req_contexto();
    if (!ctx.ok) return ctx;
    const c = await sb();
    const ex = Number(exercicio || ctx.exercicio);
    const meu = new Set(ctx.unidades_requisitaveis);
    const [{ data: reqs, error: e1 }, { data: dems, error: e2 }, { data: inst, error: e3 }] = await Promise.all([
      c.from('v_requisicoes').select('*').eq('exercicio', ex).order('data_criacao', { ascending: false }),
      c.from('v_demandas_saldo').select('*').eq('exercicio', ex).order('codigo'),
      c.from('v_instrumentos').select('*').order('numero'),
    ]);
    const erro = e1 || e2 || e3;
    if (erro) return { ok: false, erro: _erro(erro) };
    return {
      ok: true, exercicio: ex,
      requisicoes: (reqs || []).filter(r => meu.has(r.id_unidade)),
      demandas: (dems || []).filter(d => meu.has(d.id_unidade_fk)),
      instrumentos: (inst || []).filter(i => i.disponivel || (i.tipo === 'processo' && i.situacao === 'em_andamento')),
    };
  },

  async req_salvar(r) {
    const c = await sb();
    const { data, error } = await c.rpc('req_salvar', {
      p_id: r.id_requisicao || null, p_demanda: r.id_demanda || null,
      p_quantidade: Number(r.quantidade), p_valor: Number(r.valor), p_forma: r.forma,
      p_instrumento: r.id_instrumento || null, p_declaracao: !!r.declaracao, p_observacao: r.observacao || '',
    });
    return error ? { ok: false, erro: _erro(error) } : { ok: true, ...data };
  },

  async req_cancelar({ id_requisicao, motivo }) {
    const c = await sb();
    const { error } = await c.rpc('req_cancelar', { p_id: id_requisicao, p_motivo: motivo || '' });
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async req_historico({ id_requisicao }) {
    const c = await sb();
    const { data, error } = await c.from('requisicao_historico')
      .select('*, perfis(nome)').eq('id_requisicao', id_requisicao).order('data_hora');
    if (error) return { ok: false, erro: _erro(error) };
    return { ok: true, historico: (data || []).map(h => ({ ...h, autor: h.perfis ? h.perfis.nome : '' })) };
  },

  // Gestão de pedidos: instrumentos e requisições cuja seção gestora é a do usuário.
  async ped_dados({ exercicio } = {}) {
    const ctx = await ACOES.req_contexto();
    if (!ctx.ok) return ctx;
    const ex = Number(exercicio || ctx.exercicio);
    if (!ctx.pode_gerir) return { ok: true, instrumentos: [], requisicoes: [], exercicio: ex };
    const c = await sb();
    let qi = c.from('v_instrumentos').select('*').order('numero');
    let qr = c.from('v_requisicoes').select('*').eq('exercicio', ex).neq('situacao', 'cancelada').order('data_situacao');
    if (!ctx.admin_global) {
      qi = qi.eq('id_unidade_gestora', ctx.unidade.id);
      qr = qr.eq('id_unidade_gestora', ctx.unidade.id);
    }
    const [{ data: inst, error: e1 }, { data: reqs, error: e2 }] = await Promise.all([qi, qr]);
    if (e1 || e2) return { ok: false, erro: _erro(e1 || e2) };
    return { ok: true, exercicio: ex, instrumentos: inst || [], requisicoes: reqs || [], admin_global: ctx.admin_global };
  },

  async ped_analisar({ id_requisicao, acao, valor_real, motivo }) {
    const c = await sb();
    const { data, error } = await c.rpc('req_analisar', {
      p_id: id_requisicao, p_acao: acao,
      p_valor_real: valor_real === '' || valor_real == null ? null : Number(valor_real), p_motivo: motivo || null,
    });
    return error ? { ok: false, erro: _erro(error) } : { ok: true, ...data };
  },

  // Cadastro de contratos, atas e processos (Licitações e administrador).
  async inst_listar() {
    const c = await sb();
    const { data, error } = await c.from('v_instrumentos').select('*').order('tipo').order('numero');
    if (error) return { ok: false, erro: _erro(error) };
    const { data: reqs } = await c.from('v_requisicoes').select('id_instrumento, situacao').neq('situacao', 'cancelada');
    const n = {};
    (reqs || []).forEach(r => { if (r.id_instrumento) n[r.id_instrumento] = (n[r.id_instrumento] || 0) + 1; });
    return { ok: true, instrumentos: (data || []).map(i => ({ ...i, n_requisicoes: n[i.id_instrumento] || 0 })) };
  },

  async inst_salvar({ instrumento }) {
    const c = await sb();
    const p = await _meuPerfil();
    const campos = ['tipo','numero','objeto','fornecedor_cnpj','fornecedor_nome','vigencia_inicio','vigencia_fim',
                    'valor_limite','processo_sei','modalidade','situacao','id_unidade_gestora','id_processo_origem','observacao'];
    const reg = {};
    campos.forEach(k => { if (k in instrumento) reg[k] = instrumento[k] === '' ? null : instrumento[k]; });
    if (reg.valor_limite != null) reg.valor_limite = Number(reg.valor_limite);
    if (!reg.situacao) reg.situacao = reg.tipo === 'processo' ? 'em_andamento' : 'vigente';
    let q;
    if (instrumento.id_instrumento) {
      q = c.from('instrumentos').update(reg).eq('id_instrumento', instrumento.id_instrumento).select('id_instrumento');
    } else {
      reg.criado_por = p && p.id_usuario;
      q = c.from('instrumentos').insert(reg).select('id_instrumento');
    }
    const { data, error } = await q;
    if (error) {
      if (/instrumentos_tipo_numero_key|duplicate key/i.test(error.message))
        return { ok: false, erro: 'Já existe um instrumento deste tipo com este número.' };
      return { ok: false, erro: _erro(error) };
    }
    if (!data || !data.length) return { ok: false, erro: 'Você não tem permissão para esta operação.' };
    return { ok: true, id_instrumento: data[0].id_instrumento };
  },

  async inst_excluir({ id_instrumento }) {
    const c = await sb();
    const { count } = await c.from('v_requisicoes').select('id_requisicao', { count: 'exact', head: true }).eq('id_instrumento', id_instrumento);
    if (count) return { ok: false, erro: 'Este instrumento já tem requisições e não pode ser excluído. Marque-o como encerrado.' };
    const { data, error } = await c.from('instrumentos').delete().eq('id_instrumento', id_instrumento).select('id_instrumento');
    if (error) return { ok: false, erro: /foreign key|violates/i.test(error.message) ? 'Há contrato ou ata gerado a partir deste processo.' : _erro(error) };
    return data && data.length ? { ok: true } : { ok: false, erro: 'Você não tem permissão para esta operação.' };
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
      // busca pelo objeto, pelo ID (DEM-2026-0001) ou pela categoria
      demandas = demandas.filter(d => [d.descricao_objeto, d.codigo, d.categoria]
        .some(v => String(v || '').toLowerCase().includes(b)));
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
  orcamento: 'Orcamento.html', prioridades: 'Prioridades.html', monitoramento: 'Monitoramento.html',
  requisicoes: 'Requisicoes.html', pedidos: 'Pedidos.html', instrumentos: 'Instrumentos.html',
  publico: 'Publico.html', index: 'index.html',
};

// Menu lateral, igual em todas as páginas (cada página usa PMO_MENUS[papel]).
const _M = {
  inicio:       { label: 'Início', page: 'dashboard', icon: 'home' },
  minhas:       { label: 'Minhas demandas', page: 'demandas', icon: 'list' },
  todas:        { label: 'Todas as demandas', page: 'demandas', icon: 'list' },
  aprovar:      { label: 'Aprovar demandas', page: 'aprovacoes', icon: 'check' },
  aprovacoes:   { label: 'Aprovações', page: 'aprovacoes', icon: 'check' },
  orcamento:    { label: 'Orçamento', page: 'orcamento', icon: 'dollar' },
  gut:          { label: 'Prioridades GUT', page: 'prioridades', icon: 'star' },
  homologar:    { label: 'Homologar plano', page: 'homologacao', icon: 'shield' },
  usuarios:     { label: 'Usuários', page: 'admin', icon: 'users' },
  requisicoes:  { label: 'Requisições', page: 'requisicoes', icon: 'cart' },
  pedidos:      { label: 'Gestão de pedidos', page: 'pedidos', icon: 'inbox' },
  instrumentos: { label: 'Contratos e atas', page: 'instrumentos', icon: 'briefcase' },
  execucao:     { label: 'Execução', page: 'monitoramento', icon: 'activity' },
  monitorar:    { label: 'Monitoramento', page: 'monitoramento', icon: 'activity' },
};
const PMO_MENUS = {
  chefe_secao:   [_M.inicio, _M.minhas, _M.requisicoes, _M.pedidos, _M.execucao],
  chefia:        [_M.inicio, _M.minhas, _M.aprovar, _M.orcamento, _M.requisicoes, _M.pedidos, _M.execucao],
  ord_despesas:  [_M.inicio, _M.aprovacoes, _M.orcamento, _M.gut, _M.homologar, _M.pedidos, _M.monitorar],
  licitacoes:    [_M.inicio, _M.usuarios, _M.todas, _M.orcamento, _M.aprovacoes, _M.gut, _M.homologar,
                  _M.instrumentos, _M.requisicoes, _M.pedidos, _M.monitorar],
  monitoramento: [_M.inicio, _M.monitorar],
};
const PMO_ICONS = {
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  check: '<path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  dollar: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  users: '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  cart: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/>',
};
window.PMO_MENUS = PMO_MENUS;
window.PMO_ICONS = PMO_ICONS;

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

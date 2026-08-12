/*
 * api.js — Ponte google.script.run → Supabase
 * ============================================================================
 * SISTEMA PAC · Colégio Pedro II
 *
 * Substitui o api.js anterior, que encaminhava tudo para um Web App do Apps
 * Script. As 6 páginas HTML continuam chamando `google.script.run.chamarAcao(...)`
 * exatamente como antes — este arquivo é o único que sabe que o backend mudou.
 *
 * DIFERENÇA DE FUNDO EM RELAÇÃO À VERSÃO ANTERIOR
 * -----------------------------------------------
 * No Apps Script, a autorização era feita em código: o roteador conferia papel
 * e escopo antes de cada operação. Um bug ali expunha tudo.
 *
 * Aqui a autorização é do BANCO. Cada consulta abaixo é executada com o JWT do
 * usuário, e as policies de RLS decidem quais linhas ele alcança. Este arquivo
 * não tem poder de contornar nada: se ele pedir uma demanda de outra unidade,
 * o Postgres devolve vazio. A segurança não depende deste código estar correto.
 *
 * A chave `publishable` abaixo é pública por desenho — ela apenas identifica o
 * projeto. Quem autoriza é o JWT do login somado às policies.
 * ============================================================================
 */

const SUPABASE_URL  = 'https://moitotympuemxudzdeit.supabase.co';
const SUPABASE_KEY  = 'sb_publishable_36ZcT_xq_sljUuJJ0zodvw_Z4lbQdbB';

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
    return { ok: true, token: data.session.access_token, papel: p.papel, nome: p.nome };
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

  async trocar_senha({ senha_nova, senha_confirmacao }) {
    if (senha_nova !== senha_confirmacao)
      return { ok: false, erro: 'A confirmação não confere.' };
    if (String(senha_nova).length < 8)
      return { ok: false, erro: 'A senha deve ter ao menos 8 caracteres.' };
    const c = await sb();
    const { error } = await c.auth.updateUser({ password: senha_nova });
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
      .select('*, unidades!inner(nome,sigla)')
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
    if (status) q = q.eq('status', status);

    const { data, error } = await q.order('data_criacao', { ascending: false });
    if (error) return { ok: false, erro: _erro(error) };

    const demandas = (data || []).map(d => ({
      ...d,
      nome_unidade: d.unidades ? d.unidades.nome : d.id_unidade_fk,
      gut_g: d.gut_gravidade, gut_u: d.gut_urgencia,
      gut_t: d.gut_tendencia, gut_total: d.gut_pontuacao,
    }));
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

    let id = d.id_demanda;
    if (id) {
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
  // inválidas. Aqui só registramos a intenção e a trilha.
  async aprovar_demanda({ id_demanda }) { return _decidir(id_demanda, 'aprovada',  'aprovacao',  null); },

  async reprovar_demanda({ id_demanda, justificativa }) {
    if (!justificativa || !String(justificativa).trim())
      return { ok: false, erro: 'Justificativa é obrigatória para reprovar.' };
    return _decidir(id_demanda, 'reprovada', 'reprovacao', justificativa);
  },

  async salvar_gut({ id_demanda, gut_g, gut_u, gut_t }) {
    const c = await sb();
    const { error } = await c.from('demandas').update({
      gut_gravidade: gut_g, gut_urgencia: gut_u, gut_tendencia: gut_t,
    }).eq('id_demanda', id_demanda);
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async listar_demandas_gut({ exercicio }) {
    const r = await ACOES.listar_demandas({ exercicio, status: 'aprovada' });
    if (!r.ok) return r;
    r.demandas.sort((a, b) => (b.gut_pontuacao || 0) - (a.gut_pontuacao || 0));
    return r;
  },

  async homologar_demandas({ ids }) {
    const c = await sb();
    const p = await _meuPerfil();
    for (const id of (ids || [])) {
      const { error } = await c.from('demandas')
        .update({ status: 'homologada' }).eq('id_demanda', id);
      if (error) return { ok: false, erro: _erro(error) };
      await c.from('aprovacoes').insert({
        id_demanda_fk: id, id_usuario_fk: p.id_usuario,
        acao: 'homologacao', nivel: 'ordenador',
      });
    }
    return { ok: true, total: (ids || []).length };
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
  // Saldos vêm da view v_saldos, que aplica a cascata hierárquica: o alocado de
  // uma unidade é o que ela recebeu do pai, e o distribuído é só o que desceu um
  // nível. Somar a subárvore inteira contaria o mesmo dinheiro várias vezes.
  async listar_dotacoes({ exercicio }) {
    const c = await sb();
    const ex = Number(exercicio || await _exercicioAtual());
    const { data, error } = await c.from('v_saldos').select('*').eq('exercicio', ex);
    return error ? { ok: false, erro: _erro(error) } : { ok: true, saldos: data, exercicio: ex };
  },

  async listar_distribuicoes({ exercicio }) {
    const c = await sb();
    const { data, error } = await c.from('distribuicoes')
      .select('*, unidades!distribuicoes_id_unidade_destino_fk_fkey(nome,sigla), dotacoes(exercicio)')
      .order('data_hora', { ascending: false });
    if (error) return { ok: false, erro: _erro(error) };
    const ex = Number(exercicio || await _exercicioAtual());
    return { ok: true, distribuicoes: (data || []).filter(d => !d.dotacoes || d.dotacoes.exercicio === ex) };
  },

  async salvar_dotacao({ id_unidade_fk, exercicio, valor_total, observacao }) {
    const c = await sb();
    const p = await _meuPerfil();
    const { error } = await c.from('dotacoes').upsert({
      id_unidade_fk, exercicio: Number(exercicio), valor_total,
      observacao, id_usuario_criou_fk: p.id_usuario,
    }, { onConflict: 'id_unidade_fk,exercicio' });
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  // O trigger a_validar_saldo devolve mensagem pronta se faltar saldo.
  async distribuir_orcamento({ id_dotacao_origem_fk, id_unidade_destino_fk, valor, observacao }) {
    const c = await sb();
    const p = await _meuPerfil();
    const { error } = await c.from('distribuicoes').insert({
      id_dotacao_origem_fk, id_unidade_destino_fk,
      valor, observacao, id_usuario_fk: p.id_usuario,
    });
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async editar_distribuicao({ id_distribuicao, valor, observacao }) {
    const c = await sb();
    const { error } = await c.from('distribuicoes')
      .update({ valor, observacao }).eq('id_distribuicao', id_distribuicao);
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async excluir_distribuicao({ id_distribuicao }) {
    const c = await sb();
    const { error } = await c.from('distribuicoes')
      .delete().eq('id_distribuicao', id_distribuicao);
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  // ─── Administração de usuários ─────────────────────────────────────────────
  async listar_usuarios() {
    const c = await sb();
    const { data, error } = await c.from('perfis')
      .select('*, unidades(nome,sigla)').order('nome');
    return error ? { ok: false, erro: _erro(error) } : { ok: true, usuarios: data };
  },

  async salvar_usuario({ usuario }) {
    const c = await sb();
    if (!usuario.id_usuario)
      return { ok: false, erro: 'Criação de usuário exige convite pelo painel do Supabase '
                              + '(Authentication → Add user). Depois edite o perfil aqui.' };
    const { error } = await c.from('perfis').update({
      nome: usuario.nome, papel: usuario.papel,
      id_unidade_fk: usuario.id_unidade_fk || null,
      matricula_siape: usuario.matricula_siape || null,
      ativo: usuario.ativo !== false,
    }).eq('id_usuario', usuario.id_usuario);
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async deletar_usuario({ id_usuario }) {
    const c = await sb();
    const { error } = await c.from('perfis').update({ ativo: false }).eq('id_usuario', id_usuario);
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  // Reset agora é por e-mail: ninguém — nem o admin — passa a conhecer a senha.
  async resetar_senha({ id_usuario }) {
    const c = await sb();
    const { data } = await c.from('perfis').select('email').eq('id_usuario', id_usuario).single();
    if (!data) return { ok: false, erro: 'Usuário não encontrado.' };
    const { error } = await c.auth.resetPasswordForEmail(data.email, {
      redirectTo: window.location.origin + '/sistema-pac-cpii/Login.html',
    });
    return error ? { ok: false, erro: _erro(error) }
                 : { ok: true, mensagem: 'Link de redefinição enviado para ' + data.email };
  },

  // ─── Configuração e consulta pública ───────────────────────────────────────
  async get_config_exercicio() {
    return { ok: true, exercicio: await _exercicioAtual() };
  },

  async dados_publicos_pac({ exercicio } = {}) {
    const c = await sb();
    let q = c.from('pac_publico').select('*');
    if (exercicio) q = q.eq('exercicio', Number(exercicio));
    const { data, error } = await q.order('gut_pontuacao', { ascending: false, nullsFirst: false });
    return error ? { ok: false, erro: _erro(error) } : { ok: true, demandas: data || [] };
  },

  async listar_unidades_publico() { return ACOES.listar_unidades(); },

  async resumo_plano({ exercicio }) {
    const r = await ACOES.listar_demandas({ exercicio });
    if (!r.ok) return r;
    const porStatus = {};
    let total = 0;
    r.demandas.forEach(d => {
      porStatus[d.status] = (porStatus[d.status] || 0) + 1;
      total += Number(d.valor_estimado || 0);
    });
    return { ok: true, por_status: porStatus, total_estimado: total, quantidade: r.demandas.length };
  },
};


async function _decidir(id_demanda, novoStatus, acao, justificativa) {
  const c = await sb();
  const p = await _meuPerfil();
  if (!p) return { ok: false, erro: 'Sessão expirada.' };

  const { error } = await c.from('demandas')
    .update({ status: novoStatus }).eq('id_demanda', id_demanda);
  if (error) return { ok: false, erro: _erro(error) };

  const nivel = p.papel === 'chefe_secao' ? 'chefe_secao'
              : p.papel === 'ord_despesas' ? 'ordenador' : 'chefia';
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
  if (!session) location.href = _pacUrlPagina('login');
})();

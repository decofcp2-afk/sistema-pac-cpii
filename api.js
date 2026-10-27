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
    // Homologacao.html le `resp.homologadas`, nao `resp.total`.
    return {
      ok: true,
      homologadas: (ids || []).length,
      exercicio: await _exercicioAtual(),
      data_hora: new Date().toISOString(),
    };
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
  // As telas leem `resp.dotacoes` (era o nome no Apps Script), nao `resp.saldos`.
  // Devolvo os dois: `dotacoes` no formato que Orcamento.html e Demandas.html
  // esperam, e `saldos` cru da view para quem quiser a cascata completa.
  async listar_dotacoes({ exercicio }) {
    const c = await sb();
    const ex = Number(exercicio || await _exercicioAtual());
    const { data, error } = await c.from('v_saldos').select('*').eq('exercicio', ex);
    if (error) return { ok: false, erro: _erro(error) };

    const dotacoes = (data || []).map(s => ({
      id_unidade_fk:     s.id_unidade,
      nome_unidade:      s.nome,
      sigla:             s.sigla,
      exercicio:         s.exercicio,
      valor_total:       Number(s.alocado || 0),
      valor_distribuido: Number(s.distribuido || 0),
      saldo:             Number(s.saldo || 0),
    }));
    return { ok: true, dotacoes, saldos: data, exercicio: ex };
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
    if (error) return { ok: false, erro: _erro(error) };
    // Admin.html exibe `resp.senha_inicial` numa janela. Nao existe mais senha
    // inicial: quem define e o proprio usuario, pelo link. Preencho o campo com
    // a explicacao para a tela nao mostrar "undefined".
    return {
      ok: true,
      senha_inicial: 'Link de redefinicao enviado para ' + data.email
                   + ' — o proprio usuario define a senha.',
    };
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
  if (!session) location.href = _pacUrlPagina('login');
})();

})();

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

// Devolução de saldo à Reitoria (comando do Monitoramento, 09/11/2026).
const MOTIVOS_DEVOLUCAO = {
  economia: 'Economia na contratação (valor real menor que o requisitado)',
  nao_requisitada: 'Saldo não será requisitado',
  prazo_encerrado: 'Prazo para requisitar encerrado',
  restos_a_pagar: 'Executada com restos a pagar',
  outro: 'Outro motivo',
};

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

// ─── Execução: prazos para requisitar, situação e conciliação ────────────────
const DIAS_ALERTA = 15;   // amarelo: prazo vence em até 15 dias (decisão do gestor)
const SIT_DEMANDA = {
  sem_requisicao: 'Sem requisição', requisitada: 'Requisitada', aprovada: 'Aprovada pelo gestor',
  empenhada: 'Empenhada', em_execucao: 'Em execução (liquidada em parte)', liquidada: 'Liquidada', paga: 'Paga',
  encerrada: 'Não será requisitada',
};
const CANAIS_COBRANCA = ['sei', 'email', 'telefone', 'presencial', 'outro'];

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
const _n = v => Number(v || 0);

// Prazo para requisitar de uma demanda: o próprio; senão o do calendário mais
// próximo na estrutura (unidade → … → instituição), preferindo o da categoria.
function _prazoDemanda(d, arv, prazos, proprios) {
  const p = proprios.find(x => x.id_demanda === d.id_demanda);
  if (p) return { data: p.data_limite, origem: 'proprio', motivo: p.motivo };
  const cadeia = []; let x = d.id_unidade_fk, i = 0;
  while (x && i++ < 30) { cadeia.push(x); x = arv.pai[x]; }
  cadeia.push(null);
  for (const u of cadeia) {
    const doNivel = prazos.filter(m => (m.id_unidade_escopo || null) === u && m.exercicio === d.exercicio);
    const m = doNivel.find(m => m.id_categoria && m.id_categoria === d.id_categoria_fk) || doNivel.find(m => !m.id_categoria);
    if (m) return { data: m.data_limite, origem: u ? ((arv.porId[u] || {}).sigla || 'unidade') : 'instituição', descricao: m.descricao };
  }
  return null;
}

// Demanda homologada + cadeia de valores + prazo + cobranças.
function _montarDemanda(d, arv, prazos, proprios, cobs) {
  const v = { ...d };
  ['valor_estimado','requisitado','saldo','aprovado','empenhado','liquidado','pago','residuo','devolvido','devolvivel'].forEach(k => v[k] = _n(d[k]));
  v.valor_efetivo = v.valor_estimado - v.devolvido;   // homologado menos o devolvido à Reitoria
  // Paga/liquidada só quando cobre todo o aprovado; antes disso, "em execução".
  v.situacao = d.encerrada ? 'encerrada'
             : v.aprovado > 0 && v.pago >= v.aprovado - 0.005 ? 'paga'
             : v.aprovado > 0 && v.liquidado >= v.aprovado - 0.005 ? 'liquidada'
             : v.liquidado > 0 ? 'em_execucao' : v.empenhado > 0 ? 'empenhada'
             : v.aprovado > 0 ? 'aprovada' : v.requisitado > 0 ? 'requisitada' : 'sem_requisicao';
  v.situacao_nome = SIT_DEMANDA[v.situacao];
  v.pct_execucao = v.valor_efetivo > 0 ? Math.round(v.liquidado / v.valor_efetivo * 100) : 0;
  const pr = _prazoDemanda(d, arv, prazos, proprios);
  v.prazo = pr ? pr.data : null;
  v.prazo_origem = pr ? pr.origem : null;
  v.prazo_motivo = pr ? (pr.motivo || pr.descricao || '') : '';
  v.dias_prazo = v.prazo ? _dias(v.prazo) : null;
  v.estado_prazo = d.encerrada || v.saldo <= 0.005 ? 'nao_aplica'
                 : !v.prazo ? 'sem_prazo'
                 : v.dias_prazo < 0 ? 'vencido' : v.dias_prazo <= DIAS_ALERTA ? 'a_vencer' : 'no_prazo';
  const minhas = cobs.filter(c => c.id_demanda === d.id_demanda);
  v.n_cobrancas = minhas.length;
  v.ultima_cobranca = minhas.length ? minhas[0].data_cobranca : null;
  return v;
}

// Conciliação pedido × empenho: por instrumento (ou forma direta) e por unidade.
function _conciliar(reqs, emps) {
  const consome = s => ['aprovada','em_solicitacao','empenhada','liquidada','paga'].includes(s);
  const FORMAS = { bolsas_editais: 'Bolsas e editais', diarias: 'Diárias', outros: 'Outros' };
  const grupo = (chave, nome) => (r, g) => {
    const k = chave(r); const x = g[k] = g[k] || { chave: k, nome: nome(r), aprovado: 0, solicitado: 0, empenhado: 0, liquidado: 0, pago: 0, n: 0 };
    if (!consome(r.situacao)) return;
    x.n++; x.aprovado += _n(r.valor_real);
    if (r.id_solicitacao && ['enviada','devolvida'].includes(r.situacao_solicitacao)) x.solicitado += _n(r.valor_real);
    x.empenhado += _n(r.empenhado); x.liquidado += _n(r.liquidado); x.pago += _n(r.pago);
  };
  const montar = fn => {
    const g = {}; reqs.forEach(r => fn(r, g));
    return Object.values(g).filter(x => x.n).map(x => ({ ...x, a_empenhar: Math.max(0, x.solicitado - x.empenhado) }))
      .sort((a, b) => b.aprovado - a.aprovado);
  };
  const porInstrumento = montar(grupo(r => r.id_instrumento || ('forma:' + r.forma + ':' + r.id_unidade_gestora),
    r => r.id_instrumento ? ((r.tipo_instrumento === 'ata' ? 'Ata ' : r.tipo_instrumento === 'contrato' ? 'Contrato ' : '') + r.numero_instrumento + (r.fornecedor_nome ? ' — ' + r.fornecedor_nome : ''))
                          : (FORMAS[r.forma] || r.forma) + ' — ' + r.sigla_gestora));
  const porUnidade = montar(grupo(r => r.id_unidade, r => r.sigla_unidade));
  const semVinculo = emps.filter(e => Math.abs(_n(e.sem_vinculo)) > 0.005)
    .map(e => ({ id_empenho: e.id_empenho, numero: e.numero, valor_atual: _n(e.valor_atual), coberto: _n(e.coberto), sem_vinculo: _n(e.sem_vinculo) }));
  const t = porInstrumento.reduce((a, x) => { ['aprovado','solicitado','empenhado','liquidado','pago','a_empenhar'].forEach(k => a[k] += x[k]); return a; },
    { aprovado: 0, solicitado: 0, empenhado: 0, liquidado: 0, pago: 0, a_empenhar: 0 });
  t.empenhos = emps.reduce((s, e) => s + _n(e.valor_atual), 0);
  t.sem_vinculo = semVinculo.reduce((s, e) => s + e.sem_vinculo, 0);
  return { por_instrumento: porInstrumento, por_unidade: porUnidade, sem_vinculo: semVinculo, total: t };
}

const _numReq = r => ({ ...r, valor: _n(r.valor), valor_real: r.valor_real == null ? null : _n(r.valor_real),
  residuo: _n(r.residuo), empenhado: _n(r.empenhado), liquidado: _n(r.liquidado), pago: _n(r.pago) });
const _numSol = s => ({ ...s, total_previsto: _n(s.total_previsto), total_real: _n(s.total_real), empenhado: _n(s.empenhado),
  a_empenhar: _n(s.a_empenhar), saldo_instrumento: s.saldo_instrumento == null ? null : _n(s.saldo_instrumento) });
const _numEmp = e => ({ ...e, valor_empenhado: _n(e.valor_empenhado), valor_atual: _n(e.valor_atual), coberto: _n(e.coberto), sem_vinculo: _n(e.sem_vinculo) });
const _numLiq = l => ({ ...l, valor: _n(l.valor), coberto: _n(l.coberto), sem_vinculo: _n(l.sem_vinculo), pago: _n(l.pago), a_pagar: _n(l.a_pagar) });

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
  // Regras do banco com nome técnico: traduz as mais comuns.
  const REGRAS = {
    instrumentos_check: 'Contrato e ata precisam de valor limite.',
    instrumentos_check1: 'Situação inválida para um processo.',
    instrumentos_check2: 'Situação inválida para contrato ou ata.',
    instrumentos_check3: 'A vigência final não pode ser anterior à inicial. Confira as datas.',
  };
  const regra = (m.match(/violates check constraint "([^"]+)"/) || [])[1];
  if (regra) return REGRAS[regra] || 'Algum dado informado não atende às regras do sistema (' + regra + '). Confira os campos.';
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
    const [{ data, error }, { data: acoes }] = await Promise.all([
      c.from('fontes_recurso').select('codigo,nome').eq('ativo', true).order('codigo'),
      c.from('acoes_orcamentarias').select('codigo,nome').eq('ativo', true).order('codigo'),
    ]);
    return error ? { ok: false, erro: _erro(error) } : { ok: true, fontes: data, origens: ORIGENS_DOTACAO, acoes: acoes || [] };
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
    const [{ data: saldos, error }, arv, { data: dots }, { data: acoes }] = await Promise.all([
      c.from('v_saldos').select('*').eq('exercicio', ex),
      _arvore(),
      c.from('dotacoes').select('*').eq('exercicio', ex),
      c.from('acoes_orcamentarias').select('codigo,nome'),
    ]);
    const nomeAcao = Object.fromEntries((acoes || []).map(a => [a.codigo, a.nome]));
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
        // devolvido à Reitoria pelo Monitoramento (na raiz: total recuperado)
        devolvido:                 Number(s.devolvido || 0),
        e_raiz:                    !s.id_unidade_pai,
        // dotações cadastradas diretamente nesta unidade (ação, origem e fonte)
        dotacoes_proprias:         proprias.map(d => ({
          id_dotacao: d.id_dotacao, valor_total: Number(d.valor_total || 0),
          origem: d.origem, origem_nome: _nomeOrigem(d.origem), fonte_codigo: d.fonte_codigo,
          acao_codigo: d.acao_codigo || '', acao_nome: nomeAcao[d.acao_codigo] || '', previsao: !!d.previsao,
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
    let acao = String(x.acao_codigo || '').trim().toUpperCase();
    if (!acao) return { ok: false, erro: 'Selecione a ação orçamentária.' };
    if (!/^[0-9A-Z]{4}$/.test(acao)) return { ok: false, erro: 'O código da ação tem 4 caracteres (ex.: 20RI).' };
    if (x.acao_nova) {
      const nome = String(x.acao_nome || '').trim();
      if (nome.length < 3) return { ok: false, erro: 'Informe o nome da ação ' + acao + '.' };
      const { data: ja } = await c.from('acoes_orcamentarias').select('codigo').eq('codigo', acao);
      if (!ja || !ja.length) {
        const { error: eA } = await c.from('acoes_orcamentarias').insert({ codigo: acao, nome });
        if (eA) return { ok: false, erro: _erro(eA) };
      }
    }
    let q = c.from('dotacoes').select('id_dotacao')
      .eq('id_unidade_fk', x.id_unidade_fk).eq('exercicio', ex).eq('origem', origem).eq('fonte_codigo', fonte).eq('acao_codigo', acao);
    const { data: existe } = await q;
    if (existe && existe.length)
      return { ok: false, erro: 'Já existe dotação desta unidade em ' + ex + ' com a mesma ação, origem e fonte. Cadastre outra combinação ou ajuste os repasses.' };
    const { error } = await c.from('dotacoes').insert({
      id_unidade_fk: x.id_unidade_fk, exercicio: ex, valor_total: Number(x.valor_total),
      origem, fonte_codigo: fonte, acao_codigo: acao, previsao: !!x.previsao,
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
    // Saldo livre da subunidade (recebido − repassado − demandas, já
    // descontadas as devoluções à Reitoria), calculado pelo banco.
    const { data: livreDest, error: eL } = await c.rpc('saldo_livre_unidade',
      { p_unidade: dist.id_unidade_destino_fk, p_exercicio: exercicio });
    if (eL) return { ok: false, erro: _erro(eL) };
    const livre = Math.min(Number(dist.valor), Number(livreDest || 0));
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

  // ─── Monitoramento da execução (etapa 3 — 04/11/2026) ──────────────────────
  // O Monitoramento acompanha a cadeia DEM → REQ → SOL → empenho → liquidação,
  // lança liquidações e pagamentos, define prazos para requisitar e cobra.
  // O da Reitoria vê tudo (com a chave Ver); o de um campus, só o seu campus.
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
    const c = await sb();
    const { data: cats } = await c.from('categorias_despesa').select('id_categoria,nome').order('nome');
    return {
      ok: true, papel: p.papel, raiz, opcoes_escopo: opcoes,
      unidade: un ? { id: un.id_unidade, sigla: un.sigla, nome: un.nome } : null,
      pode_editar: p.papel === 'monitoramento' || (p.papel === 'licitacoes' && !p.id_unidade_fk),
      exercicio: await _exercicioAtual(), categorias: cats || [],
      unidades: arv.lista.map(u => ({ id: u.id_unidade, sigla: u.sigla, nome: u.nome, tipo: u.tipo, pai: u.id_unidade_pai })),
    };
  },

  async mon_dados({ exercicio, escopo } = {}) {
    const c = await sb();
    const ex = Number(exercicio || await _exercicioAtual());
    const arv = await _arvore();
    const dentro = _filtroEscopo(arv, escopo);
    const [rD, rR, rS, rE, rC, rL, rI, rP, rPD, rCo] = await Promise.all([
      c.from('v_demandas_saldo').select('*').eq('exercicio', ex).order('codigo'),
      c.from('v_requisicoes').select('*').eq('exercicio', ex).neq('situacao', 'cancelada').order('codigo'),
      c.from('v_solicitacoes').select('*').eq('exercicio', ex).order('codigo'),
      c.from('v_empenhos').select('*').eq('exercicio', ex).order('numero'),
      c.from('empenho_cobertura').select('id_empenho,id_requisicao,valor'),
      c.from('v_liquidacoes').select('*').eq('exercicio', ex).order('data', { ascending: false }),
      c.from('liquidacao_itens').select('id_liquidacao,id_requisicao,valor'),
      c.from('prazos_requisicao').select('*').eq('exercicio', ex),
      c.from('prazos_demanda').select('*'),
      c.from('cobrancas').select('id_cobranca,id_demanda,data_cobranca,canal').order('data_cobranca', { ascending: false }),
    ]);
    const erro = [rD, rR, rS, rE, rC, rL, rI, rP, rPD, rCo].find(r => r.error);
    if (erro) return { ok: false, erro: _erro(erro.error) };

    const reqs = (rR.data || []).filter(r => dentro(r.id_unidade)).map(_numReq);
    const idsReq = new Set(reqs.map(r => r.id_requisicao));
    const cob = (rC.data || []).filter(x => idsReq.has(x.id_requisicao));
    const itens = (rI.data || []).filter(x => idsReq.has(x.id_requisicao));
    const todosOuRaiz = !escopo || escopo === 'todos';
    const empIds = new Set(cob.map(x => x.id_empenho));
    const empenhos = (rE.data || []).filter(e => empIds.has(e.id_empenho) || (todosOuRaiz && !_n(e.coberto))).map(_numEmp);
    const solIds = new Set(reqs.filter(r => r.id_solicitacao).map(r => r.id_solicitacao));
    const solicitacoes = (rS.data || []).filter(s => solIds.has(s.id_solicitacao) || dentro(s.id_unidade_gestora)).map(_numSol);
    const liqIds = new Set(itens.map(x => x.id_liquidacao));
    const liquidacoes = (rL.data || []).filter(l => liqIds.has(l.id_liquidacao)).map(_numLiq);
    const demandas = (rD.data || []).filter(d => dentro(d.id_unidade_fk))
      .map(d => _montarDemanda(d, arv, rP.data || [], rPD.data || [], rCo.data || []));

    // Calendário: a Reitoria vê e edita todos; um campus vê os da instituição e
    // os da sua estrutura, e edita só os da sua estrutura.
    const eu = await _meuPerfil();
    const minha = eu && eu.id_unidade_fk;
    const raiz = !minha || !arv.pai[minha];
    const minhaSub = minha ? arv.sub(minha) : [];
    const acima = []; { let x = minha, i = 0; while (x && i++ < 30) { acima.push(x); x = arv.pai[x]; } }
    const editor = eu && (eu.papel === 'monitoramento' || (eu.papel === 'licitacoes' && !eu.id_unidade_fk));
    const { data: cats } = await c.from('categorias_despesa').select('id_categoria,nome');
    const nomeCat = Object.fromEntries((cats || []).map(x => [x.id_categoria, x.nome]));
    const calendario = (rP.data || [])
      .filter(m => raiz || !m.id_unidade_escopo || minhaSub.includes(m.id_unidade_escopo) || acima.includes(m.id_unidade_escopo))
      .map(m => ({
        ...m, categoria_nome: m.id_categoria ? (nomeCat[m.id_categoria] || '') : 'Todas as categorias',
        escopo_nome: m.id_unidade_escopo ? ((arv.porId[m.id_unidade_escopo] || {}).sigla || '') : 'Toda a instituição',
        n_demandas: demandas.filter(d => d.prazo === m.data_limite && d.prazo_origem !== 'proprio').length,
        editavel: !!editor && (raiz || (!!m.id_unidade_escopo && minhaSub.includes(m.id_unidade_escopo))),
      })).sort((a, b) => String(a.data_limite).localeCompare(String(b.data_limite)));

    const soma = (l, k) => l.reduce((t, d) => t + _n(d[k]), 0);
    const agrupar = chave => {
      const g = {};
      demandas.forEach(d => {
        const k = d[chave] || 'Sem categoria';
        const x = g[k] = g[k] || { nome: k, n: 0, homologado: 0, requisitado: 0, aprovado: 0, empenhado: 0, liquidado: 0, pago: 0, vencidas: 0 };
        x.n++; ['requisitado','aprovado','empenhado','liquidado','pago'].forEach(f => x[f] += d[f]); x.homologado += d.valor_estimado;
        if (d.estado_prazo === 'vencido') x.vencidas++;
      });
      return Object.values(g).sort((a, b) => b.homologado - a.homologado);
    };
    const porSituacao = {};
    demandas.forEach(d => { porSituacao[d.situacao] = (porSituacao[d.situacao] || 0) + 1; });
    const pendencias = demandas.filter(d => d.estado_prazo === 'vencido' || d.estado_prazo === 'a_vencer')
      .sort((a, b) => (a.estado_prazo === b.estado_prazo ? 0 : a.estado_prazo === 'vencido' ? -1 : 1) || String(a.prazo).localeCompare(String(b.prazo)));
    // Saldo que pode voltar à Reitoria (decisão do Monitoramento, 09/11/2026):
    // economia (requisitado − real), demandas que não serão requisitadas e
    // demandas com prazo para requisitar vencido. O valor sugerido nunca passa
    // do "devolvível" calculado pelo banco.
    const residuos = demandas.filter(d => d.devolvivel > 0.005).map(d => {
      const economia = Math.max(0, d.residuo - d.devolvido);
      const motivo = d.encerrada ? 'nao_requisitada' : d.estado_prazo === 'vencido' ? 'prazo_encerrado'
                   : economia > 0.005 ? 'economia' : null;
      if (!motivo) return null;
      const valor = motivo === 'economia' ? Math.min(economia, d.devolvivel) : d.devolvivel;
      return { id_demanda: d.id_demanda, codigo_demanda: d.codigo, descricao_objeto: d.descricao_objeto,
               sigla_unidade: d.sigla_unidade, categoria: d.categoria, motivo, motivo_nome: MOTIVOS_DEVOLUCAO[motivo],
               detalhe: motivo === 'nao_requisitada' ? (d.motivo_encerramento || '') : motivo === 'prazo_encerrado' ? 'Prazo: ' + (d.prazo || '') : '',
               valor, devolvivel: d.devolvivel };
    }).filter(Boolean);
    const idsDem = new Set(demandas.map(d => d.id_demanda));
    const { data: devs } = await c.from('devolucoes_saldo')
      .select('*, demandas(codigo,descricao_objeto,id_unidade_fk), criador:perfis!devolucoes_saldo_criado_por_fkey(nome), desfez:perfis!devolucoes_saldo_desfeita_por_fkey(nome)')
      .eq('exercicio', ex).order('data_criacao', { ascending: false });
    const devolucoes = (devs || []).filter(v => idsDem.has(v.id_demanda)).map(v => ({
      ...v, valor: _n(v.valor), motivo_nome: MOTIVOS_DEVOLUCAO[v.motivo] || v.motivo,
      codigo_demanda: v.demandas ? v.demandas.codigo : '', descricao_objeto: v.demandas ? v.demandas.descricao_objeto : '',
      sigla_unidade: v.demandas ? ((arv.porId[v.demandas.id_unidade_fk] || {}).sigla || '') : '',
      autor: v.criador ? v.criador.nome : '', autor_desfez: v.desfez ? v.desfez.nome : '',
    }));
    return {
      ok: true, exercicio: ex, demandas, requisicoes: reqs, solicitacoes, empenhos, liquidacoes, calendario, pendencias, residuos, devolucoes,
      motivos_devolucao: MOTIVOS_DEVOLUCAO,
      cobertura: cob, itens_liquidacao: itens,
      conciliacao: _conciliar(reqs, empenhos),
      resumo: {
        n: demandas.length, homologado: soma(demandas, 'valor_estimado'), requisitado: soma(demandas, 'requisitado'),
        aprovado: soma(demandas, 'aprovado'), empenhado: soma(demandas, 'empenhado'), liquidado: soma(demandas, 'liquidado'),
        pago: soma(demandas, 'pago'), saldo_requisitar: soma(demandas.filter(d => !d.encerrada), 'saldo'),
        residuos: residuos.reduce((t, x) => t + x.valor, 0),
        devolvido: devolucoes.filter(v => !v.desfeita_em).reduce((t, v) => t + v.valor, 0),
        por_situacao: porSituacao, por_unidade: agrupar('sigla_unidade'), por_categoria: agrupar('categoria'),
        vencidos: pendencias.filter(p => p.estado_prazo === 'vencido').length,
        a_vencer: pendencias.filter(p => p.estado_prazo === 'a_vencer').length,
      },
    };
  },

  // Ficha da demanda: cadeia DEM → REQ → SOL → empenho → liquidação, prazo e cobranças.
  async mon_ficha({ id_demanda }) {
    const c = await sb();
    const arv = await _arvore();
    const { data: d, error } = await c.from('v_demandas_saldo').select('*').eq('id_demanda', id_demanda).maybeSingle();
    if (error) return { ok: false, erro: _erro(error) };
    if (!d) return { ok: false, erro: 'Demanda não encontrada ou não homologada.' };
    const [rR, rP, rPD, rCo, rDv] = await Promise.all([
      c.from('v_requisicoes').select('*').eq('id_demanda', id_demanda).order('codigo'),
      c.from('prazos_requisicao').select('*').eq('exercicio', d.exercicio),
      c.from('prazos_demanda').select('*').eq('id_demanda', id_demanda),
      c.from('cobrancas').select('*, perfis(nome)').eq('id_demanda', id_demanda).order('data_cobranca', { ascending: false }),
      c.from('devolucoes_saldo').select('*, criador:perfis!devolucoes_saldo_criado_por_fkey(nome), desfez:perfis!devolucoes_saldo_desfeita_por_fkey(nome)')
        .eq('id_demanda', id_demanda).order('data_criacao', { ascending: false }),
    ]);
    const reqs = (rR.data || []).map(_numReq);
    const ids = reqs.map(r => r.id_requisicao);
    let cob = [], itens = [];
    if (ids.length) {
      const [a, b] = await Promise.all([
        c.from('empenho_cobertura').select('id_requisicao,valor,empenhos(numero,data_emissao,acao_governo,natureza_despesa)').in('id_requisicao', ids),
        c.from('liquidacao_itens').select('id_requisicao,valor,liquidacoes(documento,data)').in('id_requisicao', ids),
      ]);
      cob = a.data || []; itens = b.data || [];
    }
    return {
      ok: true,
      demanda: _montarDemanda(d, arv, rP.data || [], rPD.data || [], rCo.data || []),
      requisicoes: reqs.map(r => ({
        ...r,
        empenhos: cob.filter(x => x.id_requisicao === r.id_requisicao).map(x => ({ ...(x.empenhos || {}), valor: _n(x.valor) })),
        liquidacoes: itens.filter(x => x.id_requisicao === r.id_requisicao).map(x => ({ ...(x.liquidacoes || {}), valor: _n(x.valor) })),
      })),
      prazo_proprio: (rPD.data || [])[0] || null,
      cobrancas: (rCo.data || []).map(x => ({ ...x, autor: x.perfis ? x.perfis.nome : '' })),
      devolucoes: (rDv.data || []).map(v => ({ ...v, valor: _n(v.valor), motivo_nome: MOTIVOS_DEVOLUCAO[v.motivo] || v.motivo,
        autor: v.criador ? v.criador.nome : '', autor_desfez: v.desfez ? v.desfez.nome : '' })),
      motivos_devolucao: MOTIVOS_DEVOLUCAO,
    };
  },

  // Devolução de saldo à Reitoria: o banco confere perfil, escopo e limite.
  async dev_devolver({ id_demanda, valor, motivo, observacao }) {
    const c = await sb();
    const { data, error } = await c.rpc('dev_devolver', { p_demanda: id_demanda, p_valor: Number(valor),
      p_motivo: motivo, p_observacao: observacao || null });
    return error ? { ok: false, erro: _erro(error) } : { ok: true, id_devolucao: data };
  },

  async dev_desfazer({ id_devolucao, motivo }) {
    const c = await sb();
    const { error } = await c.rpc('dev_desfazer', { p_id: id_devolucao, p_motivo: motivo || '' });
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async mon_salvar_prazo(params) {
    const c = await sb();
    const p = await _meuPerfil();
    const x = params.prazo || params;
    if (!x.data_limite) return { ok: false, erro: 'Informe a data limite.' };
    const dados = { exercicio: Number(x.exercicio), id_unidade_escopo: x.id_unidade_escopo || null,
                    id_categoria: x.id_categoria ? Number(x.id_categoria) : null,
                    data_limite: x.data_limite, descricao: x.descricao || null };
    let r;
    if (x.id_prazo) r = await c.from('prazos_requisicao').update(dados).eq('id_prazo', x.id_prazo).select('id_prazo');
    else r = await c.from('prazos_requisicao').insert({ ...dados, criado_por: p.id_usuario }).select('id_prazo');
    if (r.error && /duplicate|unique/i.test(r.error.message)) return { ok: false, erro: 'Já existe um prazo para este escopo e categoria neste exercício; edite o existente.' };
    if (r.error && /row-level|42501/i.test(r.error.message)) return { ok: false, erro: 'Você só pode criar prazos para a sua estrutura; os de toda a instituição são da Reitoria.' };
    if (r.error) return { ok: false, erro: _erro(r.error) };
    return r.data && r.data.length ? { ok: true } : { ok: false, erro: 'Você não tem permissão para esta operação.' };
  },

  async mon_excluir_prazo({ id_prazo }) {
    const c = await sb();
    const { data, error } = await c.from('prazos_requisicao').delete().eq('id_prazo', id_prazo).select('id_prazo');
    if (error) return { ok: false, erro: _erro(error) };
    return data && data.length ? { ok: true } : { ok: false, erro: 'Você não tem permissão para esta operação.' };
  },

  // Prazo próprio da demanda (substitui o do calendário). Data vazia = volta ao calendário.
  async mon_prazo_demanda({ id_demanda, data_limite, motivo }) {
    const c = await sb();
    const p = await _meuPerfil();
    let r;
    if (!data_limite) r = await c.from('prazos_demanda').delete().eq('id_demanda', id_demanda);
    else r = await c.from('prazos_demanda').upsert({ id_demanda, data_limite, motivo: motivo || null, criado_por: p.id_usuario },
                                                    { onConflict: 'id_demanda' });
    return r.error ? { ok: false, erro: _erro(r.error) } : { ok: true };
  },

  async mon_cobrar({ id_demanda, canal, registro }) {
    const c = await sb();
    const p = await _meuPerfil();
    if (String(registro || '').trim().length < 5) return { ok: false, erro: 'Descreva a cobrança (mínimo 5 caracteres).' };
    const { error } = await c.from('cobrancas').insert({
      id_demanda, canal: CANAIS_COBRANCA.includes(canal) ? canal : 'sei', registro: String(registro).trim(), criado_por: p.id_usuario });
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async mon_resposta_cobranca({ id_cobranca, resposta, data_resposta }) {
    const c = await sb();
    const { error } = await c.from('cobrancas').update({
      resposta: resposta || null, data_resposta: data_resposta || new Date().toISOString().slice(0, 10) }).eq('id_cobranca', id_cobranca);
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  // "Não será requisitada": tira a demanda das pendências (motivo vazio = desfaz).
  async mon_encerrar({ id_demanda, motivo }) {
    const c = await sb();
    const p = await _meuPerfil();
    let r;
    if (!motivo) r = await c.from('encerramentos_demanda').delete().eq('id_demanda', id_demanda).select('id_demanda');
    else {
      if (String(motivo).trim().length < 5) return { ok: false, erro: 'Justifique por que o saldo não será requisitado.' };
      r = await c.from('encerramentos_demanda').upsert({ id_demanda, motivo: String(motivo).trim(), criado_por: p.id_usuario },
                                                       { onConflict: 'id_demanda' }).select('id_demanda');
    }
    if (r.error) return { ok: false, erro: _erro(r.error) };
    return r.data && r.data.length ? { ok: true } : { ok: false, erro: 'Você não tem permissão para esta operação.' };
  },

  // Liquidações e pagamentos (o banco confere escopo e saldos).
  async liq_detalhe({ id_liquidacao }) {
    const c = await sb();
    const [{ data: l, error }, { data: itens }, { data: pags }] = await Promise.all([
      c.from('v_liquidacoes').select('*').eq('id_liquidacao', id_liquidacao).maybeSingle(),
      c.from('liquidacao_itens').select('*').eq('id_liquidacao', id_liquidacao),
      c.from('pagamentos').select('*').eq('id_liquidacao', id_liquidacao).order('data'),
    ]);
    if (error) return { ok: false, erro: _erro(error) };
    if (!l) return { ok: false, erro: 'Liquidação não encontrada.' };
    return { ok: true, liquidacao: _numLiq(l), itens: (itens || []).map(i => ({ ...i, valor: _n(i.valor) })),
             pagamentos: (pags || []).map(x => ({ ...x, valor: _n(x.valor) })) };
  },

  async liq_salvar(params) {
    const c = await sb();
    const x = params.liquidacao || params;
    const { data, error } = await c.rpc('liq_salvar', {
      p_id: x.id_liquidacao || null, p_data: x.data || null, p_documento: x.documento || '',
      p_valor: Number(x.valor || 0), p_observacao: x.observacao || '',
      p_itens: (x.itens || []).map(i => ({ id_requisicao: i.id_requisicao, valor: Number(i.valor || 0) })),
    });
    return error ? { ok: false, erro: _erro(error) } : { ok: true, ...data };
  },

  async liq_excluir({ id_liquidacao }) {
    const c = await sb();
    const { error } = await c.rpc('liq_excluir', { p_id: id_liquidacao });
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async pag_salvar(params) {
    const c = await sb();
    const x = params.pagamento || params;
    const { error } = await c.rpc('pag_salvar', {
      p_id: x.id_pagamento || null, p_liquidacao: x.id_liquidacao, p_data: x.data || null,
      p_valor: Number(x.valor || 0), p_ordem_bancaria: x.ordem_bancaria || '', p_observacao: x.observacao || '',
    });
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async pag_excluir({ id_pagamento }) {
    const c = await sb();
    const { error } = await c.rpc('pag_excluir', { p_id: id_pagamento });
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  // ─── Solicitação de empenho (seção gestora) e empenhos (Orçamento) — etapa 2 ─
  async sol_gerar({ ids_requisicoes, observacao }) {
    const c = await sb();
    const { data, error } = await c.rpc('sol_gerar', { p_requisicoes: ids_requisicoes || [], p_observacao: observacao || '' });
    return error ? { ok: false, erro: _erro(error) } : { ok: true, ...data };
  },

  // acao: enviar | cancelar | retirar (gestor) | devolver (Orçamento)
  async sol_acao({ id_solicitacao, acao, motivo, id_requisicao }) {
    const c = await sb();
    const { data, error } = await c.rpc('sol_acao', { p_id: id_solicitacao, p_acao: acao, p_motivo: motivo || null,
                                                      p_requisicao: id_requisicao || null });
    return error ? { ok: false, erro: _erro(error) } : { ok: true, ...data };
  },

  // Solicitação completa (para a tela e para o relatório em PDF).
  async sol_detalhe({ id_solicitacao }) {
    const c = await sb();
    const [{ data: s, error }, { data: reqs }, { data: hist }] = await Promise.all([
      c.from('v_solicitacoes').select('*').eq('id_solicitacao', id_solicitacao).maybeSingle(),
      c.from('v_requisicoes').select('*').eq('id_solicitacao', id_solicitacao).order('codigo'),
      c.from('solicitacao_historico').select('*, perfis(nome)').eq('id_solicitacao', id_solicitacao).order('data_hora'),
    ]);
    if (error) return { ok: false, erro: _erro(error) };
    if (!s) return { ok: false, erro: 'Solicitação não encontrada.' };
    const ids = (reqs || []).map(r => r.id_requisicao);
    let cob = [];
    if (ids.length) {
      const { data } = await c.from('empenho_cobertura').select('id_requisicao,valor,id_empenho,empenhos(numero,data_emissao)').in('id_requisicao', ids);
      cob = data || [];
    }
    return {
      ok: true, solicitacao: _numSol(s),
      requisicoes: (reqs || []).map(_numReq).map(r => ({ ...r,
        empenhos: cob.filter(x => x.id_requisicao === r.id_requisicao).map(x => ({ id_empenho: x.id_empenho, valor: _n(x.valor), ...(x.empenhos || {}) })) })),
      historico: (hist || []).map(h => ({ ...h, autor: h.perfis ? h.perfis.nome : '' })),
    };
  },

  async emp_contexto() {
    const p = await _meuPerfil();
    if (!p) return { ok: false, erro: 'Sessão expirada.' };
    const c = await sb();
    const { data: fontes } = await c.from('fontes_recurso').select('codigo,nome').order('codigo');
    return {
      ok: true, papel: p.papel, pode_editar: p.papel === 'orcamento' || (p.papel === 'licitacoes' && !p.id_unidade_fk),
      exercicio: await _exercicioAtual(), fontes: fontes || [], origens: ORIGENS_DOTACAO,
    };
  },

  async emp_dados({ exercicio } = {}) {
    const c = await sb();
    const ex = Number(exercicio || await _exercicioAtual());
    const [rS, rE, rR, rC] = await Promise.all([
      c.from('v_solicitacoes').select('*').eq('exercicio', ex).not('situacao', 'in', '(elaboracao,cancelada)').order('data_envio', { ascending: false }),
      c.from('v_empenhos').select('*').eq('exercicio', ex).order('numero'),
      c.from('v_requisicoes').select('*').eq('exercicio', ex).not('id_solicitacao', 'is', null).order('codigo'),
      c.from('empenho_cobertura').select('id_empenho,id_requisicao,valor'),
    ]);
    const erro = [rS, rE, rR, rC].find(r => r.error);
    if (erro) return { ok: false, erro: _erro(erro.error) };
    const reqs = (rR.data || []).map(_numReq);
    const empenhos = (rE.data || []).map(_numEmp);
    return { ok: true, exercicio: ex, solicitacoes: (rS.data || []).map(_numSol), empenhos, requisicoes: reqs,
             cobertura: (rC.data || []).map(x => ({ ...x, valor: _n(x.valor) })), conciliacao: _conciliar(reqs, empenhos) };
  },

  async emp_detalhe({ id_empenho }) {
    const c = await sb();
    const [{ data: e, error }, { data: movs }, { data: cob }] = await Promise.all([
      c.from('v_empenhos').select('*').eq('id_empenho', id_empenho).maybeSingle(),
      c.from('empenho_movimentos').select('*').eq('id_empenho', id_empenho).order('data'),
      c.from('empenho_cobertura').select('id_requisicao,valor').eq('id_empenho', id_empenho),
    ]);
    if (error) return { ok: false, erro: _erro(error) };
    if (!e) return { ok: false, erro: 'Empenho não encontrado.' };
    const ids = (cob || []).map(x => x.id_requisicao);
    let reqs = [];
    if (ids.length) { const { data } = await c.from('v_requisicoes').select('*').in('id_requisicao', ids).order('codigo'); reqs = data || []; }
    return { ok: true, empenho: _numEmp(e), movimentos: (movs || []).map(m => ({ ...m, valor: _n(m.valor) })),
             cobertura: (cob || []).map(x => ({ ...x, valor: _n(x.valor), requisicao: _numReq(reqs.find(r => r.id_requisicao === x.id_requisicao) || {}) })) };
  },

  async emp_salvar({ empenho, cobertura }) {
    const c = await sb();
    const e = { ...empenho };
    const { data, error } = await c.rpc('emp_salvar', {
      p_id: e.id_empenho || null,
      p_dados: { numero: e.numero, data_emissao: e.data_emissao, origem: e.origem || '', fonte_codigo: e.fonte_codigo || '',
                 acao_governo: e.acao_governo || '', natureza_despesa: e.natureza_despesa || '',
                 valor_empenhado: Number(e.valor_empenhado || 0), id_instrumento: e.id_instrumento || '',
                 favorecido_cnpj: e.favorecido_cnpj || '', favorecido_nome: e.favorecido_nome || '', observacao: e.observacao || '' },
      p_cobertura: cobertura ? cobertura.map(x => ({ id_requisicao: x.id_requisicao, valor: Number(x.valor || 0) })) : null,
    });
    return error ? { ok: false, erro: _erro(error) } : { ok: true, ...data };
  },

  async emp_excluir({ id_empenho }) {
    const c = await sb();
    const { error } = await c.rpc('emp_excluir', { p_id: id_empenho });
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async emp_movimento({ id_empenho, tipo, valor, data, documento, observacao }) {
    const c = await sb();
    if (!['reforco', 'anulacao'].includes(tipo)) return { ok: false, erro: 'Tipo inválido.' };
    if (!(Number(valor) > 0) || !data) return { ok: false, erro: 'Informe valor e data.' };
    const { error } = await c.rpc('emp_movimento', { p_empenho: id_empenho, p_tipo: tipo, p_valor: Number(valor), p_data: data,
                                                     p_documento: documento || '', p_observacao: observacao || '' });
    return error ? { ok: false, erro: _erro(error) } : { ok: true };
  },

  async emp_excluir_movimento({ id_movimento }) {
    const c = await sb();
    const { error } = await c.rpc('emp_excluir_movimento', { p_id: id_movimento });
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
    let qs = c.from('v_solicitacoes').select('*').eq('exercicio', ex).neq('situacao', 'cancelada').order('codigo', { ascending: false });
    if (!ctx.admin_global) qs = qs.eq('id_unidade_gestora', ctx.unidade.id);
    const [{ data: inst, error: e1 }, { data: reqs, error: e2 }, { data: sols, error: e3 }] = await Promise.all([qi, qr, qs]);
    if (e1 || e2 || e3) return { ok: false, erro: _erro(e1 || e2 || e3) };
    return { ok: true, exercicio: ex, instrumentos: inst || [], requisicoes: (reqs || []).map(_numReq),
             solicitacoes: (sols || []).map(_numSol), admin_global: ctx.admin_global };
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
    const [{ data: pub, error: eD }, { data: saldos, error: eS }, { data: execPub }] = await Promise.all([
      c.from('pac_publico').select('*').eq('exercicio', Number(ex)),
      c.from('saldos_publicos').select('*').eq('exercicio', Number(ex)),
      c.from('execucao_publica').select('id_demanda,codigo,situacao,requisitado,aprovado,empenhado,liquidado').eq('exercicio', Number(ex)),
    ]);
    if (eD) return { ok: false, erro: _erro(eD) };
    if (eS) return { ok: false, erro: _erro(eS) };
    // Execução por demanda (só valores e situações — sem empenho, fornecedor ou nota fiscal).
    const execPorDem = {};
    (execPub || []).forEach(r => {
      const x = execPorDem[r.id_demanda] = execPorDem[r.id_demanda] || { n_req: 0, requisitado: 0, aprovado: 0, empenhado: 0, liquidado: 0, requisicoes: [] };
      x.n_req++; ['requisitado','aprovado','empenhado','liquidado'].forEach(k => x[k] += Number(r[k] || 0));
      x.requisicoes.push({ codigo: r.codigo, situacao: r.situacao, requisitado: Number(r.requisitado || 0) });
    });

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
        execucao: d.status === 'homologada'
          ? (execPorDem[d.id_demanda] || { n_req: 0, requisitado: 0, aprovado: 0, empenhado: 0, liquidado: 0, requisicoes: [] }) : null,
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
      unidades_arvore: (unidades || []).map(u => ({ id: u.id_unidade, sigla: u.sigla, nome: u.nome, tipo: u.tipo, pai: u.id_unidade_pai })),
      raiz_execucao: id_setor || id_unidade || null,
      total_valor: demandas.reduce((s, d) => s + Number(d.valor_estimado || 0), 0),
    };
  },

  // Acesso ao painel: aberto ao público (chave do administrador) ou só com login.
  async painel_acesso() {
    const c = await sb();
    const [{ data: { session } }, { data: aberto, error }] = await Promise.all([
      c.auth.getSession(), c.rpc('painel_publico_aberto'),
    ]);
    return { ok: true, logado: !!session, aberto: error ? false : !!aberto };
  },

  async painel_definir_publico({ aberto }) {
    const c = await sb();
    const { data, error } = await c.rpc('definir_painel_publico', { p_aberto: !!aberto });
    return error ? { ok: false, erro: _erro(error) } : { ok: true, aberto: !!data };
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
  requisicoes: 'Requisicoes.html', pedidos: 'Pedidos.html', instrumentos: 'Instrumentos.html', empenhos: 'Empenhos.html',
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
  empenhos:     { label: 'Empenhos', page: 'empenhos', icon: 'file' },
  execucao:     { label: 'Execução', page: 'monitoramento', icon: 'activity' },
  monitorar:    { label: 'Monitoramento', page: 'monitoramento', icon: 'activity' },
  painel:       { label: 'Painel', page: 'publico', icon: 'chart' },
};
const PMO_MENUS = {
  chefe_secao:   [_M.inicio, _M.minhas, _M.requisicoes, _M.pedidos, _M.execucao, _M.painel],
  chefia:        [_M.inicio, _M.minhas, _M.aprovar, _M.orcamento, _M.requisicoes, _M.pedidos, _M.execucao, _M.painel],
  ord_despesas:  [_M.inicio, _M.aprovacoes, _M.orcamento, _M.gut, _M.homologar, _M.pedidos, _M.monitorar, _M.painel],
  licitacoes:    [_M.inicio, _M.usuarios, _M.todas, _M.orcamento, _M.aprovacoes, _M.gut, _M.homologar,
                  _M.instrumentos, _M.requisicoes, _M.pedidos, _M.empenhos, _M.monitorar, _M.painel],
  monitoramento: [_M.inicio, _M.monitorar, _M.painel],
  orcamento:     [_M.inicio, _M.empenhos, _M.painel],
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
  chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  file: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/>',
};
// Exercícios oferecidos nos seletores: de 2026 até 2036 (ou dois anos à frente, se maior).
const PMO_ANO_INICIAL = 2026;
function PMO_ANOS() {
  const fim = Math.max(2036, new Date().getFullYear() + 2);
  const anos = []; for (let a = PMO_ANO_INICIAL; a <= fim; a++) anos.push(a);
  return anos;
}
window.PMO_ANOS = PMO_ANOS;
try {
  const e = sessionStorage.getItem('pac_exercicio');
  if (e && Number(e) < PMO_ANO_INICIAL) sessionStorage.removeItem('pac_exercicio');
} catch (e) {}
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

// ── Busca nas listas longas (09/11/2026) ─────────────────────────────────────
// Toda caixa de seleção com 15 opções ou mais (unidades, seções, instrumentos…)
// abre, ao clicar, uma lista com campo de busca. A caixa original continua no
// lugar e guarda o valor; a escolha dispara o evento "change" normalmente.
// Para desligar numa caixa específica: atributo data-sem-busca.
(function () {
  const MIN_OPCOES = 15;
  const norm = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const qualifica = s => s && s.tagName === 'SELECT' && !s.multiple && !(s.size > 1) && !s.disabled
    && !s.hasAttribute('data-sem-busca') && s.options.length >= MIN_OPCOES;

  function css() {
    if (document.getElementById('pmo-busca-css')) return;
    const st = document.createElement('style');
    st.id = 'pmo-busca-css';
    st.textContent = `
      .pmo-busca { position: fixed; z-index: 100000; background: #fff; border: 1px solid #B4B2A9; border-radius: 10px;
        box-shadow: 0 10px 30px rgba(0,0,0,.18); display: flex; flex-direction: column; overflow: hidden; font-family: inherit; }
      .pmo-busca input { margin: 8px; padding: 8px 10px; border: 1px solid #D3D1C7; border-radius: 8px; font-size: 13px; font-family: inherit; outline: none; }
      .pmo-busca input:focus { border-color: #534AB7; box-shadow: 0 0 0 3px rgba(83,74,183,.12); }
      .pmo-busca ul { list-style: none; margin: 0; padding: 0 0 6px; overflow-y: auto; }
      .pmo-busca li { padding: 7px 12px; font-size: 13px; cursor: pointer; color: #2C2C2A; line-height: 1.35; }
      .pmo-busca li.grupo { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; color: #888780; cursor: default; padding-top: 10px; }
      .pmo-busca li.ativo { background: #EEEDFE; color: #26215C; }
      .pmo-busca li.atual { font-weight: 600; }
      .pmo-busca li.desab { color: #B4B2A9; cursor: default; }
      .pmo-busca li mark { background: #FAEEDA; color: inherit; padding: 0; border-radius: 2px; }
      .pmo-busca .vazio-busca { padding: 10px 12px 14px; font-size: 12.5px; color: #888780; }`;
    document.head.appendChild(st);
  }

  let aberto = null;   // { sel, caixa, itens, ativo }

  function fechar(devolverFoco) {
    if (!aberto) return;
    const s = aberto.sel;
    aberto.caixa.remove();
    window.removeEventListener('resize', aoRolar, true);
    window.removeEventListener('scroll', aoRolar, true);
    aberto = null;
    if (devolverFoco) try { s.focus(); } catch (e) {}
  }
  function aoRolar(e) { if (aberto && !aberto.caixa.contains(e.target)) fechar(false); }

  function escolher(op) {
    if (!aberto || !op || op.disabled) return;
    const s = aberto.sel;
    fechar(true);
    if (s.value !== op.value) {
      s.value = op.value;
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function marcar(texto, termos) {
    const esc = t => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    if (!termos.length) return esc(texto);
    // marca o primeiro trecho de cada termo, comparando sem acentos
    const n = norm(texto);
    const marcas = [];
    termos.forEach(t => { const i = n.indexOf(t); if (i >= 0) marcas.push([i, i + t.length]); });
    marcas.sort((a, b) => a[0] - b[0]);
    let out = '', pos = 0;
    marcas.forEach(([a, b]) => { if (a < pos) return; out += esc(texto.slice(pos, a)) + '<mark>' + esc(texto.slice(a, b)) + '</mark>'; pos = b; });
    return out + esc(texto.slice(pos));
  }

  function desenhar() {
    const { sel, caixa } = aberto;
    const termos = norm(caixa.querySelector('input').value).split(/\s+/).filter(Boolean);
    const ul = caixa.querySelector('ul');
    const itens = [];
    let html = '', grupoAtual = null;
    Array.from(sel.options).forEach(op => {
      const texto = op.textContent.trim();
      if (termos.length && !termos.every(t => norm(texto).includes(t))) return;
      if (termos.length && op.value === '') return;   // "Selecione..." some durante a busca
      const g = op.parentElement && op.parentElement.tagName === 'OPTGROUP' ? op.parentElement.label : null;
      if (g !== grupoAtual) { if (g) html += `<li class="grupo">${marcar(g, [])}</li>`; grupoAtual = g; }
      const idx = itens.length;
      itens.push(op);
      html += `<li data-i="${idx}" class="${op.disabled ? 'desab' : ''}${op.value === sel.value && op.value !== '' ? ' atual' : ''}">${marcar(texto, termos)}</li>`;
    });
    ul.innerHTML = html || '';
    caixa.querySelector('.vazio-busca').style.display = itens.length ? 'none' : '';
    aberto.itens = itens;
    let ini = termos.length ? itens.findIndex(o => !o.disabled) : itens.findIndex(o => o.value === sel.value);
    if (ini < 0) ini = itens.findIndex(o => !o.disabled);
    ativar(ini, true);
  }

  function ativar(i, centralizar) {
    if (!aberto) return;
    const lis = aberto.caixa.querySelectorAll('li[data-i]');
    lis.forEach(li => li.classList.remove('ativo'));
    aberto.ativo = i;
    const li = aberto.caixa.querySelector(`li[data-i="${i}"]`);
    if (li) { li.classList.add('ativo'); li.scrollIntoView({ block: centralizar ? 'center' : 'nearest' }); }
  }

  function posicionar() {
    const { sel, caixa } = aberto;
    const r = sel.getBoundingClientRect();
    const larg = Math.min(Math.max(r.width, 320), window.innerWidth - 16);
    let esq = Math.min(Math.max(8, r.left), window.innerWidth - larg - 8);
    const abaixo = window.innerHeight - r.bottom - 12, acima = r.top - 12;
    const paraCima = abaixo < 240 && acima > abaixo;
    const alt = Math.min(380, Math.max(160, paraCima ? acima : abaixo));
    caixa.style.left = esq + 'px';
    caixa.style.width = larg + 'px';
    caixa.style.maxHeight = alt + 'px';
    if (paraCima) { caixa.style.top = ''; caixa.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
    else { caixa.style.bottom = ''; caixa.style.top = (r.bottom + 4) + 'px'; }
  }

  function abrir(sel) {
    fechar(false);
    css();
    const caixa = document.createElement('div');
    caixa.className = 'pmo-busca';
    caixa.innerHTML = '<input type="text" placeholder="Digite para buscar (sigla ou nome)…" autocomplete="off"><ul></ul><div class="vazio-busca" style="display:none">Nada encontrado.</div>';
    document.body.appendChild(caixa);
    aberto = { sel, caixa, itens: [], ativo: -1 };
    posicionar();
    const inp = caixa.querySelector('input');
    inp.addEventListener('input', desenhar);
    inp.addEventListener('keydown', e => {
      const n = aberto.itens.length;
      const passo = d => { let i = aberto.ativo; for (let k = 0; k < n; k++) { i = (i + d + n) % n; if (!aberto.itens[i].disabled) return ativar(i); } };
      if (e.key === 'ArrowDown') { e.preventDefault(); if (n) passo(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) passo(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (aberto.ativo >= 0) escolher(aberto.itens[aberto.ativo]); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fechar(true); }
      else if (e.key === 'Tab') { fechar(false); }
    });
    caixa.addEventListener('mousedown', e => {
      const li = e.target.closest('li[data-i]');
      if (li) { e.preventDefault(); escolher(aberto.itens[Number(li.dataset.i)]); }
      else if (e.target.tagName !== 'INPUT') e.preventDefault();
    });
    caixa.addEventListener('mousemove', e => {
      const li = e.target.closest('li[data-i]');
      if (li && Number(li.dataset.i) !== aberto.ativo && !aberto.itens[Number(li.dataset.i)].disabled) ativar(Number(li.dataset.i));
    });
    desenhar();
    window.addEventListener('resize', aoRolar, true);
    window.addEventListener('scroll', aoRolar, true);
    setTimeout(() => inp.focus(), 0);
  }

  // Clique na caixa: abre a busca no lugar da lista nativa.
  document.addEventListener('mousedown', e => {
    if (aberto && !aberto.caixa.contains(e.target)) {
      const mesmo = e.target === aberto.sel;
      fechar(false);
      if (mesmo) { e.preventDefault(); return; }
    }
    const s = e.target && e.target.closest ? e.target.closest('select') : null;
    if (e.button === 0 && qualifica(s)) { e.preventDefault(); s.focus(); abrir(s); }
  }, true);
  // Teclado: Enter, Espaço ou Alt+↓ com a caixa em foco também abrem a busca.
  document.addEventListener('keydown', e => {
    const s = e.target;
    if (!qualifica(s) || aberto) return;
    if (e.key === 'Enter' || e.key === ' ' || (e.altKey && e.key === 'ArrowDown') || e.key === 'F4') { e.preventDefault(); abrir(s); }
  }, true);
})();

// ── Máscaras de valor (R$) e CNPJ (09/11/2026) ───────────────────────────────
// Valor: todo campo numérico com centavos (step="0.01") vira texto formatado
// enquanto se digita (1.145.622,24). O código das telas continua lendo
// el.value como número simples ("1145622.24") e pode gravar el.value = 1500.
// CNPJ: campos cujo id contém "cnpj" formatam 00.000.000/0000-00.
(function () {
  const nativo = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const lerNat = el => nativo.get.call(el);
  const gravarNat = (el, v) => nativo.set.call(el, v);

  // "1.145.622,24" | "1145622,2" | "1500" → "1145622.24" | "1145622.2" | "1500"
  const paraNumero = t => String(t == null ? '' : t).trim().replace(/\./g, '').replace(',', '.').replace(/[^\d.\-]/g, '');
  const agrupar = int => int.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  // Formata o que está sendo digitado: só dígitos e uma vírgula, até 2 casas.
  const formatarDigitando = t => {
    t = String(t || '').replace(/[^\d,]/g, '');
    const i = t.indexOf(',');
    if (i < 0) return agrupar(t);
    const int = t.slice(0, i), dec = t.slice(i + 1).replace(/,/g, '').slice(0, 2);
    return (agrupar(int) || '0') + ',' + dec;
  };
  const formatarFinal = n => {
    if (n === '' || n == null || isNaN(Number(n))) return '';
    return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  function moeda(el) {
    if (el.dataset.moeda) return;
    const inicial = lerNat(el);
    el.dataset.moeda = '1';
    el.type = 'text';
    el.inputMode = 'decimal';
    el.autocomplete = 'off';
    if (!el.placeholder || el.placeholder === '0.00') el.placeholder = '0,00';
    Object.defineProperty(el, 'value', {
      configurable: true,
      get() { return paraNumero(lerNat(el)); },
      set(v) {
        const s = String(v == null ? '' : v);
        gravarNat(el, s === '' ? '' : formatarFinal(/,/.test(s) ? paraNumero(s) : s.replace(/[^\d.\-]/g, '')));
      },
    });
    Object.defineProperty(el, 'valueAsNumber', { configurable: true, get() { const v = el.value; return v === '' ? NaN : Number(v); } });
    gravarNat(el, inicial === '' ? '' : formatarFinal(inicial));
  }

  function cnpj(el) {
    if (el.dataset.cnpj) return;
    el.dataset.cnpj = '1';
    el.inputMode = 'numeric';
    el.maxLength = 18;
    if (!el.placeholder) el.placeholder = '00.000.000/0000-00';
    const v = lerNat(el);
    if (v) gravarNat(el, mascararCnpj(v));
  }
  function mascararCnpj(t) {
    const d = String(t || '').replace(/\D/g, '').slice(0, 14);
    return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
            .replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2');
  }

  // Reposiciona o cursor: mesmo número de dígitos (e vírgula) à esquerda.
  function reformatar(el, fn, conta) {
    const bruto = lerNat(el), pos = el.selectionStart == null ? bruto.length : el.selectionStart;
    const antes = Array.from(bruto.slice(0, pos)).filter(conta).length;
    const novo = fn(bruto);
    if (novo === bruto) return;
    gravarNat(el, novo);
    let n = 0, p = 0;
    while (p < novo.length && n < antes) { if (conta(novo[p])) n++; p++; }
    try { el.setSelectionRange(p, p); } catch (e) {}
  }

  // Captura no documento: roda antes do oninput da própria tela.
  document.addEventListener('input', e => {
    const el = e.target;
    if (!el || el.tagName !== 'INPUT') return;
    if (el.dataset.moeda) {
      // Ponto digitado (teclado americano/numérico) vale como vírgula decimal.
      if (e.data === '.') {
        const b = lerNat(el), pos = el.selectionStart;
        if (pos && b[pos - 1] === '.' && b.indexOf(',') < 0) {
          gravarNat(el, b.slice(0, pos - 1) + ',' + b.slice(pos));
          try { el.setSelectionRange(pos, pos); } catch (x) {}
        }
      }
      reformatar(el, formatarDigitando, c => /[\d,]/.test(c));
    } else if (el.dataset.cnpj) reformatar(el, mascararCnpj, c => /\d/.test(c));
  }, true);
  document.addEventListener('blur', e => {
    const el = e.target;
    if (el && el.tagName === 'INPUT' && el.dataset.moeda) { const v = el.value; gravarNat(el, v === '' ? '' : formatarFinal(v)); }
  }, true);

  function varrer(raiz) {
    if (!raiz.querySelectorAll) return;
    raiz.querySelectorAll('input[type="number"][step="0.01"]').forEach(moeda);
    raiz.querySelectorAll('input[id*="cnpj" i]').forEach(cnpj);
    if (raiz.matches && raiz.matches('input[type="number"][step="0.01"]')) moeda(raiz);
    if (raiz.matches && raiz.matches('input[id*="cnpj" i]')) cnpj(raiz);
  }
  const iniciar = () => {
    varrer(document);
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) varrer(n); })))
      .observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) iniciar(); else document.addEventListener('DOMContentLoaded', iniciar);
})();

})();

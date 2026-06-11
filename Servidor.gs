// =============================================================================
// SISTEMA PAC — Colégio Pedro II
// Fase 3 · Servidor principal (Web App) + Middleware de autenticação
// =============================================================================

// ─── ROTEADOR PRINCIPAL ──────────────────────────────────────────────────────

function doGet(e) {
  const page  = (e.parameter.page  || '').toLowerCase();
  const token = e.parameter.token  || '';

  if (page === '' || page === 'publico') {
    try {
      const exercicioAtual = _getConfig('exercicio_atual') || String(new Date().getFullYear());
      const normId = id => String(id || '').trim().replace(/^"|"$/g, '');
      const unidades = lerTodos(SHEET_NAMES.UNIDADES)
        .filter(u => ['reitoria','pro_reitoria','campus'].includes(String(u.tipo||'').toLowerCase().trim()))
        .sort((a,b) => String(a.nome||'').localeCompare(String(b.nome||'')))
        .map(u => ({
          id:    normId(u.id_unidade),
          nome:  String(u.nome  || ''),
          sigla: String(u.sigla || ''),
          tipo:  String(u.tipo  || ''),
        }));
      const anos = [];
      const anoBase = Number(exercicioAtual) || new Date().getFullYear();
      for (let a = anoBase - 3; a <= anoBase + 1; a++) anos.push(a);
      const tpl = HtmlService.createTemplateFromFile('Publico');
      tpl.dadosIniciais = JSON.stringify({ exercicioAtual: String(exercicioAtual), unidades, anos });
      return tpl.evaluate()
        .setTitle('PAC — Colégio Pedro II')
        .addMetaTag('viewport','width=device-width,initial-scale=1')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    } catch(err) {
      const tpl = HtmlService.createTemplateFromFile('Publico');
      tpl.dadosIniciais = JSON.stringify({ exercicioAtual: String(new Date().getFullYear()), unidades: [], anos: [] });
      return tpl.evaluate()
        .setTitle('PAC — Colégio Pedro II')
        .addMetaTag('viewport','width=device-width,initial-scale=1')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }
  }

  if (page === 'login')        return _servir('Login', {});
  if (page === 'trocar_senha') return _servir('TrocarSenha', { token });

  const sessao = _verificarSessao(token);
  if (!sessao) return _redirecionarLogin('Sessão expirada ou inválida.');

  const usuario = lerPor(SHEET_NAMES.USUARIOS, 'id_usuario', sessao.id_usuario);
  if (!usuario || String(usuario.ativo).toUpperCase() !== 'TRUE') return _redirecionarLogin('Usuário inativo.');

  if (String(usuario.primeiro_acesso).toUpperCase() === 'TRUE') {
    return _servir('TrocarSenha', { token, forcado: true });
  }

  const dadosPagina = { token };
  switch (page) {
    case 'dashboard':   return _servir('Dashboard',   dadosPagina);
    case 'demandas':    return _servir('Demandas',    dadosPagina);
    case 'aprovacoes':  return _servir('Aprovacoes',  dadosPagina);
    case 'orcamento':   return _servir('Orcamento',   dadosPagina);
    case 'prioridades': return _servir('Prioridades', dadosPagina);
    case 'homologacao': return _servir('Homologacao', dadosPagina);
    case 'admin':
      if (usuario.papel !== 'licitacoes') return _paginaErro('Acesso negado.');
      return _servir('Admin', dadosPagina);
    default: return _redirecionarLogin('Página não encontrada.');
  }
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const acao    = payload.acao  || '';
    const token   = payload.token || '';

    // Ações públicas (sem sessão) — usadas pelo painel público estático
    if (acao === 'dados_publicos_pac') {
      return _json(chamarAcaoPublica(acao, JSON.stringify(payload)));
    }

    // Demais ações (login, trocar_senha e ações autenticadas) — delega para
    // chamarAcao, que já implementa o conjunto completo de ações do sistema.
    return _json(chamarAcao(token, acao, JSON.stringify(payload)));
  } catch(err) {
    return _json({ ok: false, erro: err.message });
  }
}


// ─── AUTENTICAÇÃO ─────────────────────────────────────────────────────────────

function _acaoLogin(payload) {
  const { email, senha } = payload;
  if (!email || !senha) return { ok: false, erro: 'Informe e-mail e senha.' };

  const usuario = autenticar(email, senha);
  if (!usuario) return { ok: false, erro: 'E-mail ou senha incorretos.' };

  atualizar(SHEET_NAMES.USUARIOS, 'id_usuario', usuario.id_usuario, {
    ultimo_acesso: new Date().toISOString()
  });

  const token = criarSessao(usuario.id_usuario);
  return {
    ok:              true,
    token,
    papel:           usuario.papel,
    nome:            usuario.nome,
    primeiro_acesso: String(usuario.primeiro_acesso).toUpperCase() === 'TRUE',
  };
}

function _acaoTrocarSenha(payload) {
  const { token, senha_atual, senha_nova, senha_confirmacao } = payload;

  if (senha_nova !== senha_confirmacao)
    return { ok: false, erro: 'As senhas não conferem.' };
  if (senha_nova.length < 8)
    return { ok: false, erro: 'A senha deve ter no mínimo 8 caracteres.' };
  if (!/[A-Z]/.test(senha_nova) || !/[0-9]/.test(senha_nova))
    return { ok: false, erro: 'A senha deve conter ao menos uma letra maiúscula e um número.' };

  let idUsuario;
  if (token) {
    const sessao = _verificarSessao(token);
    if (!sessao) return { ok: false, erro: 'Sessão inválida.' };
    idUsuario = sessao.id_usuario;
  } else {
    return { ok: false, erro: 'Token ausente.' };
  }

  const usuario = lerPor(SHEET_NAMES.USUARIOS, 'id_usuario', idUsuario);
  if (!usuario) return { ok: false, erro: 'Usuário não encontrado.' };

  if (String(usuario.primeiro_acesso).toUpperCase() !== 'TRUE') {
    if (_sha256(senha_atual) !== usuario.senha_hash)
      return { ok: false, erro: 'Senha atual incorreta.' };
  }

  atualizar(SHEET_NAMES.USUARIOS, 'id_usuario', idUsuario, {
    senha_hash:      _sha256(senha_nova),
    primeiro_acesso: 'FALSE',
  });

  return { ok: true };
}

function _acaoLogout(token) {
  encerrarSessao(token);
  return { ok: true };
}

function _acaoDadosUsuario(usuario) {
  const unidade = usuario.id_unidade_fk
    ? lerPor(SHEET_NAMES.UNIDADES, 'id_unidade', usuario.id_unidade_fk)
    : null;
  return {
    ok: true,
    usuario: {
      id:            usuario.id_usuario,
      nome:          usuario.nome,
      email:         usuario.email,
      papel:         usuario.papel,
      unidade:       unidade ? unidade.nome : 'Administrador Global',
      sigla:         unidade ? unidade.sigla : '',
      id_unidade_fk: usuario.id_unidade_fk || '',
    }
  };
}


// ─── DEMANDAS ─────────────────────────────────────────────────────────────────

function _acaoListarDemandas(usuario, payload) {
  // Aceita exercício do payload; fallback robusto para CONFIG ou ano corrente
  const exercicio = (payload.exercicio && String(payload.exercicio).trim())
    || _getConfig('exercicio_atual')
    || String(new Date().getFullYear());

  let demandas = lerTodos(SHEET_NAMES.DEMANDAS)
    .filter(d => String(d.exercicio) === exercicio && d.status !== 'excluida');

  const normId = id => String(id || '').trim().replace(/^"|"$/g, '');

  if (usuario.papel === 'chefe_secao') {
    const idUnid = normId(usuario.id_unidade_fk);
    demandas = demandas.filter(d => normId(d.id_unidade_fk) === idUnid);
  } else if (usuario.papel === 'chefia') {
    const normIdUnid = normId(usuario.id_unidade_fk);
    if (payload.para_aprovacao) {
      const filhosDiretos = _obterSubordinadasDiretas(normIdUnid);
      demandas = demandas.filter(d => filhosDiretos.includes(normId(d.id_unidade_fk)));
    } else {
      const subordinadas = _obterSubordinadas(usuario.id_unidade_fk).map(normId);
      demandas = demandas.filter(d => subordinadas.includes(normId(d.id_unidade_fk)));
    }
  } else if (usuario.papel === 'ord_despesas' && usuario.id_unidade_fk) {
    if (payload.para_aprovacao) {
      const filhosDiretos = _obterSubordinadasDiretas(normId(usuario.id_unidade_fk));
      demandas = demandas.filter(d => filhosDiretos.includes(normId(d.id_unidade_fk)));
    } else {
      const subordinadas = _obterSubordinadas(usuario.id_unidade_fk).map(normId);
      demandas = demandas.filter(d => subordinadas.includes(normId(d.id_unidade_fk)));
    }
  } else if (usuario.papel === 'licitacoes' && usuario.id_unidade_fk) {
    const subordinadas = _obterSubordinadas(usuario.id_unidade_fk).map(normId);
    demandas = demandas.filter(d => subordinadas.includes(normId(d.id_unidade_fk)));
  }

  if (payload.status) {
    demandas = demandas.filter(d => d.status === payload.status);
  }

  const unidades = lerTodos(SHEET_NAMES.UNIDADES);
  const mapUnidades = {};
  unidades.forEach(u => { mapUnidades[u.id_unidade] = u.nome; });

  demandas = demandas.map(d => ({
    ...d,
    nome_unidade: mapUnidades[d.id_unidade_fk] || d.id_unidade_fk,
  }));

  return { ok: true, demandas, exercicio, exercicio_atual: _getConfig('exercicio_atual') };
}

function _acaoSalvarDemanda(usuario, payload) {
  _exigirPapel(usuario, ['chefe_secao','licitacoes']);

  const { demanda } = payload;
  const agora = new Date().toISOString();

  if (demanda.id_demanda) {
    const existente = lerPor(SHEET_NAMES.DEMANDAS, 'id_demanda', demanda.id_demanda);
    if (!existente) return { ok: false, erro: 'Demanda não encontrada.' };
    if (existente.status !== 'rascunho')
      return { ok: false, erro: 'Somente demandas em rascunho podem ser editadas.' };
    atualizar(SHEET_NAMES.DEMANDAS, 'id_demanda', demanda.id_demanda, {
      ...demanda,
      data_ultima_atualizacao: agora,
    });
    return { ok: true, id_demanda: demanda.id_demanda };
  } else {
    const id = _gerarUUID();
    const exDemanda = demanda.exercicio;
    if (!exDemanda)
      return { ok: false, erro: 'Exercício não informado. Selecione o ano no seletor do topo antes de salvar.' };
    inserir(SHEET_NAMES.DEMANDAS, {
      id_demanda:              id,
      id_unidade_fk:           usuario.id_unidade_fk,
      id_usuario_criou_fk:     usuario.id_usuario,
      exercicio:               exDemanda,
      status:                  'rascunho',
      data_criacao:            agora,
      data_ultima_atualizacao: agora,
      ...demanda,
    });
    return { ok: true, id_demanda: id };
  }
}

function _acaoEnviarDemanda(usuario, payload) {
  _exigirPapel(usuario, ['chefe_secao','chefia']);
  const { id_demanda, senha } = payload;

  if (_sha256(senha) !== usuario.senha_hash)
    return { ok: false, erro: 'Senha incorreta. A demanda não foi enviada.' };

  const demanda = lerPor(SHEET_NAMES.DEMANDAS, 'id_demanda', id_demanda);
  if (!demanda) return { ok: false, erro: 'Demanda não encontrada.' };
  if (demanda.status !== 'rascunho') return { ok: false, erro: 'Esta demanda já foi enviada.' };

  const idUnidade = usuario.id_unidade_fk;
  if (idUnidade) {
    const exercicio = String(demanda.exercicio || '');
    if (!exercicio) return { ok: false, erro: 'Exercício da demanda não definido.' };
    const todasDotacoes = lerTodos(SHEET_NAMES.DOTACOES)
      .filter(d => String(d.exercicio) === exercicio);
    const todasDist = lerTodos(SHEET_NAMES.DISTRIBUICOES);
    const normId = id => String(id || '').trim().replace(/^"|"$/g, '');
    const idUnidadeNorm = normId(idUnidade);

    let recebido = 0;
    todasDotacoes.forEach(dot => {
      if (normId(dot.id_unidade_fk) === idUnidadeNorm) {
        recebido += Number(dot.valor_total || 0);
      } else {
        recebido += todasDist
          .filter(d =>
            normId(d.id_dotacao_origem_fk) === normId(dot.id_dotacao) &&
            normId(d.id_unidade_destino_fk) === idUnidadeNorm &&
            Number(d.valor || 0) > 0
          )
          .reduce((s, d) => s + Number(d.valor || 0), 0);
      }
    });

    const comprometido = lerTodos(SHEET_NAMES.DEMANDAS)
      .filter(d =>
        normId(d.id_unidade_fk) === idUnidadeNorm &&
        String(d.exercicio) === exercicio &&
        ['submetida','de_acordo','homologada'].includes(d.status) &&
        normId(d.id_demanda) !== normId(id_demanda)
      )
      .reduce((s, d) => s + Number(d.valor_estimado || 0), 0);

    const saldo = recebido - comprometido;
    const valorDemanda = Number(demanda.valor_estimado || 0);

    if (recebido > 0 && valorDemanda > saldo) {
      return {
        ok: false,
        erro: 'Saldo insuficiente. Valor da demanda: R$ ' + valorDemanda.toFixed(2) +
              ' · Saldo disponível: R$ ' + saldo.toFixed(2) +
              '. Ajuste o valor ou aguarde liberação de orçamento.'
      };
    }
  }

  const responsaveis = filtrarPor(SHEET_NAMES.RESPONSAVEIS, 'id_demanda_fk', id_demanda);
  const papeisObrigatorios = ['gestor_titular','gestor_substituto','fiscal_titular','fiscal_substituto'];
  const faltando = papeisObrigatorios.filter(p => !responsaveis.map(r => r.papel).includes(p));
  if (faltando.length > 0)
    return { ok: false, erro: 'Cadastre todos os responsáveis técnicos antes de enviar. Faltando: ' + faltando.join(', ') };

  const agora = new Date().toISOString();
  atualizar(SHEET_NAMES.DEMANDAS, 'id_demanda', id_demanda, {
    status:     'submetida',
    data_envio: agora,
    data_ultima_atualizacao: agora,
  });

  inserir(SHEET_NAMES.APROVACOES, {
    id_aprovacao:    _gerarUUID(),
    id_demanda_fk:   id_demanda,
    id_usuario_fk:   usuario.id_usuario,
    acao:            'aprovacao',
    justificativa:   'Demanda submetida pelo chefe de seção.',
    data_hora:       agora,
    nivel_aprovacao: 'chefe_secao',
  });

  return { ok: true };
}

function _acaoAprovarDemanda(usuario, payload) {
  _exigirPapel(usuario, ['chefia','ord_despesas','licitacoes']);
  const { id_demanda, senha, justificativa } = payload;
  const normId = id => String(id || '').trim().replace(/^"|"$/g, '');

  if (_sha256(senha) !== usuario.senha_hash)
    return { ok: false, erro: 'Senha incorreta.' };

  const demanda = lerPor(SHEET_NAMES.DEMANDAS, 'id_demanda', id_demanda);
  if (!demanda) return { ok: false, erro: 'Demanda não encontrada.' };

  if ((usuario.papel === 'chefia' || (usuario.papel === 'ord_despesas' && usuario.id_unidade_fk && demanda.status === 'submetida'))
      && usuario.id_unidade_fk) {
    if (normId(usuario.id_unidade_fk) === normId(demanda.id_unidade_fk))
      return { ok: false, erro: 'Não é permitido aprovar demandas da própria unidade.' };
  }

  let novoStatus, nivelAprovacao;
  if (usuario.papel === 'ord_despesas' && usuario.id_unidade_fk && demanda.status === 'submetida') {
    const filhosDiretos = _obterSubordinadasDiretas(normId(usuario.id_unidade_fk));
    if (filhosDiretos.includes(normId(demanda.id_unidade_fk))) {
      novoStatus = 'de_acordo'; nivelAprovacao = 'chefia';
    } else {
      return { ok: false, erro: 'Esta demanda não é de uma subunidade direta sua.' };
    }
  } else if (usuario.papel === 'ord_despesas') {
    if (demanda.status !== 'priorizada')
      return { ok: false, erro: 'Apenas demandas priorizadas podem ser homologadas.' };
    novoStatus = 'homologada'; nivelAprovacao = 'ordenador';
  } else {
    novoStatus = 'de_acordo'; nivelAprovacao = 'chefia';
  }

  if (usuario.papel !== 'ord_despesas' && demanda.status !== 'submetida')
    return { ok: false, erro: 'Apenas demandas submetidas podem receber "De acordo".' };

  const agora = new Date().toISOString();
  atualizar(SHEET_NAMES.DEMANDAS, 'id_demanda', id_demanda, {
    status: novoStatus,
    data_ultima_atualizacao: agora,
  });

  inserir(SHEET_NAMES.APROVACOES, {
    id_aprovacao:    _gerarUUID(),
    id_demanda_fk:   id_demanda,
    id_usuario_fk:   usuario.id_usuario,
    acao:            novoStatus === 'homologada' ? 'homologacao' : 'de_acordo',
    justificativa:   justificativa || (novoStatus === 'de_acordo' ? 'De acordo.' : 'Homologado.'),
    data_hora:       agora,
    nivel_aprovacao: nivelAprovacao,
  });

  return { ok: true };
}

function _acaoReprovarDemanda(usuario, payload) {
  _exigirPapel(usuario, ['chefia','ord_despesas']);
  const { id_demanda, senha, justificativa } = payload;
  const normId = id => String(id || '').trim().replace(/^"|"$/g, '');

  if (!justificativa || justificativa.trim().length < 10)
    return { ok: false, erro: 'Informe uma justificativa com ao menos 10 caracteres.' };
  if (_sha256(senha) !== usuario.senha_hash)
    return { ok: false, erro: 'Senha incorreta.' };

  const _demandaRep = lerPor(SHEET_NAMES.DEMANDAS, 'id_demanda', id_demanda);
  if (_demandaRep && usuario.id_unidade_fk) {
    if (normId(_demandaRep.id_unidade_fk) === normId(usuario.id_unidade_fk))
      return { ok: false, erro: 'Não é permitido reprovar demandas da própria unidade.' };
    if (usuario.papel === 'chefia' || (usuario.papel === 'ord_despesas' && _demandaRep.status === 'submetida')) {
      const filhosDiretos = _obterSubordinadasDiretas(normId(usuario.id_unidade_fk));
      if (!filhosDiretos.includes(normId(_demandaRep.id_unidade_fk)))
        return { ok: false, erro: 'Esta demanda não pertence a uma subunidade direta sua.' };
    }
  }

  const agora = new Date().toISOString();
  atualizar(SHEET_NAMES.DEMANDAS, 'id_demanda', id_demanda, {
    status: 'reprovada',
    data_ultima_atualizacao: agora,
  });

  inserir(SHEET_NAMES.APROVACOES, {
    id_aprovacao:    _gerarUUID(),
    id_demanda_fk:   id_demanda,
    id_usuario_fk:   usuario.id_usuario,
    acao:            'reprovacao',
    justificativa,
    data_hora:       agora,
    nivel_aprovacao: usuario.papel === 'ord_despesas' ? 'ordenador' : 'chefia',
  });

  return { ok: true };
}


// ─── ORÇAMENTO ────────────────────────────────────────────────────────────────

function _acaoSalvarDotacao(usuario, payload) {
  const { dotacao } = payload;
  const agora = new Date().toISOString();

  if (dotacao.id_dotacao) {
    atualizar(SHEET_NAMES.DOTACOES, 'id_dotacao', dotacao.id_dotacao, dotacao);
    return { ok: true };
  }

  // Exercício deve vir obrigatoriamente do frontend
  const exercicioAlvo = dotacao.exercicio ? String(dotacao.exercicio) : null;
  if (!exercicioAlvo)
    return { ok: false, erro: 'Exercício não informado. Selecione o ano no seletor do topo antes de cadastrar a dotação.' };
  const idUnidAlvo    = dotacao.id_unidade_fk || usuario.id_unidade_fk;
  const normId2 = id => String(id || '').trim().replace(/^"|"$/g, '');

  const dotacaoExistente = lerTodos(SHEET_NAMES.DOTACOES).find(d =>
    String(d.exercicio).trim() === exercicioAlvo.trim() &&
    normId2(d.id_unidade_fk) === normId2(idUnidAlvo)
  );
  if (dotacaoExistente)
    return { ok: false, erro: 'Já existe uma dotação para esta unidade no exercício ' + exercicioAlvo + '.' };

  const id = _gerarUUID();
  inserir(SHEET_NAMES.DOTACOES, {
    id_dotacao:          id,
    id_unidade_fk:       idUnidAlvo,
    exercicio:           exercicioAlvo,
    valor_total:         dotacao.valor_total,
    valor_distribuido:   0,
    valor_solicitado:    0,
    status:              'aberto',
    id_usuario_criou_fk: usuario.id_usuario,
    data_criacao:        agora,
    observacao:          dotacao.observacao || '',
  });
  return { ok: true, id_dotacao: id };
}

function _acaoDistribuirOrcamento(usuario, payload) {
  const { id_dotacao, id_unidade_destino, valor, observacao, senha } = payload;

  if (_sha256(senha) !== usuario.senha_hash)
    return { ok: false, erro: 'Senha incorreta.' };

  const dotacao = lerPor(SHEET_NAMES.DOTACOES, 'id_dotacao', id_dotacao);
  if (!dotacao) return { ok: false, erro: 'Dotação não encontrada.' };

  const normId = id => String(id || '').trim().replace(/^"|"$/g, '');
  const idUnidade = usuario.id_unidade_fk ? normId(usuario.id_unidade_fk) : null;

  // Distribuições válidas desta dotação (valor > 0)
  const todasDist = filtrarPor(SHEET_NAMES.DISTRIBUICOES, 'id_dotacao_origem_fk', id_dotacao)
    .filter(d => Number(d.valor || 0) > 0);

  let saldoDisponivel;

  if (!idUnidade) {
    // Admin global: saldo = valor_total − o que saiu para filhos diretos da unidade dona
    const filhosDiretos = _obterSubordinadasDiretas(normId(dotacao.id_unidade_fk));
    const saiuNivel1 = todasDist
      .filter(d => filhosDiretos.includes(normId(d.id_unidade_destino_fk)))
      .reduce((s, d) => s + Number(d.valor || 0), 0);
    saldoDisponivel = Number(dotacao.valor_total) - saiuNivel1;
  } else {
    const eDono = normId(dotacao.id_unidade_fk) === idUnidade;
    const recebido = eDono
      ? Number(dotacao.valor_total)
      : todasDist
          .filter(d => normId(d.id_unidade_destino_fk) === idUnidade)
          .reduce((s, d) => s + Number(d.valor || 0), 0);

    // Repassado = o que saiu desta unidade para seus filhos DIRETOS
    const filhosDiretos = _obterSubordinadasDiretas(idUnidade);
    const repassado = todasDist
      .filter(d => filhosDiretos.includes(normId(d.id_unidade_destino_fk)))
      .reduce((s, d) => s + Number(d.valor || 0), 0);

    saldoDisponivel = recebido - repassado;
  }

  if (Number(valor) > saldoDisponivel)
    return { ok: false, erro: 'Valor excede o saldo disponível para sua unidade (R$ ' + saldoDisponivel.toFixed(2) + ').' };

  const agora = new Date().toISOString();
  inserir(SHEET_NAMES.DISTRIBUICOES, {
    id_distribuicao:       _gerarUUID(),
    id_dotacao_origem_fk:  id_dotacao,
    id_unidade_destino_fk: id_unidade_destino,
    id_usuario_fk:         usuario.id_usuario,
    valor,
    data_hora:             agora,
    observacao:            observacao || '',
  });

  atualizar(SHEET_NAMES.DOTACOES, 'id_dotacao', id_dotacao, {
    valor_distribuido: Number(dotacao.valor_distribuido) + Number(valor),
  });

  return { ok: true };
}

function _acaoEditarDistribuicao(usuario, payload) {
  const { id_distribuicao, valor, observacao, senha } = payload;
  const normId = id => String(id || '').trim().replace(/^"|"$/g, '');

  if (_sha256(senha) !== usuario.senha_hash) return { ok: false, erro: 'Senha incorreta.' };

  const dist = lerPor(SHEET_NAMES.DISTRIBUICOES, 'id_distribuicao', id_distribuicao);
  if (!dist) return { ok: false, erro: 'Distribuição não encontrada.' };

  const novoValor = Number(valor);
  if (novoValor < 0) return { ok: false, erro: 'Valor não pode ser negativo.' };

  const dotacao = lerPor(SHEET_NAMES.DOTACOES, 'id_dotacao', dist.id_dotacao_origem_fk);
  if (!dotacao) return { ok: false, erro: 'Dotação não encontrada.' };

  // Calcular saldo excluindo a distribuição atual
  const idOrigem = normId(dotacao.id_unidade_fk);
  const filhosOrigem = _obterSubordinadasDiretas(idOrigem);
  const todasDist = filtrarPor(SHEET_NAMES.DISTRIBUICOES, 'id_dotacao_origem_fk', dist.id_dotacao_origem_fk)
    .filter(d => Number(d.valor || 0) > 0);

  const totalRepassado = todasDist
    .filter(d =>
      normId(d.id_distribuicao) !== normId(id_distribuicao) &&
      filhosOrigem.includes(normId(d.id_unidade_destino_fk))
    )
    .reduce((s, d) => s + Number(d.valor || 0), 0);
  const saldoDisponivel = Number(dotacao.valor_total) - totalRepassado;

  if (novoValor > saldoDisponivel)
    return { ok: false, erro: 'Novo valor excede o saldo disponível (R$ ' + saldoDisponivel.toFixed(2) + ').' };

  const diff = novoValor - Number(dist.valor || 0);
  atualizar(SHEET_NAMES.DISTRIBUICOES, 'id_distribuicao', id_distribuicao, {
    valor: novoValor,
    observacao: observacao || dist.observacao || '',
  });
  atualizar(SHEET_NAMES.DOTACOES, 'id_dotacao', dist.id_dotacao_origem_fk, {
    valor_distribuido: Number(dotacao.valor_distribuido || 0) + diff,
  });
  return { ok: true };
}

function _acaoExcluirDistribuicao(usuario, payload) {
  const { id_distribuicao, senha } = payload;
  const normId = id => String(id || '').trim().replace(/^"|"$/g, '');

  if (_sha256(senha) !== usuario.senha_hash) return { ok: false, erro: 'Senha incorreta.' };

  const dist = lerPor(SHEET_NAMES.DISTRIBUICOES, 'id_distribuicao', id_distribuicao);
  if (!dist) return { ok: false, erro: 'Distribuição não encontrada.' };

  const dotacao = lerPor(SHEET_NAMES.DOTACOES, 'id_dotacao', dist.id_dotacao_origem_fk);
  if (dotacao) {
    atualizar(SHEET_NAMES.DOTACOES, 'id_dotacao', dist.id_dotacao_origem_fk, {
      valor_distribuido: Math.max(0, Number(dotacao.valor_distribuido || 0) - Number(dist.valor || 0)),
    });
  }
  atualizar(SHEET_NAMES.DISTRIBUICOES, 'id_distribuicao', id_distribuicao, {
    valor: 0,
    observacao: '[REMOVIDO] ' + (dist.observacao || ''),
  });
  return { ok: true };
}


// ─── PRIORIDADE GUT ───────────────────────────────────────────────────────────

function _acaoSalvarGut(usuario, payload) {
  _exigirPapel(usuario, ['ord_despesas','licitacoes']);
  const { id_demanda, gut_g, gut_u, gut_t, senha } = payload;

  if (_sha256(senha) !== usuario.senha_hash)
    return { ok: false, erro: 'Senha incorreta.' };

  const demanda = lerPor(SHEET_NAMES.DEMANDAS, 'id_demanda', id_demanda);
  if (!demanda) return { ok: false, erro: 'Demanda não encontrada.' };
  if (!['de_acordo','priorizada'].includes(demanda.status))
    return { ok: false, erro: 'Apenas demandas com "De acordo" podem ser priorizadas.' };

  const g = Number(gut_g), u = Number(gut_u), t = Number(gut_t);
  if (![1,2,3,4,5].includes(g) || ![1,2,3,4,5].includes(u) || ![1,2,3,4,5].includes(t))
    return { ok: false, erro: 'Notas devem ser entre 1 e 5.' };

  const gut_total = g * u * t;
  const agora = new Date().toISOString();

  atualizar(SHEET_NAMES.DEMANDAS, 'id_demanda', id_demanda, {
    gut_g, gut_u, gut_t, gut_total,
    status: 'priorizada',
    data_ultima_atualizacao: agora,
  });

  inserir(SHEET_NAMES.APROVACOES, {
    id_aprovacao:    _gerarUUID(),
    id_demanda_fk:   id_demanda,
    id_usuario_fk:   usuario.id_usuario,
    acao:            'priorizacao',
    justificativa:   'GUT: G=' + g + ' U=' + u + ' T=' + t + ' → ' + gut_total,
    data_hora:       agora,
    nivel_aprovacao: 'ordenador',
  });

  return { ok: true, gut_total };
}

function _acaoHomologarPlano(usuario, payload) {
  _exigirPapel(usuario, ['ord_despesas']);
  const { senha, exercicio } = payload;

  if (_sha256(senha) !== usuario.senha_hash)
    return { ok: false, erro: 'Senha incorreta.' };

  const exAtual = exercicio ? String(exercicio) : _getConfig('exercicio_atual');
  const demandas = lerTodos(SHEET_NAMES.DEMANDAS)
    .filter(d => String(d.exercicio) === exAtual && d.status === 'priorizada');

  if (demandas.length === 0)
    return { ok: false, erro: 'Não há demandas priorizadas para homologar neste exercício.' };

  const agora = new Date().toISOString();
  let homologadas = 0;

  demandas.forEach(d => {
    atualizar(SHEET_NAMES.DEMANDAS, 'id_demanda', d.id_demanda, {
      status: 'homologada',
      data_ultima_atualizacao: agora,
    });
    inserir(SHEET_NAMES.APROVACOES, {
      id_aprovacao:    _gerarUUID(),
      id_demanda_fk:   d.id_demanda,
      id_usuario_fk:   usuario.id_usuario,
      acao:            'homologacao',
      justificativa:   'Plano Anual de Contratações ' + exAtual + ' homologado pelo Ordenador de Despesas.',
      data_hora:       agora,
      nivel_aprovacao: 'ordenador',
    });
    homologadas++;
  });

  return { ok: true, homologadas, exercicio: exAtual, data_hora: agora };
}


// ─── ADMINISTRAÇÃO ────────────────────────────────────────────────────────────

function _acaoListarUsuarios(usuario) {
  const normId = id => String(id || '').trim().replace(/^"|"$/g, '');
  let todos = lerTodos(SHEET_NAMES.USUARIOS);
  if (usuario.papel === 'licitacoes' && usuario.id_unidade_fk) {
    const idProprio    = normId(usuario.id_unidade_fk);
    const subordinadas = _obterSubordinadas(idProprio).map(normId);
    todos = todos.filter(u => {
      const idU = normId(u.id_unidade_fk);
      if (!idU) return false;
      if (!subordinadas.includes(idU)) return false;
      if (u.papel === 'licitacoes' && normId(u.id_usuario) !== normId(usuario.id_usuario)) return false;
      return true;
    });
  }
  return {
    ok: true,
    usuarios: todos.map(u => ({
      id_usuario:      u.id_usuario,
      nome:            u.nome,
      email:           u.email,
      papel:           u.papel,
      id_unidade_fk:   u.id_unidade_fk,
      matricula_siape: u.matricula_siape || '',
      ativo:           u.ativo,
    })),
  };
}

function _acaoSalvarUsuario(payload, usuarioLogado) {
  const { usuario } = payload;
  const agora  = new Date().toISOString();
  const normId = id => String(id || '').trim().replace(/^"|"$/g, '');

  const ehSetorial = usuarioLogado && usuarioLogado.papel === 'licitacoes' && usuarioLogado.id_unidade_fk;
  if (ehSetorial) {
    const subordinadas = _obterSubordinadas(usuarioLogado.id_unidade_fk).map(normId);
    const idUnidAlvo   = normId(usuario.id_unidade_fk);
    if (!idUnidAlvo) return { ok: false, erro: 'Selecione uma unidade válida.' };
    if (!subordinadas.includes(idUnidAlvo)) return { ok: false, erro: 'Unidade fora do seu escopo.' };
    if (usuario.papel === 'licitacoes') return { ok: false, erro: 'Não é permitido criar outro perfil de Licitações.' };
  }

  if (usuario.id_usuario) {
    if (ehSetorial) {
      const alvo = lerPor(SHEET_NAMES.USUARIOS, 'id_usuario', usuario.id_usuario);
      if (!alvo) return { ok: false, erro: 'Usuário não encontrado.' };
      if (!alvo.id_unidade_fk) return { ok: false, erro: 'Sem permissão para editar este usuário.' };
      if (alvo.papel === 'licitacoes' && normId(alvo.id_usuario) !== normId(usuarioLogado.id_usuario))
        return { ok: false, erro: 'Sem permissão para editar outro perfil de Licitações.' };
      const subordinadas = _obterSubordinadas(usuarioLogado.id_unidade_fk).map(normId);
      if (!subordinadas.includes(normId(alvo.id_unidade_fk)))
        return { ok: false, erro: 'Usuário fora do seu escopo.' };
    }
    const { senha_hash, ...semSenha } = usuario;
    atualizar(SHEET_NAMES.USUARIOS, 'id_usuario', usuario.id_usuario, semSenha);
    return { ok: true };
  }

  const senhaInicial = _gerarSenhaInicial();
  const id = _gerarUUID();
  inserir(SHEET_NAMES.USUARIOS, {
    id_usuario:      id,
    nome:            usuario.nome,
    email:           usuario.email,
    senha_hash:      _sha256(senhaInicial),
    papel:           usuario.papel,
    id_unidade_fk:   usuario.id_unidade_fk || '',
    ativo:           'TRUE',
    primeiro_acesso: 'TRUE',
    data_criacao:    agora,
    ultimo_acesso:   '',
  });
  return { ok: true, id_usuario: id, senha_inicial: senhaInicial };
}

function _acaoDeletarUsuario(payload, usuarioLogado) {
  const { id_usuario } = payload;
  if (!id_usuario) return { ok: false, erro: 'ID não informado.' };
  const normId = id => String(id || '').trim().replace(/^"|"$/g, '');
  if (usuarioLogado && usuarioLogado.papel === 'licitacoes' && usuarioLogado.id_unidade_fk) {
    const alvo = lerPor(SHEET_NAMES.USUARIOS, 'id_usuario', id_usuario);
    if (!alvo || !alvo.id_unidade_fk) return { ok: false, erro: 'Sem permissão.' };
    const subordinadas = _obterSubordinadas(usuarioLogado.id_unidade_fk).map(normId);
    if (!subordinadas.includes(normId(alvo.id_unidade_fk))) return { ok: false, erro: 'Usuário fora do seu escopo.' };
  }
  atualizar(SHEET_NAMES.USUARIOS, 'id_usuario', id_usuario, { ativo: 'FALSE' });
  return { ok: true };
}

function _acaoResetarSenha(payload, usuarioLogado) {
  const { id_usuario } = payload;
  if (!id_usuario) return { ok: false, erro: 'ID não informado.' };
  const normId = id => String(id || '').trim().replace(/^"|"$/g, '');
  if (usuarioLogado && usuarioLogado.papel === 'licitacoes' && usuarioLogado.id_unidade_fk) {
    const alvo = lerPor(SHEET_NAMES.USUARIOS, 'id_usuario', id_usuario);
    if (!alvo || !alvo.id_unidade_fk) return { ok: false, erro: 'Sem permissão.' };
    const subordinadas = _obterSubordinadas(usuarioLogado.id_unidade_fk).map(normId);
    if (!subordinadas.includes(normId(alvo.id_unidade_fk))) return { ok: false, erro: 'Usuário fora do seu escopo.' };
  }
  const novaSenha = _gerarSenhaInicial();
  atualizar(SHEET_NAMES.USUARIOS, 'id_usuario', id_usuario, {
    senha_hash:      _sha256(novaSenha),
    primeiro_acesso: 'TRUE',
  });
  return { ok: true, senha_inicial: novaSenha };
}

function _acaoListarUnidades(usuario) {
  return {
    ok: true,
    unidades: lerTodos(SHEET_NAMES.UNIDADES)
      .filter(u => String(u.ativo).toUpperCase() === 'TRUE')
      .map(u => ({
        id_unidade:     u.id_unidade,
        nome:           u.nome,
        sigla:          u.sigla,
        tipo:           u.tipo,
        id_unidade_pai: u.id_unidade_pai,
      })),
  };
}


// ─── EXERCÍCIO ────────────────────────────────────────────────────────────────
// O exercício de trabalho é sempre enviado pelo frontend no payload de cada
// requisição. O CONFIG ('exercicio_atual') é somente leitura aqui — define
// apenas o ano padrão exibido ao carregar a página.
// NÃO existe mais uma ação para alterar o CONFIG via seletor, evitando
// colisão entre múltiplos usuários trabalhando em anos diferentes.


// ─── PAINEL PÚBLICO ───────────────────────────────────────────────────────────

function chamarAcaoPublica(acao, paramsJson) {
  try {
    const params = JSON.parse(paramsJson || '{}');
    if (acao === 'dados_publicos_pac') return _acaoDadosPublicos(params);
    return { ok: false, erro: 'Ação pública não reconhecida.' };
  } catch(e) {
    return { ok: false, erro: e.message };
  }
}

function _acaoDadosPublicos(payload) {
  const exercicio = payload.exercicio  ? String(payload.exercicio)  : _getConfig('exercicio_atual');
  const idUnidade = payload.id_unidade ? String(payload.id_unidade) : null;
  const idSetor   = payload.id_setor   ? String(payload.id_setor)   : null;
  const busca     = payload.busca      ? String(payload.busca).toLowerCase() : '';
  const status    = payload.status     ? String(payload.status)     : '';

  const normId   = id => String(id || '').trim().replace(/^"|"$/g, '');
  const unidades = lerTodos(SHEET_NAMES.UNIDADES);
  const usuarios = lerTodos(SHEET_NAMES.USUARIOS);
  const aprovacoes = lerTodos(SHEET_NAMES.APROVACOES);

  let idsEscopo = [];
  if (idUnidade) {
    idsEscopo = _obterSubordinadas(idUnidade);
  } else {
    idsEscopo = unidades.map(u => normId(u.id_unidade));
  }

  if (idSetor) {
    const subsSetor = _obterSubordinadas(idSetor);
    idsEscopo = idsEscopo.filter(id => subsSetor.includes(id));
  }

  let demandas = lerTodos(SHEET_NAMES.DEMANDAS)
    .filter(d => {
      if (String(d.exercicio) !== exercicio) return false;
      if (!idsEscopo.includes(normId(d.id_unidade_fk))) return false;
      if (status && d.status !== status) return false;
      if (busca && !String(d.descricao_objeto || '').toLowerCase().includes(busca)) return false;
      if (d.status === 'rascunho' || d.status === 'excluida') return false;
      return true;
    });

  demandas = demandas.map(d => {
    const u    = unidades.find(u => normId(u.id_unidade) === normId(d.id_unidade_fk));
    const aprs = aprovacoes.filter(a => normId(a.id_demanda_fk) === normId(d.id_demanda));

    const assinatura = (acao) => {
      const apr = aprs.filter(a => a.acao === acao).sort((a,b) => new Date(b.data_hora)-new Date(a.data_hora))[0];
      if (!apr) return null;
      const usr = usuarios.find(u => normId(u.id_usuario) === normId(apr.id_usuario_fk));
      return {
        nome:          usr ? usr.nome : '—',
        siape:         usr ? (usr.matricula_siape || '—') : '—',
        data:          apr.data_hora,
        justificativa: apr.justificativa || '',
      };
    };

    const aprReprovacao = aprs
      .filter(a => a.acao === 'reprovacao')
      .sort((a,b) => new Date(b.data_hora) - new Date(a.data_hora))[0];

    return {
      id_demanda:               d.id_demanda,
      descricao_objeto:         d.descricao_objeto,
      justificativa:            d.justificativa,
      quantidade:               d.quantidade,
      unidade_medida:           d.unidade_medida,
      valor_estimado:           d.valor_estimado,
      status:                   d.status,
      exercicio:                d.exercicio,
      gut_g:                    d.gut_g,
      gut_u:                    d.gut_u,
      gut_t:                    d.gut_t,
      gut_total:                d.gut_total,
      nome_unidade:             u ? u.nome : '—',
      sigla_unidade:            u ? u.sigla : '—',
      ass_envio:                assinatura('aprovacao'),
      ass_de_acordo:            assinatura('de_acordo'),
      ass_priorizacao:          assinatura('priorizacao'),
      ass_homologacao:          assinatura('homologacao'),
      ass_reprovacao:           assinatura('reprovacao'),
      justificativa_reprovacao: aprReprovacao ? aprReprovacao.justificativa : '',
    };
  });

  const dadosGrafico = {};
  if (idUnidade) {
    const filhasNivel1 = unidades.filter(u => normId(u.id_unidade_pai) === normId(idUnidade));
    filhasNivel1.forEach(u => {
      const subsIds = _obterSubordinadas(normId(u.id_unidade));
      const valor   = lerTodos(SHEET_NAMES.DEMANDAS)
        .filter(d =>
          String(d.exercicio) === exercicio &&
          d.status === 'homologada' &&
          subsIds.includes(normId(d.id_unidade_fk))
        )
        .reduce((s, d) => s + Number(d.valor_estimado || 0), 0);
      if (valor > 0) dadosGrafico[u.sigla || u.nome] = valor;
    });
  }

  const ordenadoras = unidades
    .filter(u => ['reitoria','pro_reitoria','campus'].includes(u.tipo))
    .sort((a,b) => a.nome.localeCompare(b.nome))
    .map(u => ({ id: normId(u.id_unidade), nome: u.nome, sigla: u.sigla, tipo: u.tipo }));

  const chefias = idUnidade
    ? unidades
        .filter(u => idsEscopo.includes(normId(u.id_unidade)) && normId(u.id_unidade) !== normId(idUnidade))
        .sort((a,b) => a.nome.localeCompare(b.nome))
        .map(u => ({ id: normId(u.id_unidade), nome: u.nome, sigla: u.sigla }))
    : [];

  const exercicioAtual = Number(_getConfig('exercicio_atual')) || new Date().getFullYear();
  const anos = [];
  for (let a = exercicioAtual - 3; a <= exercicioAtual + 1; a++) anos.push(a);

  const distribuicoesOrc = lerTodos(SHEET_NAMES.DISTRIBUICOES);
  const arvoreOrcamento  = idUnidade
    ? _construirArvoreOrcamento(idUnidade, exercicio, unidades, distribuicoesOrc)
    : [];

  return {
    ok: true,
    demandas,
    dadosGrafico,
    ordenadoras,
    chefias,
    anos,
    exercicio,
    arvoreOrcamento,
    total_valor: demandas.reduce((s,d) => s + Number(d.valor_estimado||0), 0),
  };
}

function _construirArvoreOrcamento(idUnidade, exercicio, unidades, distribuicoes) {
  const normId = id => String(id || '').trim().replace(/^"|"$/g, '');

  const dotacoes = lerTodos(SHEET_NAMES.DOTACOES)
    .filter(d => String(d.exercicio) === String(exercicio));
  const dotacoesIds = new Set(dotacoes.map(d => normId(d.id_dotacao)));

  const dotacaoPorUnidade = {};
  dotacoes.forEach(d => {
    dotacaoPorUnidade[normId(d.id_unidade_fk)] = Number(d.valor_total || 0);
  });

  // Distribuições válidas: do exercício corrente e valor > 0
  const distValidas = distribuicoes.filter(d =>
    Number(d.valor || 0) > 0 &&
    dotacoesIds.has(normId(d.id_dotacao_origem_fk))
  );

  // Recebido via distribuição por destino
  const recebidoViaDistribuicao = {};
  distValidas.forEach(d => {
    const dest = normId(d.id_unidade_destino_fk);
    recebidoViaDistribuicao[dest] = (recebidoViaDistribuicao[dest] || 0) + Number(d.valor || 0);
  });

  // Distribuído por unidade: soma do que cada unidade repassou para seus filhos DIRETOS
  const distribuido = {};
  distValidas.forEach(d => {
    const dest     = normId(d.id_unidade_destino_fk);
    const destUnid = unidades.find(u => normId(u.id_unidade) === dest);
    if (!destUnid) return;
    // O remetente é o pai hierárquico do destino
    const pai = normId(destUnid.id_unidade_pai);
    distribuido[pai] = (distribuido[pai] || 0) + Number(d.valor || 0);
  });

  function valorDaUnidade(idUnid) {
    const key = normId(idUnid);
    if (dotacaoPorUnidade[key] !== undefined) return dotacaoPorUnidade[key];
    return recebidoViaDistribuicao[key] || 0;
  }

  function getFilhos(idPai) {
    return unidades.filter(u =>
      normId(u.id_unidade_pai) === normId(idPai) &&
      normId(u.id_unidade)     !== normId(idPai)
    );
  }

  const visitados = {};
  function construirNo(idUnid, nivel) {
    if (nivel > 7) return null;
    const key = normId(idUnid);
    if (visitados[key]) return null;
    visitados[key] = true;
    try {
      const unid = unidades.find(u => normId(u.id_unidade) === key);
      if (!unid) return null;
      const recebido  = valorDaUnidade(key);
      const repassado = distribuido[key] || 0;
      const saldo     = recebido - repassado;
      const filhos    = getFilhos(key)
        .map(f => construirNo(normId(f.id_unidade), nivel + 1))
        .filter(n => n !== null)
        .sort((a,b) => b.saldo - a.saldo);
      if (recebido === 0 && filhos.length === 0) return null;
      return { id: key, nome: String(unid.nome||''), sigla: String(unid.sigla||''), nivel, recebido, repassado, saldo, filhos };
    } finally {
      delete visitados[key];
    }
  }

  try {
    const raiz = construirNo(normId(idUnidade), 0);
    return raiz ? [raiz] : [];
  } catch(e) {
    Logger.log('_construirArvoreOrcamento erro: ' + e.message);
    return [];
  }
}


// ─── AÇÕES DE LISTAGEM DE ORÇAMENTO (CORRIGIDA) ───────────────────────────────
// CORREÇÃO 1: valorRepassado agora usa o pai hierárquico do destino para
// garantir que só contabiliza distribuições de 1 grau (desta unidade → filhos diretos)

function _acaoListarDotacoes(usuario, payload) {
  const exercicio = payload.exercicio
    ? String(payload.exercicio).trim()
    : _getConfig('exercicio_atual');

  const todasDotacoes = lerTodos(SHEET_NAMES.DOTACOES)
    .filter(d => String(d.exercicio).trim() === exercicio);

  const todasDistribuicoes = lerTodos(SHEET_NAMES.DISTRIBUICOES);
  const normId = id => String(id || '').trim().replace(/^"|"$/g, '');

  // IDs das dotações válidas deste exercício
  const dotacoesIds = new Set(todasDotacoes.map(d => normId(d.id_dotacao)));

  // Distribuições válidas: somente do exercício corrente e com valor > 0
  const distValidas = todasDistribuicoes.filter(d =>
    dotacoesIds.has(normId(d.id_dotacao_origem_fk)) &&
    Number(d.valor || 0) > 0
  );

  const idUnidade = usuario.id_unidade_fk
    ? normId(usuario.id_unidade_fk)
    : null;

  // ── Admin global (licitacoes sem unidade): visão de todas as dotações ──────
  if (!idUnidade && usuario.papel === 'licitacoes') {
    const dotacoes = todasDotacoes.map(d => {
      const idDot = normId(d.id_dotacao);
      // Repassado = distribuições desta dotação cujo destino tem
      // como pai hierárquico a unidade dona da dotação (1 grau apenas)
      const filhosDiretos = _obterSubordinadasDiretas(normId(d.id_unidade_fk));
      const valorRepassado = distValidas
        .filter(x =>
          normId(x.id_dotacao_origem_fk) === idDot &&
          filhosDiretos.includes(normId(x.id_unidade_destino_fk))
        )
        .reduce((s, x) => s + Number(x.valor || 0), 0);

      const valorRecebido = Number(d.valor_total || 0);
      return {
        ...d,
        valor_recebido:            valorRecebido,
        valor_distribuido_proprio: valorRepassado,
        saldo_proprio:             valorRecebido - valorRepassado,
        e_dono: true,
      };
    });
    return { ok: true, dotacoes, exercicio };
  }

  // ── Usuário com unidade: visão centrada na sua unidade ─────────────────────
  const dotacoesIds2 = new Set();

  // Dotações onde esta unidade é dona
  todasDotacoes.forEach(d => {
    if (normId(d.id_unidade_fk) === idUnidade)
      dotacoesIds2.add(normId(d.id_dotacao));
  });

  // Dotações onde esta unidade recebeu distribuição
  distValidas.forEach(d => {
    if (normId(d.id_unidade_destino_fk) === idUnidade)
      dotacoesIds2.add(normId(d.id_dotacao_origem_fk));
  });

  const dotacoesRecebidas = [];

  dotacoesIds2.forEach(idDot => {
    const dotacao = todasDotacoes.find(d => normId(d.id_dotacao) === idDot);
    if (!dotacao) return;

    const eDono = normId(dotacao.id_unidade_fk) === idUnidade;

    // Quanto esta unidade RECEBEU desta dotação
    const valorRecebido = eDono
      ? Number(dotacao.valor_total || 0)
      : distValidas
          .filter(d =>
            normId(d.id_dotacao_origem_fk) === idDot &&
            normId(d.id_unidade_destino_fk) === idUnidade
          )
          .reduce((s, d) => s + Number(d.valor || 0), 0);

    // Quanto esta unidade REPASSOU para seus filhos DIRETOS
    // Identificado pelo pai hierárquico do destino = esta unidade
    const filhosDiretos = _obterSubordinadasDiretas(idUnidade);
    const valorRepassado = distValidas
      .filter(d =>
        normId(d.id_dotacao_origem_fk) === idDot &&
        filhosDiretos.includes(normId(d.id_unidade_destino_fk))
      )
      .reduce((s, d) => s + Number(d.valor || 0), 0);

    dotacoesRecebidas.push({
      ...dotacao,
      valor_recebido:            valorRecebido,
      valor_distribuido_proprio: valorRepassado,
      saldo_proprio:             valorRecebido - valorRepassado,
      e_dono:                    eDono,
    });
  });

  return { ok: true, dotacoes: dotacoesRecebidas, exercicio };
}

function _acaoListarDistribuicoes(usuario, payload) {
  const { id_dotacao } = payload;
  if (!id_dotacao) return { ok: false, erro: 'id_dotacao obrigatório.' };

  const todasDist = filtrarPor(SHEET_NAMES.DISTRIBUICOES, 'id_dotacao_origem_fk', id_dotacao);
  const idUnidade = usuario.id_unidade_fk;

  let distribuicoes = todasDist;
  if (idUnidade && usuario.papel !== 'licitacoes' && usuario.papel !== 'ord_despesas') {
    const subs = _obterSubordinadas(idUnidade);
    distribuicoes = todasDist.filter(d =>
      d.id_unidade_destino_fk === idUnidade ||
      subs.slice(1).includes(d.id_unidade_destino_fk)
    );
  }

  return { ok: true, distribuicoes };
}

function _acaoCancelarSaldoSubordinada(usuario, payload) {
  const { id_distribuicao, valor_cancelar, justificativa, senha } = payload;
  const normId = id => String(id || '').trim().replace(/^"|"$/g, '');

  if (_sha256(senha) !== usuario.senha_hash) return { ok: false, erro: 'Senha incorreta.' };
  if (!justificativa || justificativa.trim().length < 5) return { ok: false, erro: 'Justificativa obrigatória (mínimo 5 caracteres).' };

  const dist = lerPor(SHEET_NAMES.DISTRIBUICOES, 'id_distribuicao', id_distribuicao);
  if (!dist) return { ok: false, erro: 'Distribuição não encontrada.' };

  const normDest  = normId(dist.id_unidade_destino_fk);
  const dotacao   = lerPor(SHEET_NAMES.DOTACOES, 'id_dotacao', dist.id_dotacao_origem_fk);
  const exercicio = dotacao ? String(dotacao.exercicio || '') : '';

  const valorRecebido = Number(dist.valor || 0);
  if (valorRecebido <= 0) return { ok: false, erro: 'Esta distribuição já está zerada.' };

  const valorComprometido = lerTodos(SHEET_NAMES.DEMANDAS)
    .filter(d =>
      normId(d.id_unidade_fk) === normDest &&
      String(d.exercicio) === exercicio &&
      ['submetida','de_acordo','priorizada','homologada'].includes(d.status)
    )
    .reduce((s,d) => s + Number(d.valor_estimado||0), 0);

  const valorSubDistribuido = lerTodos(SHEET_NAMES.DISTRIBUICOES)
    .filter(d =>
      normId(d.id_dotacao_origem_fk) === normId(dist.id_dotacao_origem_fk) &&
      _obterSubordinadasDiretas(normDest).includes(normId(d.id_unidade_destino_fk)) &&
      Number(d.valor||0) > 0
    )
    .reduce((s,d) => s + Number(d.valor||0), 0);

  const saldoLivre = valorRecebido - valorComprometido - valorSubDistribuido;

  if (saldoLivre <= 0)
    return {
      ok: false,
      erro: 'Saldo livre da unidade é zero. Recebido: R$ ' + valorRecebido.toFixed(2) +
            ' | Comprometido: R$ ' + valorComprometido.toFixed(2) +
            ' | Redistribuído: R$ ' + valorSubDistribuido.toFixed(2) + '.',
    };

  const cancelar = Number(valor_cancelar || 0);
  if (cancelar <= 0 || cancelar > saldoLivre)
    return { ok: false, erro: 'Valor inválido. Saldo livre disponível: R$ ' + saldoLivre.toFixed(2) + '.' };

  atualizar(SHEET_NAMES.DISTRIBUICOES, 'id_distribuicao', id_distribuicao, {
    valor: valorRecebido - cancelar,
    observacao: (dist.observacao || '') + ' | [CANCELAMENTO PARCIAL R$ ' + cancelar.toFixed(2) + '] ' + justificativa,
  });

  if (dotacao) {
    atualizar(SHEET_NAMES.DOTACOES, 'id_dotacao', dist.id_dotacao_origem_fk, {
      valor_distribuido: Math.max(0, Number(dotacao.valor_distribuido||0) - cancelar),
    });
  }

  return { ok: true, valor_devolvido: cancelar, saldo_livre_anterior: saldoLivre };
}


// ─── FUNÇÕES EXPOSTAS AO google.script.run ────────────────────────────────────

function acaoLogin(email, senha) {
  try {
    const resp = _acaoLogin({ email, senha });
    if (resp.ok && resp.primeiro_acesso) resp.deve_trocar_senha = true;
    return resp;
  } catch(e) {
    return { ok: false, erro: e.message };
  }
}

function acaoTrocarSenha(tokenOuJson, senhaAtual, senhaNova, senhaConf) {
  try {
    let token, nova, conf, atual;
    if (typeof tokenOuJson === 'string' && tokenOuJson.startsWith('{')) {
      const parsed = JSON.parse(tokenOuJson);
      token = parsed.token;
      nova  = parsed.nova_senha || parsed.senha_nova;
      conf  = nova;
      atual = '';
    } else {
      token = tokenOuJson;
      atual = senhaAtual;
      nova  = senhaNova;
      conf  = senhaConf;
    }
    return _acaoTrocarSenha({ token, senha_atual: atual, senha_nova: nova, senha_confirmacao: conf });
  } catch(e) {
    return { ok: false, erro: e.message };
  }
}

function chamarAcao(token, acao, paramsJson) {
  try {
    const params  = JSON.parse(paramsJson || '{}');
    params.token  = token;
    params.acao   = acao;

    if (acao === 'login')        return _acaoLogin(params);
    if (acao === 'trocar_senha') return _acaoTrocarSenha(params);

    const sessao = _verificarSessao(token);
    if (!sessao) return { ok: false, erro: 'Sessão inválida ou expirada.' };

    const usuario = lerPor(SHEET_NAMES.USUARIOS, 'id_usuario', sessao.id_usuario);
    if (!usuario || String(usuario.ativo).toUpperCase() !== 'TRUE')
      return { ok: false, erro: 'Usuário inativo.' };

    switch (acao) {
      case 'dados_usuario':       return _acaoDadosUsuario(usuario);
      case 'logout':              return _acaoLogout(token);
      case 'listar_demandas':     return _acaoListarDemandas(usuario, params);
      case 'salvar_demanda':      return _acaoSalvarDemandaCompleta(usuario, params);
      case 'enviar_demanda':      return _acaoEnviarDemanda(usuario, params);
      case 'aprovar_demanda':     return _acaoAprovarDemanda(usuario, params);
      case 'reprovar_demanda':    return _acaoReprovarDemanda(usuario, params);
      case 'salvar_gut':          return _acaoSalvarGut(usuario, params);
      case 'homologar_plano':     return _acaoHomologarPlano(usuario, params);
      case 'listar_usuarios':
        _exigirPapel(usuario, ['licitacoes']);
        return _acaoListarUsuarios(usuario);
      case 'salvar_usuario':
        _exigirPapel(usuario, ['licitacoes']);
        return _acaoSalvarUsuario(params, usuario);
      case 'deletar_usuario':
        _exigirPapel(usuario, ['licitacoes']);
        return _acaoDeletarUsuario(params, usuario);
      case 'resetar_senha':
        _exigirPapel(usuario, ['licitacoes']);
        return _acaoResetarSenha(params, usuario);
      case 'listar_unidades':     return _acaoListarUnidades(usuario);
      case 'get_config_exercicio': return { ok: true, exercicio: _getConfig('exercicio_atual') };

      // exercício vem sempre no payload — sem ação de atualizar CONFIG

      case 'homologar_demandas':  return _acaoHomologarDemandas(usuario, params);
      case 'resumo_plano':        return _acaoResumoPlan(usuario, params);
      case 'listar_demandas_gut': return _acaoListarDemandasGut(usuario, params);
      case 'get_justificativa_reprovacao': {
        const { id_demanda } = params;
        const aprovacoes = filtrarPor(SHEET_NAMES.APROVACOES, 'id_demanda_fk', id_demanda);
        const reprovacao  = aprovacoes
          .filter(a => a.acao === 'reprovacao')
          .sort((a,b) => new Date(b.data_hora) - new Date(a.data_hora))[0];
        if (!reprovacao) return { ok: false, erro: 'Justificativa não encontrada.' };
        const autor = lerPor(SHEET_NAMES.USUARIOS, 'id_usuario', reprovacao.id_usuario_fk);
        return {
          ok:           true,
          justificativa: reprovacao.justificativa,
          data_hora:     reprovacao.data_hora,
          autor:         autor ? autor.nome : 'Chefia',
        };
      }
      case 'dados_publicos_pac':        return _acaoDadosPublicos(params);
      case 'excluir_demanda':           return _acaoExcluirDemanda(usuario, params);
      case 'reverter_status':           return _acaoReverterStatus(usuario, params);
      case 'listar_unidades_publico':   return _acaoListarUnidades(usuario);
      case 'debug_subordinadas': {
        const subs = usuario.id_unidade_fk ? _obterSubordinadas(usuario.id_unidade_fk) : [];
        const unidadeNome = usuario.id_unidade_fk
          ? (lerPor(SHEET_NAMES.UNIDADES, 'id_unidade', usuario.id_unidade_fk) || {}).nome || 'não encontrada'
          : 'sem unidade';
        const demandasSubs = lerTodos(SHEET_NAMES.DEMANDAS)
          .filter(d => subs.includes(d.id_unidade_fk) && d.status === 'submetida');
        return { ok: true, id_unidade: usuario.id_unidade_fk, nome_unidade: unidadeNome, subordinadas_ids: subs, total_subs: subs.length, demandas_submetidas: demandasSubs.length };
      }
      case 'listar_dotacoes':
        return _acaoListarDotacoes(usuario, params);
      case 'listar_distribuicoes':
        return _acaoListarDistribuicoes(usuario, params);
      case 'salvar_dotacao':
        _exigirPapel(usuario, ['chefia','ord_despesas','licitacoes']);
        return _acaoSalvarDotacao(usuario, params);
      case 'distribuir_orcamento':
        _exigirPapel(usuario, ['chefia','ord_despesas','licitacoes']);
        return _acaoDistribuirOrcamento(usuario, params);
      case 'editar_distribuicao':
        _exigirPapel(usuario, ['chefia','ord_despesas','licitacoes']);
        return _acaoEditarDistribuicao(usuario, params);
      case 'excluir_distribuicao':
        _exigirPapel(usuario, ['chefia','ord_despesas','licitacoes']);
        return _acaoExcluirDistribuicao(usuario, params);
      case 'cancelar_saldo_subordinada':
        _exigirPapel(usuario, ['chefia','ord_despesas','licitacoes']);
        return _acaoCancelarSaldoSubordinada(usuario, params);
      default:
        return { ok: false, erro: 'Ação desconhecida: ' + acao };
    }
  } catch(e) {
    return { ok: false, erro: e.message };
  }
}


// ─── AUXILIAR: salvar demanda completa com responsáveis ───────────────────────

function _acaoSalvarDemandaCompleta(usuario, payload) {
  _exigirPapel(usuario, ['chefe_secao','chefia','licitacoes']);

  const { demanda } = payload;
  const agora = new Date().toISOString();

  const gestorTit = demanda._gestor_tit || '';
  const gestorSub = demanda._gestor_sub || '';
  const fiscalTit = demanda._fiscal_tit || '';
  const fiscalSub = demanda._fiscal_sub || '';

  const demandaLimpa = { ...demanda };
  delete demandaLimpa._gestor_tit;
  delete demandaLimpa._gestor_sub;
  delete demandaLimpa._fiscal_tit;
  delete demandaLimpa._fiscal_sub;

  let idDemanda;

  if (demandaLimpa.id_demanda) {
    const existente = lerPor(SHEET_NAMES.DEMANDAS, 'id_demanda', demandaLimpa.id_demanda);
    if (!existente) return { ok: false, erro: 'Demanda não encontrada.' };
    if (existente.status !== 'rascunho')
      return { ok: false, erro: 'Somente demandas em rascunho podem ser editadas.' };
    atualizar(SHEET_NAMES.DEMANDAS, 'id_demanda', demandaLimpa.id_demanda, {
      ...demandaLimpa,
      data_ultima_atualizacao: agora,
    });
    idDemanda = demandaLimpa.id_demanda;

    const respAntigas = filtrarPor(SHEET_NAMES.RESPONSAVEIS, 'id_demanda_fk', idDemanda);
    respAntigas.forEach(r => {
      atualizar(SHEET_NAMES.RESPONSAVEIS, 'id_responsavel', r.id_responsavel, { papel: '__removido__' });
    });
  } else {
    idDemanda = _gerarUUID();
    // Exercício deve vir obrigatoriamente do frontend — nunca usa CONFIG como fallback
    // para evitar colisão entre usuários trabalhando em anos diferentes
    const exercicioAtual = demandaLimpa.exercicio;
    if (!exercicioAtual)
      return { ok: false, erro: 'Exercício não informado. Selecione o ano no seletor do topo antes de salvar.' };
    inserir(SHEET_NAMES.DEMANDAS, {
      id_demanda:              idDemanda,
      id_unidade_fk:           usuario.id_unidade_fk,
      id_usuario_criou_fk:     usuario.id_usuario,
      exercicio:               exercicioAtual,
      status:                  'rascunho',
      data_criacao:            agora,
      data_ultima_atualizacao: agora,
      ...demandaLimpa,
      exercicio:               exercicioAtual,
    });
  }

  const responsaveis = [
    { papel: 'gestor_titular',    nome: gestorTit },
    { papel: 'gestor_substituto', nome: gestorSub },
    { papel: 'fiscal_titular',    nome: fiscalTit },
    { papel: 'fiscal_substituto', nome: fiscalSub },
  ];

  responsaveis.filter(r => r.nome).forEach(r => {
    inserir(SHEET_NAMES.RESPONSAVEIS, {
      id_responsavel: _gerarUUID(),
      id_demanda_fk:  idDemanda,
      id_usuario_fk:  r.nome,
      papel:          r.papel,
    });
  });

  return { ok: true, id_demanda: idDemanda };
}


// ─── MATRIZ GUT ───────────────────────────────────────────────────────────────

function _acaoListarDemandasGut(usuario, payload) {
  _exigirPapel(usuario, ['ord_despesas','licitacoes']);
  const exercicio = payload.exercicio ? String(payload.exercicio) : _getConfig('exercicio_atual');

  let demandas = lerTodos(SHEET_NAMES.DEMANDAS)
    .filter(d =>
      String(d.exercicio) === exercicio &&
      ['de_acordo','priorizada'].includes(d.status)
    );

  const unidades = lerTodos(SHEET_NAMES.UNIDADES);
  demandas = demandas.map(d => {
    const u = unidades.find(u =>
      String(u.id_unidade).trim().replace(/^"|"$/g,'') ===
      String(d.id_unidade_fk).trim().replace(/^"|"$/g,'')
    );
    return { ...d, nome_unidade: u ? u.nome : '—', sigla_unidade: u ? u.sigla : '—' };
  });

  demandas.sort((a,b) => {
    if (a.status === 'priorizada' && b.status !== 'priorizada') return -1;
    if (b.status === 'priorizada' && a.status !== 'priorizada') return 1;
    return Number(b.gut_total||0) - Number(a.gut_total||0);
  });

  return { ok: true, demandas, exercicio };
}

function _acaoResumoPlan(usuario, payload) {
  _exigirPapel(usuario, ['ord_despesas','licitacoes']);
  const exercicio = payload.exercicio ? String(payload.exercicio) : _getConfig('exercicio_atual');

  const todasDemandas = lerTodos(SHEET_NAMES.DEMANDAS)
    .filter(d => String(d.exercicio) === exercicio);

  const priorizadas = todasDemandas.filter(d => d.status === 'priorizada');
  const homologadas = todasDemandas.filter(d => d.status === 'homologada');
  const de_acordo   = todasDemandas.filter(d => d.status === 'de_acordo');
  const submetidas  = todasDemandas.filter(d => d.status === 'submetida');
  const reprovadas  = todasDemandas.filter(d => d.status === 'reprovada');

  const unidades = lerTodos(SHEET_NAMES.UNIDADES);
  const normId   = id => String(id || '').trim().replace(/^"|"$/g, '');

  const listaPriorizadas = priorizadas
    .map(d => {
      const u = unidades.find(u => normId(u.id_unidade) === normId(d.id_unidade_fk));
      return { ...d, nome_unidade: u ? u.nome : '—', sigla_unidade: u ? u.sigla : '—' };
    })
    .sort((a,b) => Number(b.gut_total||0) - Number(a.gut_total||0));

  return {
    ok: true,
    exercicio,
    resumo: {
      total:               todasDemandas.length,
      priorizadas:         priorizadas.length,
      homologadas:         homologadas.length,
      de_acordo:           de_acordo.length,
      submetidas:          submetidas.length,
      reprovadas:          reprovadas.length,
      valor_total:         priorizadas.reduce((s,d) => s + Number(d.valor_estimado||0), 0),
      valor_homologado:    homologadas.reduce((s,d) => s + Number(d.valor_estimado||0), 0),
      plano_ja_homologado: homologadas.length > 0,
    },
    demandas: listaPriorizadas,
  };
}

function _acaoHomologarDemandas(usuario, payload) {
  _exigirPapel(usuario, ['ord_despesas']);
  const { ids_demandas, senha } = payload;

  if (_sha256(senha) !== usuario.senha_hash)
    return { ok: false, erro: 'Senha incorreta.' };
  if (!ids_demandas || ids_demandas.length === 0)
    return { ok: false, erro: 'Nenhuma demanda selecionada.' };

  const agora = new Date().toISOString();
  let homologadas = 0;

  ids_demandas.forEach(id => {
    const demanda = lerPor(SHEET_NAMES.DEMANDAS, 'id_demanda', id);
    if (!demanda || demanda.status !== 'priorizada') return;
    atualizar(SHEET_NAMES.DEMANDAS, 'id_demanda', id, {
      status: 'homologada',
      data_ultima_atualizacao: agora,
    });
    inserir(SHEET_NAMES.APROVACOES, {
      id_aprovacao:    _gerarUUID(),
      id_demanda_fk:   id,
      id_usuario_fk:   usuario.id_usuario,
      acao:            'homologacao',
      justificativa:   'Homologado pelo Ordenador de Despesas.',
      data_hora:       agora,
      nivel_aprovacao: 'ordenador',
    });
    homologadas++;
  });

  return { ok: true, homologadas, data_hora: agora };
}


// ─── EXCLUIR / REVERTER ───────────────────────────────────────────────────────

function _acaoExcluirDemanda(usuario, payload) {
  const { id_demanda } = payload;
  const normId = id => String(id || '').trim().replace(/^"|"$/g, '');

  const demanda = lerPor(SHEET_NAMES.DEMANDAS, 'id_demanda', id_demanda);
  if (!demanda) return { ok: false, erro: 'Demanda não encontrada.' };

  if (usuario.papel === 'chefe_secao') {
    if (demanda.status !== 'rascunho') return { ok: false, erro: 'Somente rascunhos podem ser excluídos.' };
    if (normId(demanda.id_unidade_fk) !== normId(usuario.id_unidade_fk)) return { ok: false, erro: 'Sem permissão.' };
  } else if (usuario.papel === 'licitacoes') {
    if (usuario.id_unidade_fk) {
      const subordinadas = _obterSubordinadas(usuario.id_unidade_fk).map(normId);
      if (!subordinadas.includes(normId(demanda.id_unidade_fk))) return { ok: false, erro: 'Demanda fora do seu escopo.' };
    }
  } else {
    return { ok: false, erro: 'Sem permissão para excluir demandas.' };
  }

  const agora = new Date().toISOString();
  atualizar(SHEET_NAMES.DEMANDAS, 'id_demanda', id_demanda, {
    status: 'excluida',
    data_ultima_atualizacao: agora,
  });
  inserir(SHEET_NAMES.APROVACOES, {
    id_aprovacao:    _gerarUUID(),
    id_demanda_fk:   id_demanda,
    id_usuario_fk:   usuario.id_usuario,
    acao:            'exclusao',
    justificativa:   'Demanda excluída por ' + usuario.nome,
    data_hora:       agora,
    nivel_aprovacao: usuario.papel,
  });
  return { ok: true };
}

function _acaoReverterStatus(usuario, payload) {
  _exigirPapel(usuario, ['licitacoes']);
  const { id_demanda, novo_status } = payload;

  const demanda = lerPor(SHEET_NAMES.DEMANDAS, 'id_demanda', id_demanda);
  if (!demanda) return { ok: false, erro: 'Demanda não encontrada.' };

  const normId = id => String(id || '').trim().replace(/^"|"$/g, '');

  const reversoes = {
    submetida:  { alvo: 'rascunho',  papeis: ['chefe_secao','chefia','ord_despesas','licitacoes'] },
    de_acordo:  { alvo: 'submetida', papeis: ['chefia','ord_despesas','licitacoes'] },
    priorizada: { alvo: 'de_acordo', papeis: ['ord_despesas','licitacoes'] },
    homologada: { alvo: 'priorizada',papeis: ['ord_despesas','licitacoes'] },
  };

  const regra = reversoes[demanda.status];
  if (!regra || regra.alvo !== novo_status)
    return { ok: false, erro: 'Reversão inválida: ' + demanda.status + ' → ' + novo_status + '.' };
  if (!regra.papeis.includes(usuario.papel))
    return { ok: false, erro: 'Seu perfil não pode reverter este status.' };

  if (usuario.papel === 'chefe_secao') {
    if (normId(demanda.id_unidade_fk) !== normId(usuario.id_unidade_fk))
      return { ok: false, erro: 'Sem permissão para reverter esta demanda.' };
  } else if (usuario.id_unidade_fk) {
    const subordinadas = _obterSubordinadas(usuario.id_unidade_fk).map(normId);
    if (!subordinadas.includes(normId(demanda.id_unidade_fk)))
      return { ok: false, erro: 'Demanda fora do seu escopo.' };
  }

  const agora = new Date().toISOString();
  atualizar(SHEET_NAMES.DEMANDAS, 'id_demanda', id_demanda, {
    status: novo_status,
    data_ultima_atualizacao: agora,
  });
  inserir(SHEET_NAMES.APROVACOES, {
    id_aprovacao:    _gerarUUID(),
    id_demanda_fk:   id_demanda,
    id_usuario_fk:   usuario.id_usuario,
    acao:            'reversao',
    justificativa:   'Status revertido de "' + demanda.status + '" para "' + novo_status + '" por ' + usuario.nome,
    data_hora:       agora,
    nivel_aprovacao: usuario.papel,
  });
  return { ok: true };
}


// ─── UTILITÁRIOS DO SERVIDOR ──────────────────────────────────────────────────

function _verificarSessao(token) {
  if (!token) return null;
  const idUsuario = validarSessao(token);
  if (!idUsuario) return null;
  return { id_usuario: idUsuario };
}

function _exigirPapel(usuario, papeisPermitidos) {
  if (!papeisPermitidos.includes(usuario.papel))
    throw new Error('Acesso negado. Seu perfil não tem permissão para esta ação.');
}

function _obterSubordinadas(idUnidade) {
  const todas  = lerTodos(SHEET_NAMES.UNIDADES);
  const idNorm = String(idUnidade).trim().replace(/^"|"$/g, '');
  const resultado = [idNorm];
  let mudou = true;
  while (mudou) {
    mudou = false;
    todas.forEach(u => {
      const uId  = String(u.id_unidade  || '').trim().replace(/^"|"$/g, '');
      const uPai = String(u.id_unidade_pai || '').trim().replace(/^"|"$/g, '');
      if (resultado.includes(uPai) && !resultado.includes(uId) && uId) {
        resultado.push(uId);
        mudou = true;
      }
    });
  }
  return resultado;
}

function _obterSubordinadasDiretas(idUnidade) {
  const normId = id => String(id || '').trim().replace(/^"|"$/g, '');
  return lerTodos(SHEET_NAMES.UNIDADES)
    .filter(u => normId(u.id_unidade_pai) === normId(idUnidade))
    .map(u => normId(u.id_unidade));
}

function _getConfig(chave) {
  const cfg = lerPor(SHEET_NAMES.CONFIG, 'chave', chave);
  return cfg ? cfg.valor : null;
}

function _gerarSenhaInicial() {
  const mais  = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const nums  = '23456789';
  const todos = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  s += mais[Math.floor(Math.random() * mais.length)];
  s += nums[Math.floor(Math.random() * nums.length)];
  for (let i = 0; i < 8; i++) s += todos[Math.floor(Math.random() * todos.length)];
  return s.split('').sort(() => Math.random() - 0.5).join('');
}

function _servir(template, dados) {
  const html = HtmlService.createTemplateFromFile(template);
  html.dados = JSON.stringify(dados);
  return html.evaluate()
    .setTitle('Sistema PAC — Colégio Pedro II')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function _redirecionarLogin(motivo) {
  const html = `<html><head><meta http-equiv="refresh" content="0;url=?page=login&erro=${encodeURIComponent(motivo)}"></head></html>`;
  return HtmlService.createHtmlOutput(html);
}

function _paginaErro(msg) {
  return HtmlService.createHtmlOutput(`
    <div style="font-family:sans-serif;padding:40px;text-align:center;">
      <h2 style="color:#A32D2D">Acesso negado</h2>
      <p>${msg}</p>
      <a href="?page=dashboard">Voltar</a>
    </div>`);
}
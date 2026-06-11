// =============================================================================
// SISTEMA PAC — Colégio Pedro II
// Fase 2 · Script de inicialização do banco de dados (Google Sheets)
// Execute: menu Ferramentas > Editor de Apps Script > colar este arquivo > Run
// =============================================================================

// ─── CONSTANTES GLOBAIS ──────────────────────────────────────────────────────

const SHEET_NAMES = {
  UNIDADES:             'UNIDADES',
  USUARIOS:             'USUARIOS',
  DOTACOES:             'DOTACOES',
  DISTRIBUICOES:        'DISTRIBUICOES',
  DEMANDAS:             'DEMANDAS',
  RESPONSAVEIS:         'RESPONSAVEIS_TECNICOS',
  APROVACOES:           'APROVACOES',
  SESSOES:              'SESSOES',
  CONFIG:               'CONFIG',
};

// Cor de destaque para cabeçalhos de cada aba (hexadecimal sem #)
const HEADER_COLORS = {
  UNIDADES:      '#3C3489',  // purple-800
  USUARIOS:      '#0C447C',  // blue-800
  DOTACOES:      '#085041',  // teal-800
  DISTRIBUICOES: '#085041',
  DEMANDAS:      '#712B13',  // coral-800
  RESPONSAVEIS:  '#712B13',
  APROVACOES:    '#633806',  // amber-800
  SESSOES:       '#444441',  // gray-800
  CONFIG:        '#444441',
};


// =============================================================================
// PONTO DE ENTRADA — execute esta função
// =============================================================================

function inicializarSistema() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.alert(
    'Inicializar Sistema PAC',
    'Este script irá criar (ou recriar) todas as abas do sistema.\n\n' +
    '⚠️  Abas existentes com o mesmo nome serão APAGADAS e recriadas.\n\n' +
    'Deseja continuar?',
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    _criarAbaUnidades(ss);
    _criarAbaUsuarios(ss);
    _criarAbaDotacoes(ss);
    _criarAbaDistribuicoes(ss);
    _criarAbaDemandas(ss);
    _criarAbaResponsaveis(ss);
    _criarAbaAprovacoes(ss);
    _criarAbaSessoes(ss);
    _criarAbaConfig(ss);
    _popularConfigInicial(ss);
    _popularUnidadeExemplo(ss);
    _popularUsuarioAdmin(ss);
    _protegerAbas(ss);
    _reorganizarAbas(ss);

    ui.alert(
      '✅  Sistema inicializado com sucesso!',
      'Todas as abas foram criadas.\n\n' +
      'Usuário administrador padrão:\n' +
      '  Login: admin@cp2.g12.br\n' +
      '  Senha: Admin@2025\n\n' +
      '⚠️  Troque a senha após o primeiro acesso.',
      ui.ButtonSet.OK
    );
  } catch (e) {
    ui.alert('Erro durante a inicialização', e.message, ui.ButtonSet.OK);
    throw e;
  }
}


// =============================================================================
// CRIAÇÃO DAS ABAS
// =============================================================================

function _criarAbaUnidades(ss) {
  const nome = SHEET_NAMES.UNIDADES;
  _removerAba(ss, nome);
  const sheet = ss.insertSheet(nome);

  const headers = [
    'id_unidade',
    'nome',
    'sigla',
    'tipo',
    'id_unidade_pai',
    'id_ordenador_fk',
    'ativo',
    'data_criacao',
  ];
  const descricoes = [
    'PK · UUID gerado pelo sistema',
    'Nome completo da unidade',
    'Sigla (ex: PROENS, DG-RJ)',
    'reitoria | campus | pro_reitoria | diretoria_sistêmica | diretoria_adm | diretoria_ped | coordenacao | secao',
    'FK → id_unidade (pai hierárquico; vazio = raiz)',
    'FK → id_usuario (ordenador de despesas desta unidade)',
    'TRUE | FALSE',
    'ISO 8601',
  ];

  _escreverCabecalho(sheet, headers, descricoes, HEADER_COLORS.UNIDADES);

  // Validação de dados: coluna "tipo" (coluna D = 4)
  const tiposValidos = ['reitoria','campus','pro_reitoria','diretoria_sistêmica',
                        'diretoria_adm','diretoria_ped','coordenacao','secao'];
  const regTipo = SpreadsheetApp.newDataValidation()
    .requireValueInList(tiposValidos, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange('D3:D1000').setDataValidation(regTipo);

  // Validação: ativo (coluna G = 7)
  const regBool = SpreadsheetApp.newDataValidation()
    .requireValueInList(['TRUE','FALSE'], true).build();
  sheet.getRange('G3:G1000').setDataValidation(regBool);

  _ajustarColunas(sheet, [220, 280, 80, 160, 220, 220, 60, 160]);
}


function _criarAbaUsuarios(ss) {
  const nome = SHEET_NAMES.USUARIOS;
  _removerAba(ss, nome);
  const sheet = ss.insertSheet(nome);

  const headers = [
    'id_usuario',
    'nome',
    'email',
    'senha_hash',
    'papel',
    'id_unidade_fk',
    'ativo',
    'primeiro_acesso',
    'data_criacao',
    'ultimo_acesso',
  ];
  const descricoes = [
    'PK · UUID',
    'Nome completo',
    'E-mail institucional (usado como login)',
    'SHA-256 da senha',
    'ord_despesas | chefia | chefe_secao | licitacoes',
    'FK → id_unidade',
    'TRUE | FALSE',
    'TRUE = deve trocar senha no próximo login',
    'ISO 8601',
    'ISO 8601',
  ];

  _escreverCabecalho(sheet, headers, descricoes, HEADER_COLORS.USUARIOS);

  const papeis = ['ord_despesas','chefia','chefe_secao','licitacoes'];
  const regPapel = SpreadsheetApp.newDataValidation()
    .requireValueInList(papeis, true).setAllowInvalid(false).build();
  sheet.getRange('E3:E1000').setDataValidation(regPapel);

  const regBool = SpreadsheetApp.newDataValidation()
    .requireValueInList(['TRUE','FALSE'], true).build();
  sheet.getRange('G3:G1000').setDataValidation(regBool);
  sheet.getRange('H3:H1000').setDataValidation(regBool);

  // Ocultar coluna de senha para leitura direta
  sheet.hideColumns(4);  // coluna D = senha_hash

  _ajustarColunas(sheet, [220, 240, 240, 220, 120, 220, 60, 100, 160, 160]);
}


function _criarAbaDotacoes(ss) {
  const nome = SHEET_NAMES.DOTACOES;
  _removerAba(ss, nome);
  const sheet = ss.insertSheet(nome);

  const headers = [
    'id_dotacao',
    'id_unidade_fk',
    'exercicio',
    'valor_total',
    'valor_distribuido',
    'valor_solicitado',
    'status',
    'id_usuario_criou_fk',
    'data_criacao',
    'observacao',
  ];
  const descricoes = [
    'PK · UUID',
    'FK → id_unidade',
    'Ano do exercício (ex: 2026)',
    'R$ · valor total alocado',
    'R$ · soma das distribuições para subunidades',
    'R$ · soma das demandas submetidas',
    'aberto | fechado',
    'FK → id_usuario',
    'ISO 8601',
    'Texto livre',
  ];

  _escreverCabecalho(sheet, headers, descricoes, HEADER_COLORS.DOTACOES);

  // Formato moeda nas colunas de valor (D, E, F)
  sheet.getRange('D3:F1000').setNumberFormat('R$ #,##0.00');

  const regStatus = SpreadsheetApp.newDataValidation()
    .requireValueInList(['aberto','fechado'], true).build();
  sheet.getRange('G3:G1000').setDataValidation(regStatus);

  _ajustarColunas(sheet, [220, 220, 80, 140, 140, 140, 80, 220, 160, 280]);
}


function _criarAbaDistribuicoes(ss) {
  const nome = SHEET_NAMES.DISTRIBUICOES;
  _removerAba(ss, nome);
  const sheet = ss.insertSheet(nome);

  const headers = [
    'id_distribuicao',
    'id_dotacao_origem_fk',
    'id_unidade_destino_fk',
    'id_usuario_fk',
    'valor',
    'data_hora',
    'observacao',
  ];
  const descricoes = [
    'PK · UUID',
    'FK → id_dotacao (dotação de onde saiu o recurso)',
    'FK → id_unidade (subunidade que recebe)',
    'FK → id_usuario (quem realizou a distribuição)',
    'R$ · valor distribuído',
    'ISO 8601',
    'Texto livre',
  ];

  _escreverCabecalho(sheet, headers, descricoes, HEADER_COLORS.DISTRIBUICOES);
  sheet.getRange('E3:E1000').setNumberFormat('R$ #,##0.00');
  _ajustarColunas(sheet, [220, 220, 220, 220, 140, 160, 280]);
}


function _criarAbaDemandas(ss) {
  const nome = SHEET_NAMES.DEMANDAS;
  _removerAba(ss, nome);
  const sheet = ss.insertSheet(nome);

  const headers = [
    'id_demanda',
    'id_unidade_fk',
    'id_usuario_criou_fk',
    'exercicio',
    'descricao_objeto',
    'justificativa',
    'quantidade',
    'unidade_medida',
    'valor_estimado',
    'tem_contrato_vigente',
    'risco_nao_prorrogacao',
    'exclusiva_unidade',
    'status',
    'gut_gravidade',
    'gut_urgencia',
    'gut_tendencia',
    'gut_pontuacao',
    'data_criacao',
    'data_envio',
    'data_ultima_atualizacao',
  ];
  const descricoes = [
    'PK · UUID',
    'FK → id_unidade',
    'FK → id_usuario',
    'Ano do exercício',
    'Descrição sucinta do objeto (item 8.3.2.1)',
    'Justificativa da necessidade (item 8.3.2.2)',
    'Quantidade / expectativa de consumo anual (8.3.2.3)',
    'Ex: unidade, serviço, m², hora',
    'R$ · estimativa preliminar (8.3.2.4)',
    'TRUE | FALSE · possui contrato vigente? (8.3.2.6)',
    'TRUE | FALSE · risco de não prorrogação?',
    'TRUE | FALSE · demanda exclusiva da unidade? (8.3.2.7)',
    'rascunho | submetida | aprovada | reprovada | priorizada | homologada',
    '1-5 · Gravidade (GUT)',
    '1-5 · Urgência (GUT)',
    '1-5 · Tendência (GUT)',
    'calculado: G×U×T',
    'ISO 8601',
    'ISO 8601',
    'ISO 8601',
  ];

  _escreverCabecalho(sheet, headers, descricoes, HEADER_COLORS.DEMANDAS);

  sheet.getRange('I3:I1000').setNumberFormat('R$ #,##0.00');

  const regBool = SpreadsheetApp.newDataValidation()
    .requireValueInList(['TRUE','FALSE'], true).build();
  sheet.getRange('J3:L1000').setDataValidation(regBool);

  const statusList = ['rascunho','submetida','aprovada','reprovada','priorizada','homologada'];
  const regStatus = SpreadsheetApp.newDataValidation()
    .requireValueInList(statusList, true).setAllowInvalid(false).build();
  sheet.getRange('M3:M1000').setDataValidation(regStatus);

  const regGut = SpreadsheetApp.newDataValidation()
    .requireNumberBetween(1, 5).setAllowInvalid(false).build();
  sheet.getRange('N3:P1000').setDataValidation(regGut);

  // Fórmula automática para pontuação GUT na coluna Q
  sheet.getRange('Q3').setFormula('=IF(AND(N3<>"",O3<>"",P3<>""),N3*O3*P3,"")');
  // Propagar fórmula pelas próximas 997 linhas
  sheet.getRange('Q3').copyTo(sheet.getRange('Q4:Q1000'));

  // Congelar coluna de ID e status para facilitar navegação
  sheet.setFrozenColumns(1);

  _ajustarColunas(sheet, [220,220,220,80,300,300,80,120,140,80,80,80,110,80,80,80,100,160,160,160]);
}


function _criarAbaResponsaveis(ss) {
  const nome = SHEET_NAMES.RESPONSAVEIS;
  _removerAba(ss, nome);
  const sheet = ss.insertSheet(nome);

  const headers = [
    'id_responsavel',
    'id_demanda_fk',
    'id_usuario_fk',
    'papel',
  ];
  const descricoes = [
    'PK · UUID',
    'FK → id_demanda',
    'FK → id_usuario (responsável técnico cadastrado)',
    'gestor_titular | gestor_substituto | fiscal_titular | fiscal_substituto',
  ];

  _escreverCabecalho(sheet, headers, descricoes, HEADER_COLORS.RESPONSAVEIS);

  const papeis = ['gestor_titular','gestor_substituto','fiscal_titular','fiscal_substituto'];
  const regPapel = SpreadsheetApp.newDataValidation()
    .requireValueInList(papeis, true).setAllowInvalid(false).build();
  sheet.getRange('D3:D1000').setDataValidation(regPapel);

  _ajustarColunas(sheet, [220, 220, 220, 200]);
}


function _criarAbaAprovacoes(ss) {
  const nome = SHEET_NAMES.APROVACOES;
  _removerAba(ss, nome);
  const sheet = ss.insertSheet(nome);

  const headers = [
    'id_aprovacao',
    'id_demanda_fk',
    'id_usuario_fk',
    'acao',
    'justificativa',
    'data_hora',
    'nivel_aprovacao',
  ];
  const descricoes = [
    'PK · UUID',
    'FK → id_demanda',
    'FK → id_usuario (quem realizou a ação)',
    'aprovacao | reprovacao | homologacao | priorizacao',
    'Obrigatório em caso de reprovação',
    'ISO 8601',
    'chefia | reitoria_dg | ordenador',
  ];

  _escreverCabecalho(sheet, headers, descricoes, HEADER_COLORS.APROVACOES);

  const acoes = ['aprovacao','reprovacao','homologacao','priorizacao'];
  const regAcao = SpreadsheetApp.newDataValidation()
    .requireValueInList(acoes, true).build();
  sheet.getRange('D3:D1000').setDataValidation(regAcao);

  const niveis = ['chefia','reitoria_dg','ordenador'];
  const regNivel = SpreadsheetApp.newDataValidation()
    .requireValueInList(niveis, true).build();
  sheet.getRange('G3:G1000').setDataValidation(regNivel);

  _ajustarColunas(sheet, [220, 220, 220, 120, 300, 160, 140]);
}


function _criarAbaSessoes(ss) {
  const nome = SHEET_NAMES.SESSOES;
  _removerAba(ss, nome);
  const sheet = ss.insertSheet(nome);

  const headers = [
    'id_sessao',
    'id_usuario_fk',
    'token',
    'data_criacao',
    'data_expiracao',
    'ip_origem',
    'ativa',
  ];
  const descricoes = [
    'PK · UUID',
    'FK → id_usuario',
    'Token gerado aleatoriamente (32 chars)',
    'ISO 8601',
    'ISO 8601 · criação + 8h',
    'IP do cliente (capturado via Session)',
    'TRUE | FALSE',
  ];

  _escreverCabecalho(sheet, headers, descricoes, HEADER_COLORS.SESSOES);
  sheet.hideColumns(3);  // ocultar token
  _ajustarColunas(sheet, [220, 220, 280, 160, 160, 140, 60]);
}


function _criarAbaConfig(ss) {
  const nome = SHEET_NAMES.CONFIG;
  _removerAba(ss, nome);
  const sheet = ss.insertSheet(nome);

  const headers = [
    'chave',
    'valor',
    'descricao',
    'data_atualizacao',
  ];
  const descricoes = [
    'PK · identificador único da configuração',
    'Valor da configuração',
    'Descrição legível',
    'ISO 8601',
  ];

  _escreverCabecalho(sheet, headers, descricoes, HEADER_COLORS.CONFIG);
  _ajustarColunas(sheet, [240, 200, 360, 160]);
}


// =============================================================================
// DADOS INICIAIS
// =============================================================================

function _popularConfigInicial(ss) {
  const sheet = ss.getSheetByName(SHEET_NAMES.CONFIG);
  const agora = new Date().toISOString();
  const configs = [
    ['exercicio_atual',       '2026',        'Ano do exercício corrente do planejamento',            agora],
    ['ciclo_aberto',          'FALSE',       'Controla se o ciclo de demandas está aberto',          agora],
    ['data_inicio_ciclo',     '',            'Data de abertura do ciclo (ISO 8601)',                  agora],
    ['data_fim_ciclo',        '',            'Data de encerramento do ciclo (ISO 8601)',              agora],
    ['valor_ploa_disponivel', '0',           'Valor total disponibilizado pelo PLOA (R$)',            agora],
    ['sessao_duracao_horas',  '8',           'Duração da sessão em horas antes de expirar',          agora],
    ['versao_sistema',        '1.0.0',       'Versão atual do sistema PAC',                          agora],
    ['email_suporte',         'tic@cp2.g12.br', 'E-mail da equipe de suporte do sistema',            agora],
  ];
  sheet.getRange(3, 1, configs.length, 4).setValues(configs);
}


function _popularUnidadeExemplo(ss) {
  const sheet = ss.getSheetByName(SHEET_NAMES.UNIDADES);
  const agora = new Date().toISOString();
  // Unidade raiz: Reitoria (sem pai)
  sheet.getRange('A3:H3').setValues([[
    _gerarUUID(),
    'Reitoria do Colégio Pedro II',
    'REIT',
    'reitoria',
    '',
    '',
    'TRUE',
    agora,
  ]]);
}


function _popularUsuarioAdmin(ss) {
  const sheet = ss.getSheetByName(SHEET_NAMES.USUARIOS);
  const agora = new Date().toISOString();
  // Senha padrão: Admin@2025 → hash SHA-256
  const senhaHash = _sha256('Admin@2025');
  sheet.getRange('A3:J3').setValues([[
    _gerarUUID(),
    'Administrador do Sistema',
    'admin@cp2.g12.br',
    senhaHash,
    'licitacoes',
    '',              // sem unidade vinculada — admin global
    'TRUE',
    'TRUE',          // primeiro_acesso = TRUE → força troca de senha
    agora,
    '',
  ]]);
}


// =============================================================================
// PROTEÇÃO DAS ABAS
// =============================================================================

function _protegerAbas(ss) {
  const abasProteger = [
    SHEET_NAMES.APROVACOES,
    SHEET_NAMES.SESSOES,
    SHEET_NAMES.CONFIG,
  ];

  abasProteger.forEach(nome => {
    const sheet = ss.getSheetByName(nome);
    if (!sheet) return;
    const prot = sheet.protect();
    prot.setDescription('Protegida — edição apenas via sistema');
    // Permite apenas o proprietário da planilha editar diretamente
    const eu = Session.getEffectiveUser();
    prot.addEditor(eu);
    prot.removeEditors(prot.getEditors().filter(e => e.getEmail() !== eu.getEmail()));
  });
}


// =============================================================================
// REORGANIZAR ABAS NA ORDEM LÓGICA
// =============================================================================

function _reorganizarAbas(ss) {
  const ordem = [
    SHEET_NAMES.CONFIG,
    SHEET_NAMES.UNIDADES,
    SHEET_NAMES.USUARIOS,
    SHEET_NAMES.DOTACOES,
    SHEET_NAMES.DISTRIBUICOES,
    SHEET_NAMES.DEMANDAS,
    SHEET_NAMES.RESPONSAVEIS,
    SHEET_NAMES.APROVACOES,
    SHEET_NAMES.SESSOES,
  ];
  ordem.forEach((nome, i) => {
    const sheet = ss.getSheetByName(nome);
    if (sheet) ss.setActiveSheet(sheet) && ss.moveActiveSheet(i + 1);
  });
}


// =============================================================================
// UTILITÁRIOS INTERNOS
// =============================================================================

/**
 * Escreve a linha 1 (rótulo do header) e linha 2 (descrição)
 * com formatação visual padronizada.
 */
function _escreverCabecalho(sheet, headers, descricoes, corFundo) {
  const nCols = headers.length;

  // Linha 1 — nomes das colunas
  const rangeHeader = sheet.getRange(1, 1, 1, nCols);
  rangeHeader.setValues([headers]);
  rangeHeader.setBackground(corFundo);
  rangeHeader.setFontColor('#FFFFFF');
  rangeHeader.setFontWeight('bold');
  rangeHeader.setFontSize(11);

  // Linha 2 — descrições (cinza claro, itálico)
  const rangeDesc = sheet.getRange(2, 1, 1, nCols);
  rangeDesc.setValues([descricoes]);
  rangeDesc.setBackground('#F1EFE8');
  rangeDesc.setFontColor('#5F5E5A');
  rangeDesc.setFontStyle('italic');
  rangeDesc.setFontSize(10);
  rangeDesc.setWrap(true);
  sheet.setRowHeight(2, 48);

  // Congelar as duas primeiras linhas
  sheet.setFrozenRows(2);

  // Cor alternada nas linhas de dados (começa na 3)
  const regra = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=MOD(ROW(),2)=1')
    .setBackground('#F8F7F4')
    .setRanges([sheet.getRange('A3:ZZ1000')])
    .build();
  sheet.setConditionalFormatRules([regra]);
}

function _removerAba(ss, nome) {
  const sheet = ss.getSheetByName(nome);
  if (sheet) ss.deleteSheet(sheet);
}

function _ajustarColunas(sheet, larguras) {
  larguras.forEach((w, i) => sheet.setColumnWidth(i + 1, w));
}

/**
 * Gera um UUID v4 simples usando Math.random.
 * No AppScript não há crypto.randomUUID — esta implementação é suficiente
 * para IDs internos.
 */
function _gerarUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/**
 * SHA-256 via Utilities.computeDigest do Apps Script.
 * Retorna string hexadecimal.
 */
function _sha256(texto) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    texto,
    Utilities.Charset.UTF_8
  );
  return bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}


// =============================================================================
// FUNÇÕES DE CRUD GENÉRICO
// Estas funções serão usadas por todos os módulos do sistema nas fases seguintes
// =============================================================================

/**
 * Retorna todos os registros de uma aba como array de objetos.
 * A linha 1 é o cabeçalho, a linha 2 é a descrição — dados começam na linha 3.
 */
function lerTodos(nomeAba) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(nomeAba);
  if (!sheet) throw new Error('Aba não encontrada: ' + nomeAba);

  const dados = sheet.getDataRange().getValues();
  if (dados.length < 3) return [];

  const headers = dados[0];  // linha 1
  return dados.slice(2).map(row => {  // pula linha de descrição (linha 2)
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  }).filter(obj => obj[headers[0]] !== '');  // ignora linhas vazias
}

/**
 * Retorna um único registro que satisfaça { campo: valor }.
 */
function lerPor(nomeAba, campo, valor) {
  return lerTodos(nomeAba).find(r => String(r[campo]) === String(valor)) || null;
}

/**
 * Retorna todos os registros que satisfaçam { campo: valor }.
 */
function filtrarPor(nomeAba, campo, valor) {
  return lerTodos(nomeAba).filter(r => String(r[campo]) === String(valor));
}

/**
 * Insere um novo registro no final da aba.
 * @param {string} nomeAba
 * @param {Object} dados — objeto com chaves iguais ao cabeçalho
 */
function inserir(nomeAba, dados) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(nomeAba);
  if (!sheet) throw new Error('Aba não encontrada: ' + nomeAba);

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const linha = headers.map(h => dados[h] !== undefined ? dados[h] : '');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    sheet.appendRow(linha);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Atualiza campos de um registro identificado por { campoPK: valorPK }.
 * @param {string} nomeAba
 * @param {string} campoPK — nome da coluna PK (ex: 'id_demanda')
 * @param {string} valorPK — valor a localizar
 * @param {Object} atualizacoes — { campo: novoValor, ... }
 */
function atualizar(nomeAba, campoPK, valorPK, atualizacoes) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(nomeAba);
  if (!sheet) throw new Error('Aba não encontrada: ' + nomeAba);

  const dados = sheet.getDataRange().getValues();
  const headers = dados[0];
  const pkIdx = headers.indexOf(campoPK);
  if (pkIdx === -1) throw new Error('Campo PK não encontrado: ' + campoPK);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    for (let i = 2; i < dados.length; i++) {  // começa na linha 3 (índice 2)
      if (String(dados[i][pkIdx]) === String(valorPK)) {
        Object.entries(atualizacoes).forEach(([campo, valor]) => {
          const colIdx = headers.indexOf(campo);
          if (colIdx !== -1) {
            sheet.getRange(i + 1, colIdx + 1).setValue(valor);
          }
        });
        return true;
      }
    }
  } finally {
    lock.releaseLock();
  }
  return false;  // registro não encontrado
}

/**
 * Marca um registro como inativo (exclusão lógica).
 * Convenção: todos os registros têm campo 'ativo'.
 */
function desativar(nomeAba, campoPK, valorPK) {
  return atualizar(nomeAba, campoPK, valorPK, { ativo: 'FALSE' });
}


// =============================================================================
// FUNÇÕES DE AUTENTICAÇÃO (base para a Fase 3)
// =============================================================================

/**
 * Verifica credenciais. Retorna o objeto usuário ou null.
 */
function autenticar(email, senha) {
  const senhaHash = _sha256(senha);
  const usuario = lerPor(SHEET_NAMES.USUARIOS, 'email', email);
  if (!usuario) return null;
  if (String(usuario.ativo).toUpperCase() !== 'TRUE') return null;
  if (String(usuario.senha_hash).trim() !== senhaHash) return null;
  return usuario;
}

/**
 * Cria uma sessão para o usuário e retorna o token.
 */
function criarSessao(idUsuario) {
  const token = _gerarToken();
  const agora = new Date();
  const expiracao = new Date(agora.getTime() + 8 * 60 * 60 * 1000);  // +8h

  inserir(SHEET_NAMES.SESSOES, {
    id_sessao:       _gerarUUID(),
    id_usuario_fk:   idUsuario,
    token:           token,
    data_criacao:    agora.toISOString(),
    data_expiracao:  expiracao.toISOString(),
    ip_origem:       Session.getActiveUser().getEmail(),
    ativa:           'TRUE',
  });

  // Armazenar token na PropertiesService para lookup rápido
  PropertiesService.getScriptProperties().setProperty('sessao_' + token, idUsuario);
  return token;
}

/**
 * Valida um token de sessão. Retorna o id_usuario ou null se inválido/expirado.
 */
function validarSessao(token) {
  const props = PropertiesService.getScriptProperties();
  const idUsuario = props.getProperty('sessao_' + token);
  if (!idUsuario) return null;

  // Verificar expiração na aba SESSOES
  const sessao = lerPor(SHEET_NAMES.SESSOES, 'token', token);
  if (!sessao || String(sessao.ativa).toUpperCase() !== 'TRUE') return null;

  const expiracao = new Date(sessao.data_expiracao);
  if (new Date() > expiracao) {
    encerrarSessao(token);
    return null;
  }

  return idUsuario;
}

/**
 * Encerra uma sessão (logout).
 */
function encerrarSessao(token) {
  PropertiesService.getScriptProperties().deleteProperty('sessao_' + token);
  // Marcar aba como inativa
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.SESSOES);
  const dados = sheet.getDataRange().getValues();
  const headers = dados[0];
  const tokenIdx = headers.indexOf('token');
  for (let i = 2; i < dados.length; i++) {
    if (dados[i][tokenIdx] === token) {
      const ativaIdx = headers.indexOf('ativa');
      sheet.getRange(i + 1, ativaIdx + 1).setValue('FALSE');
      break;
    }
  }
}

function _gerarToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 48; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}


// =============================================================================
// FUNÇÕES DE REDIRECIONAMENTO — ficam aqui no Código.gs para garantir
// que google.script.run as encontre sem depender do Servidor.gs
// =============================================================================

/**
 * Gera uma página HTML de redirecionamento via meta-refresh.
 * Usada pelo Login.html para navegar após autenticação.
 */
function criarPaginaRedirect(token, page) {
  const base = ScriptApp.getService().getUrl();
  const url  = base + '?page=' + page + '&token=' + encodeURIComponent(token);
  return '<!DOCTYPE html><html><head><title>Redirecionando...</title></head>'
    + '<body style="font-family:sans-serif;padding:40px;color:#888;text-align:center">'
    + '<p>Redirecionando...</p>'
    + '<script>'
    + 'try { window.top.location.href = ' + JSON.stringify(url) + '; }'
    + 'catch(e) { window.location.href = ' + JSON.stringify(url) + '; }'
    + '<\/script>'
    + '</body></html>';
}

/**
 * Retorna a URL base do Web App.
 */
function getAppUrl() {
  return ScriptApp.getService().getUrl();
}
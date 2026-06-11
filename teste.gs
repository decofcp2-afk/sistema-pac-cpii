function debugLogin4() {
  // Testar passo a passo
  const email = 'admin@cp2.g12.br';
  const senha = 'Admin@2025';
  
  // Passo 1: encontrar usuário
  const usuario = lerPor(SHEET_NAMES.USUARIOS, 'email', email);
  Logger.log('1. Usuário encontrado: ' + (usuario ? 'SIM' : 'NÃO'));
  if (!usuario) return;
  
  // Passo 2: verificar ativo
  Logger.log('2. ativo = ' + usuario.ativo + ' (tipo: ' + typeof usuario.ativo + ')');
  Logger.log('2. String(ativo) === TRUE: ' + (String(usuario.ativo) === 'TRUE'));
  
  // Passo 3: verificar senha
  const hashDigitado = _sha256(senha);
  Logger.log('3. hash planilha: ' + usuario.senha_hash);
  Logger.log('3. hash digitado: ' + hashDigitado);
  Logger.log('3. senhas batem: ' + (usuario.senha_hash === hashDigitado));
  
  // Passo 4: chamar autenticar
  const auth = autenticar(email, senha);
  Logger.log('4. autenticar retornou: ' + (auth ? 'USUÁRIO' : 'NULL'));
}

function debugAcaoLogin() {
  const resultado = acaoLogin('admin@cp2.g12.br', 'Admin@2025');
  Logger.log(JSON.stringify(resultado));
}

function debugSenhaAtual() {
  const usuario = lerPor(SHEET_NAMES.USUARIOS, 'email', 'admin@cp2.g12.br');
  Logger.log('Hash na planilha: ' + usuario.senha_hash);
  Logger.log('Hash D1c2@1214:   ' + _sha256('D1c2@1214'));
  Logger.log('Hash Admin@2025:  ' + _sha256('Admin@2025'));
  Logger.log('D1c2@1214 bate?   ' + (usuario.senha_hash === _sha256('D1c2@1214')));
  Logger.log('Admin@2025 bate?  ' + (usuario.senha_hash === _sha256('Admin@2025')));
}

function resetarSenhaAdmin() {
  const novaSenha = 'Admin@2025';
  const hash = _sha256(novaSenha);
  atualizar(SHEET_NAMES.USUARIOS, 'email', 'admin@cp2.g12.br', {
    senha_hash: hash,
    ativo: 'TRUE',
    primeiro_acesso: 'FALSE',
  });
  Logger.log('Senha redefinida para: ' + novaSenha);
  Logger.log('Hash gravado: ' + hash);
}

function resetarSenhaAdmin() {
  atualizar(SHEET_NAMES.USUARIOS, 'email', 'admin@cp2.g12.br', {
    senha_hash: _sha256('Admin@2025'),
    ativo: 'TRUE',
    primeiro_acesso: 'FALSE',
  });
  Logger.log('Feito. Senha: Admin@2025');
}

function resetarSenhaAdmin() {
  // Buscar o ID do admin primeiro
  const usuario = lerPor(SHEET_NAMES.USUARIOS, 'email', 'admin@cp2.g12.br');
  Logger.log('ID: ' + usuario.id_usuario);
  
  atualizar(SHEET_NAMES.USUARIOS, 'id_usuario', usuario.id_usuario, {
    senha_hash:      _sha256('Admin@2025'),
    ativo:           'TRUE',
    primeiro_acesso: 'FALSE',
  });
  Logger.log('Senha redefinida para Admin@2025');
}

function testarRedirect() {
  const url = criarPaginaRedirect('token-teste', 'dashboard');
  Logger.log(url ? 'Função OK — retornou HTML' : 'Retornou vazio');
  Logger.log(url ? url.substring(0, 100) : '');
}

function debugChefiaDecof() {
  // Simular o que o servidor faz para o usuário DECOF
  const usuario = lerPor(SHEET_NAMES.USUARIOS, 'email', 'COLOQUE_EMAIL_DECOF_AQUI');
  Logger.log('Usuário: ' + usuario.nome);
  Logger.log('Papel: ' + usuario.papel);
  Logger.log('id_unidade_fk: ' + usuario.id_unidade_fk);
  
  if (!usuario.id_unidade_fk) {
    Logger.log('PROBLEMA: usuário sem unidade vinculada!');
    return;
  }
  
  const unidade = lerPor(SHEET_NAMES.UNIDADES, 'id_unidade', usuario.id_unidade_fk);
  Logger.log('Unidade: ' + (unidade ? unidade.nome : 'NÃO ENCONTRADA'));
  
  const subs = _obterSubordinadas(usuario.id_unidade_fk);
  Logger.log('Total subordinadas: ' + subs.length);
  
  // Verificar se DECOF-LIC está nas subordinadas
  const decofLic = lerTodos(SHEET_NAMES.UNIDADES).find(u => u.sigla === 'DECOF-LIC');
  Logger.log('DECOF-LIC id: ' + (decofLic ? decofLic.id_unidade : 'NÃO ENCONTRADA'));
  Logger.log('DECOF-LIC pai: ' + (decofLic ? decofLic.id_unidade_pai : '—'));
  Logger.log('DECOF-LIC está nas subordinadas: ' + (decofLic ? subs.includes(decofLic.id_unidade) : false));
  
  // Demandas submetidas
  const demandas = lerTodos(SHEET_NAMES.DEMANDAS).filter(d => 
    subs.includes(d.id_unidade_fk) && d.status === 'submetida'
  );
  Logger.log('Demandas submetidas visíveis: ' + demandas.length);
}

function listarUsuarios() {
  const usuarios = lerTodos(SHEET_NAMES.USUARIOS);
  usuarios.forEach(u => {
    Logger.log(u.nome + ' | ' + u.email + ' | ' + u.papel + ' | unidade: ' + u.id_unidade_fk);
  });
}

function verificarDemandasAmanda() {
  // Demandas na aba DEMANDAS
  const demandas = lerTodos(SHEET_NAMES.DEMANDAS);
  Logger.log('Total demandas: ' + demandas.length);
  demandas.forEach(d => {
    Logger.log('Objeto: ' + d.descricao_objeto + 
               ' | status: ' + d.status + 
               ' | id_unidade_fk: "' + d.id_unidade_fk + '"' +
               ' | exercicio: ' + d.exercicio);
  });
}

function adicionarColunasGut() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('DEMANDAS');
  if (!sheet) return;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colsNeeded = ['gut_g','gut_u','gut_t','gut_total'];
  colsNeeded.forEach(col => {
    if (!headers.includes(col)) {
      const nextCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, nextCol).setValue(col);
      Logger.log('Coluna adicionada: ' + col);
    }
  });
  Logger.log('Colunas GUT verificadas.');
}

function adicionarColunaSiape() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('USUARIOS');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (!headers.includes('matricula_siape')) {
    sheet.getRange(1, sheet.getLastColumn() + 1).setValue('matricula_siape');
    Logger.log('Coluna adicionada');
  }
}

function verificarTiposUnidades() {
  const unidades = lerTodos(SHEET_NAMES.UNIDADES);
  const tipos = {};
  unidades.forEach(u => {
    const t = u.tipo || '(vazio)';
    tipos[t] = (tipos[t] || 0) + 1;
  });
  Logger.log('Tipos encontrados:');
  Object.entries(tipos).forEach(([t, n]) => Logger.log(`  ${t}: ${n}`));
}

// ── DIAGNÓSTICO ÁRVORE ORÇAMENTO ─────────────────────────────────────────────
function debugArvoreOrcamento() {
  const exercicio = _getConfig('exercicio_atual') || '2026';
  const normId = id => String(id || '').trim().replace(/^"|"$/g, '');
  
  const dotacoes = lerTodos(SHEET_NAMES.DOTACOES)
    .filter(d => String(d.exercicio) === String(exercicio));
  const distribuicoes = lerTodos(SHEET_NAMES.DISTRIBUICOES);
  
  Logger.log('=== DOTAÇÕES exercício ' + exercicio + ' ===');
  dotacoes.forEach(d => {
    Logger.log('Dotação: id=' + d.id_dotacao + ' | unidade=' + d.id_unidade_fk + ' | valor_total=' + d.valor_total + ' | valor_distribuido=' + d.valor_distribuido);
  });
  
  Logger.log('\n=== DISTRIBUIÇÕES ===');
  distribuicoes.forEach(d => {
    Logger.log('Dist: id=' + d.id_distribuicao + ' | origem_dot=' + d.id_dotacao_origem_fk + ' | destino=' + d.id_unidade_destino_fk + ' | valor=' + d.valor);
  });
  
  // Calcular recebidoViaDistribuicao
  const recebidoViaDistribuicao = {};
  distribuicoes.forEach(d => {
    if (Number(d.valor || 0) <= 0) return;
    const dest = normId(d.id_unidade_destino_fk);
    recebidoViaDistribuicao[dest] = (recebidoViaDistribuicao[dest] || 0) + Number(d.valor || 0);
  });
  
  Logger.log('\n=== RECEBIDO VIA DISTRIBUIÇÃO (por destino) ===');
  Object.entries(recebidoViaDistribuicao).forEach(([id, val]) => {
    const unid = lerTodos(SHEET_NAMES.UNIDADES).find(u => normId(u.id_unidade) === id);
    Logger.log((unid ? unid.sigla : id) + ' → R$ ' + val);
  });
}
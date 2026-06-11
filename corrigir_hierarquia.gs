// =============================================================================
// SISTEMA PAC — Corrigir hierarquia de unidades
// Execute: selecione corrigirHierarquia() e clique em Executar
// =============================================================================

function corrigirHierarquia() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('UNIDADES');
  if (!sheet) { SpreadsheetApp.getUi().alert('Aba UNIDADES não encontrada!'); return; }

  const dados   = sheet.getDataRange().getValues();
  const headers = dados[0];

  const idxId   = headers.indexOf('id_unidade');
  const idxSig  = headers.indexOf('sigla');
  const idxNome = headers.indexOf('nome');
  const idxPai  = headers.indexOf('id_unidade_pai');

  if (idxId < 0 || idxSig < 0 || idxPai < 0) {
    SpreadsheetApp.getUi().alert('Colunas não encontradas. Verifique os cabeçalhos.');
    return;
  }

  // 1. Montar mapa sigla → id_unidade (a partir dos dados reais da planilha)
  const mapaSiglaId = {};
  for (let i = 2; i < dados.length; i++) {
    const id   = dados[i][idxId];
    const sig  = dados[i][idxSig];
    if (id && sig) mapaSiglaId[String(sig).trim()] = String(id).trim();
  }

  Logger.log('Unidades encontradas: ' + Object.keys(mapaSiglaId).length);

  // 2. Mapa de pai correto por sigla (baseado na hierarquia real do CPII)
  // Formato: 'SIGLA_FILHO': 'SIGLA_PAI'
  const hierarquia = {
    // Reitoria — sem pai
    'CPII': '',

    // Vinculados diretamente à Reitoria
    'DRI': 'CPII', 'GAB': 'CPII', 'UGI': 'CPII', 'AAADH': 'CPII',
    'ARINTER': 'CPII', 'CORRE': 'CPII', 'OUV': 'CPII',
    'PF': 'CPII', 'SCO': 'CPII', 'AUDIN': 'CPII',

    // GAB → seções
    'SECADM': 'GAB', 'SECTEC': 'GAB', 'SECOM': 'GAB', 'SEPROG': 'GAB',

    // Pró-Reitorias → CPII
    'PROAD': 'CPII', 'PROEN': 'CPII', 'PROGESP': 'CPII',
    'PRODI': 'CPII', 'PROPGPEC': 'CPII',

    // PROAD
    'CINLOG': 'PROAD', 'DECOF': 'PROAD', 'DIFIN': 'PROAD', 'PROAD-SANE': 'PROAD',
    'DECOF-SEC': 'DECOF', 'DECOF-SENG': 'DECOF', 'DECOF-LIC': 'DECOF', 'DECOF-SAILC': 'DECOF',
    'CGCC': 'DIFIN', 'DIFIN-SAP': 'DIFIN', 'DIFIN-SEFIN': 'DIFIN', 'DIFIN-SEORC': 'DIFIN',
    'CGCC-SECONT': 'CGCC',

    // PROEN
    'DEFEI': 'PROEN', 'DEMP': 'PROEN', 'DGRAD': 'PROEN', 'PROEN-DAEE': 'PROEN',
    'PROEN-CAE': 'PROEN', 'PROEN-CBIB': 'PROEN', 'PROEN-COEP': 'PROEN',
    'PROEN-CRA': 'PROEN', 'PROEN-CNAP': 'PROEN', 'PROEN-SAAD': 'PROEN',
    'PROEN-CEST': 'PROEN', 'PROEN-SESP': 'PROEN',
    'PROEN-DAD': 'PROEN', 'PROEN-DAIEF': 'PROEN', 'PROEN-DAV': 'PROEN',
    'PROEN-DBC': 'PROEN', 'PROEN-DCC': 'PROEN', 'PROEN-DDS': 'PROEN',
    'PROEN-DEF': 'PROEN', 'PROEN-DEI': 'PROEN', 'PROEN-DEM': 'PROEN',
    'PROEN-DES': 'PROEN', 'PROEN-DFIL': 'PROEN', 'PROEN-DFIS': 'PROEN',
    'PROEN-DFRA': 'PROEN', 'PROEN-DGEO': 'PROEN', 'PROEN-DHIST': 'PROEN',
    'PROEN-DIE': 'PROEN', 'PROEN-DING': 'PROEN', 'PROEN-DMAT': 'PROEN',
    'PROEN-DPLLP': 'PROEN', 'PROEN-DQUI': 'PROEN', 'PROEN-DSOC': 'PROEN',
    'DEFEI-SEI': 'DEFEI', 'DEFEI-SEF': 'DEFEI',
    'DEMP-SEM': 'DEMP', 'DEMP-SETP': 'DEMP', 'DEMP-SEJA': 'DEMP',
    'DGRAD-SPEG': 'DGRAD',

    // PROGESP
    'DAF': 'PROGESP', 'DDHO': 'PROGESP',
    'PROGESP-SE': 'PROGESP', 'PROGESP-LN': 'PROGESP', 'PROGESP-PC': 'PROGESP',
    'CPLAC': 'DAF', 'DAF-SEAF': 'DAF', 'DAF-SEPAB': 'DAF',
    'DDHO-SASQV': 'DDHO', 'DDHO-SECAP': 'DDHO',

    // PRODI
    'DGC': 'PRODI', 'DTI': 'PRODI', 'PRODI-SECE': 'PRODI',
    'DGC-SDI': 'DGC', 'DGC-SPM': 'DGC',
    'DTI-SEIS': 'DTI', 'DTI-SESIST': 'DTI', 'DTI-SAS': 'DTI',
    'DTI-SEGMON': 'DTI-SEIS',

    // PROPGPEC
    'CULTURA': 'PROPGPEC', 'EXTENSAO': 'PROPGPEC', 'PESQUISA': 'PROPGPEC', 'PGRAD': 'PROPGPEC',
    'CEP': 'PROPGPEC',
    'CULTURA-EC': 'CULTURA', 'CULTURA-PCULT': 'CULTURA',
    'EXTENSAO-EAD': 'EXTENSAO', 'EXTENSAO-PEXT': 'EXTENSAO',
    'PESQUISA-INOV': 'PESQUISA', 'PESQUISA-PUB': 'PESQUISA',
    'PGRAD-BIB': 'PGRAD', 'PGRAD-SA': 'PGRAD',
  };

  // Gerar hierarquia dos campi automaticamente
  const campi = [
    'CCE','CDC','CEN1','CEN2','CH1','CH2','CNI','CRE1','CRE2',
    'CSC1','CSC2','CSC3','CT1','CT2'
  ];
  campi.forEach(pre => {
    hierarquia[pre] = 'CPII';
    ['SGP','SADPE','SGE','SAE'].forEach(s => hierarquia[pre+'-'+s] = pre);
    // Diretoria Administrativa e seus setores
    hierarquia[pre+'-DIAD'] = pre;
    ['PREF','SECOF','SEC','SAP','SEPMA'].forEach(s => hierarquia[pre+'-'+s] = pre+'-DIAD');
    // Diretoria Pedagógica e seus setores
    hierarquia[pre+'-DIPE'] = pre;
    ['NAPNE','SOEP','BIBLI','SEORE','SECR'].forEach(s => hierarquia[pre+'-'+s] = pre+'-DIPE');
  });

  // CCE especial: CEDOM e subunidades
  hierarquia['CCE-CEDOM'] = 'CCE';
  hierarquia['CCE-BIBLIHIST'] = 'CCE-CEDOM';
  hierarquia['CCE-NUDOM'] = 'CCE-CEDOM';

  // CRE1: CREIR
  hierarquia['CREIR'] = 'CRE1';
  hierarquia['CREIR-SECGP'] = 'CREIR';
  hierarquia['CREIR-SAD'] = 'CREIR';
  hierarquia['CREIR-PREF'] = 'CREIR-SAD';
  hierarquia['CREIR-SAP'] = 'CREIR';
  hierarquia['CREIR-PROJ'] = 'CREIR-SAP';
  hierarquia['CREIR-NAPNE'] = 'CREIR-SAP';
  hierarquia['CREIR-SECR'] = 'CREIR';
  hierarquia['CREIR-SEOP'] = 'CREIR';

  // CRE2 especial
  hierarquia['CRE2-CER'] = 'CRE2';
  hierarquia['CRE2-CADPE'] = 'CRE2-DIPE';
  hierarquia['CRE2-SEGRAD'] = 'CRE2-CADPE';

  // CSC2 especial
  hierarquia['CSC2-CESC'] = 'CSC2';
  hierarquia['CSC2-EMUSC'] = 'CSC2';

  // CSC3 especial
  hierarquia['CSC3-HORTO'] = 'CSC3';

  // 3. Aplicar correções
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  let corrigidos = 0;
  let naoMapeados = [];

  try {
    for (let i = 2; i < dados.length; i++) {
      const sigla = String(dados[i][idxSig] || '').trim();
      if (!sigla) continue;

      if (!(sigla in hierarquia)) {
        naoMapeados.push(sigla);
        continue;
      }

      const siglaPai    = hierarquia[sigla];
      const idPaiEsperado = siglaPai ? (mapaSiglaId[siglaPai] || '') : '';
      const idPaiAtual    = String(dados[i][idxPai] || '').trim();

      if (idPaiAtual !== idPaiEsperado) {
        sheet.getRange(i + 1, idxPai + 1).setValue(idPaiEsperado);
        corrigidos++;
        Logger.log('Corrigido: ' + sigla + ' → pai: ' + siglaPai + ' (' + idPaiEsperado + ')');
      }
    }
  } finally {
    lock.releaseLock();
  }

  const msg = '✅ Hierarquia corrigida!\n\n' +
    corrigidos + ' vínculos atualizados.\n' +
    (naoMapeados.length > 0 ? '\nNão mapeadas (' + naoMapeados.length + '): ' + naoMapeados.join(', ') : '');

  Logger.log(msg);
  SpreadsheetApp.getUi().alert(msg);
}
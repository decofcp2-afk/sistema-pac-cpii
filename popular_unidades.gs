// =============================================================================
// SISTEMA PAC — Popular aba UNIDADES
// Execute: selecione popularUnidades() e clique em Executar
// =============================================================================

function popularUnidades() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('UNIDADES');
  if (!sheet) { SpreadsheetApp.getUi().alert('Aba UNIDADES não encontrada!'); return; }

  const agora = new Date().toISOString();

  // ── Gerar UUIDs para cada unidade ────────────────────────────────────────
  const IDS = {};
  const siglas = [
    'CPII','DRI','GAB','GAB-SECADM','GAB-SECTEC','GAB-SECOM','GAB-SEPROG',
    'UGI','AAADH','ARINTER','CORRE','OUV',
    'PROAD','CINLOG','DECOF','DECOF-SEC','DECOF-SENG','DECOF-LIC','DECOF-SAILC',
    'DIFIN','CGCC','CGCC-SECONT','DIFIN-SAP','DIFIN-SEFIN','DIFIN-SEORC','PROAD-SANE',
    'PROEN','PROEN-DAEE','DEFEI','DEFEI-SEI','DEFEI-SEF','DEMP','DEMP-SEM','DEMP-SETP','DEMP-SEJA',
    'DGRAD','DGRAD-SPEG','PROEN-CAE','PROEN-CBIB','PROEN-COEP','PROEN-CRA','PROEN-CNAP',
    'PROEN-SAAD','PROEN-CEST','PROEN-SESP',
    'PROEN-DAD','PROEN-DAIEF','PROEN-DAV','PROEN-DBC','PROEN-DCC','PROEN-DDS',
    'PROEN-DEF','PROEN-DEI','PROEN-DEM','PROEN-DES','PROEN-DFIL','PROEN-DFIS',
    'PROEN-DFRA','PROEN-DGEO','PROEN-DHIST','PROEN-DIE','PROEN-DING','PROEN-DMAT',
    'PROEN-DPLLP','PROEN-DQUI','PROEN-DSOC',
    'PROGESP','DAF','CPLAC','DAF-SEAF','DAF-SEPAB','DDHO','DDHO-SASQV','DDHO-SECAP',
    'PROGESP-SE','PROGESP-LN','PROGESP-PC',
    'PRODI','DGC','DGC-SDI','DGC-SPM','DTI','DTI-SEIS','DTI-SEGMON','DTI-SESIST','DTI-SAS','PRODI-SECE',
    'PROPGPEC','CULTURA','CULTURA-EC','CULTURA-PCULT','EXTENSAO','EXTENSAO-EAD','EXTENSAO-PEXT',
    'PESQUISA','PESQUISA-INOV','PESQUISA-PUB','PGRAD','PGRAD-BIB','PGRAD-SA',
    'CEP','CPII-PF','CPII-SCO','CPII-AUDIN',
    // Campi
    'CCE','CCE-SGP','CCE-SADPE','CCE-SGE','CCE-DIAD','CCE-PREF','CCE-SECOF','CCE-SEC','CCE-SAP','CCE-SEPMA',
    'CCE-DIPE','CCE-NAPNE','CCE-SOEP','CCE-BIBLI','CCE-SEORE','CCE-SECR','CCE-SAE','CCE-CEDOM','CCE-BIBLIHIST','CCE-NUDOM',
    'CDC','CDC-SGP','CDC-SADPE','CDC-SGE','CDC-DIAD','CDC-PREF','CDC-SECOF','CDC-SEC','CDC-SAP','CDC-SEPMA',
    'CDC-DIPE','CDC-NAPNE','CDC-SOEP','CDC-BIBLI','CDC-SEORE','CDC-SECR','CDC-SAE',
    'CEN1','CEN1-SGE','CEN1-SGP','CEN1-SAE','CEN1-SADPE','CEN1-DIAD','CEN1-PREF','CEN1-SECOF','CEN1-SEC','CEN1-SAP','CEN1-SEPMA',
    'CEN1-DIPE','CEN1-NAPNE','CEN1-SOEP','CEN1-BIBLI','CEN1-SEORE','CEN1-SECR',
    'CEN2','CEN2-SGP','CEN2-SADPE','CEN2-SGE','CEN2-DIAD','CEN2-PREF','CEN2-SECOF','CEN2-SEC','CEN2-SAP','CEN2-SEPMA',
    'CEN2-DIPE','CEN2-NAPNE','CEN2-SOEP','CEN2-BIBLI','CEN2-SEORE','CEN2-SECR','CEN2-SAE',
    'CH1','CH1-SGP','CH1-SADPE','CH1-SGE','CH1-DIAD','CH1-PREF','CH1-SECOF','CH1-SEC','CH1-SAP','CH1-SEPMA',
    'CH1-DIPE','CH1-NAPNE','CH1-SOEP','CH1-BIBLI','CH1-SEORE','CH1-SECR','CH1-SAE',
    'CH2','CH2-SGP','CH2-SADPE','CH2-SGE','CH2-DIAD','CH2-PREF','CH2-SECOF','CH2-SEC','CH2-SAP','CH2-SEPMA',
    'CH2-DIPE','CH2-NAPNE','CH2-SOEP','CH2-BIBLI','CH2-SEORE','CH2-SECR','CH2-SAE',
    'CNI','CNI-SGP','CNI-SADPE','CNI-SGE','CNI-DIAD','CNI-PREF','CNI-SECOF','CNI-SEC','CNI-SAP','CNI-SEPMA',
    'CNI-DIPE','CNI-NAPNE','CNI-SOEP','CNI-BIBLI','CNI-SEORE','CNI-SECR','CNI-SAE',
    'CRE1','CRE1-SGP','CRE1-SADPE','CRE1-SGE','CRE1-DIAD','CRE1-PREF','CRE1-SECOF','CRE1-SEC','CRE1-SAP','CRE1-SEPMA',
    'CRE1-DIPE','CRE1-NAPNE','CRE1-SOEP','CRE1-BIBLI','CRE1-SEORE','CRE1-SECR','CRE1-SAE',
    'CREIR','CREIR-SECGP','CREIR-SAD','CREIR-PREF','CREIR-SAP','CREIR-PROJ','CREIR-NAPNE','CREIR-SECR','CREIR-SEOP',
    'CRE2','CRE2-CER','CRE2-SGP','CRE2-SADPE','CRE2-SGE','CRE2-DIAD','CRE2-PREF','CRE2-SECOF','CRE2-SEC','CRE2-SAP','CRE2-SEPMA',
    'CRE2-DIPE','CRE2-CADPE','CRE2-SEGRAD','CRE2-NAPNE','CRE2-SOEP','CRE2-BIBLI','CRE2-SEORE','CRE2-SECR','CRE2-SAE',
    'CSC1','CSC1-SGP','CSC1-SADPE','CSC1-SGE','CSC1-DIAD','CSC1-PREF','CSC1-SECOF','CSC1-SEC','CSC1-SAP','CSC1-SEPMA',
    'CSC1-DIPE','CSC1-NAPNE','CSC1-SOEP','CSC1-BIBLI','CSC1-SEORE','CSC1-SECR','CSC1-SAE',
    'CSC2','CSC2-CESC','CSC2-EMUSC','CSC2-SGP','CSC2-SADPE','CSC2-SGE','CSC2-DIAD','CSC2-PREF','CSC2-SECOF','CSC2-SEC','CSC2-SAP','CSC2-SEPMA',
    'CSC2-DIPE','CSC2-NAPNE','CSC2-SOEP','CSC2-BIBLI','CSC2-SEORE','CSC2-SECR','CSC2-SAE',
    'CSC3','CSC3-SADPE','CSC3-SGE','CSC3-SGP','CSC3-DIAD','CSC3-SAP','CSC3-SEPMA','CSC3-PREF','CSC3-SECOF','CSC3-SEC',
    'CSC3-DIPE','CSC3-NAPNE','CSC3-SOEP','CSC3-BIBLI','CSC3-SEORE','CSC3-SECR','CSC3-HORTO','CSC3-SAE',
    'CT1','CT1-SADPE','CT1-SGE','CT1-SGP','CT1-DIAD','CT1-SAP','CT1-SEPMA','CT1-PREF','CT1-SECOF','CT1-SEC',
    'CT1-DIPE','CT1-NAPNE','CT1-SOEP','CT1-BIBLI','CT1-SEORE','CT1-SECR','CT1-SAE',
    'CT2','CT2-SADPE','CT2-SGE','CT2-SGP','CT2-DIAD','CT2-SAP','CT2-SEPMA','CT2-PREF','CT2-SECOF','CT2-SEC',
    'CT2-DIPE','CT2-NAPNE','CT2-SOEP','CT2-BIBLI','CT2-SEORE','CT2-SECR','CT2-SAE',
  ];
  siglas.forEach(s => { IDS[s] = _gerarUUID(); });

  // Mapear nível da planilha → tipo do sistema
  function mapTipo(nivel, sigla) {
    if (nivel === 'Ordenador de Despesas') return sigla.startsWith('CPII') && !sigla.includes('-') ? 'reitoria' : 'campus';
    if (nivel === 'Departamento Intermediário') {
      if (sigla.startsWith('PROAD') || sigla.startsWith('PROEN') || sigla.startsWith('PROGESP') ||
          sigla.startsWith('PRODI') || sigla.startsWith('PROPGPEC')) return 'pro_reitoria';
      if (sigla.includes('DIAD') || sigla.includes('DIPE')) return 'diretoria_ped';
      return 'diretoria_adm';
    }
    return 'secao';
  }

  // ── Definição das unidades com pai ────────────────────────────────────────
  const unidades = [
    // CPII — Reitoria (raiz)
    ['CPII','CPII – Colégio Pedro II','CPII','reitoria','','TRUE'],

    // Unidades ligadas diretamente à Reitoria (sem pai intermediário)
    ['DRI','CPII-DRI – Diretoria de Relações Institucionais','DRI','diretoria_adm','CPII','TRUE'],
    ['GAB','CPII-GAB – Gabinete do Reitor','GAB','diretoria_adm','CPII','TRUE'],
    ['GAB-SECADM','GAB-SECADM – Secretaria Administrativa da Reitoria','SECADM','secao','GAB','TRUE'],
    ['GAB-SECTEC','GAB-SECTEC – Secretaria Técnica da Reitoria','SECTEC','secao','GAB','TRUE'],
    ['GAB-SECOM','GAB-SECOM – Seção de Comunicação Social','SECOM','secao','GAB','TRUE'],
    ['GAB-SEPROG','GAB-SEPROG – Seção de Protocolo e Arquivo Geral','SEPROG','secao','GAB','TRUE'],
    ['UGI','CPII-UGI – Unidade de Gestão da Integridade','UGI','secao','CPII','TRUE'],
    ['AAADH','CPII-AAADH – Assessoria de Ações Afirmativas e Direitos Humanos','AAADH','secao','CPII','TRUE'],
    ['ARINTER','CPII-ARINTER – Assessoria de Relações Internacionais','ARINTER','secao','CPII','TRUE'],
    ['CORRE','CPII-CORRE – Corregedoria','CORRE','secao','CPII','TRUE'],
    ['OUV','CPII-OUV – Ouvidoria','OUV','secao','CPII','TRUE'],
    ['CPII-PF','CPII-PF – Procuradoria Federal','PF','secao','CPII','TRUE'],
    ['CPII-SCO','CPII-SCO – Secretaria dos Conselhos','SCO','secao','CPII','TRUE'],
    ['CPII-AUDIN','CPII-AUDIN – Auditoria Interna','AUDIN','secao','CPII','TRUE'],

    // PROAD — Pró-Reitoria de Administração
    ['PROAD','PROAD – Pró-Reitoria de Administração','PROAD','pro_reitoria','CPII','TRUE'],
    ['CINLOG','CINLOG – Coordenadoria de Infraestrutura e Logística','CINLOG','coordenacao','PROAD','TRUE'],
    ['DECOF','DECOF – Diretoria de Engenharia, Contratos e Fiscalização','DECOF','diretoria_adm','PROAD','TRUE'],
    ['DECOF-SEC','DECOF-SEC – Seção de Contratos','DECOF-SEC','secao','DECOF','TRUE'],
    ['DECOF-SENG','DECOF-SENG – Seção de Engenharia','DECOF-SENG','secao','DECOF','TRUE'],
    ['DECOF-LIC','DECOF-LIC – Seção de Licitações','DECOF-LIC','secao','DECOF','TRUE'],
    ['DECOF-SAILC','DECOF-SAILC – Setor de Apuração de Irregularidades Licitatórias e Contratuais','DECOF-SAILC','secao','DECOF','TRUE'],
    ['DIFIN','DIFIN – Diretoria de Orçamento e Finanças','DIFIN','diretoria_adm','PROAD','TRUE'],
    ['CGCC','CGCC – Coordenação Geral de Contabilidade e Controle','CGCC','coordenacao','DIFIN','TRUE'],
    ['CGCC-SECONT','CGCC-SECONT – Setor de Contabilidade','CGCC-SECONT','secao','CGCC','TRUE'],
    ['DIFIN-SAP','DIFIN-SAP – Seção de Almoxarifado e Patrimônio','DIFIN-SAP','secao','DIFIN','TRUE'],
    ['DIFIN-SEFIN','DIFIN-SEFIN – Setor de Finanças','DIFIN-SEFIN','secao','DIFIN','TRUE'],
    ['DIFIN-SEORC','DIFIN-SEORC – Setor de Orçamento','DIFIN-SEORC','secao','DIFIN','TRUE'],
    ['PROAD-SANE','PROAD-SANE – Seção de Alimentação e Nutrição Estudantil','PROAD-SANE','secao','PROAD','TRUE'],

    // PROEN — Pró-Reitoria de Ensino
    ['PROEN','PROEN – Pró-Reitoria de Ensino','PROEN','pro_reitoria','CPII','TRUE'],
    ['PROEN-DAEE','PROEN-DAEE – Departamento de Atendimento Educacional Especializado','PROEN-DAEE','secao','PROEN','TRUE'],
    ['DEFEI','DEFEI – Diretoria de Ensino Fundamental e Educação Infantil','DEFEI','diretoria_ped','PROEN','TRUE'],
    ['DEFEI-SEI','DEFEI-SEI – Setor de Educação Infantil','DEFEI-SEI','secao','DEFEI','TRUE'],
    ['DEFEI-SEF','DEFEI-SEF – Setor de Ensino Fundamental','DEFEI-SEF','secao','DEFEI','TRUE'],
    ['DEMP','DEMP – Diretoria de Ensino Médio e Profissional','DEMP','diretoria_ped','PROEN','TRUE'],
    ['DEMP-SEM','DEMP-SEM – Setor de Ensino Médio','DEMP-SEM','secao','DEMP','TRUE'],
    ['DEMP-SETP','DEMP-SETP – Setor de Ensino Técnico e Profissional','DEMP-SETP','secao','DEMP','TRUE'],
    ['DEMP-SEJA','DEMP-SEJA – Setor Geral de EJA-EPT','DEMP-SEJA','secao','DEMP','TRUE'],
    ['DGRAD','DGRAD – Diretoria de Graduação','DGRAD','diretoria_ped','PROEN','TRUE'],
    ['DGRAD-SPEG','DGRAD-SPEG – Setor de Planejamento, Estudos e Gestão','DGRAD-SPEG','secao','DGRAD','TRUE'],
    ['PROEN-CAE','PROEN-CAE – Seção Central de Assistência Estudantil','PROEN-CAE','secao','PROEN','TRUE'],
    ['PROEN-CBIB','PROEN-CBIB – Seção Central de Bibliotecas','PROEN-CBIB','secao','PROEN','TRUE'],
    ['PROEN-COEP','PROEN-COEP – Seção Central de Orientação Educacional e Pedagógica','PROEN-COEP','secao','PROEN','TRUE'],
    ['PROEN-CRA','PROEN-CRA – Seção Central de Registros Acadêmicos','PROEN-CRA','secao','PROEN','TRUE'],
    ['PROEN-CNAP','PROEN-CNAP – Seção Central dos Núcleos de Atendimento às Pessoas com Necessidades Específicas','PROEN-CNAP','secao','PROEN','TRUE'],
    ['PROEN-SAAD','PROEN-SAAD – Seção de Apoio Administrativo','PROEN-SAAD','secao','PROEN','TRUE'],
    ['PROEN-CEST','PROEN-CEST – Setor Central de Estágio','PROEN-CEST','secao','PROEN','TRUE'],
    ['PROEN-SESP','PROEN-SESP – Setor de Esportes','PROEN-SESP','secao','PROEN','TRUE'],
    ['PROEN-DAD','PROEN-DAD – Departamento Pedagógico de Administração e Direito','PROEN-DAD','secao','PROEN','TRUE'],
    ['PROEN-DAIEF','PROEN-DAIEF – Departamento Pedagógico de Anos Iniciais do Ensino Fundamental','PROEN-DAIEF','secao','PROEN','TRUE'],
    ['PROEN-DAV','PROEN-DAV – Departamento Pedagógico de Artes Visuais','PROEN-DAV','secao','PROEN','TRUE'],
    ['PROEN-DBC','PROEN-DBC – Departamento Pedagógico de Biologia e Ciências','PROEN-DBC','secao','PROEN','TRUE'],
    ['PROEN-DCC','PROEN-DCC – Departamento Pedagógico de Ciência da Computação','PROEN-DCC','secao','PROEN','TRUE'],
    ['PROEN-DDS','PROEN-DDS – Departamento Pedagógico de Desenho','PROEN-DDS','secao','PROEN','TRUE'],
    ['PROEN-DEF','PROEN-DEF – Departamento Pedagógico de Educação Física','PROEN-DEF','secao','PROEN','TRUE'],
    ['PROEN-DEI','PROEN-DEI – Departamento Pedagógico de Educação Infantil','PROEN-DEI','secao','PROEN','TRUE'],
    ['PROEN-DEM','PROEN-DEM – Departamento Pedagógico de Educação Musical','PROEN-DEM','secao','PROEN','TRUE'],
    ['PROEN-DES','PROEN-DES – Departamento Pedagógico de Espanhol','PROEN-DES','secao','PROEN','TRUE'],
    ['PROEN-DFIL','PROEN-DFIL – Departamento Pedagógico de Filosofia','PROEN-DFIL','secao','PROEN','TRUE'],
    ['PROEN-DFIS','PROEN-DFIS – Departamento Pedagógico de Física','PROEN-DFIS','secao','PROEN','TRUE'],
    ['PROEN-DFRA','PROEN-DFRA – Departamento Pedagógico de Francês','PROEN-DFRA','secao','PROEN','TRUE'],
    ['PROEN-DGEO','PROEN-DGEO – Departamento Pedagógico de Geografia','PROEN-DGEO','secao','PROEN','TRUE'],
    ['PROEN-DHIST','PROEN-DHIST – Departamento Pedagógico de História','PROEN-DHIST','secao','PROEN','TRUE'],
    ['PROEN-DIE','PROEN-DIE – Departamento Pedagógico de Informática Educativa','PROEN-DIE','secao','PROEN','TRUE'],
    ['PROEN-DING','PROEN-DING – Departamento Pedagógico de Inglês','PROEN-DING','secao','PROEN','TRUE'],
    ['PROEN-DMAT','PROEN-DMAT – Departamento Pedagógico de Matemática','PROEN-DMAT','secao','PROEN','TRUE'],
    ['PROEN-DPLLP','PROEN-DPLLP – Departamento Pedagógico de Português e Literaturas de Língua Portuguesa','PROEN-DPLLP','secao','PROEN','TRUE'],
    ['PROEN-DQUI','PROEN-DQUI – Departamento Pedagógico de Química','PROEN-DQUI','secao','PROEN','TRUE'],
    ['PROEN-DSOC','PROEN-DSOC – Departamento Pedagógico de Sociologia','PROEN-DSOC','secao','PROEN','TRUE'],

    // PROGESP — Pró-Reitoria de Gestão de Pessoas
    ['PROGESP','PROGESP – Pró-Reitoria de Gestão de Pessoas','PROGESP','pro_reitoria','CPII','TRUE'],
    ['DAF','DAF – Diretoria de Administração Funcional','DAF','diretoria_adm','PROGESP','TRUE'],
    ['CPLAC','CPLAC – Coordenadoria de Planejamento Acadêmico e Funcional','CPLAC','coordenacao','DAF','TRUE'],
    ['DAF-SEAF','DAF-SEAF – Seção de Acompanhamento Funcional','DAF-SEAF','secao','DAF','TRUE'],
    ['DAF-SEPAB','DAF-SEPAB – Seção de Pagamento e Benefícios','DAF-SEPAB','secao','DAF','TRUE'],
    ['DDHO','DDHO – Diretoria de Desenvolvimento Humano e Organizacional','DDHO','diretoria_adm','PROGESP','TRUE'],
    ['DDHO-SASQV','DDHO-SASQV – Seção de Atenção à Saúde, Segurança e Qualidade de Vida','DDHO-SASQV','secao','DDHO','TRUE'],
    ['DDHO-SECAP','DDHO-SECAP – Seção de Capacitação e Progressão','DDHO-SECAP','secao','DDHO','TRUE'],
    ['PROGESP-SE','PROGESP-SE – Secretaria Executiva','PROGESP-SE','secao','PROGESP','TRUE'],
    ['PROGESP-LN','PROGESP-LN – Secretaria de Legislação e Normas','PROGESP-LN','secao','PROGESP','TRUE'],
    ['PROGESP-PC','PROGESP-PC – Secretaria de Planejamento e Comunicação','PROGESP-PC','secao','PROGESP','TRUE'],

    // PRODI — Pró-Reitoria de Planejamento e Desenvolvimento Institucional
    ['PRODI','PRODI – Pró-Reitoria de Planejamento e Desenvolvimento Institucional','PRODI','pro_reitoria','CPII','TRUE'],
    ['DGC','DGC – Diretoria de Gestão do Conhecimento','DGC','diretoria_adm','PRODI','TRUE'],
    ['DGC-SDI','DGC-SDI – Seção de Desenvolvimento Institucional','DGC-SDI','secao','DGC','TRUE'],
    ['DGC-SPM','DGC-SPM – Setor de Planejamento e Monitoramento','DGC-SPM','secao','DGC','TRUE'],
    ['DTI','DTI – Diretoria de Tecnologia da Informação','DTI','diretoria_adm','PRODI','TRUE'],
    ['DTI-SEIS','DTI-SEIS – Seção de Infraestrutura e Segurança de TI','DTI-SEIS','secao','DTI','TRUE'],
    ['DTI-SEGMON','DTI-SEGMON – Setor de Segurança da Informação e Monitoramento','DTI-SEGMON','secao','DTI-SEIS','TRUE'],
    ['DTI-SESIST','DTI-SESIST – Seção de Sistemas de TI','DTI-SESIST','secao','DTI','TRUE'],
    ['DTI-SAS','DTI-SAS – Setor de Atendimento e Suporte de TI','DTI-SAS','secao','DTI','TRUE'],
    ['PRODI-SECE','PRODI-SECE – Secretaria Executiva','PRODI-SECE','secao','PRODI','TRUE'],

    // PROPGPEC — Pró-Reitoria de Pós-Graduação, Pesquisa, Extensão e Cultura
    ['PROPGPEC','PROPGPEC – Pró-Reitoria de Pós-Graduação, Pesquisa, Extensão e Cultura','PROPGPEC','pro_reitoria','CPII','TRUE'],
    ['CULTURA','CULTURA – Coordenadoria de Cultura','CULTURA','coordenacao','PROPGPEC','TRUE'],
    ['CULTURA-EC','CULTURA-EC – Espaço Cultural','CULTURA-EC','secao','CULTURA','TRUE'],
    ['CULTURA-PCULT','CULTURA-PCULT – Setor de Políticas de Cultura','CULTURA-PCULT','secao','CULTURA','TRUE'],
    ['EXTENSAO','EXTENSAO – Coordenadoria de Extensão','EXTENSAO','coordenacao','PROPGPEC','TRUE'],
    ['EXTENSAO-EAD','EXTENSAO-EAD – Seção de Educação a Distância','EXTENSAO-EAD','secao','EXTENSAO','TRUE'],
    ['EXTENSAO-PEXT','EXTENSAO-PEXT – Setor de Políticas de Extensão','EXTENSAO-PEXT','secao','EXTENSAO','TRUE'],
    ['PESQUISA','PESQUISA – Coordenadoria de Pesquisa','PESQUISA','coordenacao','PROPGPEC','TRUE'],
    ['PESQUISA-INOV','PESQUISA-INOV – Setor de Inovação','PESQUISA-INOV','secao','PESQUISA','TRUE'],
    ['PESQUISA-PUB','PESQUISA-PUB – Setor de Publicações Científicas','PESQUISA-PUB','secao','PESQUISA','TRUE'],
    ['PGRAD','PGRAD – Diretoria de Pós-Graduação','PGRAD','diretoria_ped','PROPGPEC','TRUE'],
    ['PGRAD-BIB','PGRAD-BIB – Biblioteca','PGRAD-BIB','secao','PGRAD','TRUE'],
    ['PGRAD-SA','PGRAD-SA – Setor de Registro Acadêmico','PGRAD-SA','secao','PGRAD','TRUE'],
    ['CEP','CEP – Comitê de Ética em Pesquisa','CEP','secao','PROPGPEC','TRUE'],

    // ── CAMPI ───────────────────────────────────────────────────────────────
    // CCE — Campus Centro
    ['CCE','CCE – Campus Centro','CCE','campus','CPII','TRUE'],
    ['CCE-SGP','CCE-SGP – Setor de Gestão de Pessoas','CCE-SGP','secao','CCE','TRUE'],
    ['CCE-SADPE','CCE-SADPE – Superintendência Administrativo-Pedagógica','CCE-SADPE','secao','CCE','TRUE'],
    ['CCE-SGE','CCE-SGE – Superintendência Geral','CCE-SGE','secao','CCE','TRUE'],
    ['CCE-DIAD','CCE-DIAD – Diretoria Administrativa','CCE-DIAD','diretoria_adm','CCE','TRUE'],
    ['CCE-PREF','CCE-PREF – Prefeitura','CCE-PREF','secao','CCE-DIAD','TRUE'],
    ['CCE-SECOF','CCE-SECOF – Seção de Contabilidade e Finanças','CCE-SECOF','secao','CCE-DIAD','TRUE'],
    ['CCE-SEC','CCE-SEC – Seção de Contratos','CCE-SEC','secao','CCE-DIAD','TRUE'],
    ['CCE-SAP','CCE-SAP – Setor de Almoxarifado e Patrimônio','CCE-SAP','secao','CCE-DIAD','TRUE'],
    ['CCE-SEPMA','CCE-SEPMA – Setor de Planejamento e Monitoramento de Aquisições','CCE-SEPMA','secao','CCE-DIAD','TRUE'],
    ['CCE-DIPE','CCE-DIPE – Diretoria Pedagógica','CCE-DIPE','diretoria_ped','CCE','TRUE'],
    ['CCE-NAPNE','CCE-NAPNE – Núcleo de Atendimento às Pessoas com Necessidades Específicas','CCE-NAPNE','secao','CCE-DIPE','TRUE'],
    ['CCE-SOEP','CCE-SOEP – Seção de Orientação Educacional e Pedagógica','CCE-SOEP','secao','CCE-DIPE','TRUE'],
    ['CCE-BIBLI','CCE-BIBLI – Setor de Biblioteca e Sala de Leitura','CCE-BIBLI','secao','CCE-DIPE','TRUE'],
    ['CCE-SEORE','CCE-SEORE – Setor de Organização Escolar','CCE-SEORE','secao','CCE-DIPE','TRUE'],
    ['CCE-SECR','CCE-SECR – Setor de Secretaria Acadêmica','CCE-SECR','secao','CCE-DIPE','TRUE'],
    ['CCE-SAE','CCE-SAE – Setor de Assistência Estudantil','CCE-SAE','secao','CCE','TRUE'],
    ['CCE-CEDOM','CCE-CEDOM – Centro de Documentação e Memória','CCE-CEDOM','diretoria_adm','CCE','TRUE'],
    ['CCE-BIBLIHIST','CCE-BIBLIHIST – Biblioteca Histórica','CCE-BIBLIHIST','secao','CCE-CEDOM','TRUE'],
    ['CCE-NUDOM','CCE-NUDOM – Núcleo de Documentação Histórica','CCE-NUDOM','secao','CCE-CEDOM','TRUE'],
  ];

  // Macro para cada campus repetido (CDC, CEN1, CEN2, CH1, CH2, CNI, CRE1, CRE2, CSC1, CSC2, CSC3, CT1, CT2)
  function campusPadrao(pre, nome) {
    return [
      [pre, pre + ' – ' + nome, pre, 'campus', 'CPII', 'TRUE'],
      [pre+'-SGP', pre+'-SGP – Setor de Gestão de Pessoas', pre+'-SGP', 'secao', pre, 'TRUE'],
      [pre+'-SADPE', pre+'-SADPE – Superintendência Administrativo-Pedagógica', pre+'-SADPE', 'secao', pre, 'TRUE'],
      [pre+'-SGE', pre+'-SGE – Superintendência Geral', pre+'-SGE', 'secao', pre, 'TRUE'],
      [pre+'-SAE', pre+'-SAE – Setor de Assistência Estudantil', pre+'-SAE', 'secao', pre, 'TRUE'],
      [pre+'-DIAD', pre+'-DIAD – Diretoria Administrativa', pre+'-DIAD', 'diretoria_adm', pre, 'TRUE'],
      [pre+'-PREF', pre+'-PREF – Prefeitura', pre+'-PREF', 'secao', pre+'-DIAD', 'TRUE'],
      [pre+'-SECOF', pre+'-SECOF – Seção de Contabilidade e Finanças', pre+'-SECOF', 'secao', pre+'-DIAD', 'TRUE'],
      [pre+'-SEC', pre+'-SEC – Seção de Contratos', pre+'-SEC', 'secao', pre+'-DIAD', 'TRUE'],
      [pre+'-SAP', pre+'-SAP – Setor de Almoxarifado e Patrimônio', pre+'-SAP', 'secao', pre+'-DIAD', 'TRUE'],
      [pre+'-SEPMA', pre+'-SEPMA – Setor de Planejamento e Monitoramento de Aquisições', pre+'-SEPMA', 'secao', pre+'-DIAD', 'TRUE'],
      [pre+'-DIPE', pre+'-DIPE – Diretoria Pedagógica', pre+'-DIPE', 'diretoria_ped', pre, 'TRUE'],
      [pre+'-NAPNE', pre+'-NAPNE – Núcleo de Atendimento às Pessoas com Necessidades Específicas', pre+'-NAPNE', 'secao', pre+'-DIPE', 'TRUE'],
      [pre+'-SOEP', pre+'-SOEP – Seção de Orientação Educacional e Pedagógica', pre+'-SOEP', 'secao', pre+'-DIPE', 'TRUE'],
      [pre+'-BIBLI', pre+'-BIBLI – Setor de Biblioteca e Sala de Leitura', pre+'-BIBLI', 'secao', pre+'-DIPE', 'TRUE'],
      [pre+'-SEORE', pre+'-SEORE – Setor de Organização Escolar', pre+'-SEORE', 'secao', pre+'-DIPE', 'TRUE'],
      [pre+'-SECR', pre+'-SECR – Setor de Secretaria Acadêmica', pre+'-SECR', 'secao', pre+'-DIPE', 'TRUE'],
    ];
  }

  const campiPadrao = [
    campusPadrao('CDC', 'Campus Duque de Caxias'),
    campusPadrao('CEN1', 'Campus Engenho Novo I'),
    campusPadrao('CEN2', 'Campus Engenho Novo II'),
    campusPadrao('CH1', 'Campus Humaitá I'),
    campusPadrao('CH2', 'Campus Humaitá II'),
    campusPadrao('CNI', 'Campus Niterói'),
    campusPadrao('CRE1', 'Campus Realengo I'),
    campusPadrao('CSC1', 'Campus São Cristóvão I'),
    campusPadrao('CT1', 'Campus Tijuca I'),
    campusPadrao('CT2', 'Campus Tijuca II'),
  ].flat();

  // Campi especiais com subunidades extras
  const campiEspeciais = [
    // CRE1 — Realengo I (possui CREIR vinculado)
    ['CREIR','CREIR – Centro de Referência em Educação Infantil - Realengo','CREIR','diretoria_ped','CRE1','TRUE'],
    ['CREIR-SECGP','CREIR-SECGP – Secretaria de Gestão de Pessoas Setorial','CREIR-SECGP','secao','CREIR','TRUE'],
    ['CREIR-SAD','CREIR-SAD – Superintendência Administrativa Setorial','CREIR-SAD','secao','CREIR','TRUE'],
    ['CREIR-PREF','CREIR-PREF – Prefeitura Setorial','CREIR-PREF','secao','CREIR-SAD','TRUE'],
    ['CREIR-SAP','CREIR-SAP – Superintendência Pedagógica Setorial','CREIR-SAP','secao','CREIR','TRUE'],
    ['CREIR-PROJ','CREIR-PROJ – Coordenador de Projetos','CREIR-PROJ','secao','CREIR-SAP','TRUE'],
    ['CREIR-NAPNE','CREIR-NAPNE – Núcleo Setorial de Atendimento às Pessoas com Necessidades Especiais','CREIR-NAPNE','secao','CREIR-SAP','TRUE'],
    ['CREIR-SECR','CREIR-SECR – Secretaria Acadêmica Setorial','CREIR-SECR','secao','CREIR','TRUE'],
    ['CREIR-SEOP','CREIR-SEOP – Setor de Orientação Pedagógica','CREIR-SEOP','secao','CREIR','TRUE'],
    // CRE2 — Realengo II
    ['CRE2','CRE2 – Campus Realengo II','CRE2','campus','CPII','TRUE'],
    ['CRE2-CER','CRE2-CER – Complexo Esportivo de Realengo','CRE2-CER','secao','CRE2','TRUE'],
    ['CRE2-SGP','CRE2-SGP – Setor de Gestão de Pessoas','CRE2-SGP','secao','CRE2','TRUE'],
    ['CRE2-SADPE','CRE2-SADPE – Superintendência Administrativo-Pedagógica','CRE2-SADPE','secao','CRE2','TRUE'],
    ['CRE2-SGE','CRE2-SGE – Superintendência Geral','CRE2-SGE','secao','CRE2','TRUE'],
    ['CRE2-SAE','CRE2-SAE – Setor de Assistência Estudantil','CRE2-SAE','secao','CRE2','TRUE'],
    ['CRE2-DIAD','CRE2-DIAD – Diretoria Administrativa','CRE2-DIAD','diretoria_adm','CRE2','TRUE'],
    ['CRE2-PREF','CRE2-PREF – Prefeitura','CRE2-PREF','secao','CRE2-DIAD','TRUE'],
    ['CRE2-SECOF','CRE2-SECOF – Seção de Contabilidade e Finanças','CRE2-SECOF','secao','CRE2-DIAD','TRUE'],
    ['CRE2-SEC','CRE2-SEC – Seção de Contratos','CRE2-SEC','secao','CRE2-DIAD','TRUE'],
    ['CRE2-SAP','CRE2-SAP – Setor de Almoxarifado e Patrimônio','CRE2-SAP','secao','CRE2-DIAD','TRUE'],
    ['CRE2-SEPMA','CRE2-SEPMA – Setor de Planejamento e Monitoramento de Aquisições','CRE2-SEPMA','secao','CRE2-DIAD','TRUE'],
    ['CRE2-DIPE','CRE2-DIPE – Diretoria Pedagógica','CRE2-DIPE','diretoria_ped','CRE2','TRUE'],
    ['CRE2-CADPE','CRE2-CADPE – Coordenação Administrativa-Pedagógica da Graduação','CRE2-CADPE','coordenacao','CRE2-DIPE','TRUE'],
    ['CRE2-SEGRAD','CRE2-SEGRAD – Secretaria Acadêmica da Graduação','CRE2-SEGRAD','secao','CRE2-CADPE','TRUE'],
    ['CRE2-NAPNE','CRE2-NAPNE – Núcleo de Atendimento às Pessoas com Necessidades Específicas','CRE2-NAPNE','secao','CRE2-DIPE','TRUE'],
    ['CRE2-SOEP','CRE2-SOEP – Seção de Orientação Educacional e Pedagógica','CRE2-SOEP','secao','CRE2-DIPE','TRUE'],
    ['CRE2-BIBLI','CRE2-BIBLI – Setor de Biblioteca e Sala de Leitura','CRE2-BIBLI','secao','CRE2-DIPE','TRUE'],
    ['CRE2-SEORE','CRE2-SEORE – Setor de Organização Escolar','CRE2-SEORE','secao','CRE2-DIPE','TRUE'],
    ['CRE2-SECR','CRE2-SECR – Setor de Secretaria Acadêmica','CRE2-SECR','secao','CRE2-DIPE','TRUE'],
    // CSC2 — São Cristóvão II
    ['CSC2','CSC2 – Campus São Cristóvão II','CSC2','campus','CPII','TRUE'],
    ['CSC2-CESC','CSC2-CESC – Complexo Esportivo de São Cristóvão','CSC2-CESC','secao','CSC2','TRUE'],
    ['CSC2-EMUSC','CSC2-EMUSC – Espaço Musical de São Cristóvão','CSC2-EMUSC','secao','CSC2','TRUE'],
    ['CSC2-SGP','CSC2-SGP – Setor de Gestão de Pessoas','CSC2-SGP','secao','CSC2','TRUE'],
    ['CSC2-SADPE','CSC2-SADPE – Superintendência Administrativo-Pedagógica','CSC2-SADPE','secao','CSC2','TRUE'],
    ['CSC2-SGE','CSC2-SGE – Superintendência Geral','CSC2-SGE','secao','CSC2','TRUE'],
    ['CSC2-SAE','CSC2-SAE – Setor de Assistência Estudantil','CSC2-SAE','secao','CSC2','TRUE'],
    ['CSC2-DIAD','CSC2-DIAD – Diretoria Administrativa','CSC2-DIAD','diretoria_adm','CSC2','TRUE'],
    ['CSC2-PREF','CSC2-PREF – Prefeitura','CSC2-PREF','secao','CSC2-DIAD','TRUE'],
    ['CSC2-SECOF','CSC2-SECOF – Seção de Contabilidade e Finanças','CSC2-SECOF','secao','CSC2-DIAD','TRUE'],
    ['CSC2-SEC','CSC2-SEC – Seção de Contratos','CSC2-SEC','secao','CSC2-DIAD','TRUE'],
    ['CSC2-SAP','CSC2-SAP – Setor de Almoxarifado e Patrimônio','CSC2-SAP','secao','CSC2-DIAD','TRUE'],
    ['CSC2-SEPMA','CSC2-SEPMA – Setor de Planejamento e Monitoramento de Aquisições','CSC2-SEPMA','secao','CSC2-DIAD','TRUE'],
    ['CSC2-DIPE','CSC2-DIPE – Diretoria Pedagógica','CSC2-DIPE','diretoria_ped','CSC2','TRUE'],
    ['CSC2-NAPNE','CSC2-NAPNE – Núcleo de Atendimento às Pessoas com Necessidades Específicas','CSC2-NAPNE','secao','CSC2-DIPE','TRUE'],
    ['CSC2-SOEP','CSC2-SOEP – Seção de Orientação Educacional e Pedagógica','CSC2-SOEP','secao','CSC2-DIPE','TRUE'],
    ['CSC2-BIBLI','CSC2-BIBLI – Setor de Biblioteca e Sala de Leitura','CSC2-BIBLI','secao','CSC2-DIPE','TRUE'],
    ['CSC2-SEORE','CSC2-SEORE – Setor de Organização Escolar','CSC2-SEORE','secao','CSC2-DIPE','TRUE'],
    ['CSC2-SECR','CSC2-SECR – Setor de Secretaria Acadêmica','CSC2-SECR','secao','CSC2-DIPE','TRUE'],
    // CSC3 — São Cristóvão III
    ['CSC3','CSC3 – Campus São Cristóvão III','CSC3','campus','CPII','TRUE'],
    ['CSC3-SGP','CSC3-SGP – Setor de Gestão de Pessoas','CSC3-SGP','secao','CSC3','TRUE'],
    ['CSC3-SADPE','CSC3-SADPE – Superintendência Administrativo-Pedagógica','CSC3-SADPE','secao','CSC3','TRUE'],
    ['CSC3-SGE','CSC3-SGE – Superintendência Geral','CSC3-SGE','secao','CSC3','TRUE'],
    ['CSC3-SAE','CSC3-SAE – Setor de Assistência Estudantil','CSC3-SAE','secao','CSC3','TRUE'],
    ['CSC3-DIAD','CSC3-DIAD – Diretoria Administrativa','CSC3-DIAD','diretoria_adm','CSC3','TRUE'],
    ['CSC3-SAP','CSC3-SAP – Setor de Almoxarifado e Patrimônio','CSC3-SAP','secao','CSC3-DIAD','TRUE'],
    ['CSC3-SEPMA','CSC3-SEPMA – Setor de Planejamento e Monitoramento de Aquisições','CSC3-SEPMA','secao','CSC3-DIAD','TRUE'],
    ['CSC3-PREF','CSC3-PREF – Prefeitura','CSC3-PREF','secao','CSC3-DIAD','TRUE'],
    ['CSC3-SECOF','CSC3-SECOF – Seção de Contabilidade e Finanças','CSC3-SECOF','secao','CSC3-DIAD','TRUE'],
    ['CSC3-SEC','CSC3-SEC – Seção de Contratos','CSC3-SEC','secao','CSC3-DIAD','TRUE'],
    ['CSC3-DIPE','CSC3-DIPE – Diretoria Pedagógica','CSC3-DIPE','diretoria_ped','CSC3','TRUE'],
    ['CSC3-NAPNE','CSC3-NAPNE – Núcleo de Atendimento às Pessoas com Necessidades Específicas','CSC3-NAPNE','secao','CSC3-DIPE','TRUE'],
    ['CSC3-SOEP','CSC3-SOEP – Seção de Orientação Educacional e Pedagógica','CSC3-SOEP','secao','CSC3-DIPE','TRUE'],
    ['CSC3-BIBLI','CSC3-BIBLI – Setor de Biblioteca e Sala de Leitura','CSC3-BIBLI','secao','CSC3-DIPE','TRUE'],
    ['CSC3-SEORE','CSC3-SEORE – Setor de Organização Escolar','CSC3-SEORE','secao','CSC3-DIPE','TRUE'],
    ['CSC3-SECR','CSC3-SECR – Setor de Secretaria Acadêmica','CSC3-SECR','secao','CSC3-DIPE','TRUE'],
    ['CSC3-HORTO','CSC3-HORTO – Horto Botânico de São Cristóvão','CSC3-HORTO','secao','CSC3','TRUE'],
  ];

  const todasUnidades = [...unidades, ...campiPadrao, ...campiEspeciais];

  // Limpar linhas existentes a partir da linha 3
  const ultimaLinha = sheet.getLastRow();
  if (ultimaLinha >= 3) sheet.getRange(3, 1, ultimaLinha - 2, 8).clearContent();

  // Montar linhas para inserção
  const linhas = todasUnidades.map(u => {
    const [sigla, nome, siglaCurta, tipo, paiSigla, ativo] = u;
    const id     = IDS[sigla] || _gerarUUID();
    const idPai  = paiSigla ? (IDS[paiSigla] || '') : '';
    return [id, nome, siglaCurta, tipo, idPai, '', ativo, agora];
  });

  sheet.getRange(3, 1, linhas.length, 8).setValues(linhas);

  SpreadsheetApp.getUi().alert(
    '✅ Unidades populadas!',
    linhas.length + ' unidades inseridas com sucesso na aba UNIDADES.',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}
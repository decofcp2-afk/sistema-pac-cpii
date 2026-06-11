/*
 * api.js — Compatibilidade google.script.run -> fetch()
 *
 * Permite que o front-end (HTML/CSS/JS), hospedado estaticamente no GitHub
 * Pages, continue usando as mesmas chamadas "google.script.run...." que
 * eram usadas quando o front-end era servido pelo próprio Apps Script.
 *
 * Cada chamada é convertida em um POST para o Apps Script publicado como
 * Web App (doPost), que já implementa toda a lógica de negócio existente.
 *
 * IMPORTANTE: substitua a URL abaixo pela URL de implantação ("/exec") do
 * Web App do Apps Script após publicá-lo (Implantar > Nova implantação >
 * Aplicativo da Web).
 */

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwrWWfQ7pEM4GRE51WHC_RvQ8XIXEwjFxJXCI3L-4Ydkwny3nYZznDYZzSiDW9B2_4Sgg/exec';

// Retentativas: o Apps Script Web App ocasionalmente responde com erro
// transitório (503 "Service Unavailable" ou falha de rede momentânea),
// especialmente quando várias chamadas chegam em sequência rápida logo
// após o login. Tenta novamente algumas vezes com espera crescente antes
// de reportar falha ao chamador.
const PAC_FETCH_MAX_TENTATIVAS = 4;
const PAC_FETCH_ESPERA_BASE_MS = 600;

function _pacFetch(body, onSuccess, onFailure, tentativa) {
  tentativa = tentativa || 1;

  fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    // Content-Type "text/plain" evita o preflight CORS (OPTIONS), que o
    // Apps Script não trata por padrão. O doPost faz JSON.parse normalmente.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  })
    .then(function(r) {
      if (!r.ok) {
        const erro = new Error('HTTP ' + r.status);
        erro.status = r.status;
        throw erro;
      }
      return r.json();
    })
    .then(function(data) { if (onSuccess) onSuccess(data); })
    .catch(function(err) {
      if (tentativa < PAC_FETCH_MAX_TENTATIVAS) {
        const espera = PAC_FETCH_ESPERA_BASE_MS * Math.pow(2, tentativa - 1);
        setTimeout(function() {
          _pacFetch(body, onSuccess, onFailure, tentativa + 1);
        }, espera);
        return;
      }
      if (onFailure) onFailure({ message: err.message });
    });
}

function _pacChamada(fnName, args, onSuccess, onFailure) {
  let body;

  switch (fnName) {
    case 'chamarAcao': {
      const [token, acao, paramsJson] = args;
      const params = JSON.parse(paramsJson || '{}');
      body = Object.assign({}, params, { acao: acao, token: token });
      break;
    }
    case 'chamarAcaoPublica': {
      const [acao, paramsJson] = args;
      const params = JSON.parse(paramsJson || '{}');
      body = Object.assign({}, params, { acao: acao });
      break;
    }
    case 'acaoLogin': {
      const [email, senha] = args;
      body = { acao: 'login', email: email, senha: senha };
      break;
    }
    case 'acaoTrocarSenha': {
      const [token, senha_atual, senha_nova, senha_confirmacao] = args;
      body = {
        acao: 'trocar_senha',
        token: token,
        senha_atual: senha_atual,
        senha_nova: senha_nova,
        senha_confirmacao: senha_confirmacao
      };
      break;
    }
    default:
      if (onFailure) onFailure({ message: 'Função não suportada pelo api.js: ' + fnName });
      return;
  }

  _pacFetch(body, onSuccess, onFailure);
}

function _criarRunner(onSuccess, onFailure) {
  return new Proxy({}, {
    get: function(target, prop) {
      if (prop === 'withSuccessHandler') {
        return function(cb) { return _criarRunner(cb, onFailure); };
      }
      if (prop === 'withFailureHandler') {
        return function(cb) { return _criarRunner(onSuccess, cb); };
      }
      return function() {
        const args = Array.prototype.slice.call(arguments);
        _pacChamada(prop, args, onSuccess, onFailure);
      };
    }
  });
}

// Mapa de identificadores de página (minúsculas) -> nome real do arquivo no
// repositório (GitHub Pages é case-sensitive, mas os arquivos .html mantêm
// a grafia original com iniciais maiúsculas).
const PAGE_FILE_MAP = {
  admin: 'Admin.html',
  aprovacoes: 'Aprovacoes.html',
  dashboard: 'Dashboard.html',
  demandas: 'Demandas.html',
  homologacao: 'Homologacao.html',
  login: 'Login.html',
  orcamento: 'Orcamento.html',
  prioridades: 'Prioridades.html',
  publico: 'Publico.html',
  index: 'index.html'
};

function _pacUrlPagina(page) {
  const limpo = String(page || '').replace(/\.html$/i, '').toLowerCase();
  return PAGE_FILE_MAP[limpo] || (page + '.html');
}

window.google = window.google || {};
window.google.script = window.google.script || {};
window.google.script.run = _criarRunner(null, null);

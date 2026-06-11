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

function _pacFetch(body, onSuccess, onFailure) {
  fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    // Content-Type "text/plain" evita o preflight CORS (OPTIONS), que o
    // Apps Script não trata por padrão. O doPost faz JSON.parse normalmente.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  })
    .then(function(r) { return r.json(); })
    .then(function(data) { if (onSuccess) onSuccess(data); })
    .catch(function(err) { if (onFailure) onFailure({ message: err.message }); });
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

window.google = window.google || {};
window.google.script = window.google.script || {};
window.google.script.run = _criarRunner(null, null);

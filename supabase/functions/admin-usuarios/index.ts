// Edge Function: admin-usuarios
// ---------------------------------------------------------------------------
// Cadastro de usuários pelo próprio sistema PAC (tela Admin), sem passar pelo
// painel do Supabase. Cria a conta no Auth com uma senha temporária; o gatilho
// handle_new_user() cria o perfil a partir dos metadados, e o usuário é
// obrigado a trocar a senha no primeiro acesso.
//
// Ações (POST JSON):
//   { acao: 'criar',   usuario: { nome, email, papel, id_unidade_fk, matricula_siape } }
//   { acao: 'resetar', id_usuario }
//
// Quem pode chamar:
//   - administrador global (papel 'licitacoes' sem unidade): qualquer usuário;
//   - 'licitacoes' com unidade: só usuários de unidades subordinadas à sua,
//     e nunca com papel 'licitacoes'.
// A chave service_role só existe aqui dentro, no servidor; o navegador nunca a vê.
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const PAPEIS = ['ord_despesas', 'chefia', 'chefe_secao', 'licitacoes'];

const resposta = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Senha temporária legível: sem caracteres ambíguos (0/O, 1/l/I), com
// maiúscula, minúscula e número, para atender às regras da troca de senha.
function senhaTemporaria(): string {
  const mai = 'ABCDEFGHJKLMNPQRSTUVWXYZ', min = 'abcdefghijkmnpqrstuvwxyz', num = '23456789';
  const todos = mai + min + num;
  const rnd = (s: string) => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
  const chars = [rnd(mai), rnd(min), rnd(num)];
  while (chars.length < 10) chars.push(rnd(todos));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return resposta({ ok: false, erro: 'Método não permitido.' }, 405);

  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ── Quem está chamando ────────────────────────────────────────────────
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: { user }, error: eUser } = await admin.auth.getUser(jwt);
    if (eUser || !user) return resposta({ ok: false, erro: 'Sessão expirada. Entre novamente.' });

    const { data: eu } = await admin.from('perfis')
      .select('papel, id_unidade_fk, ativo').eq('id_usuario', user.id).single();
    if (!eu || !eu.ativo || eu.papel !== 'licitacoes')
      return resposta({ ok: false, erro: 'Você não tem permissão para cadastrar usuários.' });
    const adminGlobal = !eu.id_unidade_fk;

    let escopo: string[] = [];
    if (!adminGlobal) {
      const { data } = await admin.rpc('subordinadas', { p_unidade: eu.id_unidade_fk });
      escopo = (data || []).map((r: { id_unidade: string }) => r.id_unidade);
    }
    const podeGerir = (papel: string, unidade: string | null) =>
      adminGlobal || (papel !== 'licitacoes' && !!unidade && escopo.includes(unidade));

    const corpo = await req.json();

    // ── Criar ──────────────────────────────────────────────────────────────
    if (corpo.acao === 'criar') {
      const u = corpo.usuario || {};
      const nome = String(u.nome || '').trim();
      const email = String(u.email || '').trim().toLowerCase();
      const papel = String(u.papel || '');
      const unidade = u.id_unidade_fk ? String(u.id_unidade_fk) : null;
      const siape = u.matricula_siape ? String(u.matricula_siape).trim() : null;

      if (!nome) return resposta({ ok: false, erro: 'Informe o nome completo.' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return resposta({ ok: false, erro: 'E-mail inválido.' });
      if (!PAPEIS.includes(papel)) return resposta({ ok: false, erro: 'Papel inválido.' });
      if (papel !== 'licitacoes' && !unidade)
        return resposta({ ok: false, erro: 'Selecione a unidade do usuário.' });
      if (!podeGerir(papel, unidade))
        return resposta({ ok: false, erro: 'Você só pode cadastrar usuários das unidades sob sua responsabilidade.' });

      const { data: existe } = await admin.from('perfis').select('id_usuario').ilike('email', email).maybeSingle();
      if (existe) return resposta({ ok: false, erro: 'Já existe um usuário com este e-mail.' });

      const senha = senhaTemporaria();
      const { data: criado, error: eCriar } = await admin.auth.admin.createUser({
        email, password: senha, email_confirm: true,
        user_metadata: { nome, papel, id_unidade_fk: unidade || '', deve_trocar_senha: true },
      });
      if (eCriar) {
        const msg = /already|registered|exists/i.test(eCriar.message)
          ? 'Já existe um usuário com este e-mail.' : eCriar.message;
        return resposta({ ok: false, erro: msg });
      }

      // O gatilho já criou o perfil; completa o que não vem dos metadados.
      const { error: ePerfil } = await admin.from('perfis').upsert({
        id_usuario: criado.user.id, nome, email, papel,
        id_unidade_fk: unidade, matricula_siape: siape, ativo: true,
      }, { onConflict: 'id_usuario' });
      if (ePerfil) {
        await admin.auth.admin.deleteUser(criado.user.id);
        return resposta({ ok: false, erro: 'Não foi possível gravar o perfil: ' + ePerfil.message });
      }
      return resposta({ ok: true, id_usuario: criado.user.id, senha_inicial: senha });
    }

    // ── Resetar senha ──────────────────────────────────────────────────────
    if (corpo.acao === 'resetar') {
      const id = String(corpo.id_usuario || '');
      const { data: alvo } = await admin.from('perfis')
        .select('papel, id_unidade_fk').eq('id_usuario', id).single();
      if (!alvo) return resposta({ ok: false, erro: 'Usuário não encontrado.' });
      if (!podeGerir(alvo.papel, alvo.id_unidade_fk))
        return resposta({ ok: false, erro: 'Você não tem permissão para resetar a senha deste usuário.' });

      const { data: atual } = await admin.auth.admin.getUserById(id);
      const senha = senhaTemporaria();
      const { error } = await admin.auth.admin.updateUserById(id, {
        password: senha,
        user_metadata: { ...(atual?.user?.user_metadata || {}), deve_trocar_senha: true },
      });
      if (error) return resposta({ ok: false, erro: error.message });
      return resposta({ ok: true, senha_inicial: senha });
    }

    return resposta({ ok: false, erro: 'Ação desconhecida.' });
  } catch (e) {
    return resposta({ ok: false, erro: 'Erro interno: ' + (e instanceof Error ? e.message : String(e)) }, 500);
  }
});

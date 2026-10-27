-- Cadastro de usuários pelo próprio sistema (Edge Function admin-usuarios)
-- Aplicado no Supabase em 27/10/2026.
--
-- A função roda com a chave de serviço e precisa ler/gravar perfis e ler
-- unidades. O papel `authenticated` continua só com SELECT em perfis: assim
-- nenhum usuário consegue alterar o próprio papel ou unidade pela API; toda
-- criação, edição, ativação e reset de senha passa pela função, que confere
-- se quem chama é administrador.
grant select, insert, update on public.perfis to service_role;
grant select on public.unidades to service_role;
